/** Persistence interface shared by the SQLite (dev) and Supabase impls. */
import { createHash } from "node:crypto";
import type { SupportedFlowGraph } from "../flow/types";
import type {
  ApprovalKind,
  ApprovalRecord,
  ApprovalStatus,
  CreateApprovalInput,
  CompanyRecord,
  CompanyStatus,
  DepartmentRecord,
  EmployeeLifecycleStatus,
  EmployeeRecord,
  EmployeeRole,
} from "../company/types";
import type {
  FlowMutationInput,
  FlowMutationResult,
} from "../flow/flow-mutation-service";
import type { SubflowBreadcrumbRepository } from "../flow/subflow-breadcrumbs";
import type {
  CreateModerationReportInput,
  ModerationQueueQuery,
  ModerationReportRecord,
  UpdateModerationReportInput,
} from "../moderation/types";
import type { ProspectRecord } from "../company/prospect-engine/contracts";

export interface FlowRecord {
  id: string;
  ownerId: string;
  name: string;
  graph: SupportedFlowGraph;
  updatedAt: number;
}

export interface AgentRecord {
  id: string;
  flowId: string;
  slug: string;
  status: "draft" | "live";
  priceUsdc: number;
  createdAt: number;
  settlementLive: boolean;
}

export interface LiveAgentFlowRecord {
  agent: AgentRecord;
  flow: FlowRecord;
}

export interface RunRecord {
  id: string;
  flowId: string;
  agentId: string | null;
  trigger: string;
  status: "running" | "done" | "error";
  totalCostUsdc: number;
  startedAt: number;
  finishedAt: number | null;
  settledAt: string | null;
  /** The exact trigger input this run was started with, or null if it predates this column / none was given. */
  triggerInput: unknown | null;
  /** The exact request-scoped run variables this run was started with, or null. */
  runVariables: unknown | null;
}

export interface RunStepRecord {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  costUsdc: number;
  output: unknown;
  error: string | null;
}

export interface ScheduleRecord {
  id: string;
  agentId: string;
  cron: string;
  enabled: boolean;
  lastRunAt: number | null;
}

export interface WalletRecord {
  ownerId: string;
  address: string;
  network: string;
  label: string | null;
}

export interface RelayEndpointRecord {
  agentId: string;
  url: string;
  secret: string;
  protocolVersion: 1 | 2;
  createdAt: string;
}

/**
 * Proof that a workspace controls a domain its site-drafted agent speaks
 * for. One row per (owner, host); its absence is what keeps a site agent
 * out of the public catalog (see lib/site/verification.ts).
 */
export interface SiteVerificationRecord {
  ownerId: string;
  host: string;
  /** How ownership was proven; currently always "file". */
  method: string;
  verifiedAt: string;
}

export interface SiteVerificationRequirement {
  ownerId: string;
  host: string;
}

export interface WebhookEndpointRecord {
  agentId: string;
  /** SHA-256 digest of the generated secret; doubles as the HMAC key. See src/lib/webhook-auth.ts. */
  secretHash: string;
  createdAt: string;
}

export interface UsageRecord {
  id: string;
  ownerId: string;
  kind: string;
  units: number;
  costUsdc: number;
  createdAt: string;
}

export interface CreditRecord {
  id: string;
  ownerId: string;
  /** Positive for topup, negative for debit. In USDC. */
  deltaUsdc: number;
  reason: string;
  /** Transaction hash for on-chain credits (null for manual/dev credits). */
  tx: string | null;
  createdAt: string;
}

export type StripeRevenueRefundState = "none" | "partial" | "full";

interface StripeRevenueEventBase {
  /** Raw Stripe event id. Stored only inside the private receipt ledger. */
  providerEventId: string;
  /** Raw Stripe PaymentIntent id used to link later refunds to the payment. */
  providerPaymentIntentId: string;
  /** Authoritative provider amount, in the provider currency's minor units. */
  amountTotalCents: number;
  /** Uppercase ISO-4217-style three-letter currency code. */
  currency: string;
  /** Exact provider event time, normalized to an ISO-8601 UTC instant. */
  occurredAt: string;
}

export interface StripeTopupPaymentRevenueInput extends StripeRevenueEventBase {
  kind: "payment";
  ownerId: string;
  /** Raw Checkout Session id. Stored only inside the private receipt ledger. */
  providerCheckoutSessionId: string;
  /** Raw Stripe product/price ids, when the signed event includes them. */
  providerProductId: string | null;
  providerPriceId: string | null;
  terminalStatus: "paid";
  /**
   * Gateway credit granted by the purchase. This may include a committed-use
   * bonus and is deliberately separate from amountTotalCents.
   */
  creditGrantUsdc: number;
}

