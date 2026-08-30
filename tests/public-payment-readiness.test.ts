import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRecord,
  FlowRecord,
  FlowRepo,
} from "@/lib/db/repo";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { ProjectRepo } from "@/lib/projects/repo";
import type { DeploymentRecord } from "@/lib/projects/types";

const state = vi.hoisted(() => ({
  repo: null as FlowRepo | null,
  projectRepo: null as ProjectRepo | null,
  publishedGraph: null as SupportedFlowGraph | null,
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => {
    if (!state.repo) throw new Error("payment readiness harness is not configured");
    return state.repo;
  }),
}));

vi.mock("@/lib/projects/provider", () => ({
  getProjectRepo: vi.fn(async () => state.projectRepo),
}));

vi.mock("@/lib/projects/public-agent-graph", () => ({
  resolvePublicAgentRelease: vi.fn(async (
    input: Readonly<{ flow: FlowRecord; activeDeployment: DeploymentRecord }>,
  ) => ({
    graph: state.publishedGraph ?? input.flow.graph,
    resourceDependencies: [],
    release: {
      ownerId: input.flow.ownerId,
      flowId: input.flow.id,
      deploymentId: input.activeDeployment.id,
      environmentId: input.activeDeployment.environmentId,
      flowVersionId: input.activeDeployment.flowVersionId,
      semanticHash: "a".repeat(64),
      fullHash: "b".repeat(64),
    },
  })),
}));

const { buildCatalog } = await import("@/lib/catalog");

const OWNER_ID = "payment-readiness-owner";
const PAYOUT = "0x1111111111111111111111111111111111111111";
const EMPLOYEE_PAYOUT = "0x2222222222222222222222222222222222222222";

interface HarnessOptions {
  readonly activeDeployment?: boolean;
  readonly agentSettlementLive?: boolean;
  readonly payout?: boolean;
  readonly company?: {
    readonly status: "active" | "draft" | "paused";
    readonly publishGated?: boolean;
    readonly paidCall?: boolean;
    readonly departmentAttached?: boolean;
    readonly payTo?: string | null;
    readonly employeeMonthlyBudgetUsdc?: number | null;
    readonly departmentMonthlyBudgetUsdc?: number | null;
    readonly employeeSpentUsdc?: number;
    readonly departmentSpentUsdc?: number;
    readonly budgetReadReject?: boolean;
  };
  readonly publishedPaidCall?: boolean;
}

function graph(paidCall = true): SupportedFlowGraph {
  return {
    id: "flow-readiness",
    name: "Payment Readiness",
    nodes: paidCall
      ? [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }]
      : [{
          id: "schedule",
          type: "schedule",
          params: { cron: "0 * * * *" },
          position: { x: 0, y: 0 },
        }],
    edges: [],
  };
}

function deployment(): DeploymentRecord {
  return {
    id: "deployment-readiness",
    flowId: "flow-readiness",
    flowVersionId: "version-readiness",
    environmentId: "environment-readiness",
    status: "live",
    createdAt: 1,
  };
}

