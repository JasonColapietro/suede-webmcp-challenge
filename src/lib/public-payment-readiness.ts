import type {
  AgentRecord,
  FlowRecord,
  FlowRepo,
} from "@/lib/db/repo";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { publicCallBudgetBlock } from "@/lib/company/guardrails";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { PublicAgentRelease } from "@/lib/projects/public-agent-graph";
import { publishedResourceAccess } from "@/lib/resources/public-access";
import {
  isConfiguredPayout,
  resolvePayoutFromRepo,
  selectPayout,
  type PayoutInfo,
} from "@/lib/payout";

export const PUBLIC_PAYMENT_STATES = [
  "preview",
  "payment-enabled",
  "unavailable",
] as const;

export type PublicPaymentState = (typeof PUBLIC_PAYMENT_STATES)[number];

/** Versioned vendor projection; the A2A AgentCard protocol version stays 1.0. */
export const PUBLIC_PAYMENT_PROJECTION = {
  version: 2,
  states: PUBLIC_PAYMENT_STATES,
  migration:
    "Version 2 omits x402 terms unless state is payment-enabled; unavailable does not imply a public dry-run.",
} as const;

/** Public discovery never exposes a Draft, retired, or otherwise unpublished agent. */
export function isPublishedAgentRecord(
  agent: AgentRecord | null | undefined,
): agent is AgentRecord {
  return agent?.status === "live";
}

export interface PublicPaymentReadiness {
  readonly state: PublicPaymentState;
  readonly acceptsPayment: boolean;
  readonly previewAvailable: boolean;
  readonly publishedLive: boolean;
  readonly payout: PayoutInfo;
  readonly companyService: boolean;
}

export interface ResolvePublicPaymentReadinessInput {
  readonly agent: AgentRecord;
  readonly flow: FlowRecord;
  readonly repo: FlowRepo;
  /**
   * True only after the caller has resolved an exact immutable Live execution.
   * A raw deployment row alone is not sufficient proof.
   */
  readonly liveExecutionReady: boolean;
  /** Exact immutable graph resolved from the active release. Never the Draft graph. */
  readonly publishedGraph: PublicAgentRelease["graph"];
  /** Bulk catalog callers can reuse their already-loaded owner/platform payout. */
  readonly fallbackPayout?: PayoutInfo;
  /** Defaults to the same environment gate used by the public run route. */
  readonly platformSettlementLive?: boolean;
}

async function companyPublicCallGatesPass(input: {
  readonly repo: FlowRepo;
  readonly flow: FlowRecord;
  readonly publishedGraph: PublicAgentRelease["graph"];
  readonly employee: NonNullable<Awaited<ReturnType<FlowRepo["getEmployeeByAgent"]>>>;
}): Promise<boolean> {
  try {
    if (input.employee.publishGated) return false;
    const company = await input.repo.getCompany(input.employee.companyId);
    if (company?.status !== "active") return false;
    const graph = input.publishedGraph as SupportedFlowGraph;
    const manifest = isFlowGraphV2(graph)
      ? flowToManifest(graph)
      : flowToManifest(graph);
    if (!manifest.triggers.some((trigger) => trigger.kind === "paidCall")) return false;
    const [departments, employeeHistory] = await Promise.all([
      input.repo.listDepartments(input.employee.companyId),
      input.repo.listCompanyEmployeeHistory(input.employee.companyId),
    ]);
    const department = departments.find(
      (candidate) => candidate.id === input.employee.departmentId,
    );
    if (!department) return false;
    const budgetBlock = await publicCallBudgetBlock({
      repo: input.repo,
      department,
      employee: input.employee,
      departmentAgentIds: employeeHistory
        .filter((candidate) => candidate.departmentId === input.employee.departmentId)
        .map((candidate) => candidate.agentId),
      now: new Date(),
    });
    return budgetBlock === null;
  } catch {
    return false;
  }
}

/**
 * Shared public projection of the run route's pre-payment gates, including
 * current company budget state.
 *
 * Ordinary published agents retain their explicit dry-run path whenever a
 * paid Live call is not ready. Company employees and paid Resources do not:
 * the public run route forbids those previews, so any failed paid-call gate is
 * `unavailable` rather than a fictional preview.
 */
export async function resolvePublicPaymentReadiness(
  input: ResolvePublicPaymentReadinessInput,
): Promise<PublicPaymentReadiness> {
  let employee: Awaited<ReturnType<FlowRepo["getEmployeeByAgent"]>>;
  try {
    employee = typeof input.repo.getEmployeeByAgent === "function"
      ? await input.repo.getEmployeeByAgent(input.agent.id)
      : null;
  } catch {
    return {
      state: "unavailable",
      acceptsPayment: false,
      previewAvailable: false,
      publishedLive: false,
      payout: selectPayout([]),
      companyService: false,
    };
  }

  const companyService = employee !== null;
  const paidResource = publishedResourceAccess(
    input.publishedGraph as SupportedFlowGraph,
  )?.executionAccess === "paid";
  const payout = input.fallbackPayout === undefined
    ? await resolvePayoutFromRepo(input.agent, input.repo, {
        flow: input.flow,
        employee,
      }).catch(() => selectPayout([]))
    : employee?.payTo
      ? selectPayout([
          { payTo: employee.payTo, source: "creator" },
          { payTo: input.fallbackPayout.payTo, source: input.fallbackPayout.source },
        ])
      : input.fallbackPayout;
  const publishedLive = input.agent.status === "live" && input.liveExecutionReady;
  const platformSettlementLive = input.platformSettlementLive
    ?? process.env.X402_SKIP_SETTLEMENT === "false";
  const companyReady = employee
    ? await companyPublicCallGatesPass({
        repo: input.repo,
        flow: input.flow,
        publishedGraph: input.publishedGraph,
        employee,
      })
    : true;
  const acceptsPayment = input.agent.status === "live"
    && input.agent.priceUsdc > 0
    && publishedLive
    && input.agent.settlementLive
    && platformSettlementLive
    && isConfiguredPayout(payout)
    && companyReady;

  if (acceptsPayment) {
    return {
      state: "payment-enabled",
      acceptsPayment: true,
      previewAvailable: !companyService && !paidResource,
      publishedLive,
      payout,
      companyService,
    };
  }
  if (!companyService && !paidResource && input.agent.status === "live") {
    return {
      state: "preview",
      acceptsPayment: false,
      previewAvailable: true,
      publishedLive,
      payout,
      companyService: false,
    };
  }
  return {
    state: "unavailable",
    acceptsPayment: false,
    previewAvailable: false,
    publishedLive,
    payout,
    companyService,
  };
}