export interface StripeTopupRefundRevenueInput extends StripeRevenueEventBase {
  kind: "refund";
  /** Raw Stripe Refund id. Stored only inside the private receipt ledger. */
  providerRefundId: string;
  terminalStatus: "succeeded";
}

export type StripeRevenueEventInput =
  | StripeTopupPaymentRevenueInput
  | StripeTopupRefundRevenueInput;

export interface StripeRevenueWriteResult {
  recorded: boolean;
  /** Credit mutation, separate from authoritative provider cash cents. */
  creditDeltaUsdc: number;
  refundState: StripeRevenueRefundState;
}

/**
 * One row per settled x402 agent call, written at settlement time. Records
 * what ACTUALLY routed on-chain — amounts here are facts, not intentions.
 * Today resolvePayout returns a single payTo, so one of creatorUsdc /
 * platformUsdc is the full gross and the other is 0. When split collection
 * lands at settlement, the settle path writes the real split and dashboards
 * sum this table instead of recomputing settled_count × current price (which
 * silently rewrites history when a creator edits their price).
 */
export interface SettlementRecord {
  /** The settled run — one settlement per run, so this is the primary key. */
  runId: string;
  agentId: string;
  /** The creator's owner id (flow owner), denormalized for owner queries. */
  ownerId: string;
  /** Price charged for this call, in USDC, at the moment it settled. */
  grossUsdc: number;
  /** USDC that routed to the creator's wallet in this settlement. */
  creatorUsdc: number;
  /** USDC that routed to the platform wallet in this settlement. */
  platformUsdc: number;
  /** Recipient address of the settled authorization. */
  payTo: string;
  /** Which resolvePayout branch picked the recipient. */
  payoutSource: "creator" | "platform";
  /** Payer address reported by the facilitator (null when not returned). */
  payer: string | null;
  /** On-chain transaction hash (null when the facilitator omits it). */
  tx: string | null;
  createdAt: string;
}

export type Ap2AuthorizationState =
  | "authorized"
  | "settling"
  | "settled"
  | "executing"
  | "completed"
  | "rejected"
  | "failed"
  | "pending_reconciliation";

/** JSON that has already been reduced to the bounded, non-secret AP2 projection. */
export type Ap2SanitizedJson =
  | null
  | boolean
  | number
  | string
  | Ap2SanitizedJson[]
  | { [key: string]: Ap2SanitizedJson };

/** Exact database attestation returned only by the AP2 replay-store v2 schema. */
export const AP2_REPLAY_STORE_ATTESTATION = "ap2-replay-v2" as const;

/**
 * Durable AP2 replay and fulfillment record. This projection deliberately has
 * no field capable of holding a raw mandate, disclosure, checkout JWT,
 * payment signature, authorization header, or request body.
 */