function configure(options: HarnessOptions = {}): void {
  const companyOptions = options.company;
  const flow: FlowRecord = {
    id: "flow-readiness",
    ownerId: OWNER_ID,
    name: "Payment Readiness",
    graph: graph(companyOptions?.paidCall ?? true),
    updatedAt: 1,
  };
  state.publishedGraph = options.publishedPaidCall === undefined
    ? null
    : graph(options.publishedPaidCall);
  const agent: AgentRecord = {
    id: "agent-readiness",
    flowId: flow.id,
    slug: "payment-readiness-service",
    status: "live",
    priceUsdc: 0.05,
    createdAt: 1,
    settlementLive: options.agentSettlementLive ?? true,
  };
  const employee = companyOptions
    ? {
        agentId: agent.id,
        companyId: "company-readiness",
        departmentId: "department-readiness",
        jobDescription: "Public service",
        publishGated: companyOptions.publishGated ?? false,
        monthlyBudgetUsdc: companyOptions.employeeMonthlyBudgetUsdc ?? null,
        payTo: companyOptions.payTo ?? null,
      }
    : null;

  state.repo = {
    listLiveAgents: vi.fn(async () => [agent]),
    listFlowsByIds: vi.fn(async () => [flow]),
    getFlow: vi.fn(async () => flow),
    countRunsByAgent: vi.fn(async () => ({ [agent.id]: 0 })),
    countSettledRunsByAgent: vi.fn(async () => ({ [agent.id]: 0 })),
    lastAgentCallAt: vi.fn(async () => ({})),
    listSchedulesByAgents: vi.fn(async () => []),
    listWalletsByOwners: vi.fn(async () =>
      options.payout === false ? [] : [{ ownerId: OWNER_ID, address: PAYOUT }]),
    getWallet: vi.fn(async () =>
      options.payout === false ? null : { ownerId: OWNER_ID, address: PAYOUT }),
    getEmployeeByAgent: vi.fn(async () => employee),
    getCompany: vi.fn(async () => companyOptions
      ? {
          id: "company-readiness",
          ownerId: OWNER_ID,
          name: "Readiness Co",
          mission: "Test public readiness",
          status: companyOptions.status,
          fireCostThresholdUsdc: null,
          createdAt: "2026-08-14T00:00:00.000Z",
        }
      : null),
    listDepartments: vi.fn(async () =>
      companyOptions?.departmentAttached === false
        ? []
        : [{
            id: "department-readiness",
            companyId: "company-readiness",
            name: "Operations",
            monthlyBudgetUsdc: companyOptions?.departmentMonthlyBudgetUsdc ?? null,
          }]),
    listCompanyEmployeeHistory: vi.fn(async () => employee
      ? [
          employee,
          {
            ...employee,
            agentId: "agent-readiness-peer",
            jobDescription: "Peer service",
          },
        ]
      : []),
    sumCostByAgents: vi.fn(async (agentIds: string[]) => {
      if (companyOptions?.budgetReadReject) throw new Error("budget ledger unavailable");
      return agentIds.length > 1
        ? companyOptions?.departmentSpentUsdc ?? 0
        : companyOptions?.employeeSpentUsdc ?? 0;
    }),
  } as unknown as FlowRepo;

  state.projectRepo = {
    listActiveDeploymentsForFlows: vi.fn(async () =>
      options.activeDeployment === false ? [] : [deployment()]),
  } as unknown as ProjectRepo;
}

async function readiness(options: HarnessOptions = {}): Promise<{
  readonly state: string;
  readonly acceptsPayment: boolean;
  readonly publishedLive: boolean;
} | null> {
  configure(options);
  const [entry] = await buildCatalog();
  if (!entry) return null;
  return {
    state: Reflect.get(entry, "paymentState") as string,
    acceptsPayment: entry.acceptsPayment,
    publishedLive: entry.publishedLive,
  };
}

afterEach(() => {
  state.repo = null;
  state.projectRepo = null;
  state.publishedGraph = null;
  vi.unstubAllEnvs();
});

