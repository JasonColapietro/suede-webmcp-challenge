/**
 * Tests for the paused-company external-call gate added to
 * src/app/api/agents/[agent]/run/route.ts (Task 9): a run request for an
 * agent that belongs to a non-active company must answer 503 before any
 * payment or execution work; a non-employee agent or an employee of an
 * active company must take the existing path untouched. Mock setup mirrors
 * tests/api-agent-connection-live.test.ts,
 * extended with getEmployeeByAgent/getCompany.
 *
 * Kept in its own file (rather than folded into tests/api-company-fire.test.ts)
 * because that file mocks @/lib/db/repo to return a real SqliteRepo instance
 * and @/lib/run-service with a 2-export shape; this file needs synthetic
 * fakes for a much larger set of run-route dependencies (@/lib/agents,
 * @/lib/payout, @/lib/rails/x402-verify, @/lib/relay, a 5-export
 * @/lib/run-service). Combining both mock shapes for the same module
 * specifiers in one file fights vitest's per-file module mock caching.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord, FlowRecord } from "@/lib/db/repo";

const state = vi.hoisted(() => ({
  agent: {
    id: "agent-1",
    flowId: "flow-1",
    slug: "employee-agent",
    status: "live",
    priceUsdc: 0,
    createdAt: 1,
    settlementLive: true,
  } as AgentRecord,
  flow: {
    id: "flow-1",
    ownerId: "owner-1",
    name: "Employee flow",
    graph: { id: "draft-graph", name: "Draft", nodes: [], edges: [], revision: 1 },
    updatedAt: 1,
  } as FlowRecord,
  employee: null as {
    agentId: string;
    companyId: string;
    departmentId: string;
    jobDescription: string;
    publishGated: boolean;
    monthlyBudgetUsdc: number | null;
  } | null,
  company: null as {
    id: string;
    ownerId: string;
    name: string;
    mission: string;
    status: "draft" | "active" | "paused";
    fireCostThresholdUsdc: number | null;
    createdAt: string;
  } | null,
  departments: [{
    id: "dept-1",
    companyId: "company-1",
    name: "Ops",
    monthlyBudgetUsdc: null as number | null,
  }],
  employeeHistory: [] as Array<{
    agentId: string;
    companyId: string;
    departmentId: string;
    jobDescription: string;
    publishGated: boolean;
    monthlyBudgetUsdc: number | null;
  }>,
  getFlow: vi.fn(),
  getRelayEndpoint: vi.fn(),
  createRun: vi.fn(),
  finishRun: vi.fn(),
  stampRunSettled: vi.fn(),
  recordSettlement: vi.fn(),
  getEmployeeByAgent: vi.fn(),
  getCompany: vi.fn(),
  listDepartments: vi.fn(),
  listCompanyEmployeeHistory: vi.fn(),
  sumCostByAgents: vi.fn(),
  runToCompletion: vi.fn(),
  runPublishedLiveToCompletion: vi.fn(),
  preparePublishedLiveExecution: vi.fn(),
  runPreparedPublishedLiveToCompletion: vi.fn(),
  runPreparedPublishedLiveDryRunToCompletion: vi.fn(),
  consumePreparedPublishedLiveRelay: vi.fn(),
  preparedPublishedLiveRelaySnapshot: vi.fn(),
  preparedPublishedLiveExecutionReceipt: vi.fn(),
  runIdFromExecutionError: vi.fn(),
  disposePreparedPublishedLiveExecution: vi.fn(),
  verifyAndSettle: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({ resolveAgent: vi.fn(async () => state.agent) }));
vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => ({
    getFlow: (...args: unknown[]) => state.getFlow(...args),
    getRelayEndpoint: (...args: unknown[]) => state.getRelayEndpoint(...args),
    createRun: (...args: unknown[]) => state.createRun(...args),
    finishRun: (...args: unknown[]) => state.finishRun(...args),
    stampRunSettled: (...args: unknown[]) => state.stampRunSettled(...args),
    recordSettlement: (...args: unknown[]) => state.recordSettlement(...args),
    getEmployeeByAgent: (...args: unknown[]) => state.getEmployeeByAgent(...args),
    getCompany: (...args: unknown[]) => state.getCompany(...args),
    listDepartments: (...args: unknown[]) => state.listDepartments(...args),
    listCompanyEmployeeHistory: (...args: unknown[]) => state.listCompanyEmployeeHistory(...args),
    sumCostByAgents: (...args: unknown[]) => state.sumCostByAgents(...args),
  })),
}));
vi.mock("@/lib/run-service", () => ({
  runToCompletion: (...args: unknown[]) => state.runToCompletion(...args),
  runPublishedLiveToCompletion: (...args: unknown[]) => state.runPublishedLiveToCompletion(...args),
  preparePublishedLiveExecution: (...args: unknown[]) => state.preparePublishedLiveExecution(...args),
  runPreparedPublishedLiveToCompletion: (...args: unknown[]) => state.runPreparedPublishedLiveToCompletion(...args),
  runPreparedPublishedLiveDryRunToCompletion: (...args: unknown[]) =>
    state.runPreparedPublishedLiveDryRunToCompletion(...args),
  consumePreparedPublishedLiveRelay: (...args: unknown[]) =>
    state.consumePreparedPublishedLiveRelay(...args),
  preparedPublishedLiveRelaySnapshot: (...args: unknown[]) =>
    state.preparedPublishedLiveRelaySnapshot(...args),
  preparedPublishedLiveExecutionReceipt: (...args: unknown[]) =>
    state.preparedPublishedLiveExecutionReceipt(...args),
  runIdFromExecutionError: (...args: unknown[]) => state.runIdFromExecutionError(...args),
  disposePreparedPublishedLiveExecution: (...args: unknown[]) => state.disposePreparedPublishedLiveExecution(...args),
  // Pure helpers mirrored from the real module so the mock stays in sync with
  // the run route's imports; fire-gating behavior does not depend on them.
  runModeResponseFields: (dryRun: boolean) => (dryRun ? { mode: "dry-run" } : {}),
  triggerInputContractViolations: () => [],
}));
vi.mock("@/lib/connections/provider", () => ({
  getConnectionRepository: vi.fn(),
}));
vi.mock("@/lib/payout", () => ({
  resolvePayout: vi.fn(async () => ({ source: "creator", payTo: "0x1111111111111111111111111111111111111111" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  ipFromRequest: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/rails/x402-verify", () => ({
  X402_AGENT_RUN_RESOURCE_DESCRIPTION:
    "Run a Suede Agent Studio workflow over x402.",
  X402_RUN_OUTPUT_SCHEMA: {},
  buildX402BazaarExtensions: vi.fn(() => ({ bazaar: {} })),
  buildX402Accept: vi.fn(() => ({})),
  buildX402PaymentRequired: vi.fn(() => ({ accepts: [{}] })),
  encodeX402Header: vi.fn(() => ""),
  verifyAndSettle: (...args: unknown[]) => state.verifyAndSettle(...args),
}));
vi.mock("@/lib/relay", () => ({
  RelayError: class RelayError extends Error {},
  forwardToRelay: (...args: unknown[]) => state.fetch(...args),
}));

const { POST } = await import("@/app/api/agents/[agent]/run/route");

function context() {
  return { params: Promise.resolve({ agent: "employee-agent" }) };
}

function request(body: Readonly<Record<string, unknown>>): Request {
  return new Request("https://agents.suedeai.ai/api/agents/employee-agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
  state.agent = {
    id: "agent-1",
    flowId: "flow-1",
    slug: "employee-agent",
    status: "live",
    priceUsdc: 0,
    createdAt: 1,
    settlementLive: true,
  };
  state.flow = {
    id: "flow-1",
    ownerId: "owner-1",
    name: "Employee flow",
    graph: {
      id: "draft-graph",
      name: "Draft",
      nodes: [{ id: "out", type: "output", params: {}, position: { x: 0, y: 0 } }],
      edges: [],
      meta: { triggers: [{ kind: "paidCall", priceUsdc: 0 }] },
    },
    updatedAt: 1,
  };
  state.employee = null;
  state.company = null;
  state.departments = [{
    id: "dept-1",
    companyId: "company-1",
    name: "Ops",
    monthlyBudgetUsdc: null,
  }];
  state.employeeHistory = [];
  state.getFlow.mockImplementation(async () => state.flow);
  state.getRelayEndpoint.mockResolvedValue(null);
  state.createRun.mockResolvedValue({ id: "relay-run" });
  state.finishRun.mockResolvedValue(undefined);
  state.stampRunSettled.mockResolvedValue(undefined);
  state.recordSettlement.mockResolvedValue(undefined);
  state.getEmployeeByAgent.mockImplementation(async () => state.employee);
  state.getCompany.mockImplementation(async () => state.company);
  state.listDepartments.mockImplementation(async () => state.departments);
  state.listCompanyEmployeeHistory.mockImplementation(async () => state.employeeHistory);
  state.sumCostByAgents.mockResolvedValue(0);
  state.runToCompletion.mockResolvedValue({
    runId: "dry-run",
    status: "done",
    totalCostUsdc: 0,
    outputs: { preview: true },
  });
  state.runPublishedLiveToCompletion.mockResolvedValue({
    runId: "live-run",
    status: "done",
    totalCostUsdc: 0,
    outputs: { published: true },
  });
  state.preparePublishedLiveExecution.mockImplementation(async () => Object.freeze({
    graph: Object.freeze({
      id: "live-graph",
      name: "Employee flow",
      nodes: Object.freeze([{ id: "out", type: "output", params: {}, position: { x: 0, y: 0 } }]),
      edges: Object.freeze([]),
      meta: Object.freeze({ triggers: Object.freeze([{ kind: "paidCall", priceUsdc: 0 }]) }),
    }),
    release: Object.freeze({
      ownerId: "owner-1",
      flowId: "flow-1",
      deploymentId: "deployment-1",
      environmentId: "environment-live",
      flowVersionId: "version-1",
      semanticHash: "a".repeat(64),
      fullHash: "b".repeat(64),
    }),
    agent: Object.freeze({
      id: state.agent.id,
      flowId: state.agent.flowId,
      priceUsdc: state.agent.priceUsdc,
    }),
    resourceDependencies: Object.freeze([]),
    relay: false,
  }));
  state.runPreparedPublishedLiveToCompletion.mockResolvedValue({
    runId: "live-run",
    status: "done",
    totalCostUsdc: 0,
    outputs: { published: true },
  });
  state.runPreparedPublishedLiveDryRunToCompletion.mockResolvedValue({
    runId: "dry-run",
    status: "done",
    totalCostUsdc: 0,
    outputs: { preview: true },
  });
  state.consumePreparedPublishedLiveRelay.mockResolvedValue(null);
  state.preparedPublishedLiveRelaySnapshot.mockReturnValue(null);
  state.preparedPublishedLiveExecutionReceipt.mockReturnValue({
    ownerId: "owner-1",
    flowId: "flow-1",
    deploymentId: "deployment-1",
    environmentId: "environment-live",
    flowVersionId: "version-1",
    semanticHash: "a".repeat(64),
    fullHash: "b".repeat(64),
  });
  state.runIdFromExecutionError.mockReturnValue(null);
  state.disposePreparedPublishedLiveExecution.mockReturnValue(undefined);
  state.verifyAndSettle.mockResolvedValue({ ok: true, transaction: null, payer: null });
});

describe("agent run route — paused-company call gate", () => {
  it("returns 404 for an unpublished former employee before company or execution work", async () => {
    state.agent = { ...state.agent, status: "draft", settlementLive: false };

    const response = await POST(request({ input: {}, dryRun: true }), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "agent not found" });
    expect(state.getEmployeeByAgent).not.toHaveBeenCalled();
    expect(state.getFlow).not.toHaveBeenCalled();
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.preparePublishedLiveExecution).not.toHaveBeenCalled();
  });

  it("returns 503 company_paused for an employee agent whose company is paused, before any run-service call", async () => {
    state.employee = {
      agentId: "agent-1",
      companyId: "company-1",
      departmentId: "dept-1",
      jobDescription: "Does the thing",
      publishGated: false,
      monthlyBudgetUsdc: null,
    };
    state.company = {
      id: "company-1",
      ownerId: "owner-1",
      name: "Co",
      mission: "M",
      status: "paused",
      fireCostThresholdUsdc: null,
      createdAt: "t",
    };

    const response = await POST(request({ input: {} }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "company_paused",
      message: "This service's company is paused by its founder.",
    });
    expect(state.getEmployeeByAgent).toHaveBeenCalledWith("agent-1");
    expect(state.getCompany).toHaveBeenCalledWith("company-1");
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.runPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledOnce();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
  });

  it("returns 503 company_not_active for a draft-company employee before payment or execution", async () => {
    state.employee = {
      agentId: "agent-1",
      companyId: "company-1",
      departmentId: "dept-1",
      jobDescription: "Does the thing",
      publishGated: false,
      monthlyBudgetUsdc: null,
    };
    state.company = {
      id: "company-1",
      ownerId: "owner-1",
      name: "Co",
      mission: "M",
      status: "draft",
      fireCostThresholdUsdc: null,
      createdAt: "t",
    };

    const response = await POST(request({ input: {}, dryRun: true }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "company_not_active",
      message: "This service is not available until its company is active.",
    });
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledOnce();
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
  });

  it("takes the existing dry-run path untouched for a non-employee agent", async () => {
    state.employee = null; // resolveAgent's agent has no company_employees row

    const response = await POST(request({ input: { topic: "x" }, dryRun: true }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: "dry-run" });
    expect(state.getEmployeeByAgent).toHaveBeenCalledWith("agent-1");
    expect(state.getCompany).not.toHaveBeenCalled();
  });

  it("rejects a caller-selected public dry run for an active company employee", async () => {
    state.employee = {
      agentId: "agent-1",
      companyId: "company-1",
      departmentId: "dept-1",
      jobDescription: "Does the thing",
      publishGated: false,
      monthlyBudgetUsdc: null,
    };
    state.company = {
      id: "company-1",
      ownerId: "owner-1",
      name: "Co",
      mission: "M",
      status: "active",
      fireCostThresholdUsdc: null,
      createdAt: "t",
    };
    state.employeeHistory = [state.employee];

    const response = await POST(request({ input: {}, dryRun: true }), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "company_public_dry_run_forbidden" });
    expect(state.runToCompletion).not.toHaveBeenCalled();
  });

  it("runs an eligible employee live when its company is active", async () => {
    state.employee = {
      agentId: "agent-1",
      companyId: "company-1",
      departmentId: "dept-1",
      jobDescription: "Does the thing",
      publishGated: false,
      monthlyBudgetUsdc: null,
    };
    state.employeeHistory = [state.employee];
    state.company = {
      id: "company-1",
      ownerId: "owner-1",
      name: "Co",
      mission: "M",
      status: "active",
      fireCostThresholdUsdc: null,
      createdAt: "t",
    };

    const response = await POST(request({ input: {} }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: "live-run" });
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).toHaveBeenCalled();
  });

  it("blocks publish-gated and budget-exhausted employees on the public route", async () => {
    state.employee = {
      agentId: "agent-1",
      companyId: "company-1",
      departmentId: "dept-1",
      jobDescription: "Publishes",
      publishGated: true,
      monthlyBudgetUsdc: 1,
    };
    state.employeeHistory = [state.employee];
    state.company = {
      id: "company-1",
      ownerId: "owner-1",
      name: "Co",
      mission: "M",
      status: "active",
      fireCostThresholdUsdc: null,
      createdAt: "t",
    };

    const gated = await POST(request({ input: {} }), context());
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({ error: "company_service_approval_required" });

    state.employee = { ...state.employee, publishGated: false };
    state.employeeHistory = [state.employee];
    state.sumCostByAgents.mockResolvedValueOnce(1);
    const budgeted = await POST(request({ input: {} }), context());
    expect(budgeted.status).toBe(429);
    expect(await budgeted.json()).toMatchObject({ error: "employee_budget_exhausted" });
  });

  it("blocks an active-company employee whose live selling is not enabled", async () => {
    state.agent = { ...state.agent, settlementLive: false };
    state.employee = {
      agentId: "agent-1",
      companyId: "company-1",
      departmentId: "dept-1",
      jobDescription: "Does the thing",
      publishGated: false,
      monthlyBudgetUsdc: null,
    };
    state.company = {
      id: "company-1",
      ownerId: "owner-1",
      name: "Co",
      mission: "M",
      status: "active",
      fireCostThresholdUsdc: null,
      createdAt: "t",
    };

    const response = await POST(request({ input: {}, dryRun: true }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "company_service_not_live",
      message: "This service is not enabled for public calls.",
    });
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledOnce();
  });
});