export interface Ap2AuthorizationRecord {
  id: string;
  mandateReference: string;
  /** SHA-256 (or stronger) digest of the payment nonce identity, never the raw nonce. */
  paymentNonceHash: string;
  requestDigest: string;
  issuer: string;
  subjectId: string | null;
  checkoutHash: string;
  agentId: string;
  flowId: string;
  deploymentId: string;
  network: string;
  asset: string;
  /** Exact atomic-unit amount represented as decimal text to avoid numeric precision loss. */
  amountAtomic: string;
  amountMinorUsd: number;
  payeeId: string;
  payTo: string;
  /** Bound x402 payer required to reconcile EIP-3009 authorization state. */
  payer: string;
  state: Ap2AuthorizationState;
  decisionCode: string | null;
  receiptJson: Ap2SanitizedJson | null;
  resultJson: Ap2SanitizedJson | null;
  /** AP2 credential/checkout expiry retained for dispute and cleanup policy. */
  expiresAt: string;
  /** Exact x402 EIP-3009 validBefore bound before settlement. */
  paymentValidBefore: string;
  runId: string | null;
  tx: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReserveAp2AuthorizationInput = Omit<
  Ap2AuthorizationRecord,
  | "id"
  | "state"
  | "decisionCode"
  | "receiptJson"
  | "resultJson"
  | "runId"
  | "tx"
  | "createdAt"
  | "updatedAt"
>;

export type ReserveAp2AuthorizationResult =
  | { status: "reserved"; authorization: Ap2AuthorizationRecord }
  | { status: "exact-retry"; authorization: Ap2AuthorizationRecord }
  | { status: "conflict"; authorization: Ap2AuthorizationRecord | null };

export interface TransitionAp2AuthorizationInput {
  id: string;
  fromState: Ap2AuthorizationState;
  toState: Ap2AuthorizationState;
  decisionCode?: string | null;
  receiptJson?: Ap2SanitizedJson | null;
  resultJson?: Ap2SanitizedJson | null;
  runId?: string | null;
  tx?: string | null;
}

export interface ScrubExpiredAp2TerminalEvidenceInput {
  /** Terminal rows older than this exclusive ISO timestamp are eligible. */
  terminalBefore: string;
  /** Audit marker written into the retained bounded receipt reference. */
  scrubbedAt: string;
  /** Maximum rows changed in this invocation. */
  limit: number;
}

export const AP2_TERMINAL_EVIDENCE_RETENTION_DEFAULT_DAYS = 90;
export const AP2_TERMINAL_EVIDENCE_RETENTION_MIN_DAYS = 7;
export const AP2_TERMINAL_EVIDENCE_RETENTION_MAX_DAYS = 365;
export const AP2_TERMINAL_EVIDENCE_SCRUB_BATCH_LIMIT = 100;

export function resolveAp2TerminalEvidenceRetentionDays(raw: string | undefined): number {
  if (!raw || !/^[1-9]\d{0,2}$/u.test(raw)) {
    return AP2_TERMINAL_EVIDENCE_RETENTION_DEFAULT_DAYS;
  }
  const days = Number(raw);
  return Number.isSafeInteger(days)
    && days >= AP2_TERMINAL_EVIDENCE_RETENTION_MIN_DAYS
    && days <= AP2_TERMINAL_EVIDENCE_RETENTION_MAX_DAYS
    ? days
    : AP2_TERMINAL_EVIDENCE_RETENTION_DEFAULT_DAYS;
}

function ap2AuthorizationMetadata(
  value: Ap2SanitizedJson | null,
): { mode: "direct" | "autonomous"; checkoutReference: string; paymentReference: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const authorization = value.authorization;
  if (typeof authorization !== "object" || authorization === null || Array.isArray(authorization)) {
    return null;
  }
  if (
    authorization.mode !== "direct" && authorization.mode !== "autonomous"
    || typeof authorization.checkoutReference !== "string"
    || authorization.checkoutReference.length < 1
    || typeof authorization.paymentReference !== "string"
    || authorization.paymentReference.length < 1
  ) return null;
  return {
    mode: authorization.mode,
    checkoutReference: authorization.checkoutReference,
    paymentReference: authorization.paymentReference,
  };
}

export function compactExpiredAp2TerminalEvidence(
  value: Ap2SanitizedJson | null,
  scrubbedAt: string,
): Ap2SanitizedJson | null {
  const authorization = ap2AuthorizationMetadata(value);
  if (!authorization || typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const checkoutReceipt = value.checkoutReceipt;
  const receiptReference = typeof checkoutReceipt === "string" && checkoutReceipt.length > 0
    ? {
        kind: "checkout_receipt_sha256",
        value: createHash("sha256").update(checkoutReceipt, "utf8").digest("hex"),
      }
    : {
        kind: "payment_mandate_reference",
        value: authorization.paymentReference,
      };
  return {
    authorization,
    evidenceRetention: {
      status: "expired",
      scrubbedAt,
      receiptReference,
    },
  };
}

export function isAp2TerminalEvidenceExpired(value: Ap2SanitizedJson | null): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const retention = value.evidenceRetention;
  return typeof retention === "object"
    && retention !== null
    && !Array.isArray(retention)
    && retention.status === "expired";
}

export function assertValidAp2EvidenceScrubInput(
  input: ScrubExpiredAp2TerminalEvidenceInput,
): void {
  const terminalBefore = Date.parse(input.terminalBefore);
  const scrubbedAt = Date.parse(input.scrubbedAt);
  if (
    !Number.isFinite(terminalBefore)
    || !Number.isFinite(scrubbedAt)
    || new Date(terminalBefore).toISOString() !== input.terminalBefore
    || new Date(scrubbedAt).toISOString() !== input.scrubbedAt
    || terminalBefore >= scrubbedAt
  ) throw new Error("Invalid AP2 evidence retention timestamps");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new Error("Invalid AP2 evidence retention batch limit");
  }
}

const AP2_AUTHORIZATION_TRANSITIONS: Readonly<
  Record<Ap2AuthorizationState, ReadonlySet<Ap2AuthorizationState>>
> = {
  authorized: new Set(["settling", "rejected", "failed"]),
  settling: new Set(["settled", "failed", "pending_reconciliation"]),
  settled: new Set(["executing"]),
  executing: new Set(["completed", "failed", "pending_reconciliation"]),
  completed: new Set(),
  rejected: new Set(),
  failed: new Set(),
  pending_reconciliation: new Set(["settled", "completed", "failed"]),
};

export function isAp2AuthorizationTransitionAllowed(
  fromState: Ap2AuthorizationState,
  toState: Ap2AuthorizationState,
): boolean {
  return AP2_AUTHORIZATION_TRANSITIONS[fromState].has(toState);
}