describe("public payment readiness", () => {
  it("enables payment only with platform and agent flags, Live deployment, and payout", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    vi.stubEnv("X402_SELLER_WALLET_ADDRESS", "");

    await expect(readiness()).resolves.toEqual({
      state: "payment-enabled",
      acceptsPayment: true,
      publishedLive: true,
    });
    await expect(readiness({ activeDeployment: false })).resolves.toBeNull();
    await expect(readiness({ payout: false })).resolves.toEqual({
      state: "preview",
      acceptsPayment: false,
      publishedLive: true,
    });
    await expect(readiness({ agentSettlementLive: false })).resolves.toEqual({
      state: "preview",
      acceptsPayment: false,
      publishedLive: true,
    });
  });

  it("keeps an ordinary published service previewable while platform settlement is off", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "true");

    await expect(readiness()).resolves.toEqual({
      state: "preview",
      acceptsPayment: false,
      publishedLive: true,
    });
  });

  it.each([
    ["inactive company", { status: "paused" as const }],
    ["publish gate", { status: "active" as const, publishGated: true }],
    ["missing paidCall trigger", { status: "active" as const, paidCall: false }],
    ["detached department", { status: "active" as const, departmentAttached: false }],
  ])("marks a company service unavailable for %s", async (_label, company) => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");

    await expect(readiness({ company })).resolves.toEqual({
      state: "unavailable",
      acceptsPayment: false,
      publishedLive: true,
    });
  });

  it("never calls a company service a preview when paid readiness is incomplete", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "true");

    await expect(readiness({ company: { status: "active" } })).resolves.toEqual({
      state: "unavailable",
      acceptsPayment: false,
      publishedLive: true,
    });
  });

  it.each([
    [
      "employee budget",
      { status: "active" as const, employeeMonthlyBudgetUsdc: 5, employeeSpentUsdc: 5 },
    ],
    [
      "department budget",
      { status: "active" as const, departmentMonthlyBudgetUsdc: 5, departmentSpentUsdc: 5 },
    ],
    [
      "budget ledger failure",
      { status: "active" as const, employeeMonthlyBudgetUsdc: 5, budgetReadReject: true },
    ],
  ])("marks a company service unavailable for %s", async (_label, company) => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");

    await expect(readiness({ company })).resolves.toEqual({
      state: "unavailable",
      acceptsPayment: false,
      publishedLive: true,
    });
  });

  it("projects the employee payout used by runtime ahead of the owner wallet", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    configure({ company: { status: "active", payTo: EMPLOYEE_PAYOUT } });

    const [entry] = await buildCatalog();
    expect(entry).toMatchObject({
      paymentState: "payment-enabled",
      acceptsPayment: true,
      payTo: EMPLOYEE_PAYOUT,
    });
  });

  it("fails payment readiness closed for an invalid preferred employee payout", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    configure({ company: { status: "active", payTo: "not-an-address" } });

    const [entry] = await buildCatalog();
    expect(entry).toMatchObject({
      paymentState: "unavailable",
      acceptsPayment: false,
      payTo: "0x0000000000000000000000000000000000000000",
    });
  });

  it.each([
    ["paid Draft / scheduled Live", true, false, "unavailable"],
    ["scheduled Draft / paid Live", false, true, "payment-enabled"],
  ] as const)("derives %s from immutable Live", async (_label, draftPaidCall, livePaidCall, stateName) => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");

    await expect(readiness({
      company: { status: "active", paidCall: draftPaidCall },
      publishedPaidCall: livePaidCall,
    })).resolves.toEqual({
      state: stateName,
      acceptsPayment: stateName === "payment-enabled",
      publishedLive: true,
    });
  });
});

describe("immutable payment-readiness callers", () => {
  it.each([
    ["catalog", "src/lib/catalog.ts", "publishedGraph: publicGraph"],
    ["x402", "src/app/api/agents/[agent]/.well-known/x402/route.ts", "publishedGraph: service.graph"],
    ["AgentCard", "src/app/api/agents/[agent]/.well-known/agent-card/route.ts", "publishedGraph: service.graph"],
    ["A2A", "src/app/api/agents/[agent]/a2a/route.ts", "publishedGraph: service.graph"],
    ["page", "src/app/a/[slug]/page.tsx", "publishedGraph: service.graph"],
    ["OG", "src/app/a/[slug]/opengraph-image.tsx", "publishedGraph: service.graph"],
    ["template", "src/app/api/agents/[agent]/template/route.ts", "publishedGraph: service.graph"],
  ] as const)("passes exact published authority on %s", (_surface, path, marker) => {
    expect(readFileSync(join(process.cwd(), path), "utf8")).toContain(marker);
  });

  it("derives the run-route company trigger from prepared Live authority", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/agents/[agent]/run/route.ts"),
      "utf8",
    );
    expect(source).toMatch(/flowToManifest\(preparedGraph\)/u);
    expect(source).not.toMatch(/flowToManifest\(flow\.graph\)/u);
  });
});