/** Recorded state of an agent's listing on one external discovery venue. */
export type AgentListingStatus = "submitted" | "listed" | "failed" | "pending";

/**
 * One row per (agent, venue) discovery submission. Records what the studio
 * actually did — a real POST to a free registry, a real GitHub PR/issue URL, or
 * a queued/failed attempt — so the console shows honest, dated submission
 * receipts instead of a marketing claim. Dark-deploy safe: reads return empty
 * and writes are swallowed when the table is absent (see the settlements
 * pattern), never throwing on a missing migration.
 */
export interface AgentListingRecord {
  id: string;
  agentId: string;
  venueId: string;
  status: AgentListingStatus;
  /** External URL the submission produced (a PR/issue link), or null. */
  externalUrl: string | null;
  /** ISO timestamp of the first submission for this (agent, venue) pair. */
  submittedAt: string;
  /** ISO timestamp of the most recent status change. */
  updatedAt: string;
}

export interface UpsertAgentListingInput {
  agentId: string;
  venueId: string;
  status: AgentListingStatus;
  externalUrl?: string | null;
}

export type CompanyActivityStatus = RunRecord["status"] | ApprovalStatus;

/** Stable keyset boundary for the mixed run + approval company ledger. */
export interface CompanyActivityCursor {
  /** Exact adapter timestamp; retained so PostgreSQL sub-millisecond rows do not get skipped. */
  occurredAt: string;
  /** Globally comparable, source-prefixed id (`run:<id>` or `approval:<id>`). */
  id: string;
}

/**
 * A partial employee update. Every field is optional and only the keys
 * actually present are written, so a caller changing a budget never silently
 * rewrites the org chart. The org-chart and heartbeat fields address
 * additive, still-pending columns: on Supabase an explicit write reaches a
 * schema that lacks them and fails loudly rather than dropping the value,
 * which is the same contract payTo already has.
 */
export interface UpdateEmployeeInput {
  jobDescription?: string;
  monthlyBudgetUsdc?: number | null;
  departmentId?: string;
  payTo?: string | null;
  role?: EmployeeRole | null;
  reportsTo?: string | null;
  lifecycleStatus?: EmployeeLifecycleStatus;
  heartbeatEnabled?: boolean;
  heartbeatIntervalSeconds?: number | null;
  lastHeartbeatAt?: string | null;
}

export interface CompanyActivityQuery {
  companyId: string;
  employeeId?: string;
  departmentId?: string;
  status?: CompanyActivityStatus;
  fromMs: number;
  toMs: number;
  cursor?: CompanyActivityCursor;
  /** Requested response size. Adapters read at most limit + 1 per source. */
  limit: number;
}

export interface CompanyActivityRecord {
  id: string;
  kind: "run" | "approval";
  employeeId: string | null;
  departmentId: string | null;
  status: CompanyActivityStatus;
  occurredAt: string;
  trigger: string | null;
  costUsdc: number | null;
  approvalKind: ApprovalKind | null;
  reason: string | null;
  receipt: SettlementRecord | null;
}

export interface CompanyActivityPage {
  records: CompanyActivityRecord[];
  hasMore: boolean;
}

export interface SaveFlowInput {
  id?: string;
  ownerId: string;
  name: string;
  graph: SupportedFlowGraph;
}

export interface CreateAgentInput {
  flowId: string;
  slug: string;
  status?: "draft" | "live";
  priceUsdc?: number;
}

export interface CreateRunInput {
  /** Stable caller-owned identity for payment attempts that must survive replay. */
  id?: string;
  flowId: string;
  agentId?: string | null;
  trigger: string;
  triggerInput?: Record<string, unknown> | null;
  runVariables?: Readonly<Record<string, unknown>> | null;
}

export interface AppendStepInput {
  runId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  costUsdc: number;
  output?: unknown;
  error?: string | null;
}

export interface UpdateAgentInput {
  status?: "draft" | "live";
  priceUsdc?: number;
  settlementLive?: boolean;
}

export interface GuidedFlowMutationInput extends FlowMutationInput {
  priceUsdc: number;
  scheduleCron: string | null;
}

/**
 * One recorded infra health snapshot, written by the hourly cron recorder.
 * No user data — only dependency reachability, latencies, and a timestamp.
 */
export interface RecordHealthCheckInput {
  status: "ok" | "degraded" | "down";
  dbOk: boolean;
  dbLatencyMs: number;
  gatewayOk: boolean;
  gatewayLatencyMs: number;
  facilitatorOk: boolean;
  facilitatorLatencyMs: number;
}

/** Aggregated recorded health over a window. Percentages are computed live by
 *  the caller from these counts — this repo never stores an uptime constant. */
export interface HealthUptimeStats {
  total: number;
  ok: number;
  degraded: number;
  down: number;
  /** ISO timestamp of the earliest check in the window, or null when none. */
  firstAt: string | null;
  /** ISO timestamp of the latest check in the window, or null when none. */
  lastAt: string | null;
  avgDbLatencyMs: number | null;
  avgGatewayLatencyMs: number | null;
  avgFacilitatorLatencyMs: number | null;
}

/** Launched-agent run throughput over a window. Counts + durations only. */
export interface RunOutcomeStats {
  total: number;
  done: number;
  error: number;
  running: number;
  /** Median duration of completed runs in ms, or null when none finished. */
  medianDurationMs: number | null;
  /** Distinct launched agents that ran in the window. */
  agentsLive: number;
}

export type CeoMessageRole = "user" | "assistant";

/** One turn in a company's persistent CEO chat thread. Append-only, ordered by createdAt then id. */
export interface CeoMessageRecord {
  id: string;
  companyId: string;
  role: CeoMessageRole;
  content: string;
  /** Structured action proposal attached to an assistant turn awaiting confirmation, or null. Shape owned by src/lib/company/ceo.ts. */
  proposal: unknown | null;
  createdAt: string;
}

export interface CreateCeoMessageInput {
  companyId: string;
  role: CeoMessageRole;
  content: string;
  proposal?: unknown | null;
}

export interface FlowRepo {
  /** Atomic owner-scoped graph mutation boundary; unsupported adapters omit it and fail closed. */
  mutateFlow?(input: FlowMutationInput): Promise<FlowMutationResult>;
  /** One atomic graph/name/price/schedule mutation for a Guided save. */
  mutateGuidedFlow?(input: GuidedFlowMutationInput): Promise<FlowMutationResult>;
  /** One owner-scoped read transaction validates a complete persisted breadcrumb chain. */
  readSubflowBreadcrumbs?: SubflowBreadcrumbRepository["readSubflowBreadcrumbs"];
  saveFlow(input: SaveFlowInput): Promise<FlowRecord>;
  getFlow(id: string): Promise<FlowRecord | null>;
  /** Bounded collection read for public/catalog surfaces; adapters may fall back to getFlow. */
  listFlowsByIds?(ids: readonly string[]): Promise<FlowRecord[]>;
  /** Owner-filter before graph hydration so foreign malformed rows remain private. */
  getOwnedFlow(id: string, ownerId: string): Promise<FlowRecord | null>;
  listFlows(ownerId: string): Promise<FlowRecord[]>;
  deleteFlow(id: string, ownerId: string): Promise<boolean>;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  getAgent(id: string): Promise<AgentRecord | null>;
  getAgentBySlug(slug: string): Promise<AgentRecord | null>;
  getAgentByFlowId(flowId: string): Promise<AgentRecord | null>;
  updateAgent(id: string, input: UpdateAgentInput): Promise<AgentRecord | null>;
  listLiveAgents(): Promise<AgentRecord[]>;
  /** One fresh relational read for catalog membership, price, and flow graph. */
  listLiveAgentsWithFlows?(): Promise<LiveAgentFlowRecord[]>;
  listAgentsByOwner(ownerId: string): Promise<AgentRecord[]>;
  createRun(input: CreateRunInput): Promise<RunRecord>;
  appendStep(step: AppendStepInput): Promise<void>;
  finishRun(id: string, status: "done" | "error", totalCostUsdc: number): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(flowId: string): Promise<RunRecord[]>;
  listRunsByOwner(ownerId: string, limit: number): Promise<RunRecord[]>;
  countRunsByAgent(agentIds: string[], trigger?: string): Promise<Record<string, number>>;
  listRunSteps(runId: string): Promise<RunStepRecord[]>;
  /** Persist a bounded, reference-only report. No generated content is copied. */
  createModerationReport?(input: CreateModerationReportInput): Promise<ModerationReportRecord>;
  /** Server-side reviewer queue; adapters must never expose this through browser credentials. */
  listModerationReports?(query: ModerationQueueQuery): Promise<ModerationReportRecord[]>;
  /** Reviewer-only status/notes transition. Reports are audit records and are never deleted here. */
  updateModerationReport?(
    id: string,
    input: UpdateModerationReportInput,
  ): Promise<ModerationReportRecord | null>;
  /** One schedule per agent: creates, or replaces cron/enabled in place (lastRunAt survives). */
  upsertSchedule(input: { agentId: string; cron: string; enabled: boolean }): Promise<ScheduleRecord>;
  listSchedulesByAgents(agentIds: string[]): Promise<ScheduleRecord[]>;
  dueSchedules(now: number): Promise<ScheduleRecord[]>;
  markScheduleRun(id: string, at: number): Promise<void>;
  getWallet(ownerId: string): Promise<WalletRecord | null>;
  /** Bounded collection read for public/catalog surfaces; adapters may fall back to getWallet. */
  listWalletsByOwners?(ownerIds: readonly string[]): Promise<WalletRecord[]>;
  saveWallet(input: { ownerId: string; address: string; network?: string; label?: string }): Promise<WalletRecord>;
  /** One relay per agent: select-then-write (upsert pattern same as upsertSchedule). */
  upsertRelayEndpoint(input: {
    agentId: string;
    url: string;
    secret: string;
    protocolVersion?: 1 | 2;
  }): Promise<RelayEndpointRecord>;
  getRelayEndpoint(agentId: string): Promise<RelayEndpointRecord | null>;
  /**
   * Domain-ownership proof for site-drafted agents. Optional so adapters and
   * test fakes without the table fail CLOSED: a missing method or missing
   * row both read as "unverified", which keeps the agent unlisted — never
   * the other way around.
   */
  upsertSiteVerification?(input: { ownerId: string; host: string; method: string }): Promise<SiteVerificationRecord>;
  getSiteVerification?(ownerId: string, host: string): Promise<SiteVerificationRecord | null>;
  /**
   * Fresh collection read for the public catalog. Implementations must return
   * only exact requested owner/host pairs; the catalog never caches this proof.
   */
  listSiteVerificationsByOwnersAndHosts?(
    requirements: readonly SiteVerificationRequirement[],
  ): Promise<SiteVerificationRecord[]>;
  /**
   * One webhook secret per agent. Only created when none exists yet — the
   * launch route never calls this once a row is present, because the raw
   * secret can't be recovered/reshown after the fact (see webhook-auth.ts).
   */
  upsertWebhookEndpoint(input: { agentId: string; secretHash: string }): Promise<WebhookEndpointRecord>;
  getWebhookEndpoint(agentId: string): Promise<WebhookEndpointRecord | null>;
  /** Revoke (delete) an agent's webhook endpoint row. Returns false when none existed. */
  deleteWebhookEndpoint(agentId: string): Promise<boolean>;
  /** Stamp a run as settled at the given ISO timestamp. */
  stampRunSettled(runId: string, settledAt: string): Promise<void>;
  /**
   * Record the settlement facts for a run. Idempotent on runId — a repeat
   * call for the same run is a no-op, mirroring stampRunSettled. Must never
   * throw on a missing table (dark-deploy safe): the money already moved
   * on-chain, so an accounting write failure is logged, not fatal.
   */
  recordSettlement(input: Omit<SettlementRecord, "createdAt">): Promise<void>;
  /** Fetch the settlement row for a run, or null when none exists. */
  getSettlementByRun(runId: string): Promise<SettlementRecord | null>;
  /**
   * Atomically reserve one mandate and payment-nonce identity before
   * facilitator access. Storage failures throw: callers must fail closed.
   */
  reserveAp2Authorization(
    input: ReserveAp2AuthorizationInput,
  ): Promise<ReserveAp2AuthorizationResult>;
  /** Exact replay lookup. Storage failures throw rather than resembling a miss. */
  getAp2AuthorizationByMandateReference(
    mandateReference: string,
  ): Promise<Ap2AuthorizationRecord | null>;
  /** Atomic compare-and-set transition. Null means the expected state lost the race. */
  transitionAp2Authorization(
    input: TransitionAp2AuthorizationInput,
  ): Promise<Ap2AuthorizationRecord | null>;
  /**
   * Scrub bounded terminal response payloads without deleting replay,
   * settlement, state, run, transaction, or receipt-reference facts.
   */
  scrubExpiredAp2TerminalEvidence(
    input: ScrubExpiredAp2TerminalEvidenceInput,
  ): Promise<number>;
  /** Non-mutating revision and constraint attestation for the durable AP2 replay store. */
  checkAp2ReplayStoreReady(): Promise<boolean>;
  /**
   * List an agent's recorded discovery-venue submissions, newest first.
   * Returns [] when the table is absent (dark-deploy safe).
   */
  listAgentListings(agentId: string): Promise<AgentListingRecord[]>;
  /**
   * Record (or update) an agent's submission status on one venue. Idempotent
   * on (agentId, venueId): a repeat upsert refreshes status/externalUrl and
   * updatedAt while preserving the original submittedAt. Never throws on a
   * missing table — it returns the in-memory record and logs the write failure.
   */
  upsertAgentListing(input: UpsertAgentListingInput): Promise<AgentListingRecord>;
  /** Write a usage row for gateway metering. */
  createUsage(input: { ownerId: string; kind: string; units: number; costUsdc: number }): Promise<UsageRecord>;
  /** Sum usage units for an owner within the current calendar month (UTC). */
  sumMonthlyUsage(ownerId: string, kind: string): Promise<number>;
  /** Count settled runs per agent and sum the creator payout using priceUsdc × (1 - PLATFORM_TAKE_RATE). */
  countSettledRunsByAgent(agentIds: string[]): Promise<Record<string, number>>;
  /**
   * Most recent runs.started_at per agent (ms epoch), one bulk
   * MAX(started_at) GROUP BY agent_id query, optionally filtered by trigger
   * (the catalog passes "agent" so recency reflects external calls only).
   * Optional so adapters and test fakes without it fail closed: absence
   * reads as "no recorded calls", never a fabricated timestamp.
   */
  lastAgentCallAt?(
    agentIds: string[],
    trigger?: string,
  ): Promise<Record<string, number>>;
  /**
   * Sum total_cost_usdc across all runs for `agentId` with started_at >=
   * `sinceMs` (ms epoch). Durable, DB-backed usage figure — unlike the
   * in-memory rate limiter, this survives across serverless instances, so
   * it is the source of truth for the per-agent daily cost cap.
   */
  sumAgentCostSince(agentId: string, sinceMs: number): Promise<number>;
  /** Write a credit row (positive = topup, negative = debit). */
  createCredit(input: { ownerId: string; deltaUsdc: number; reason: string; tx?: string | null }): Promise<CreditRecord>;
  /**
   * Atomically append one verified Stripe payment/refund receipt and its
   * corresponding credit mutation. Idempotency is enforced by provider
   * transaction ids inside the private ledger; raw provider ids never enter
   * the public credits table or the return value.
   */
  recordStripeRevenueEvent(input: StripeRevenueEventInput): Promise<StripeRevenueWriteResult>;
  /**
   * Does this workspace retain payment evidence?
   *
   * Distinct from `getCreditBalance`: spending paid credit does not revoke the
   * signal, but a full provider refund does. It is the entitlement behind the
   * free monthly allowance (see gateway/eligibility.ts) and the site-agent
   * model refinement. Optional so adapters and test fakes without it fail
   * CLOSED — absent means "hasn't paid", never the reverse.
   */
  hasEverPaid?(ownerId: string): Promise<boolean>;
  /** Sum all credit deltas for an owner. Returns 0 when table absent (dark-deploy safe). */
  getCreditBalance(ownerId: string): Promise<number>;
  /**
   * Look up an existing credit row by its owner-scoped tx reference, such as
   * an on-chain settlement hash. No unique DB constraint backs this generic
   * lookup, so callers must not treat it as a concurrency guarantee. Stripe
   * idempotency instead belongs to `recordStripeRevenueEvent`, whose private
   * ledger has provider-identity constraints and stores only an internal
   * `stripe-receipt:<uuid>` reference in credits.
   */
  getCreditByTx(ownerId: string, tx: string): Promise<CreditRecord | null>;
  /**
   * Return the promo-node output from the most recent successful run of the
   * given agent, or null when no such run/output exists.
   * Shape mirrors what the suede.promo node emits: { campaignId, campaignUrl, name }.
   */
  getLastPromoOutput(agentId: string): Promise<{ campaignId: string; campaignUrl: string; name: string } | null>;
  // ── Company domain (Autonomous Company layer) ───────────────────────────
  createCompany(input: { ownerId: string; name: string; mission: string }): Promise<CompanyRecord>;
  getCompany(id: string): Promise<CompanyRecord | null>;
  listCompaniesByOwner(ownerId: string): Promise<CompanyRecord[]>;
  updateCompany(
    id: string,
    input: { name?: string; mission?: string; status?: CompanyStatus; fireCostThresholdUsdc?: number | null },
  ): Promise<CompanyRecord | null>;
  createDepartment(input: { companyId: string; name: string; monthlyBudgetUsdc?: number | null }): Promise<DepartmentRecord>;
  listDepartments(companyId: string): Promise<DepartmentRecord[]>;
  setDepartmentBudget(id: string, monthlyBudgetUsdc: number | null): Promise<void>;
  /** Idempotent on agentId — a repeat add is a no-op. */
  addEmployee(input: EmployeeRecord): Promise<void>;
  /** Active company employees only. Former employees remain persisted for audit history. */
  listEmployees(companyId: string): Promise<EmployeeRecord[]>;
  /** Active and removed employees, for owner-scoped historical reconstruction only. */
  listCompanyEmployeeHistory(companyId: string): Promise<EmployeeRecord[]>;
  getEmployeeByAgent(agentId: string): Promise<EmployeeRecord | null>;
  /** Soft-removes membership so company run history retains employee identity. */
  removeEmployee(agentId: string): Promise<boolean>;
  updateEmployee(agentId: string, input: UpdateEmployeeInput): Promise<void>;
  createApproval(input: CreateApprovalInput): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  listApprovals(companyId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]>;
  /**
   * Mixed company run/approval ledger in stable keyset order. Historical
   * memberships are included so removing an employee never erases attribution.
   */
  listCompanyActivity(input: CompanyActivityQuery): Promise<CompanyActivityPage>;
  /** Append one CEO chat turn (user or assistant). */
  appendCeoMessage(input: CreateCeoMessageInput): Promise<CeoMessageRecord>;
  /** The most recent `limit` CEO chat turns for a company, returned oldest-first. */
  listCeoMessages(companyId: string, limit: number): Promise<CeoMessageRecord[]>;
  /** pending → approved|rejected only; returns null when not pending. */
  decideApproval(id: string, decision: "approved" | "rejected", reason?: string | null): Promise<ApprovalRecord | null>;
  /** approved → consumed only; returns false otherwise. One fire per approval. */
  consumeApproval(id: string): Promise<boolean>;
  /**
   * consumed → approved only. Compensation for a guarded action that did
   * not complete after this request atomically won approval consumption.
   */
  restoreApproval(id: string): Promise<boolean>;
  /**
   * Sum runs.total_cost_usdc for these agents with started_at >= sinceMs
   * and, when untilMs is given, started_at < untilMs (books window bound).
   */
  sumCostByAgents(agentIds: string[], sinceMs: number, untilMs?: number): Promise<number>;
  /** Settlements rows for these agents in [fromIso, toIso), newest first. */
  listSettlementsByAgents(agentIds: string[], fromIso: string, toIso: string): Promise<SettlementRecord[]>;

  /**
   * Re-own every owner-scoped row (flows, usage, credits, and — when the
   * target has none — the wallet) from `fromOwnerId` to `toOwnerId`.
   * Idempotent: once moved, a repeat call matches zero rows. When both
   * owners hold a wallet, the source wallet row is left in place (never
   * deleted — it may map to funds) and simply becomes unreachable.
   */
  adoptOwner(fromOwnerId: string, toOwnerId: string): Promise<void>;
  /**
   * Cheap datastore liveness probe: resolves on a trivial query, rejects when
   * the datastore is unreachable. Non-mutating; used only by the health surface
   * (src/lib/health.ts).
   */
  ping(): Promise<void>;
  /**
   * Append one infra health snapshot. Append-only and dark-deploy safe: a
   * missing health_checks table (migration pending) is swallowed, not fatal,
   * mirroring recordSettlement. No user data, only infra timestamps.
   */
  recordHealthCheck(input: RecordHealthCheckInput): Promise<void>;
  /**
   * Aggregate recorded health checks with checked_at >= sinceMs into counts,
   * window bounds, and average latencies. Returns zeroed stats when the table
   * is absent (dark-deploy safe). The caller computes availability live from
   * these counts — never a stored uptime constant.
   */
  getHealthUptime(sinceMs: number): Promise<HealthUptimeStats>;
  /**
   * Launched-agent run outcomes (agent_id IS NOT NULL) with started_at >=
   * sinceMs: status counts, median completed-run duration, and distinct active
   * agents. Counts + durations only — no owner_id, outputs, or PII. Presented
   * as throughput, never a graded success rate.
   */
  getRunOutcomeStats(sinceMs: number): Promise<RunOutcomeStats>;
  /** Private, owner-scoped Prospect Engine records. */
  createProspect(record: ProspectRecord): Promise<ProspectRecord>;
  getProspect(id: string, ownerId: string): Promise<ProspectRecord | null>;
  listProspects(ownerId: string): Promise<ProspectRecord[]>;
  updateProspect(record: ProspectRecord, expectedRevision: number): Promise<ProspectRecord | null>;
  updateProspectUnlessSuppressed(record: ProspectRecord, expectedRevision: number, emailDigest: string): Promise<ProspectRecord | null>;
  isProspectRecipientSuppressed(ownerId: string, emailDigest: string): Promise<boolean>;
  optOutProspect(record: ProspectRecord, expectedRevision: number, emailDigest: string): Promise<ProspectRecord | null>;
  suppressProspect(record: ProspectRecord, expectedRevision: number, emailDigest: string, reason: "opt-out" | "operator"): Promise<ProspectRecord | null>;
  redactProspect(id: string, ownerId: string): Promise<boolean>;
}

let cached: FlowRepo | null = null;

/** Returns the repo for the configured driver (DB_DRIVER=sqlite|supabase). */
export async function getRepo(): Promise<FlowRepo> {
  if (cached) return cached;
  const driver = process.env.DB_DRIVER ?? "sqlite";
  if (driver === "supabase") {
    const { SupabaseRepo } = await import("./supabase-repo");
    cached = new SupabaseRepo();
  } else {
    const { SqliteRepo } = await import("./sqlite-repo");
    cached = new SqliteRepo(process.env.SQLITE_PATH ?? "studio.db");
  }
  return cached;
}
