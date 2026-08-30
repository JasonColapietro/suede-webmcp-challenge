/** better-sqlite3 implementation of FlowRepo — the zero-dependency dev default. */
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { filterDue, parseCron } from "../cron";
import { parsePromoOutput } from "../promo-output";
import { parseSupportedFlowGraph } from "../flow/graph-schema";
import { isFlowGraphV2 } from "../flow/graph-schema";
import {
  hashCallableInterface,
  normalizeSubflowReference,
} from "../flow/subflow-reference";
import type {
  FlowImpactDependent,
  FlowMutationInput,
  FlowMutationResult,
} from "../flow/flow-mutation-service";
import { mutationValueWithinBudget } from "../flow/flow-mutation-service";
import type {
  FlowCallableInterface,
  SupportedFlowGraph,
  SubflowReference,
} from "../flow/types";
import type {
  SubflowApiRepository,
  SubflowCandidate,
  SubflowDependentProjection,
  SubflowResolveProjection,
  SubflowVersionProjection,
} from "../flow/subflow-api";
import type {
  SubflowBreadcrumb,
  SubflowBreadcrumbRepository,
} from "../flow/subflow-breadcrumbs";
import { hashFlowGraph } from "../projects/hash";
import { DEPENDENCY_KINDS, type DependencyPinInput } from "../projects/types";
import { isAp2ReplayStoreAttested, runSqliteMigrations } from "./migrations/sqlite";
import {
  assertValidAp2EvidenceScrubInput,
  compactExpiredAp2TerminalEvidence,
  isAp2AuthorizationTransitionAllowed,
  isAp2TerminalEvidenceExpired,
} from "./repo";
import type {
  AgentListingRecord,
  AgentRecord,
  Ap2AuthorizationRecord,
  Ap2SanitizedJson,
  AppendStepInput,
  CeoMessageRecord,
  CeoMessageRole,
  CompanyActivityPage,
  CompanyActivityQuery,
  CompanyActivityRecord,
  CreateAgentInput,
  CreateCeoMessageInput,
  CreateRunInput,
  CreditRecord,
  FlowRecord,
  FlowRepo,
  HealthUptimeStats,
  RecordHealthCheckInput,
  ReserveAp2AuthorizationInput,
  ReserveAp2AuthorizationResult,
  RunOutcomeStats,
  RunRecord,
  RunStepRecord,
  SaveFlowInput,
  ScheduleRecord,
  SettlementRecord,
  StripeRevenueEventInput,
  StripeRevenueRefundState,
  StripeRevenueWriteResult,
  ScrubExpiredAp2TerminalEvidenceInput,
  TransitionAp2AuthorizationInput,
  UpdateAgentInput,
  UpdateEmployeeInput,
  UpsertAgentListingInput,
  UsageRecord,
  WalletRecord,
} from "./repo";
import type {
  CreateModerationReportInput,
  ModerationQueueQuery,
  ModerationReportRecord,
  ModerationReason,
  ModerationStatus,
  ModerationSubjectType,
  UpdateModerationReportInput,
} from "../moderation/types";
import type {
  ApprovalKind,
  ApprovalCostSnapshot,
  ApprovalRecord,
  ApprovalStatus,
  CompanyRecord,
  CompanyStatus,
  CreateApprovalInput,
  DepartmentRecord,
  EmployeeRecord,
} from "../company/types";
import { parseEmployeeRole, parseLifecycleStatus } from "../company/roles";
import {
  ProspectRecordSchema,
  type ProspectRecord,
} from "../company/prospect-engine/contracts";
import { validateProspectIntegrity } from "../company/prospect-engine/engine";

const IMPACT_RECEIPT_TTL_MS = 5 * 60 * 1_000;
const MAX_IMPACT_SUMMARY = 50;
const NO_INTERFACE_HASH = "none";
const MAX_MUTATION_DFS_DEPTH = 64;
const MAX_MUTATION_DFS_GRAPHS = 256;
const MAX_MUTATION_DFS_NODES = 20_000;
const MAX_MUTATION_DFS_EDGES = 40_000;
const MAX_MUTATION_GRAPH_BYTES = 2 * 1024 * 1024;
const MAX_MUTATION_DFS_BYTES = 16 * 1024 * 1024;
const MAX_MUTATION_DFS_REFERENCES = 1_000;
const MAX_MUTATION_VERSION_PINS = 1_000;
const MAX_MUTATION_VERSION_PIN_BYTES = 1024 * 1024;
const MAX_MUTATION_DFS_PINS = 2_000;
const MAX_MUTATION_DFS_PIN_BYTES = 2 * 1024 * 1024;
const MAX_IMPACT_SCAN_FLOWS = 1_000;
const MAX_IMPACT_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_IMPACT_SCAN_NAME_BYTES = 1024 * 1024;
const MAX_IMPACT_SCAN_NODES = 100_000;
const MAX_IMPACT_SCAN_EDGES = 200_000;
const MAX_IMPACT_RESPONSE_BYTES = 64 * 1024;
const MAX_PUBLIC_INTERFACE_BYTES = 64 * 1024;
const MAX_PUBLIC_PAGE_BYTES = 256 * 1024;
const MAX_PUBLIC_PAGE_PROJECTION_BYTES = MAX_PUBLIC_PAGE_BYTES - 4 * 1024;
const MAX_SUBFLOW_API_VERSION_ROWS = 4_096;
const dependencyKinds = new Set<string>(DEPENDENCY_KINDS);
const CREDIT_PRECISION = 8;

interface SqliteStripeRevenueReceiptRow {
  id: string;
  kind: "payment" | "refund";
  owner_id: string;
  provider_event_id: string;
  provider_checkout_session_id: string | null;
  provider_payment_intent_id: string;
  provider_refund_id: string | null;
  amount_total_cents: number;
  currency: string;
  terminal_status: "paid" | "succeeded";
  refund_state: StripeRevenueRefundState;
  provider_product_id: string | null;
  provider_price_id: string | null;
  occurred_at: string;
  source_revision_at: string;
  credit_delta_usdc: number;
  credit_id: string;
  parent_receipt_id: string | null;
}

function roundCredit(value: number): number {
  return Number(value.toFixed(CREDIT_PRECISION));
}

function stripeOccurredAtMs(occurredAt: string): number {
  const milliseconds = Date.parse(occurredAt);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== occurredAt) {
    throw new Error("Invalid Stripe revenue occurrence timestamp");
  }
  return milliseconds;
}

function stripeOwnerAliasResolution(
  db: Database.Database,
  ownerId: string,
): { ownerId: string; depth: number } {
  const seen = new Set<string>([ownerId]);
  let current = ownerId;
  for (let depth = 0; depth <= 31; depth += 1) {
    const row = db
      .prepare(
        `SELECT to_owner_id
         FROM stripe_owner_adoptions
         WHERE from_owner_id = ?`,
      )
      .get(current) as { to_owner_id: string } | undefined;
    if (!row) return { ownerId: current, depth };
    if (depth === 31) {
      throw new Error("Stripe owner adoption chain is too deep");
    }
    if (seen.has(row.to_owner_id)) {
      throw new Error("Stripe owner adoption cycle");
    }
    seen.add(row.to_owner_id);
    current = row.to_owner_id;
  }
  throw new Error("Stripe owner adoption chain is too deep");
}

function resolveStripeOwnerAlias(
  db: Database.Database,
  ownerId: string,
): string {
  return stripeOwnerAliasResolution(db, ownerId).ownerId;
}

function maxStripeOwnerAncestorDepth(
  db: Database.Database,
  ownerId: string,
): number {
  const parentAliases = db.prepare(
    `SELECT from_owner_id
     FROM stripe_owner_adoptions
     WHERE to_owner_id = ?`,
  );
  let maximum = 0;
  const pending: Array<{
    ownerId: string;
    depth: number;
    path: Set<string>;
  }> = [{ ownerId, depth: 0, path: new Set([ownerId]) }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    maximum = Math.max(maximum, current.depth);
    const parents = parentAliases.all(current.ownerId) as Array<{
      from_owner_id: string;
    }>;
    for (const parent of parents) {
      if (current.path.has(parent.from_owner_id)) {
        throw new Error("Stripe owner adoption cycle");
      }
      if (current.depth >= 31) {
        return 32;
      }
      const path = new Set(current.path);
      path.add(parent.from_owner_id);
      pending.push({
        ownerId: parent.from_owner_id,
        depth: current.depth + 1,
        path,
      });
    }
  }
  return maximum;
}

/** Median of a numeric list rounded to whole ms, or null when empty. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(value);
}

type GraphReference =
  | { readonly kind: "legacy"; readonly flowId: string }
  | SubflowReference;

function callableInterfaceOf(graph: SupportedFlowGraph): FlowCallableInterface | undefined {
  return isFlowGraphV2(graph) ? graph.callableInterface : undefined;
}

function safeParsePersistedGraph(raw: unknown): SupportedFlowGraph | null {
  try {
    if (typeof raw !== "string") return null;
    if (Buffer.byteLength(raw, "utf8") > MAX_MUTATION_GRAPH_BYTES) return null;
    const decoded: unknown = JSON.parse(raw);
    if (!mutationValueWithinBudget(decoded)) return null;
    return parseSupportedFlowGraph(decoded);
  } catch {
    return null;
  }
}

function graphReferences(graph: SupportedFlowGraph): GraphReference[] {
  const references: GraphReference[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "subflow" && node.type !== "loop") continue;
    const normalized = normalizeSubflowReference(node.params);
    references.push(normalized.kind === "typed" ? normalized.reference : normalized);
  }
  return references;
}

function referenceReceiptMatches(
  reference: GraphReference,
  graph: SupportedFlowGraph,
  semanticHash?: string,
): boolean {
  if (reference.kind === "legacy") return true;
  const callable = callableInterfaceOf(graph);
  if (!callable || hashCallableInterface(callable) !== reference.interfaceHash) return false;
  return reference.kind !== "pinned" || semanticHash === reference.contentHash;
}

function hashDependentSet(dependents: readonly FlowImpactDependent[]): string {
  const canonical = dependents.map((dependent) => ({
    flowId: dependent.flowId,
    nodeIds: [...dependent.nodeIds].sort(),
  })).sort((left, right) => left.flowId < right.flowId ? -1 : left.flowId > right.flowId ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function boundedImpact(dependents: readonly FlowImpactDependent[]): {
  readonly dependents: readonly FlowImpactDependent[];
  readonly truncated: boolean;
  readonly total: number;
} {
  const projected: FlowImpactDependent[] = [];
  let truncated = dependents.length > MAX_IMPACT_SUMMARY;
  let responseBytes = 0;
  for (const dependent of dependents.slice(0, MAX_IMPACT_SUMMARY)) {
    const safeName = dependent.name.slice(0, 200);
    if (safeName !== dependent.name) truncated = true;
    if (
      dependent.flowId.length > 512 ||
      dependent.nodeIds.length > 50 ||
      dependent.nodeIds.some((nodeId) => nodeId.length > 128)
    ) {
      truncated = true;
      continue;
    }
    const candidate = { flowId: dependent.flowId, name: safeName, nodeIds: dependent.nodeIds };
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (responseBytes + candidateBytes > MAX_IMPACT_RESPONSE_BYTES) {
      truncated = true;
      continue;
    }
    projected.push(candidate);
    responseBytes += candidateBytes;
  }
  return {
    dependents: projected,
    truncated,
    total: dependents.length,
  };
}

function projectPublicInterface(graph: SupportedFlowGraph): {
  readonly interface: FlowCallableInterface;
  readonly interfaceHash: string;
} | null {
  const callable = callableInterfaceOf(graph);
  if (!callable || callable.inputs.length > 64 || callable.outputs.length > 64) return null;
  const encoded = JSON.stringify(callable);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PUBLIC_INTERFACE_BYTES) return null;
  const pending: Array<{ value: unknown; depth: number }> = [
    ...callable.inputs.map((port) => ({ value: port.schema, depth: 0 })),
    ...callable.outputs.map((port) => ({ value: port.schema, depth: 0 })),
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 2_048 || current.depth > 24) return null;
    if (current.value !== null && typeof current.value === "object") {
      for (const value of Object.values(current.value)) {
        pending.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return { interface: callable, interfaceHash: hashCallableInterface(callable) };
}

export class SqliteRepo implements FlowRepo {
  private readonly db: Database.Database;

  constructor(path: string | Database.Database = "studio.db") {
    if (typeof path !== "string") {
      this.db = path;
      return;
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    runSqliteMigrations(this.db);
  }

  async mutateFlow(input: FlowMutationInput): Promise<FlowMutationResult> {
    const mutate = this.db.transaction(() => this.mutateFlowInCurrentTransaction(input));
    return mutate.immediate();
  }

  async mutateGuidedFlow(
    input: import("./repo").GuidedFlowMutationInput,
  ): Promise<FlowMutationResult> {
    if (
      !Number.isFinite(input.priceUsdc) || input.priceUsdc < 0 ||
      (input.scheduleCron !== null && parseCron(input.scheduleCron) === null)
    ) return { status: "invalid-reference" };
    const mutate = this.db.transaction(() => {
      const result = this.mutateFlowInCurrentTransaction(input);
      if (result.status !== "saved") return result;
      const agent = this.db
        .prepare(`SELECT id FROM agents WHERE flow_id = ? ORDER BY created_at ASC LIMIT 1`)
        .get(result.flow.id) as { id: string } | undefined;
      if (!agent) return result;
      this.db.prepare(`UPDATE agents SET price_usdc = ? WHERE id = ?`)
        .run(input.priceUsdc, agent.id);
      const schedule = this.db
        .prepare(`SELECT id FROM schedules WHERE agent_id = ? ORDER BY id ASC LIMIT 1`)
        .get(agent.id) as { id: string } | undefined;
      if (input.scheduleCron !== null) {
        if (schedule) {
          this.db.prepare(`UPDATE schedules SET cron = ? WHERE id = ?`)
            .run(input.scheduleCron, schedule.id);
        } else {
          this.db
            .prepare(`INSERT INTO schedules (id, agent_id, cron, enabled, last_run_at) VALUES (?, ?, ?, 0, NULL)`)
            .run(randomUUID(), agent.id, input.scheduleCron);
        }
      } else if (schedule) {
        this.db.prepare(`UPDATE schedules SET enabled = 0 WHERE id = ?`).run(schedule.id);
      }
      return result;
    });
    return mutate.immediate();
  }

  /** Shared synchronous core for a caller that already owns this connection's transaction. */
  mutateFlowInCurrentTransaction(input: FlowMutationInput): FlowMutationResult {
    if (!this.db.inTransaction) throw new Error("Flow mutation requires an open SQLite transaction");
    if (
      !mutationValueWithinBudget(input.graph) ||
      typeof input.name !== "string" ||
      typeof input.ownerId !== "string" ||
      (input.id !== undefined && typeof input.id !== "string") ||
      (input.createOnly !== undefined && typeof input.createOnly !== "boolean") ||
      (input.expectedUpdatedAt !== undefined &&
        (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt < 0)) ||
      (input.impactReceipt !== undefined && typeof input.impactReceipt !== "string") ||
      input.name.length < 1 || input.name.trim() !== input.name || Buffer.byteLength(input.name, "utf8") > 200 ||
      input.ownerId.length < 1 || input.ownerId.length > 512 ||
      (input.id !== undefined && (input.id.length < 1 || input.id.length > 512)) ||
      (input.createOnly === true && (input.id === undefined || input.mustExist === true)) ||
      (input.expectedUpdatedAt !== undefined && input.id === undefined) ||
      (input.impactReceipt !== undefined && (input.impactReceipt.length < 32 || input.impactReceipt.length > 256))
    ) {
      return { status: "invalid-reference" };
    }
    let acceptedGraph: SupportedFlowGraph;
    try {
      acceptedGraph = parseSupportedFlowGraph(input.graph);
    } catch {
      return { status: "invalid-reference" };
    }
    input = { ...input, graph: acceptedGraph };
    const id = input.id ?? randomUUID();
    const existing = this.db
        .prepare("SELECT * FROM flows WHERE id = ? AND owner_id = ?")
        .get(id, input.ownerId) as Record<string, unknown> | undefined;
      if (input.mustExist && !existing) return { status: "not-found" };
      if (input.createOnly && existing) return { status: "conflict" };
      if (input.expectedUpdatedAt !== undefined) {
        if (!existing) return { status: "conflict" };
        if (Number(existing.updated_at) !== input.expectedUpdatedAt) {
          return { status: "conflict" };
        }
      }

      const validation = this.validateFlowReferenceClosure({
        rootFlowId: id,
        ownerId: input.ownerId,
        proposedRoot: input.graph,
      });
      if (validation.status !== "valid") return validation;

      const existingGraph = existing ? safeParsePersistedGraph(existing.graph) : null;
      if (existing && !existingGraph) return { status: "invalid-reference" };
      if (input.validateOnly) {
        if (!existing || !existingGraph) return { status: "not-found" };
        if (
          input.impactReceipt !== undefined ||
          input.name !== existing.name ||
          JSON.stringify(input.graph) !== JSON.stringify(existingGraph)
        ) return { status: "conflict" };
        return {
          status: "saved",
          flow: {
            id,
            ownerId: input.ownerId,
            name: existing.name as string,
            graph: existingGraph,
            updatedAt: existing.updated_at as number,
          },
        };
      }
      const oldInterface = existingGraph ? callableInterfaceOf(existingGraph) : undefined;
      const proposedInterface = callableInterfaceOf(input.graph);
      const oldHash = oldInterface ? hashCallableInterface(oldInterface) : null;
      const proposedHash = proposedInterface ? hashCallableInterface(proposedInterface) : null;

      if (existing && oldHash !== proposedHash) {
        const dependents = this.scanTypedDependents(input.ownerId, id);
        if (dependents === null) return { status: "invalid-reference" };
        if (dependents.length > 0) {
          const dependentSetHash = hashDependentSet(dependents);
          if (!input.impactReceipt) {
            const issuedAt = Date.now();
            const active = this.db.prepare(
              `SELECT id, issued_at, expires_at FROM subflow_impact_receipts
               WHERE owner_id = ? AND child_flow_id = ?
                 AND old_interface_hash = ? AND proposed_interface_hash = ?
                 AND dependent_set_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
            ).get(
              input.ownerId,
              id,
              oldHash ?? NO_INTERFACE_HASH,
              proposedHash ?? NO_INTERFACE_HASH,
              dependentSetHash,
              issuedAt,
            ) as Record<string, unknown> | undefined;
            if (
              active &&
              Number(active.expires_at) === Number(active.issued_at) + IMPACT_RECEIPT_TTL_MS
            ) {
              return {
                status: "impact-required",
                receipt: active.id as string,
                impact: boundedImpact(dependents),
              };
            }
            const receipt = randomBytes(32).toString("base64url");
            this.db.prepare(
              `INSERT INTO subflow_impact_receipts
                 (id, owner_id, child_flow_id, old_interface_hash, proposed_interface_hash,
                  dependent_set_hash, issued_at, expires_at, consumed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
               ON CONFLICT(owner_id, child_flow_id) DO UPDATE SET
                 id = excluded.id,
                 old_interface_hash = excluded.old_interface_hash,
                 proposed_interface_hash = excluded.proposed_interface_hash,
                 dependent_set_hash = excluded.dependent_set_hash,
                 issued_at = excluded.issued_at,
                 expires_at = excluded.expires_at,
                 consumed_at = NULL`,
            ).run(
              receipt,
              input.ownerId,
              id,
              oldHash ?? NO_INTERFACE_HASH,
              proposedHash ?? NO_INTERFACE_HASH,
              dependentSetHash,
              issuedAt,
              issuedAt + IMPACT_RECEIPT_TTL_MS,
            );
            return {
              status: "impact-required",
              receipt,
              impact: boundedImpact(dependents),
            };
          }

          const receipt = this.db.prepare(
            `SELECT * FROM subflow_impact_receipts
             WHERE id = ? AND owner_id = ? AND child_flow_id = ?`,
          ).get(input.impactReceipt, input.ownerId, id) as Record<string, unknown> | undefined;
          const now = Date.now();
          const issuedAt = Number(receipt?.issued_at);
          const expiresAt = Number(receipt?.expires_at);
          if (
            !receipt || receipt.consumed_at !== null ||
            !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
            issuedAt > now || expiresAt !== issuedAt + IMPACT_RECEIPT_TTL_MS || expiresAt <= now ||
            boundedImpact(dependents).truncated ||
            receipt.old_interface_hash !== (oldHash ?? NO_INTERFACE_HASH) ||
            receipt.proposed_interface_hash !== (proposedHash ?? NO_INTERFACE_HASH) ||
            receipt.dependent_set_hash !== dependentSetHash
          ) {
            return { status: "conflict" };
          }
          const consumed = this.db.prepare(
            `UPDATE subflow_impact_receipts SET consumed_at = ?
             WHERE id = ? AND owner_id = ? AND child_flow_id = ?
               AND old_interface_hash = ? AND proposed_interface_hash = ?
               AND dependent_set_hash = ? AND issued_at = ? AND expires_at = ?
               AND expires_at > ? AND consumed_at IS NULL`,
          ).run(
            now,
            input.impactReceipt,
            input.ownerId,
            id,
            oldHash ?? NO_INTERFACE_HASH,
            proposedHash ?? NO_INTERFACE_HASH,
            dependentSetHash,
            issuedAt,
            expiresAt,
            now,
          );
          if (consumed.changes !== 1) return { status: "conflict" };
        } else if (input.impactReceipt) {
          return { status: "conflict" };
        }
      } else if (input.impactReceipt) {
        return { status: "conflict" };
      }

      const updatedAt = existing
        ? Math.max(Date.now(), Number(existing.updated_at) + 1)
        : Date.now();
      if (existing) {
        const updated = input.expectedUpdatedAt === undefined
          ? this.db.prepare(
              "UPDATE flows SET name = ?, graph = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
            ).run(input.name, JSON.stringify(input.graph), updatedAt, id, input.ownerId)
          : this.db.prepare(
              `UPDATE flows SET name = ?, graph = ?, updated_at = ?
               WHERE id = ? AND owner_id = ? AND updated_at = ?`,
            ).run(
              input.name,
              JSON.stringify(input.graph),
              updatedAt,
              id,
              input.ownerId,
              input.expectedUpdatedAt,
            );
        if (updated.changes !== 1) return { status: "conflict" };
      } else {
        const inserted = input.createOnly
          ? this.db.prepare(
              `INSERT INTO flows (id, owner_id, name, graph, updated_at)
               VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
            ).run(id, input.ownerId, input.name, JSON.stringify(input.graph), updatedAt)
          : this.db.prepare(
              "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run(id, input.ownerId, input.name, JSON.stringify(input.graph), updatedAt);
        if (inserted.changes !== 1) return { status: "conflict" };
      }
    return {
      status: "saved",
      flow: { id, ownerId: input.ownerId, name: input.name, graph: input.graph, updatedAt },
    };
  }

  private validateFlowReferenceClosure(input: {
    readonly rootFlowId: string;
    readonly ownerId: string;
    readonly proposedRoot: SupportedFlowGraph;
  }): FlowMutationResult | { readonly status: "valid" } {
    const visited = new Set<string>();
    const resolvedReferences = new Map<string, Extract<
      ReturnType<SqliteRepo["resolveOwnedReference"]>,
      { readonly status: "resolved" }
    >>();
    let graphCount = 0;
    let nodeCount = 0;
    let edgeCount = 0;
    let byteCount = 0;
    let referenceCount = 0;
    let pinCount = 0;
    let pinBytes = 0;
    const visit = (
      flowId: string,
      graph: SupportedFlowGraph,
      ancestry: readonly string[],
      graphKey: string,
      graphBytes: number,
    ): FlowMutationResult | { readonly status: "valid" } => {
      if (ancestry.length > MAX_MUTATION_DFS_DEPTH) return { status: "invalid-reference" };
      if (visited.has(graphKey)) return { status: "valid" };
      graphCount += 1;
      nodeCount += graph.nodes.length;
      edgeCount += graph.edges.length;
      byteCount += graphBytes;
      if (
        graphCount > MAX_MUTATION_DFS_GRAPHS ||
        nodeCount > MAX_MUTATION_DFS_NODES ||
        edgeCount > MAX_MUTATION_DFS_EDGES ||
        byteCount > MAX_MUTATION_DFS_BYTES
      ) return { status: "invalid-reference" };
      let references: GraphReference[];
      try {
        references = graphReferences(graph);
      } catch {
        return { status: "invalid-reference" };
      }
      for (const reference of references) {
        referenceCount += 1;
        if (referenceCount > MAX_MUTATION_DFS_REFERENCES) return { status: "invalid-reference" };
        if (ancestry.includes(reference.flowId)) {
          return { status: "cycle", flowIds: [...ancestry, reference.flowId] };
        }
        const resolutionKey = reference.kind === "pinned"
          ? JSON.stringify(["pinned", reference.flowId, reference.versionId])
          : JSON.stringify(["draft", reference.flowId]);
        let resolved = resolvedReferences.get(resolutionKey);
        if (!resolved) {
          const loaded = this.resolveOwnedReference(input.ownerId, reference);
          if (loaded.status !== "resolved") return loaded.result;
          pinCount += loaded.pinCount;
          pinBytes += loaded.pinBytes;
          if (pinCount > MAX_MUTATION_DFS_PINS || pinBytes > MAX_MUTATION_DFS_PIN_BYTES) {
            return { status: "invalid-reference" };
          }
          resolved = loaded;
          resolvedReferences.set(resolutionKey, loaded);
        }
        if (resolved.graph) {
          const nested = visit(
            reference.flowId,
            resolved.graph,
            [...ancestry, reference.flowId],
            resolutionKey,
            resolved.byteLength,
          );
          if (nested.status !== "valid") return nested;
        }
        if (resolved.graph && !referenceReceiptMatches(reference, resolved.graph, resolved.semanticHash)) {
          return { status: "invalid-reference" };
        }
      }
      visited.add(graphKey);
      return { status: "valid" };
    };
    return visit(
      input.rootFlowId,
      input.proposedRoot,
      [input.rootFlowId],
      JSON.stringify(["root", input.rootFlowId]),
      Buffer.byteLength(JSON.stringify(input.proposedRoot), "utf8"),
    );
  }

  private resolveOwnedReference(
    ownerId: string,
    reference: GraphReference,
  ):
    | {
        readonly status: "resolved";
        readonly graph: SupportedFlowGraph | null;
        readonly semanticHash?: string;
        readonly byteLength: number;
        readonly pinCount: number;
        readonly pinBytes: number;
      }
    | { readonly status: "refused"; readonly result: FlowMutationResult } {
    if (reference.kind === "pinned") {
      const row = this.db.prepare(
        `SELECT CASE WHEN length(CAST(fv.graph AS BLOB)) <= ? THEN fv.graph ELSE NULL END AS graph,
                length(CAST(fv.graph AS BLOB)) > ? AS oversized, fv.semantic_hash
         FROM flow_versions fv
         JOIN flows f ON f.id = fv.flow_id
         WHERE fv.id = ? AND fv.flow_id = ? AND f.owner_id = ?
        `,
      ).get(
        MAX_MUTATION_GRAPH_BYTES, MAX_MUTATION_GRAPH_BYTES,
        reference.versionId, reference.flowId, ownerId,
      ) as Record<string, unknown> | undefined;
      if (!row) return { status: "refused", result: { status: "not-found" } };
      if (row.oversized) return { status: "refused", result: { status: "invalid-reference" } };
      const graph = safeParsePersistedGraph(row.graph);
      if (!graph) return { status: "refused", result: { status: "invalid-reference" } };
      const pinTotals = this.db.prepare(
        `SELECT COUNT(*) AS pin_count,
                COALESCE(SUM(length(CAST(kind AS BLOB)) + length(CAST(resource_id AS BLOB)) +
                  length(CAST(version AS BLOB)) + length(CAST(COALESCE(content_hash, '') AS BLOB))), 0) AS pin_bytes
         FROM dependency_pins WHERE flow_version_id = ?`,
      ).get(reference.versionId) as Record<string, unknown>;
      const pinCount = Number(pinTotals.pin_count);
      const pinBytes = Number(pinTotals.pin_bytes);
      if (
        !Number.isSafeInteger(pinCount) || pinCount < 0 || pinCount > MAX_MUTATION_VERSION_PINS ||
        !Number.isSafeInteger(pinBytes) || pinBytes < 0 || pinBytes > MAX_MUTATION_VERSION_PIN_BYTES
      ) return { status: "refused", result: { status: "invalid-reference" } };
      const pins = this.db.prepare(
        `SELECT kind, resource_id, version, content_hash
         FROM dependency_pins WHERE flow_version_id = ?
         ORDER BY kind ASC, resource_id ASC, version ASC, id ASC`,
      ).all(reference.versionId) as Record<string, unknown>[];
      let dependencies: DependencyPinInput[];
      try {
        dependencies = pins.map((pin): DependencyPinInput => {
          if (
            typeof pin.kind !== "string" || !dependencyKinds.has(pin.kind) ||
            typeof pin.resource_id !== "string" || typeof pin.version !== "string" ||
            (pin.content_hash !== null && typeof pin.content_hash !== "string")
          ) throw new Error("invalid pin");
          return {
            kind: pin.kind as DependencyPinInput["kind"],
            resourceId: pin.resource_id,
            version: pin.version,
            ...(pin.content_hash === null ? {} : { contentHash: pin.content_hash }),
          };
        });
      } catch {
        return { status: "refused", result: { status: "invalid-reference" } };
      }
      const recomputed = hashFlowGraph(graph, { semantic: true }, dependencies);
      if (recomputed !== row.semantic_hash) {
        return { status: "refused", result: { status: "invalid-reference" } };
      }
      return {
        status: "resolved",
        graph,
        semanticHash: recomputed,
        byteLength: Buffer.byteLength(row.graph as string, "utf8"),
        pinCount,
        pinBytes,
      };
    }

    const row = this.db.prepare(
      `SELECT CASE WHEN length(CAST(graph AS BLOB)) <= ? THEN graph ELSE NULL END AS graph,
              length(CAST(graph AS BLOB)) > ? AS oversized
       FROM flows WHERE id = ? AND owner_id = ?`,
    ).get(
      MAX_MUTATION_GRAPH_BYTES, MAX_MUTATION_GRAPH_BYTES, reference.flowId, ownerId,
    ) as Record<string, unknown> | undefined;
    if (!row) {
      return { status: "refused", result: { status: "not-found" } };
    }
    if (row.oversized) return { status: "refused", result: { status: "invalid-reference" } };
    const graph = safeParsePersistedGraph(row.graph);
    if (!graph) return { status: "refused", result: { status: "invalid-reference" } };
    return {
      status: "resolved",
      graph,
      byteLength: Buffer.byteLength(row.graph as string, "utf8"),
      pinCount: 0,
      pinBytes: 0,
    };
  }

  private scanTypedDependents(ownerId: string, childFlowId: string): FlowImpactDependent[] | null {
    const totals = this.db.prepare(
      `SELECT COUNT(*) AS flow_count,
              COALESCE(SUM(length(CAST(graph AS BLOB))), 0) AS graph_bytes,
              COALESCE(SUM(length(CAST(name AS BLOB))), 0) AS name_bytes
       FROM flows WHERE owner_id = ?`,
    ).get(ownerId) as Record<string, unknown>;
    const flowCount = Number(totals.flow_count);
    const graphBytes = Number(totals.graph_bytes);
    const nameBytes = Number(totals.name_bytes);
    if (
      !Number.isSafeInteger(flowCount) || flowCount < 0 || flowCount > MAX_IMPACT_SCAN_FLOWS ||
      !Number.isSafeInteger(graphBytes) || graphBytes < 0 || graphBytes > MAX_IMPACT_SCAN_BYTES ||
      !Number.isSafeInteger(nameBytes) || nameBytes < 0 || nameBytes > MAX_IMPACT_SCAN_NAME_BYTES
    ) return null;
    const dependents: FlowImpactDependent[] = [];
    let nodeCount = 0;
    let edgeCount = 0;
    const rows = this.db.prepare(
      "SELECT id, name, graph FROM flows WHERE owner_id = ? ORDER BY id ASC",
    ).iterate(ownerId) as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const graph = safeParsePersistedGraph(row.graph);
      if (!graph) return null;
      nodeCount += graph.nodes.length;
      edgeCount += graph.edges.length;
      if (nodeCount > MAX_IMPACT_SCAN_NODES || edgeCount > MAX_IMPACT_SCAN_EDGES) return null;
      let malformed = false;
      const nodeIds = graph.nodes.flatMap((node) => {
        if (node.type !== "subflow" && node.type !== "loop") return [];
        try {
          const normalized = normalizeSubflowReference(node.params);
          return normalized.kind === "typed" &&
            normalized.reference.kind === "draft" &&
            normalized.reference.flowId === childFlowId
            ? [node.id]
            : [];
        } catch {
          malformed = true;
          return [];
        }
      }).sort();
      if (malformed) return null;
      if (nodeIds.length > 0) {
        dependents.push({ flowId: row.id as string, name: row.name as string, nodeIds });
      }
    }
    return dependents;
  }

  private verifiedTypedVersionProjection(
    ownerId: string,
    flowId: string,
    row: Record<string, unknown>,
    remainingPinCount = MAX_MUTATION_DFS_PINS,
    remainingPinBytes = MAX_MUTATION_DFS_PIN_BYTES,
  ): {
    readonly receipt: ReturnType<typeof projectPublicInterface> & {};
    readonly semanticHash: string;
    readonly pinCount: number;
    readonly pinBytes: number;
    readonly graphBytes: number;
  } | null | false {
    if (
      typeof row.id !== "string" || typeof row.graph !== "string" ||
      typeof row.semantic_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.semantic_hash)
    ) return null;
    const stillOwned = this.db.prepare(
      `SELECT 1 FROM flow_versions fv
       JOIN flows f ON f.id = fv.flow_id AND f.owner_id = ?
       WHERE fv.id = ? AND fv.flow_id = ?`,
    ).get(ownerId, row.id, flowId);
    if (!stillOwned) return null;
    const graph = safeParsePersistedGraph(row.graph);
    const receipt = graph ? projectPublicInterface(graph) : null;
    if (!graph || !receipt) return null;
    const totals = this.db.prepare(
      `SELECT COUNT(*) AS pin_count,
              COALESCE(SUM(length(CAST(kind AS BLOB)) + length(CAST(resource_id AS BLOB)) +
                length(CAST(version AS BLOB)) + length(CAST(COALESCE(content_hash, '') AS BLOB))), 0) AS pin_bytes
       FROM dependency_pins WHERE flow_version_id = ?`,
    ).get(row.id) as Record<string, unknown>;
    const pinCount = Number(totals.pin_count);
    const pinBytes = Number(totals.pin_bytes);
    if (
      !Number.isSafeInteger(pinCount) || pinCount < 0 || pinCount > 1_000 ||
      !Number.isSafeInteger(pinBytes) || pinBytes < 0 || pinBytes > 1024 * 1024
    ) return null;
    if (pinCount > remainingPinCount || pinBytes > remainingPinBytes) return false;
    try {
      const pins = this.db.prepare(
        `SELECT kind, resource_id, version, content_hash
         FROM dependency_pins WHERE flow_version_id = ?
         ORDER BY kind ASC, resource_id ASC, version ASC, id ASC`,
      ).all(row.id) as Record<string, unknown>[];
      const dependencies = pins.map((pin): DependencyPinInput => {
        if (
          typeof pin.kind !== "string" || !dependencyKinds.has(pin.kind) ||
          typeof pin.resource_id !== "string" ||
          typeof pin.version !== "string" ||
          (pin.content_hash !== null && typeof pin.content_hash !== "string")
        ) throw new Error("invalid pin");
        return {
          kind: pin.kind as DependencyPinInput["kind"],
          resourceId: pin.resource_id,
          version: pin.version,
          ...(pin.content_hash === null ? {} : { contentHash: pin.content_hash }),
        };
      });
      const semanticHash = hashFlowGraph(graph, { semantic: true }, dependencies);
      return semanticHash === row.semantic_hash ? {
        receipt,
        semanticHash,
        pinCount,
        pinBytes,
        graphBytes: Buffer.byteLength(row.graph, "utf8"),
      } : null;
    } catch {
      return null;
    }
  }

  async ownsSubflowApiFlow(
    input: Parameters<SubflowApiRepository["ownsSubflowApiFlow"]>[0],
  ): Promise<boolean> {
    return Boolean(this.db.prepare("SELECT 1 FROM flows WHERE id = ? AND owner_id = ?")
      .get(input.flowId, input.ownerId));
  }

  async listSubflowCandidates(
    input: Parameters<SubflowApiRepository["listSubflowCandidates"]>[0],
  ): ReturnType<SubflowApiRepository["listSubflowCandidates"]> {
    const read = this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM flows WHERE id = ? AND owner_id = ?")
        .get(input.parentFlowId, input.ownerId)) return null;
      let truncated = false;
      const statement = this.db.prepare(
        `SELECT f.id, f.name,
           CASE WHEN length(CAST(f.graph AS BLOB)) <= ? THEN f.graph ELSE NULL END AS graph,
           length(CAST(f.graph AS BLOB)) > ? AS draft_oversized,
           (SELECT w.name
            FROM flow_project_bindings b
            JOIN workbooks w ON w.id = b.workbook_id
            JOIN projects p ON p.id = w.project_id AND p.id = b.project_id
            JOIN workspaces ws ON ws.id = p.workspace_id
            JOIN organizations o ON o.id = ws.organization_id
            WHERE b.flow_id = f.id AND o.personal_owner_id = f.owner_id
            LIMIT 1) AS workbook_name
         FROM flows f
         WHERE f.owner_id = ? AND f.id <> ?
           AND (? IS NULL OR f.name > ? OR (f.name = ? AND f.id > ?))
         ORDER BY f.name COLLATE BINARY ASC, f.id COLLATE BINARY ASC
         LIMIT 2`,
      );
      const collected: Array<{ projection: SubflowCandidate; sort: readonly [string, string] }> = [];
      const pageBytes = { bytes: 0 };
      let extraSort: readonly [string, string] | undefined;
      let scanName: string | null = input.cursor?.[0] ?? null;
      let scanId = input.cursor?.[1] ?? "";
      let scanned = 0;
      let scannedBytes = 0;
      let pinsScanned = 0;
      let versionRowsScanned = 0;
      let resourceExhausted = false;
      let more = false;
      candidateScan: while (scanned < 512 && !extraSort && !resourceExhausted) {
        const rows = statement.all(
          MAX_MUTATION_GRAPH_BYTES, MAX_MUTATION_GRAPH_BYTES,
          input.ownerId, input.parentFlowId,
          scanName, scanName, scanName, scanId,
        ) as Record<string, unknown>[];
        if (rows.length === 0) { more = false; break; }
        more = rows.length > 1;
        for (const row of rows.slice(0, 1)) {
          scanned += 1;
          if (
            typeof row.id !== "string" || row.id.length < 1 || row.id.length > 512 ||
            Buffer.byteLength(row.id, "utf8") > 512 || typeof row.name !== "string"
          ) {
            truncated = true;
            resourceExhausted = true;
            break candidateScan;
          }
          scanName = row.name;
          scanId = row.id;
          scannedBytes += typeof row.graph === "string" ? Buffer.byteLength(row.graph, "utf8") : 0;
          if (scannedBytes > 32 * 1024 * 1024) {
            truncated = true; more = true; resourceExhausted = true; break candidateScan;
          }
          if (!row.name.normalize("NFC").toLowerCase().includes(input.query)) continue;
          if (row.name.length < 1 || Buffer.byteLength(row.name, "utf8") > 200) { truncated = true; continue; }
          const graph = row.graph === null ? null : safeParsePersistedGraph(row.graph);
          if (!graph) truncated = true;
          const draftInterface = graph ? projectPublicInterface(graph) : null;
          const versionStatement = this.db.prepare(
            `SELECT fv.id, fv.version_number, fv.created_at,
                    CASE WHEN length(CAST(fv.graph AS BLOB)) <= ? THEN fv.graph ELSE NULL END AS graph,
                    length(CAST(fv.graph AS BLOB)) > ? AS oversized, fv.semantic_hash
             FROM flow_versions fv
             JOIN flows owned ON owned.id = fv.flow_id AND owned.owner_id = ?
             WHERE fv.flow_id = ?
               AND (? IS NULL OR fv.version_number < ? OR (fv.version_number = ? AND fv.id < ?))
             ORDER BY fv.version_number DESC, fv.id DESC LIMIT 2`,
          );
          let latestTypedVersion: SubflowCandidate["latestTypedVersion"];
          let versionCursorNumber: number | null = null;
          let versionCursorId = "";
          while (!latestTypedVersion && scannedBytes <= 32 * 1024 * 1024) {
            const versionRows = versionStatement.all(
              MAX_MUTATION_GRAPH_BYTES, MAX_MUTATION_GRAPH_BYTES, input.ownerId, row.id,
              versionCursorNumber, versionCursorNumber, versionCursorNumber, versionCursorId,
            ) as Record<string, unknown>[];
            if (versionRows.length === 0) break;
            for (const versionRow of versionRows.slice(0, 1)) {
              versionRowsScanned += 1;
              if (versionRowsScanned > 1_024) {
                truncated = true;
                resourceExhausted = true;
                break;
              }
              const versionNumber = Number(versionRow.version_number);
              if (!Number.isSafeInteger(versionNumber) || versionNumber < 1 ||
                  typeof versionRow.id !== "string" || versionRow.id.length < 1 ||
                  versionRow.id.length > 512 || Buffer.byteLength(versionRow.id, "utf8") > 512) {
                truncated = true;
                resourceExhausted = true;
                break;
              }
              versionCursorNumber = versionNumber;
              versionCursorId = versionRow.id;
              if (versionRow.oversized) { truncated = true; continue; }
              const createdAt = Number(versionRow.created_at);
              if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
                truncated = true;
                continue;
              }
              scannedBytes += typeof versionRow.graph === "string"
                ? Buffer.byteLength(versionRow.graph, "utf8")
                : 0;
              if (scannedBytes > 32 * 1024 * 1024) {
                truncated = true;
                resourceExhausted = true;
                break;
              }
              let verified: ReturnType<SqliteRepo["verifiedTypedVersionProjection"]> = null;
              try {
                verified = this.verifiedTypedVersionProjection(
                  input.ownerId, row.id, versionRow,
                  MAX_MUTATION_DFS_PINS - pinsScanned,
                  MAX_IMPACT_SCAN_BYTES - scannedBytes,
                );
              } catch {
                verified = null;
              }
              if (verified === false) {
                truncated = true;
                resourceExhausted = true;
                break;
              }
              if (!verified) { truncated = true; continue; }
              pinsScanned += verified.pinCount;
              scannedBytes += verified.pinBytes;
              if (pinsScanned > 2_000 || scannedBytes > 32 * 1024 * 1024) {
                truncated = true;
                resourceExhausted = true;
                break;
              }
              latestTypedVersion = {
                versionId: versionRow.id,
                versionNumber,
                createdAt,
                interfaceHash: verified.receipt.interfaceHash,
                contentHash: verified.semanticHash,
              };
              break;
            }
            if (resourceExhausted) break;
            if (versionRows.length < 2) break;
          }
          if (resourceExhausted) break candidateScan;
          if (!draftInterface && !latestTypedVersion) { truncated = true; continue; }
          let workbookName: string | null = null;
          if (row.workbook_name !== null) {
            if (typeof row.workbook_name === "string" && row.workbook_name.length > 0 &&
                Buffer.byteLength(row.workbook_name, "utf8") <= 200) {
              workbookName = row.workbook_name;
            } else {
              truncated = true;
            }
          }
          const projection: SubflowCandidate = {
            flowId: row.id,
            name: row.name,
            workbookName: workbookName as string | null,
            draft: draftInterface ? {
              interface: draftInterface.interface,
              interfaceHash: draftInterface.interfaceHash,
              semanticHash: hashFlowGraph(graph!, { semantic: true }),
            } : null,
            ...(latestTypedVersion ? { latestTypedVersion } : {}),
          };
          const bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
          if (bytes > MAX_PUBLIC_PAGE_PROJECTION_BYTES) { truncated = true; continue; }
          if (collected.length >= input.limit ||
              pageBytes.bytes + bytes > MAX_PUBLIC_PAGE_PROJECTION_BYTES) {
            extraSort = [row.name, row.id];
            break candidateScan;
          }
          pageBytes.bytes += bytes;
          collected.push({ projection, sort: [row.name, row.id] });
        }
        if (!more) break;
      }
      if ((scanned >= 512 && more) || resourceExhausted) truncated = true;
      const hasRepresentableExtra = Boolean(extraSort);
      const last = hasRepresentableExtra ? collected.at(-1)?.sort : undefined;
      return {
        page: {
          flows: collected.map(({ projection }) => projection),
          truncated: truncated || hasRepresentableExtra || more,
        },
        ...(last ? { last } : {}),
      };
    });
    return read.deferred();
  }

  async listSubflowVersions(
    input: Parameters<SubflowApiRepository["listSubflowVersions"]>[0],
  ): ReturnType<SubflowApiRepository["listSubflowVersions"]> {
    const read = this.db.transaction(() => {
      const ownership = this.db.prepare(
        `SELECT
           EXISTS(SELECT 1 FROM flows WHERE id = ? AND owner_id = ?) AS parent_owned,
           EXISTS(SELECT 1 FROM flows WHERE id = ? AND owner_id = ?) AS child_owned`,
      ).get(input.parentFlowId, input.ownerId, input.childFlowId, input.ownerId) as {
        parent_owned: number; child_owned: number;
      };
      if (!ownership.parent_owned || !ownership.child_owned) return null;
      let truncated = false;
      const statement = this.db.prepare(
        `SELECT fv.id, fv.version_number, fv.created_at,
                CASE WHEN length(CAST(fv.graph AS BLOB)) <= ? THEN fv.graph ELSE NULL END AS graph,
                length(CAST(fv.graph AS BLOB)) > ? AS oversized, fv.semantic_hash
         FROM flow_versions fv
         JOIN flows f ON f.id = fv.flow_id AND f.owner_id = ?
         WHERE fv.flow_id = ?
           AND (? IS NULL OR fv.version_number < ? OR (fv.version_number = ? AND fv.id < ?))
         ORDER BY fv.version_number DESC, fv.id DESC LIMIT 2`,
      );
      const collected: Array<{
        projection: SubflowVersionProjection;
        sort: readonly [number, string];
      }> = [];
      const pageBytes = { bytes: 0 };
      let extraSort: readonly [number, string] | undefined;
      let scanNumber: number | null = input.cursor?.[0] ?? null;
      let scanId = input.cursor?.[1] ?? "";
      let scanned = 0;
      let scannedBytes = 0;
      let pinsScanned = 0;
      let resourceExhausted = false;
      let more = false;
      versionScan: while (scanned < MAX_SUBFLOW_API_VERSION_ROWS && !extraSort && !resourceExhausted) {
        const rows = statement.all(
          MAX_MUTATION_GRAPH_BYTES, MAX_MUTATION_GRAPH_BYTES, input.ownerId, input.childFlowId,
          scanNumber, scanNumber, scanNumber, scanId,
        ) as Record<string, unknown>[];
        if (rows.length === 0) { more = false; break; }
        more = rows.length > 1;
        for (const row of rows.slice(0, 1)) {
          scanned += 1;
          const versionNumber = Number(row.version_number);
          const createdAt = Number(row.created_at);
          if (
            !Number.isSafeInteger(versionNumber) || versionNumber < 1 ||
            typeof row.id !== "string" || row.id.length < 1 || row.id.length > 512 ||
            (typeof row.id === "string" && Buffer.byteLength(row.id, "utf8") > 512)
          ) {
            truncated = true;
            resourceExhausted = true;
            break versionScan;
          }
          scanNumber = versionNumber;
          scanId = row.id;
          if (!Number.isSafeInteger(createdAt) || createdAt < 0) { truncated = true; continue; }
          if (row.oversized) { truncated = true; continue; }
          scannedBytes += typeof row.graph === "string" ? Buffer.byteLength(row.graph, "utf8") : 0;
          if (scannedBytes > 32 * 1024 * 1024) {
            truncated = true; more = true; resourceExhausted = true; break versionScan;
          }
          const verified = this.verifiedTypedVersionProjection(
            input.ownerId, input.childFlowId, row,
            MAX_MUTATION_DFS_PINS - pinsScanned,
            MAX_IMPACT_SCAN_BYTES - scannedBytes,
          );
          if (verified === false) {
            truncated = true;
            more = true;
            resourceExhausted = true;
            break versionScan;
          }
          if (!verified) { truncated = true; continue; }
          pinsScanned += verified.pinCount;
          scannedBytes += verified.pinBytes;
          if (pinsScanned > 2_000 || scannedBytes > 32 * 1024 * 1024) {
            truncated = true;
            more = true;
            resourceExhausted = true;
            break versionScan;
          }
          const projection: SubflowVersionProjection = {
            versionId: row.id,
            versionNumber,
            createdAt,
            interface: verified.receipt.interface,
            interfaceHash: verified.receipt.interfaceHash,
            contentHash: verified.semanticHash,
          };
          const bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
          if (bytes > MAX_PUBLIC_PAGE_PROJECTION_BYTES) { truncated = true; continue; }
          if (collected.length >= input.limit ||
              pageBytes.bytes + bytes > MAX_PUBLIC_PAGE_PROJECTION_BYTES) {
            extraSort = [versionNumber, row.id];
            break versionScan;
          }
          pageBytes.bytes += bytes;
          collected.push({ projection, sort: [versionNumber, row.id] });
        }
        if (!more) break;
      }
      if ((scanned >= MAX_SUBFLOW_API_VERSION_ROWS && more) || resourceExhausted) truncated = true;
      const hasRepresentableExtra = Boolean(extraSort);
      const last = hasRepresentableExtra
        ? collected.at(-1)?.sort
        : undefined;
      return {
        page: {
          versions: collected.map(({ projection }) => projection),
          truncated: truncated || hasRepresentableExtra || more,
        },
        ...(last ? { last } : {}),
      };
    });
    return read.deferred();
  }

  async resolveSubflowReference(
    input: Parameters<SubflowApiRepository["resolveSubflowReference"]>[0],
  ): ReturnType<SubflowApiRepository["resolveSubflowReference"]> {
    const read = this.db.transaction(() => {
    const parent = this.db.prepare(
      `SELECT CASE WHEN length(CAST(graph AS BLOB)) <= ? THEN graph ELSE NULL END AS graph
       FROM flows WHERE id = ? AND owner_id = ?`,
    ).get(MAX_MUTATION_GRAPH_BYTES, input.parentFlowId, input.ownerId) as Record<string, unknown> | undefined;
    if (!parent) return null;
    const parentGraph = safeParsePersistedGraph(parent.graph);
    if (!parentGraph) return null;
    const persistedNode = parentGraph.nodes.find((node) => node.id === input.nodeId);
    if (persistedNode && persistedNode.type !== "subflow" && persistedNode.type !== "loop") return null;
    const resolved = this.resolveOwnedReference(input.ownerId, input.reference);
    if (resolved.status !== "resolved" || !resolved.graph) return null;
    const receipt = projectPublicInterface(resolved.graph);
    if (!receipt) return null;
    const issues: Array<"interface-drift" | "content-drift"> = [];
    if (receipt.interfaceHash !== input.reference.interfaceHash) issues.push("interface-drift");
    if (input.reference.kind === "pinned" && resolved.semanticHash !== input.reference.contentHash) {
      issues.push("content-drift");
    }
    const reference: SubflowReference = input.reference.kind === "draft"
      ? {
          kind: "draft", flowId: input.reference.flowId,
          interface: receipt.interface, interfaceHash: receipt.interfaceHash,
        }
      : {
          kind: "pinned", flowId: input.reference.flowId, versionId: input.reference.versionId,
          interface: receipt.interface, interfaceHash: receipt.interfaceHash,
          contentHash: resolved.semanticHash!,
        };
    const projection: SubflowResolveProjection = {
      reference,
      interface: receipt.interface,
      interfaceHash: receipt.interfaceHash,
      ...(input.reference.kind === "pinned" ? {
        contentHash: resolved.semanticHash!,
        dependency: {
          kind: "flow" as const,
          resourceId: input.reference.flowId,
          version: input.reference.versionId,
          contentHash: resolved.semanticHash!,
        },
      } : {}),
      issues,
    };
    return Buffer.byteLength(JSON.stringify(projection), "utf8") <= MAX_PUBLIC_INTERFACE_BYTES * 2
      ? projection
      : null;
    });
    return read.deferred();
  }

  async readSubflowBreadcrumbs(
    input: Parameters<SubflowBreadcrumbRepository["readSubflowBreadcrumbs"]>[0],
  ): ReturnType<SubflowBreadcrumbRepository["readSubflowBreadcrumbs"]> {
    const read = this.db.transaction(() => {
      const direct = input.trail.length === 0;
      const requested = direct
        ? [{ flowId: input.currentFlowId }]
        : input.trail;
      if (requested.length < 1 || requested.length > 32 ||
          requested.at(-1)?.flowId !== input.currentFlowId ||
          new Set(requested.map(({ flowId }) => flowId)).size !== requested.length) return null;

      const ids = requested.map(({ flowId }) => flowId);
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT id, name,
                CASE WHEN length(CAST(graph AS BLOB)) <= ? THEN graph ELSE NULL END AS graph
         FROM flows WHERE owner_id = ? AND id IN (${placeholders})`,
      ).all(MAX_MUTATION_GRAPH_BYTES, input.ownerId, ...ids) as Array<{
        id: unknown; name: unknown; graph: unknown;
      }>;
      if (rows.length !== ids.length) return null;

      const flows = new Map<string, { readonly name: string; readonly graph: SupportedFlowGraph }>();
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.name !== "string" ||
            row.id.length < 1 || row.id.length > 512 || Buffer.byteLength(row.id, "utf8") > 512 ||
            row.name.length < 1 || row.name.length > 200 || Buffer.byteLength(row.name, "utf8") > 200) return null;
        const graph = safeParsePersistedGraph(row.graph);
        if (!graph) return null;
        flows.set(row.id, { name: row.name, graph });
      }
      if (direct) return { crumbs: [] };

      const crumbs: SubflowBreadcrumb[] = [];
      const effectiveGraphs = new Map<string, SupportedFlowGraph>();
      for (let index = 0; index < requested.length; index += 1) {
        const item = requested[index]!;
        const flow = flows.get(item.flowId);
        if (!flow) return null;
        if ((item.versionId === undefined) !== (item.contentHash === undefined)) return null;

        let pin: { readonly versionNumber: number; readonly graph: SupportedFlowGraph } | null = null;
        if (item.versionId !== undefined && item.contentHash !== undefined) {
          const row = this.db.prepare(
            `SELECT fv.version_number, fv.semantic_hash,
                    CASE WHEN length(CAST(fv.graph AS BLOB)) <= ? THEN fv.graph ELSE NULL END AS graph
             FROM flow_versions fv
             JOIN flows f ON f.id = fv.flow_id AND f.owner_id = ?
             WHERE fv.id = ? AND fv.flow_id = ?`,
          ).get(MAX_MUTATION_GRAPH_BYTES, input.ownerId, item.versionId, item.flowId) as
            { version_number: unknown; semantic_hash: unknown; graph: unknown } | undefined;
          if (!row || !Number.isSafeInteger(row.version_number) || Number(row.version_number) < 1 ||
              row.semantic_hash !== item.contentHash) return null;
          const versionGraph = safeParsePersistedGraph(row.graph);
          if (!versionGraph || hashFlowGraph(versionGraph, { semantic: true }) !== item.contentHash) return null;
          pin = { versionNumber: Number(row.version_number), graph: versionGraph };
        }
        effectiveGraphs.set(item.flowId, pin?.graph ?? flow.graph);

        if (index > 0) {
          const parentGraph = effectiveGraphs.get(requested[index - 1]!.flowId);
          if (!parentGraph) return null;
          let references: GraphReference[];
          try {
            references = graphReferences(parentGraph);
          } catch {
            return null;
          }
          const matches = references.some((reference) => {
            if (reference.kind === "legacy" || reference.flowId !== item.flowId) return false;
            if (pin === null) {
              return reference.kind === "draft" &&
                referenceReceiptMatches(reference, flow.graph);
            }
            return reference.kind === "pinned" &&
              reference.versionId === item.versionId &&
              reference.contentHash === item.contentHash &&
              referenceReceiptMatches(reference, pin.graph, item.contentHash);
          });
          if (!matches) return null;
        }

        crumbs.push({
          flowId: item.flowId,
          name: flow.name,
          ...(pin && item.versionId && item.contentHash ? {
            versionId: item.versionId,
            versionNumber: pin.versionNumber,
            contentHash: item.contentHash,
          } : {}),
        });
      }
      return { crumbs };
    });
    return read.deferred();
  }

  async listSubflowDependents(
    input: Parameters<SubflowApiRepository["listSubflowDependents"]>[0],
  ): ReturnType<SubflowApiRepository["listSubflowDependents"]> {
    const read = this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM flows WHERE id = ? AND owner_id = ?")
        .get(input.flowId, input.ownerId)) return null;
      let truncated = false;
      const statement = this.db.prepare(
        `SELECT id, name,
                CASE WHEN length(CAST(graph AS BLOB)) <= ? THEN graph ELSE NULL END AS graph,
                length(CAST(graph AS BLOB)) > ? AS oversized
         FROM flows WHERE owner_id = ? AND id > ?
         ORDER BY id ASC LIMIT 2`,
      );
      const collected: SubflowDependentProjection[] = [];
      const pageBytes = { bytes: 0 };
      let extraFound = false;
      let scanId = input.cursor ?? "";
      let scanned = 0;
      let scannedBytes = 0;
      let resourceExhausted = false;
      let more = false;
      dependentScan: while (scanned < MAX_IMPACT_SCAN_FLOWS && !extraFound && !resourceExhausted) {
        const rows = statement.all(
          MAX_MUTATION_GRAPH_BYTES, MAX_MUTATION_GRAPH_BYTES, input.ownerId, scanId,
        ) as Record<string, unknown>[];
        if (rows.length === 0) { more = false; break; }
        more = rows.length > 1;
        for (const row of rows.slice(0, 1)) {
          scanned += 1;
          if (typeof row.id !== "string" || row.id.length < 1 || row.id.length > 512 ||
              Buffer.byteLength(row.id, "utf8") > 512) {
            truncated = true;
            resourceExhausted = true;
            break dependentScan;
          }
          scanId = row.id;
          if (row.oversized) { truncated = true; continue; }
          scannedBytes += typeof row.graph === "string" ? Buffer.byteLength(row.graph, "utf8") : 0;
          if (scannedBytes > 32 * 1024 * 1024) {
            truncated = true; more = true; resourceExhausted = true; break dependentScan;
          }
          const graph = safeParsePersistedGraph(row.graph);
          if (!graph) { truncated = true; continue; }
          const nodeIds: string[] = [];
          let malformed = false;
          for (const node of graph.nodes) {
            if (node.type !== "subflow" && node.type !== "loop") continue;
            try {
              const normalized = normalizeSubflowReference(node.params);
              if (
                normalized.kind === "typed" && normalized.reference.kind === "draft" &&
                normalized.reference.flowId === input.flowId
              ) nodeIds.push(node.id);
            } catch {
              malformed = true;
              break;
            }
          }
          nodeIds.sort();
          if (malformed) { truncated = true; continue; }
          if (nodeIds.length === 0) continue;
          if (
            nodeIds.length > 100 || nodeIds.some((nodeId) =>
              nodeId.length < 1 || nodeId.length > 128 || Buffer.byteLength(nodeId, "utf8") > 128) ||
            typeof row.name !== "string" || row.name.length < 1 ||
            Buffer.byteLength(row.name, "utf8") > 200
          ) { truncated = true; continue; }
          const projection: SubflowDependentProjection = {
            flowId: row.id,
            name: row.name,
            nodeIds,
          };
          const bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
          if (bytes > MAX_PUBLIC_PAGE_PROJECTION_BYTES) { truncated = true; continue; }
          if (pageBytes.bytes + bytes > MAX_PUBLIC_PAGE_PROJECTION_BYTES ||
              collected.length >= input.limit) {
            extraFound = true;
            break dependentScan;
          }
          pageBytes.bytes += bytes;
          collected.push(projection);
        }
        if (!more) break;
      }
      if ((scanned >= MAX_IMPACT_SCAN_FLOWS && more) || resourceExhausted) truncated = true;
      const last = extraFound ? collected.at(-1)?.flowId : undefined;
      return {
        page: { dependents: collected, truncated: truncated || extraFound || more },
        ...(last ? { last } : {}),
      };
    });
    return read.deferred();
  }

  async saveFlow(input: SaveFlowInput): Promise<FlowRecord> {
    const id = input.id ?? randomUUID();
    const updatedAt = Date.now();
    const saved = this.db
      .prepare(
        `INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, graph=excluded.graph, updated_at=excluded.updated_at
         WHERE flows.owner_id = excluded.owner_id`,
      )
      .run(id, input.ownerId, input.name, JSON.stringify(input.graph), updatedAt);
    if (saved.changes !== 1) throw new Error("Flow ownership conflict");
    return { id, ownerId: input.ownerId, name: input.name, graph: input.graph, updatedAt };
  }

  async getFlow(id: string): Promise<FlowRecord | null> {
    const row = this.db.prepare(`SELECT * FROM flows WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToFlow(row) : null;
  }

  async listFlowsByIds(ids: readonly string[]): Promise<FlowRecord[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM flows WHERE id IN (${placeholders})`)
      .all(...uniqueIds) as Record<string, unknown>[];
    return rows.map((row) => this.rowToFlow(row));
  }

  async getOwnedFlow(id: string, ownerId: string): Promise<FlowRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM flows WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as Record<string, unknown> | undefined;
    return row ? this.rowToFlow(row) : null;
  }

  async listFlows(ownerId: string): Promise<FlowRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM flows WHERE owner_id = ? ORDER BY updated_at DESC`)
      .all(ownerId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToFlow(r));
  }

  async deleteFlow(id: string, ownerId: string): Promise<boolean> {
    const deleteOwnedFlow = this.db.transaction(
      (flowId: string, expectedOwnerId: string): boolean => {
        const flow = this.db
          .prepare(`SELECT id FROM flows WHERE id = ? AND owner_id = ?`)
          .get(flowId, expectedOwnerId) as Record<string, unknown> | undefined;
        if (!flow) return false;
        const agents = this.db
          .prepare(`SELECT id FROM agents WHERE flow_id = ?`)
          .all(flowId) as Record<string, unknown>[];
        for (const agent of agents) {
          this.db
            .prepare(`DELETE FROM schedules WHERE agent_id = ?`)
            .run(agent.id as string);
        }
        this.db.prepare(`DELETE FROM agents WHERE flow_id = ?`).run(flowId);
        const runs = this.db
          .prepare(`SELECT id FROM runs WHERE flow_id = ?`)
          .all(flowId) as Record<string, unknown>[];
        for (const run of runs) {
          this.db
            .prepare(`DELETE FROM run_steps WHERE run_id = ?`)
            .run(run.id as string);
        }
        this.db.prepare(`DELETE FROM runs WHERE flow_id = ?`).run(flowId);
        // Deploy-on-launch writes version/deployment rows that reference
        // flows(id); without this cascade a launched flow can never be deleted.
        this.db.prepare(`DELETE FROM deployments WHERE flow_id = ?`).run(flowId);
        this.db
          .prepare(
            `DELETE FROM dependency_pins WHERE flow_version_id IN (SELECT id FROM flow_versions WHERE flow_id = ?)`,
          )
          .run(flowId);
        this.db.prepare(`DELETE FROM flow_versions WHERE flow_id = ?`).run(flowId);
        this.db.prepare(`DELETE FROM flow_project_bindings WHERE flow_id = ?`).run(flowId);
        this.db.prepare(`DELETE FROM flows WHERE id = ?`).run(flowId);
        return true;
      },
    );
    return deleteOwnedFlow.immediate(id, ownerId);
  }

  private rowToFlow(row: Record<string, unknown>): FlowRecord {
    return {
      id: row.id as string,
      ownerId: row.owner_id as string,
      name: row.name as string,
      graph: parseSupportedFlowGraph(JSON.parse(row.graph as string)),
      updatedAt: row.updated_at as number,
    };
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const agent: AgentRecord = {
      id: randomUUID(),
      flowId: input.flowId,
      slug: input.slug,
      status: input.status ?? "draft",
      priceUsdc: input.priceUsdc ?? 0,
      createdAt: Date.now(),
      // New agents start with settlement OFF so a fresh launch cannot move
      // real money until the owner explicitly enables it (matches the FAQ
      // and docs). Written explicitly: NULL/missing still means LIVE for
      // pre-existing rows (see supabase-repo toAgent Phase 9 note).
      settlementLive: false,
    };
    this.db
      .prepare(
        `INSERT INTO agents (id, flow_id, slug, status, price_usdc, created_at, settlement_live) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.flowId,
        agent.slug,
        agent.status,
        agent.priceUsdc,
        agent.createdAt,
        agent.settlementLive ? 1 : 0,
      );
    return agent;
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  async getAgentBySlug(slug: string): Promise<AgentRecord | null> {
    const row = this.db.prepare(`SELECT * FROM agents WHERE slug = ?`).get(slug) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  async getAgentByFlowId(flowId: string): Promise<AgentRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE flow_id = ? ORDER BY created_at ASC LIMIT 1`)
      .get(flowId) as Record<string, unknown> | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<AgentRecord | null> {
    const existing = await this.getAgent(id);
    if (!existing) return null;
    const status = input.status ?? existing.status;
    const priceUsdc = input.priceUsdc ?? existing.priceUsdc;
    const settlementLive = input.settlementLive ?? existing.settlementLive;
    this.db
      .prepare(`UPDATE agents SET status = ?, price_usdc = ?, settlement_live = ? WHERE id = ?`)
      .run(status, priceUsdc, settlementLive ? 1 : 0, id);
    return { ...existing, status, priceUsdc, settlementLive };
  }

  async listLiveAgents(): Promise<AgentRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM agents WHERE status = 'live' ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

  async listAgentsByOwner(ownerId: string): Promise<AgentRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM agents a JOIN flows f ON f.id = a.flow_id
         WHERE f.owner_id = ? ORDER BY a.created_at DESC`,
      )
      .all(ownerId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

  private rowToAgent(row: Record<string, unknown>): AgentRecord {
    return {
      id: row.id as string,
      flowId: row.flow_id as string,
      slug: row.slug as string,
      status: row.status as "draft" | "live",
      priceUsdc: row.price_usdc as number,
      createdAt: row.created_at as number,
      // Default-LIVE (opt-out): only an explicit 0 disables settlement.
      settlementLive: row.settlement_live !== 0,
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const run: RunRecord = {
      id: input.id ?? randomUUID(),
      flowId: input.flowId,
      agentId: input.agentId ?? null,
      trigger: input.trigger,
      status: "running",
      totalCostUsdc: 0,
      startedAt: Date.now(),
      finishedAt: null,
      settledAt: null,
      triggerInput: input.triggerInput ?? null,
      runVariables: input.runVariables ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, flow_id, agent_id, trigger, status, total_cost_usdc, started_at, finished_at, trigger_input, run_variables)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.flowId, run.agentId, run.trigger, run.status, 0, run.startedAt, null,
        run.triggerInput === null ? null : JSON.stringify(run.triggerInput),
        run.runVariables === null ? null : JSON.stringify(run.runVariables),
      );
    return run;
  }

  async appendStep(step: AppendStepInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO run_steps (id, run_id, node_id, node_type, status, cost_usdc, output, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        step.runId,
        step.nodeId,
        step.nodeType,
        step.status,
        step.costUsdc,
        step.output === undefined ? null : JSON.stringify(step.output),
        step.error ?? null,
      );
  }

  async finishRun(id: string, status: "done" | "error", totalCostUsdc: number): Promise<void> {
    this.db
      .prepare(`UPDATE runs SET status = ?, total_cost_usdc = ?, finished_at = ? WHERE id = ?`)
      .run(status, totalCostUsdc, Date.now(), id);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRun(row) : null;
  }

  async listRuns(flowId: string): Promise<RunRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE flow_id = ? ORDER BY started_at DESC`)
      .all(flowId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  async listRunsByOwner(ownerId: string, limit: number): Promise<RunRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN flows f ON f.id = r.flow_id
         WHERE f.owner_id = ? ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(ownerId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  async countRunsByAgent(agentIds: string[], trigger?: string): Promise<Record<string, number>> {
    if (agentIds.length === 0) return {};
    const placeholders = agentIds.map(() => "?").join(",");
    const triggerClause = trigger === undefined ? "" : " AND trigger = ?";
    const args: (string | number)[] = trigger === undefined ? agentIds : [...agentIds, trigger];
    const rows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) AS n FROM runs
         WHERE agent_id IN (${placeholders})${triggerClause} GROUP BY agent_id`,
      )
      .all(...args) as Record<string, unknown>[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.agent_id as string] = Number(row.n);
    return out;
  }

  private rowToRun(row: Record<string, unknown>): RunRecord {
    return {
      id: row.id as string,
      flowId: row.flow_id as string,
      agentId: (row.agent_id as string) ?? null,
      trigger: row.trigger as string,
      status: row.status as "running" | "done" | "error",
      totalCostUsdc: row.total_cost_usdc as number,
      startedAt: row.started_at as number,
      finishedAt: (row.finished_at as number) ?? null,
      settledAt: (row.settled_at as string) ?? null,
      triggerInput: row.trigger_input ? JSON.parse(row.trigger_input as string) : null,
      runVariables: row.run_variables ? JSON.parse(row.run_variables as string) : null,
    };
  }

  async listRunSteps(runId: string): Promise<RunStepRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY rowid ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      runId: row.run_id as string,
      nodeId: row.node_id as string,
      nodeType: row.node_type as string,
      status: row.status as string,
      costUsdc: row.cost_usdc as number,
      output: row.output ? JSON.parse(row.output as string) : null,
      error: (row.error as string) ?? null,
    }));
  }

  private rowToModerationReport(row: Record<string, unknown>): ModerationReportRecord {
    return {
      id: row.id as string,
      reporterOwnerId: row.reporter_owner_id as string,
      subjectOwnerId: row.subject_owner_id as string,
      subjectType: row.subject_type as ModerationSubjectType,
      flowId: (row.flow_id as string | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
      nodeId: (row.node_id as string | null) ?? null,
      agentId: (row.agent_id as string | null) ?? null,
      reason: row.reason as ModerationReason,
      status: row.status as ModerationStatus,
      reviewerNotes: (row.reviewer_notes as string | null) ?? null,
      reviewedBy: (row.reviewed_by as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      reviewedAt: (row.reviewed_at as string | null) ?? null,
    };
  }

  async createModerationReport(input: CreateModerationReportInput): Promise<ModerationReportRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO moderation_reports (
        id, reporter_owner_id, subject_owner_id, subject_type,
        flow_id, run_id, node_id, agent_id, reason,
        status, reviewer_notes, reviewed_by, created_at, updated_at, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?, NULL)`,
    ).run(
      id,
      input.reporterOwnerId,
      input.subjectOwnerId,
      input.subjectType,
      input.flowId ?? null,
      input.runId ?? null,
      input.nodeId ?? null,
      input.agentId ?? null,
      input.reason,
      now,
      now,
    );
    const row = this.db.prepare("SELECT * FROM moderation_reports WHERE id = ?")
      .get(id) as Record<string, unknown>;
    return this.rowToModerationReport(row);
  }

  async listModerationReports(query: ModerationQueueQuery): Promise<ModerationReportRecord[]> {
    const rows = query.status
      ? this.db.prepare(
        `SELECT * FROM moderation_reports WHERE status = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(query.status, query.limit)
      : this.db.prepare(
        `SELECT * FROM moderation_reports
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(query.limit);
    return (rows as Record<string, unknown>[]).map((row) => this.rowToModerationReport(row));
  }

  async updateModerationReport(
    id: string,
    input: UpdateModerationReportInput,
  ): Promise<ModerationReportRecord | null> {
    const currentRow = this.db.prepare("SELECT * FROM moderation_reports WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!currentRow) return null;
    const current = this.rowToModerationReport(currentRow);
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE moderation_reports
       SET status = ?, reviewer_notes = ?, reviewed_by = ?, updated_at = ?, reviewed_at = ?
       WHERE id = ?`,
    ).run(
      input.status,
      input.reviewerNotes === undefined ? current.reviewerNotes : input.reviewerNotes,
      input.reviewedBy,
      now,
      now,
      id,
    );
    const updated = this.db.prepare("SELECT * FROM moderation_reports WHERE id = ?")
      .get(id) as Record<string, unknown>;
    return this.rowToModerationReport(updated);
  }

  async upsertSchedule(input: {
    agentId: string;
    cron: string;
    enabled: boolean;
  }): Promise<ScheduleRecord> {
    const existing = (await this.listSchedulesByAgents([input.agentId]))[0];
    if (existing) {
      this.db
        .prepare(`UPDATE schedules SET cron = ?, enabled = ? WHERE id = ?`)
        .run(input.cron, input.enabled ? 1 : 0, existing.id);
      return { ...existing, cron: input.cron, enabled: input.enabled };
    }
    const schedule: ScheduleRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      cron: input.cron,
      enabled: input.enabled,
      lastRunAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO schedules (id, agent_id, cron, enabled, last_run_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(schedule.id, schedule.agentId, schedule.cron, schedule.enabled ? 1 : 0, null);
    return schedule;
  }

  async listSchedulesByAgents(agentIds: string[]): Promise<ScheduleRecord[]> {
    if (agentIds.length === 0) return [];
    const placeholders = agentIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM schedules WHERE agent_id IN (${placeholders})`)
      .all(...agentIds) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSchedule(row));
  }

  async dueSchedules(now: number): Promise<ScheduleRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM schedules WHERE enabled = 1`)
      .all() as Record<string, unknown>[];
    return filterDue(
      rows.map((row) => this.rowToSchedule(row)),
      now,
    );
  }

  private rowToSchedule(row: Record<string, unknown>): ScheduleRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      cron: row.cron as string,
      enabled: Boolean(row.enabled),
      lastRunAt: (row.last_run_at as number) ?? null,
    };
  }

  async markScheduleRun(id: string, at: number): Promise<void> {
    this.db.prepare(`UPDATE schedules SET last_run_at = ? WHERE id = ?`).run(at, id);
  }

  async getWallet(ownerId: string): Promise<WalletRecord | null> {
    const row = this.db.prepare(`SELECT * FROM wallets WHERE owner_id = ?`).get(ownerId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      ownerId: row.owner_id as string,
      address: row.address as string,
      network: row.network as string,
      label: (row.label as string) ?? null,
    };
  }

  async listWalletsByOwners(ownerIds: readonly string[]): Promise<WalletRecord[]> {
    const uniqueOwnerIds = [...new Set(ownerIds)];
    if (uniqueOwnerIds.length === 0) return [];
    const placeholders = uniqueOwnerIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM wallets WHERE owner_id IN (${placeholders})`)
      .all(...uniqueOwnerIds) as Record<string, unknown>[];
    return rows.map((row) => ({
      ownerId: row.owner_id as string,
      address: row.address as string,
      network: row.network as string,
      label: (row.label as string) ?? null,
    }));
  }

  async upsertRelayEndpoint(input: {
    agentId: string;
    url: string;
    secret: string;
    protocolVersion?: 1 | 2;
  }): Promise<import("./repo").RelayEndpointRecord> {
    const createdAt = new Date().toISOString();
    const protocolVersion = input.protocolVersion ?? 1;
    this.db
      .prepare(
        `INSERT INTO relay_endpoints (agent_id, url, secret, protocol_version, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET url=excluded.url, secret=excluded.secret,
           protocol_version=excluded.protocol_version, created_at=excluded.created_at`,
      )
      .run(input.agentId, input.url, input.secret, protocolVersion, createdAt);
    return { agentId: input.agentId, url: input.url, secret: input.secret, protocolVersion, createdAt };
  }

  async getRelayEndpoint(agentId: string): Promise<import("./repo").RelayEndpointRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM relay_endpoints WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id as string,
      url: row.url as string,
      secret: row.secret as string,
      protocolVersion: (row.protocol_version === 2 ? 2 : 1),
      createdAt: row.created_at as string,
    };
  }

  async upsertSiteVerification(input: {
    ownerId: string;
    host: string;
    method: string;
  }): Promise<import("./repo").SiteVerificationRecord> {
    const verifiedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO site_verifications (owner_id, host, method, verified_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id, host) DO UPDATE SET method=excluded.method, verified_at=excluded.verified_at`,
      )
      .run(input.ownerId, input.host, input.method, verifiedAt);
    return { ownerId: input.ownerId, host: input.host, method: input.method, verifiedAt };
  }

  async getSiteVerification(
    ownerId: string,
    host: string,
  ): Promise<import("./repo").SiteVerificationRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM site_verifications WHERE owner_id = ? AND host = ?`)
      .get(ownerId, host) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ownerId: row.owner_id as string,
      host: row.host as string,
      method: row.method as string,
      verifiedAt: row.verified_at as string,
    };
  }

  async listSiteVerificationsByOwnersAndHosts(
    requirements: readonly import("./repo").SiteVerificationRequirement[],
  ): Promise<import("./repo").SiteVerificationRecord[]> {
    const exactPairs = new Set(
      requirements.map(({ ownerId, host }) => JSON.stringify([ownerId, host])),
    );
    if (exactPairs.size === 0) return [];
    const ownerIds = [...new Set(requirements.map(({ ownerId }) => ownerId))];
    const hosts = [...new Set(requirements.map(({ host }) => host))];
    const ownerPlaceholders = ownerIds.map(() => "?").join(",");
    const hostPlaceholders = hosts.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM site_verifications
         WHERE owner_id IN (${ownerPlaceholders}) AND host IN (${hostPlaceholders})`,
      )
      .all(...ownerIds, ...hosts) as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const ownerId = row.owner_id as string;
      const host = row.host as string;
      if (!exactPairs.has(JSON.stringify([ownerId, host]))) return [];
      return [{
        ownerId,
        host,
        method: row.method as string,
        verifiedAt: row.verified_at as string,
      }];
    });
  }

  async upsertWebhookEndpoint(input: {
    agentId: string;
    secretHash: string;
  }): Promise<import("./repo").WebhookEndpointRecord> {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_endpoints (agent_id, secret_hash, created_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET secret_hash=excluded.secret_hash, created_at=excluded.created_at`,
      )
      .run(input.agentId, input.secretHash, createdAt);
    return { agentId: input.agentId, secretHash: input.secretHash, createdAt };
  }

  async getWebhookEndpoint(agentId: string): Promise<import("./repo").WebhookEndpointRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM webhook_endpoints WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id as string,
      secretHash: row.secret_hash as string,
      createdAt: row.created_at as string,
    };
  }

  async deleteWebhookEndpoint(agentId: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM webhook_endpoints WHERE agent_id = ?`).run(agentId);
    return result.changes > 0;
  }

  async saveWallet(input: {
    ownerId: string;
    address: string;
    network?: string;
    label?: string;
  }): Promise<WalletRecord> {
    const network = input.network ?? "base-mainnet";
    const label = input.label ?? null;
    this.db
      .prepare(
        `INSERT INTO wallets (owner_id, address, network, label) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET address=excluded.address, network=excluded.network, label=excluded.label`,
      )
      .run(input.ownerId, input.address, network, label);
    return { ownerId: input.ownerId, address: input.address, network, label };
  }

  async stampRunSettled(runId: string, settledAt: string): Promise<void> {
    this.db
      .prepare(`UPDATE runs SET settled_at = ? WHERE id = ?`)
      .run(settledAt, runId);
  }

  async recordSettlement(input: Omit<SettlementRecord, "createdAt">): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO settlements (run_id, agent_id, owner_id, gross_usdc, creator_usdc, platform_usdc, pay_to, payout_source, payer, tx, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO NOTHING`,
        )
        .run(
          input.runId,
          input.agentId,
          input.ownerId,
          input.grossUsdc,
          input.creatorUsdc,
          input.platformUsdc,
          input.payTo,
          input.payoutSource,
          input.payer,
          input.tx,
          new Date().toISOString(),
        );
    } catch (error) {
      console.error("settlement ledger write failed", input.runId, error);
    }
  }

  async getSettlementByRun(runId: string): Promise<SettlementRecord | null> {
    try {
      const row = this.db
        .prepare(`SELECT * FROM settlements WHERE run_id = ? LIMIT 1`)
        .get(runId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        runId: row.run_id as string,
        agentId: row.agent_id as string,
        ownerId: row.owner_id as string,
        grossUsdc: Number(row.gross_usdc),
        creatorUsdc: Number(row.creator_usdc),
        platformUsdc: Number(row.platform_usdc),
        payTo: row.pay_to as string,
        payoutSource: row.payout_source as "creator" | "platform",
        payer: (row.payer as string | null) ?? null,
        tx: (row.tx as string | null) ?? null,
        createdAt: row.created_at as string,
      };
    } catch {
      return null;
    }
  }

  async reserveAp2Authorization(
    input: ReserveAp2AuthorizationInput,
  ): Promise<ReserveAp2AuthorizationResult> {
    const authorization: Ap2AuthorizationRecord = {
      id: randomUUID(),
      ...input,
      state: "authorized",
      decisionCode: null,
      receiptJson: null,
      resultJson: null,
      runId: null,
      tx: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    authorization.updatedAt = authorization.createdAt;

    const reserve = this.db.transaction((): ReserveAp2AuthorizationResult => {
      try {
        this.db.prepare(
          `INSERT INTO ap2_authorizations (
             id, mandate_reference, payment_nonce_hash, request_digest,
             issuer, subject_id, checkout_hash, agent_id, flow_id,
             deployment_id, network, asset, amount_atomic, amount_minor_usd,
             payee_id, pay_to, payer, state, decision_code, receipt_json, result_json,
             expires_at, payment_valid_before, run_id, tx, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          authorization.id,
          authorization.mandateReference,
          authorization.paymentNonceHash,
          authorization.requestDigest,
          authorization.issuer,
          authorization.subjectId,
          authorization.checkoutHash,
          authorization.agentId,
          authorization.flowId,
          authorization.deploymentId,
          authorization.network,
          authorization.asset,
          authorization.amountAtomic,
          authorization.amountMinorUsd,
          authorization.payeeId,
          authorization.payTo,
          authorization.payer,
          authorization.state,
          authorization.decisionCode,
          null,
          null,
          authorization.expiresAt,
          authorization.paymentValidBefore,
          authorization.runId,
          authorization.tx,
          authorization.createdAt,
          authorization.updatedAt,
        );
        return { status: "reserved", authorization };
      } catch (error) {
        const code = typeof error === "object" && error !== null
          ? Reflect.get(error, "code")
          : null;
        if (code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;

        const existing = this.db
          .prepare(`SELECT * FROM ap2_authorizations WHERE mandate_reference = ? LIMIT 1`)
          .get(input.mandateReference) as Record<string, unknown> | undefined;
        if (!existing) return { status: "conflict", authorization: null };
        const persisted = this.rowToAp2Authorization(existing);
        if (
          persisted.requestDigest === input.requestDigest &&
          persisted.paymentNonceHash === input.paymentNonceHash
        ) {
          return { status: "exact-retry", authorization: persisted };
        }
        return { status: "conflict", authorization: persisted };
      }
    });
    return reserve.immediate();
  }

  async getAp2AuthorizationByMandateReference(
    mandateReference: string,
  ): Promise<Ap2AuthorizationRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ap2_authorizations WHERE mandate_reference = ? LIMIT 1`)
      .get(mandateReference) as Record<string, unknown> | undefined;
    return row ? this.rowToAp2Authorization(row) : null;
  }

  async transitionAp2Authorization(
    input: TransitionAp2AuthorizationInput,
  ): Promise<Ap2AuthorizationRecord | null> {
    if (!isAp2AuthorizationTransitionAllowed(input.fromState, input.toState)) {
      throw new Error(`Invalid AP2 authorization transition: ${input.fromState} -> ${input.toState}`);
    }

    const assignments = ["state = ?"];
    const values: unknown[] = [input.toState];
    const append = (property: keyof TransitionAp2AuthorizationInput, column: string): void => {
      if (!Object.prototype.hasOwnProperty.call(input, property)) return;
      assignments.push(`${column} = ?`);
      const value = input[property];
      if (property === "receiptJson" || property === "resultJson") {
        values.push(value == null ? null : JSON.stringify(value));
      } else {
        values.push(value ?? null);
      }
    };
    append("decisionCode", "decision_code");
    append("receiptJson", "receipt_json");
    append("resultJson", "result_json");
    append("runId", "run_id");
    append("tx", "tx");
    assignments.push("updated_at = ?");
    values.push(new Date().toISOString(), input.id, input.fromState);

    const result = this.db
      .prepare(
        `UPDATE ap2_authorizations SET ${assignments.join(", ")}
         WHERE id = ? AND state = ?`,
      )
      .run(...values);
    if (result.changes === 0) return null;
    const row = this.db
      .prepare(`SELECT * FROM ap2_authorizations WHERE id = ? LIMIT 1`)
      .get(input.id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("AP2 authorization disappeared after transition");
    return this.rowToAp2Authorization(row);
  }

  async scrubExpiredAp2TerminalEvidence(
    input: ScrubExpiredAp2TerminalEvidenceInput,
  ): Promise<number> {
    assertValidAp2EvidenceScrubInput(input);
    const scrub = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT id, receipt_json
         FROM ap2_authorizations
         WHERE state IN ('completed', 'rejected', 'failed')
           AND updated_at < ?
           AND (
             result_json IS NOT NULL
             OR receipt_json IS NULL
             OR json_valid(receipt_json) = 0
             OR json_extract(receipt_json, '$.evidenceRetention.status') IS NULL
             OR json_extract(receipt_json, '$.evidenceRetention.status') <> 'expired'
           )
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
      ).all(input.terminalBefore, input.limit) as Array<{
        id: string;
        receipt_json: string | null;
      }>;
      let scrubbed = 0;
      const update = this.db.prepare(
        `UPDATE ap2_authorizations
         SET receipt_json = ?, result_json = NULL
         WHERE id = ?
           AND state IN ('completed', 'rejected', 'failed')
           AND updated_at < ?`,
      );
      for (const row of rows) {
        let receipt: Ap2SanitizedJson | null = null;
        try {
          receipt = row.receipt_json
            ? JSON.parse(row.receipt_json) as Ap2SanitizedJson
            : null;
        } catch {
          continue;
        }
        if (isAp2TerminalEvidenceExpired(receipt)) continue;
        const compacted = compactExpiredAp2TerminalEvidence(receipt, input.scrubbedAt);
        if (!compacted) continue;
        scrubbed += update.run(
          JSON.stringify(compacted),
          row.id,
          input.terminalBefore,
        ).changes;
      }
      return scrubbed;
    });
    return scrub.immediate();
  }

  private rowToAp2Authorization(row: Record<string, unknown>): Ap2AuthorizationRecord {
    return {
      id: row.id as string,
      mandateReference: row.mandate_reference as string,
      paymentNonceHash: row.payment_nonce_hash as string,
      requestDigest: row.request_digest as string,
      issuer: row.issuer as string,
      subjectId: (row.subject_id as string | null) ?? null,
      checkoutHash: row.checkout_hash as string,
      agentId: row.agent_id as string,
      flowId: row.flow_id as string,
      deploymentId: row.deployment_id as string,
      network: row.network as string,
      asset: row.asset as string,
      amountAtomic: row.amount_atomic as string,
      amountMinorUsd: Number(row.amount_minor_usd),
      payeeId: row.payee_id as string,
      payTo: row.pay_to as string,
      payer: row.payer as string,
      state: row.state as Ap2AuthorizationRecord["state"],
      decisionCode: (row.decision_code as string | null) ?? null,
      receiptJson: row.receipt_json
        ? JSON.parse(row.receipt_json as string) as Ap2SanitizedJson
        : null,
      resultJson: row.result_json
        ? JSON.parse(row.result_json as string) as Ap2SanitizedJson
        : null,
      expiresAt: row.expires_at as string,
      paymentValidBefore: row.payment_valid_before as string,
      runId: (row.run_id as string | null) ?? null,
      tx: (row.tx as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  async checkAp2ReplayStoreReady(): Promise<boolean> {
    try {
      return isAp2ReplayStoreAttested(this.db);
    } catch {
      return false;
    }
  }

  async listAgentListings(agentId: string): Promise<AgentListingRecord[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM agent_listings WHERE agent_id = ? ORDER BY updated_at DESC, venue_id ASC`,
        )
        .all(agentId) as Record<string, unknown>[];
      return rows.map((row) => this.rowToAgentListing(row));
    } catch {
      // Table may not exist yet (migration pending) — dark-deploy safe.
      return [];
    }
  }

  async upsertAgentListing(input: UpsertAgentListingInput): Promise<AgentListingRecord> {
    const now = new Date().toISOString();
    const record: AgentListingRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      venueId: input.venueId,
      status: input.status,
      externalUrl: input.externalUrl ?? null,
      submittedAt: now,
      updatedAt: now,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO agent_listings (id, agent_id, venue_id, status, external_url, submitted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, venue_id) DO UPDATE SET
             status = excluded.status,
             external_url = excluded.external_url,
             updated_at = excluded.updated_at`,
        )
        .run(
          record.id,
          record.agentId,
          record.venueId,
          record.status,
          record.externalUrl,
          record.submittedAt,
          record.updatedAt,
        );
      const row = this.db
        .prepare(`SELECT * FROM agent_listings WHERE agent_id = ? AND venue_id = ? LIMIT 1`)
        .get(input.agentId, input.venueId) as Record<string, unknown> | undefined;
      return row ? this.rowToAgentListing(row) : record;
    } catch (error) {
      // Table may not exist yet (migration pending) — return the in-memory
      // record so the submit route can still respond, and log the write miss.
      console.error("agent_listings write failed", input.agentId, input.venueId, error);
      return record;
    }
  }

  private rowToAgentListing(row: Record<string, unknown>): AgentListingRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      venueId: row.venue_id as string,
      status: row.status as AgentListingRecord["status"],
      externalUrl: (row.external_url as string | null) ?? null,
      submittedAt: row.submitted_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  // ── Company domain (Autonomous Company layer) ───────────────────────────

  async createCompany(input: { ownerId: string; name: string; mission: string }): Promise<CompanyRecord> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO companies (id, owner_id, name, mission, status, fire_cost_threshold_usdc, created_at)
         VALUES (?, ?, ?, ?, 'draft', NULL, ?)`,
      )
      .run(id, input.ownerId, input.name, input.mission, createdAt);
    return {
      id,
      ownerId: input.ownerId,
      name: input.name,
      mission: input.mission,
      status: "draft",
      fireCostThresholdUsdc: null,
      createdAt,
    };
  }

  async getCompany(id: string): Promise<CompanyRecord | null> {
    const row = this.db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToCompany(row) : null;
  }

  async listCompaniesByOwner(ownerId: string): Promise<CompanyRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM companies WHERE owner_id = ? ORDER BY created_at DESC`)
      .all(ownerId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToCompany(r));
  }

  async updateCompany(
    id: string,
    input: { name?: string; mission?: string; status?: CompanyStatus; fireCostThresholdUsdc?: number | null },
  ): Promise<CompanyRecord | null> {
    const existing = this.db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) return null;
    const name = input.name ?? (existing.name as string);
    const mission = input.mission ?? (existing.mission as string);
    const status = input.status ?? (existing.status as CompanyStatus);
    const fireCostThresholdUsdc = "fireCostThresholdUsdc" in input
      ? input.fireCostThresholdUsdc ?? null
      : existing.fire_cost_threshold_usdc === null ? null : Number(existing.fire_cost_threshold_usdc);
    this.db
      .prepare(
        `UPDATE companies SET name = ?, mission = ?, status = ?, fire_cost_threshold_usdc = ? WHERE id = ?`,
      )
      .run(name, mission, status, fireCostThresholdUsdc, id);
    return {
      id,
      ownerId: existing.owner_id as string,
      name,
      mission,
      status,
      fireCostThresholdUsdc,
      createdAt: existing.created_at as string,
    };
  }

  async createDepartment(
    input: { companyId: string; name: string; monthlyBudgetUsdc?: number | null },
  ): Promise<DepartmentRecord> {
    const id = randomUUID();
    const monthlyBudgetUsdc = input.monthlyBudgetUsdc ?? null;
    this.db
      .prepare(
        `INSERT INTO company_departments (id, company_id, name, monthly_budget_usdc) VALUES (?, ?, ?, ?)`,
      )
      .run(id, input.companyId, input.name, monthlyBudgetUsdc);
    return { id, companyId: input.companyId, name: input.name, monthlyBudgetUsdc };
  }

  async listDepartments(companyId: string): Promise<DepartmentRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM company_departments WHERE company_id = ?`)
      .all(companyId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDepartment(r));
  }

  async setDepartmentBudget(id: string, monthlyBudgetUsdc: number | null): Promise<void> {
    this.db
      .prepare(`UPDATE company_departments SET monthly_budget_usdc = ? WHERE id = ?`)
      .run(monthlyBudgetUsdc, id);
  }

  /** Idempotent on agentId — a repeat add is a no-op (first write wins). */
  async addEmployee(input: EmployeeRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO company_employees
           (agent_id, company_id, department_id, job_description, publish_gated, monthly_budget_usdc, pay_to,
            role, reports_to, lifecycle_status, heartbeat_enabled, heartbeat_interval_seconds, last_heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO NOTHING`,
      )
      .run(
        input.agentId,
        input.companyId,
        input.departmentId,
        input.jobDescription,
        input.publishGated ? 1 : 0,
        input.monthlyBudgetUsdc,
        input.payTo,
        // An unset role stays NULL rather than becoming 'worker' — see
        // resolveEffectiveRole in src/lib/company/roles.ts.
        input.role ?? null,
        input.reportsTo ?? null,
        input.lifecycleStatus ?? null,
        input.heartbeatEnabled === undefined ? null : input.heartbeatEnabled ? 1 : 0,
        input.heartbeatIntervalSeconds ?? null,
        input.lastHeartbeatAt ?? null,
      );
  }

  async listEmployees(companyId: string): Promise<EmployeeRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM company_employees WHERE company_id = ? AND removed_at IS NULL`)
      .all(companyId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEmployee(r));
  }

  async listCompanyEmployeeHistory(companyId: string): Promise<EmployeeRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM company_employees WHERE company_id = ?`)
      .all(companyId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEmployee(r));
  }

  async getEmployeeByAgent(agentId: string): Promise<EmployeeRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM company_employees WHERE agent_id = ? AND removed_at IS NULL`)
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? this.rowToEmployee(row) : null;
  }

  async removeEmployee(agentId: string): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE company_employees SET removed_at = ? WHERE agent_id = ? AND removed_at IS NULL`)
      .run(new Date().toISOString(), agentId);
    return result.changes > 0;
  }

  async updateEmployee(agentId: string, input: UpdateEmployeeInput): Promise<void> {
    const existing = this.db
      .prepare(`SELECT * FROM company_employees WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown> | undefined;
    if (!existing) return;
    const jobDescription = input.jobDescription ?? (existing.job_description as string);
    const departmentId = input.departmentId ?? (existing.department_id as string);
    const monthlyBudgetUsdc = "monthlyBudgetUsdc" in input
      ? input.monthlyBudgetUsdc ?? null
      : existing.monthly_budget_usdc === null ? null : Number(existing.monthly_budget_usdc);
    const payTo = "payTo" in input
      ? input.payTo ?? null
      : existing.pay_to == null ? null : String(existing.pay_to);
    // Each org-chart column keeps its stored value unless this call named it,
    // so a budget edit never blanks the chart or the heartbeat cadence.
    const role = "role" in input
      ? input.role ?? null
      : existing.role == null ? null : String(existing.role);
    const reportsTo = "reportsTo" in input
      ? input.reportsTo ?? null
      : existing.reports_to == null ? null : String(existing.reports_to);
    const lifecycleStatus = input.lifecycleStatus
      ?? (existing.lifecycle_status == null ? null : String(existing.lifecycle_status));
    const heartbeatEnabled = input.heartbeatEnabled === undefined
      ? existing.heartbeat_enabled == null ? null : Number(existing.heartbeat_enabled) === 0 ? 0 : 1
      : input.heartbeatEnabled ? 1 : 0;
    const heartbeatIntervalSeconds = "heartbeatIntervalSeconds" in input
      ? input.heartbeatIntervalSeconds ?? null
      : existing.heartbeat_interval_seconds == null
        ? null
        : Number(existing.heartbeat_interval_seconds);
    const lastHeartbeatAt = "lastHeartbeatAt" in input
      ? input.lastHeartbeatAt ?? null
      : existing.last_heartbeat_at == null ? null : String(existing.last_heartbeat_at);
    this.db
      .prepare(
        `UPDATE company_employees
           SET job_description = ?, department_id = ?, monthly_budget_usdc = ?, pay_to = ?,
               role = ?, reports_to = ?, lifecycle_status = ?, heartbeat_enabled = ?,
               heartbeat_interval_seconds = ?, last_heartbeat_at = ?
         WHERE agent_id = ?`,
      )
      .run(
        jobDescription,
        departmentId,
        monthlyBudgetUsdc,
        payTo,
        role,
        reportsTo,
        lifecycleStatus,
        heartbeatEnabled,
        heartbeatIntervalSeconds,
        lastHeartbeatAt,
        agentId,
      );
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const snapshot = input.costSnapshot ?? null;
    this.db
      .prepare(
        `INSERT INTO company_approvals (
           id, company_id, kind, subject_id, status, reason,
           action_summary, cost_basis, cost_usdc, cost_note, created_at, decided_at
         ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.companyId,
        input.kind,
        input.subjectId,
        input.actionSummary ?? null,
        snapshot?.basis ?? null,
        snapshot?.amountUsdc ?? null,
        snapshot?.note ?? null,
        createdAt,
      );
    return {
      id,
      companyId: input.companyId,
      kind: input.kind,
      subjectId: input.subjectId,
      status: "pending",
      reason: null,
      actionSummary: input.actionSummary ?? null,
      costSnapshot: snapshot,
      createdAt,
      decidedAt: null,
    };
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const row = this.db.prepare(`SELECT * FROM company_approvals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToApproval(row) : null;
  }

  async listApprovals(companyId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    const rows = status === undefined
      ? (this.db
          .prepare(`SELECT * FROM company_approvals WHERE company_id = ? ORDER BY created_at DESC`)
          .all(companyId) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM company_approvals WHERE company_id = ? AND status = ? ORDER BY created_at DESC`,
          )
          .all(companyId, status) as Record<string, unknown>[]);
    return rows.map((r) => this.rowToApproval(r));
  }

  async listCompanyActivity(input: CompanyActivityQuery): Promise<CompanyActivityPage> {
    const fetchLimit = input.limit + 1;
    const cursorPrefix = input.cursor?.id.split(":", 1)[0];
    const cursorRawId = input.cursor?.id.slice((cursorPrefix?.length ?? -1) + 1);
    const runStatuses = new Set(["running", "done", "error"]);
    const approvalStatuses = new Set(["pending", "approved", "rejected", "consumed"]);
    const records: CompanyActivityRecord[] = [];

    if (!input.status || runStatuses.has(input.status)) {
      const filters = [
        "ce.company_id = ?",
        "r.started_at >= ?",
        "r.started_at < ?",
      ];
      const args: Array<string | number> = [input.companyId, input.fromMs, input.toMs];
      if (input.employeeId) {
        filters.push("ce.agent_id = ?");
        args.push(input.employeeId);
      }
      if (input.departmentId) {
        filters.push("ce.department_id = ?");
        args.push(input.departmentId);
      }
      if (input.status) {
        filters.push("r.status = ?");
        args.push(input.status);
      }
      if (input.cursor) {
        if (cursorPrefix === "run") {
          filters.push("(r.started_at < ? OR (r.started_at = ? AND r.id < ?))");
          const cursorMs = Date.parse(input.cursor.occurredAt);
          args.push(cursorMs, cursorMs, cursorRawId ?? "");
        } else if (cursorPrefix === "approval") {
          // `run:` sorts after `approval:` in descending global id order, so
          // equal-time runs were already before an approval cursor.
          filters.push("r.started_at < ?");
          args.push(Date.parse(input.cursor.occurredAt));
        }
      }
      const rows = this.db
        .prepare(
          `SELECT r.*, ce.department_id
           FROM runs r
           JOIN company_employees ce ON ce.agent_id = r.agent_id
           WHERE ${filters.join(" AND ")}
           ORDER BY r.started_at DESC, r.id DESC
           LIMIT ?`,
        )
        .all(...args, fetchLimit) as Record<string, unknown>[];
      for (const row of rows) {
        records.push({
          id: `run:${String(row.id)}`,
          kind: "run",
          employeeId: String(row.agent_id),
          departmentId: String(row.department_id),
          status: row.status as CompanyActivityRecord["status"],
          occurredAt: new Date(Number(row.started_at)).toISOString(),
          trigger: String(row.trigger),
          costUsdc: Number(row.total_cost_usdc ?? 0),
          approvalKind: null,
          reason: null,
          receipt: null,
        });
      }
    }

    if (!input.status || approvalStatuses.has(input.status)) {
      const filters = [
        "a.company_id = ?",
        "a.created_at >= ?",
        "a.created_at < ?",
      ];
      const args: Array<string | number> = [
        input.companyId,
        new Date(input.fromMs).toISOString(),
        new Date(input.toMs).toISOString(),
      ];
      if (input.employeeId) {
        filters.push("ce.agent_id = ?");
        args.push(input.employeeId);
      }
      if (input.departmentId) {
        filters.push("ce.department_id = ?");
        args.push(input.departmentId);
      }
      if (input.status) {
        filters.push("a.status = ?");
        args.push(input.status);
      }
      if (input.cursor) {
        const cursorIso = input.cursor.occurredAt;
        if (cursorPrefix === "approval") {
          filters.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
          args.push(cursorIso, cursorIso, cursorRawId ?? "");
        } else if (cursorPrefix === "run") {
          // `approval:` follows `run:` at the same timestamp.
          filters.push("a.created_at <= ?");
          args.push(cursorIso);
        }
      }
      const rows = this.db
        .prepare(
          `SELECT a.*, ce.agent_id AS employee_id, ce.department_id
           FROM company_approvals a
           LEFT JOIN company_employees ce
             ON ce.agent_id = a.subject_id AND ce.company_id = a.company_id
           WHERE ${filters.join(" AND ")}
           ORDER BY a.created_at DESC, a.id DESC
           LIMIT ?`,
        )
        .all(...args, fetchLimit) as Record<string, unknown>[];
      for (const row of rows) {
        records.push({
          id: `approval:${String(row.id)}`,
          kind: "approval",
          employeeId: row.employee_id ? String(row.employee_id) : null,
          departmentId: row.department_id ? String(row.department_id) : null,
          status: row.status as CompanyActivityRecord["status"],
          occurredAt: String(row.created_at),
          trigger: null,
          costUsdc: null,
          approvalKind: row.kind as ApprovalKind,
          reason: (row.reason as string | null) ?? null,
          receipt: null,
        });
      }
    }

    records.sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id),
    );
    const hasMore = records.length > input.limit;
    const selected = records.slice(0, input.limit);
    const runIds = selected
      .filter((record) => record.kind === "run")
      .map((record) => record.id.slice("run:".length));
    if (runIds.length > 0) {
      const placeholders = runIds.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM settlements WHERE run_id IN (${placeholders})`)
        .all(...runIds) as Record<string, unknown>[];
      const settlements = new Map(rows.map((row) => [String(row.run_id), row]));
      for (const record of selected) {
        if (record.kind !== "run") continue;
        const row = settlements.get(record.id.slice("run:".length));
        if (!row) continue;
        record.receipt = {
          runId: String(row.run_id),
          agentId: String(row.agent_id),
          ownerId: String(row.owner_id),
          grossUsdc: Number(row.gross_usdc),
          creatorUsdc: Number(row.creator_usdc),
          platformUsdc: Number(row.platform_usdc),
          payTo: String(row.pay_to),
          payoutSource: row.payout_source as "creator" | "platform",
          payer: (row.payer as string | null) ?? null,
          tx: (row.tx as string | null) ?? null,
          createdAt: String(row.created_at),
        };
      }
    }
    return { records: selected, hasMore };
  }

  async appendCeoMessage(input: CreateCeoMessageInput): Promise<CeoMessageRecord> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const proposal = input.proposal ?? null;
    this.db
      .prepare(
        `INSERT INTO company_ceo_messages (id, company_id, role, content, proposal, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.companyId,
        input.role,
        input.content,
        proposal === null ? null : JSON.stringify(proposal),
        createdAt,
      );
    return { id, companyId: input.companyId, role: input.role, content: input.content, proposal, createdAt };
  }

  async listCeoMessages(companyId: string, limit: number): Promise<CeoMessageRecord[]> {
    // Tie-break on rowid, not id — id is a random UUID and two turns
    // appended within the same request commonly share one millisecond of
    // created_at resolution. rowid is SQLite's implicit, always-monotonic
    // insertion-order column, so it reliably preserves turn order.
    const rows = this.db
      .prepare(
        `SELECT * FROM company_ceo_messages WHERE company_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(companyId, limit) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        id: r.id as string,
        companyId: r.company_id as string,
        role: r.role as CeoMessageRole,
        content: r.content as string,
        proposal: r.proposal ? (JSON.parse(r.proposal as string) as unknown) : null,
        createdAt: r.created_at as string,
      }))
      .reverse();
  }

  /** pending → approved|rejected only; returns null when not pending. */
  async decideApproval(
    id: string,
    decision: "approved" | "rejected",
    reason?: string | null,
  ): Promise<ApprovalRecord | null> {
    const decidedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE company_approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, reason ?? null, decidedAt, id);
    if (result.changes === 0) return null;
    const row = this.db.prepare(`SELECT * FROM company_approvals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToApproval(row) : null;
  }

  /** approved → consumed only; returns false otherwise. One fire per approval. */
  async consumeApproval(id: string): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE company_approvals SET status = 'consumed' WHERE id = ? AND status = 'approved'`)
      .run(id);
    return result.changes > 0;
  }

  /** consumed → approved only; used to compensate a guarded action failure. */
  async restoreApproval(id: string): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE company_approvals SET status = 'approved' WHERE id = ? AND status = 'consumed'`)
      .run(id);
    return result.changes > 0;
  }

  /**
   * Sum runs.total_cost_usdc for these agents with started_at >= sinceMs
   * and, when untilMs is given, started_at < untilMs. Single query; returns
   * 0 for an empty agent list without querying.
   */
  async sumCostByAgents(agentIds: string[], sinceMs: number, untilMs?: number): Promise<number> {
    if (agentIds.length === 0) return 0;
    const placeholders = agentIds.map(() => "?").join(",");
    const untilClause = untilMs === undefined ? "" : " AND started_at < ?";
    const args: (string | number)[] = untilMs === undefined
      ? [...agentIds, sinceMs]
      : [...agentIds, sinceMs, untilMs];
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_cost_usdc), 0) AS total FROM runs
         WHERE agent_id IN (${placeholders}) AND started_at >= ?${untilClause}`,
      )
      .get(...args) as Record<string, unknown> | undefined;
    return Number(row?.total ?? 0);
  }

  /** Settlements rows for these agents in [fromIso, toIso), newest first. */
  async listSettlementsByAgents(
    agentIds: string[],
    fromIso: string,
    toIso: string,
  ): Promise<SettlementRecord[]> {
    if (agentIds.length === 0) return [];
    const placeholders = agentIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM settlements
         WHERE agent_id IN (${placeholders}) AND created_at >= ? AND created_at < ?
         ORDER BY created_at DESC`,
      )
      .all(...agentIds, fromIso, toIso) as Record<string, unknown>[];
    return rows.map((row) => ({
      runId: row.run_id as string,
      agentId: row.agent_id as string,
      ownerId: row.owner_id as string,
      grossUsdc: Number(row.gross_usdc),
      creatorUsdc: Number(row.creator_usdc),
      platformUsdc: Number(row.platform_usdc),
      payTo: row.pay_to as string,
      payoutSource: row.payout_source as "creator" | "platform",
      payer: (row.payer as string | null) ?? null,
      tx: (row.tx as string | null) ?? null,
      createdAt: row.created_at as string,
    }));
  }

  private rowToCompany(row: Record<string, unknown>): CompanyRecord {
    return {
      id: row.id as string,
      ownerId: row.owner_id as string,
      name: row.name as string,
      mission: row.mission as string,
      status: row.status as CompanyStatus,
      fireCostThresholdUsdc: row.fire_cost_threshold_usdc === null ? null : Number(row.fire_cost_threshold_usdc),
      createdAt: row.created_at as string,
    };
  }

  private rowToDepartment(row: Record<string, unknown>): DepartmentRecord {
    return {
      id: row.id as string,
      companyId: row.company_id as string,
      name: row.name as string,
      monthlyBudgetUsdc: row.monthly_budget_usdc === null ? null : Number(row.monthly_budget_usdc),
    };
  }

  private rowToEmployee(row: Record<string, unknown>): EmployeeRecord {
    return {
      agentId: row.agent_id as string,
      companyId: row.company_id as string,
      departmentId: row.department_id as string,
      jobDescription: row.job_description as string,
      publishGated: row.publish_gated !== 0,
      monthlyBudgetUsdc: row.monthly_budget_usdc === null ? null : Number(row.monthly_budget_usdc),
      payTo: row.pay_to == null ? null : String(row.pay_to),
      role: parseEmployeeRole(row.role),
      reportsTo: row.reports_to == null ? null : String(row.reports_to),
      lifecycleStatus: parseLifecycleStatus(row.lifecycle_status),
      heartbeatEnabled: row.heartbeat_enabled == null
        ? false
        : Number(row.heartbeat_enabled) !== 0,
      heartbeatIntervalSeconds: row.heartbeat_interval_seconds == null
        ? null
        : Number(row.heartbeat_interval_seconds),
      lastHeartbeatAt: row.last_heartbeat_at == null ? null : String(row.last_heartbeat_at),
    };
  }

  private rowToApproval(row: Record<string, unknown>): ApprovalRecord {
    const costBasis = row.cost_basis;
    const costAmount = Number(row.cost_usdc);
    const costSnapshot: ApprovalCostSnapshot | null =
      (costBasis === "quoted" || costBasis === "estimated") &&
      Number.isFinite(costAmount) &&
      costAmount >= 0
        ? {
            basis: costBasis,
            amountUsdc: costAmount,
            note: (row.cost_note as string | null) ?? null,
          }
        : costBasis === "unavailable"
          ? {
              basis: "unavailable",
              amountUsdc: null,
              note: (row.cost_note as string | null) ?? null,
            }
          : null;
    return {
      id: row.id as string,
      companyId: row.company_id as string,
      kind: row.kind as ApprovalKind,
      subjectId: row.subject_id as string,
      status: row.status as ApprovalStatus,
      reason: (row.reason as string | null) ?? null,
      actionSummary: (row.action_summary as string | null) ?? null,
      costSnapshot,
      createdAt: row.created_at as string,
      decidedAt: (row.decided_at as string | null) ?? null,
    };
  }

  async createUsage(input: {
    ownerId: string;
    kind: string;
    units: number;
    costUsdc: number;
  }): Promise<UsageRecord> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO usage (id, owner_id, kind, units, cost_usdc, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.ownerId, input.kind, input.units, input.costUsdc, createdAt);
    return { id, ownerId: input.ownerId, kind: input.kind, units: input.units, costUsdc: input.costUsdc, createdAt };
  }

  async sumMonthlyUsage(ownerId: string, kind: string): Promise<number> {
    // SQLite: month prefix match on ISO string "YYYY-MM"
    const monthPrefix = new Date().toISOString().slice(0, 7); // "2026-06"
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(units), 0) AS total FROM usage
         WHERE owner_id = ? AND kind = ? AND created_at LIKE ?`,
      )
      .get(ownerId, kind, `${monthPrefix}%`) as Record<string, unknown>;
    return Number(row.total ?? 0);
  }

  async countSettledRunsByAgent(agentIds: string[]): Promise<Record<string, number>> {
    if (agentIds.length === 0) return {};
    const placeholders = agentIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) AS n FROM runs
         WHERE agent_id IN (${placeholders}) AND settled_at IS NOT NULL GROUP BY agent_id`,
      )
      .all(...agentIds) as Record<string, unknown>[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.agent_id as string] = Number(row.n);
    return out;
  }

  async lastAgentCallAt(
    agentIds: string[],
    trigger?: string,
  ): Promise<Record<string, number>> {
    if (agentIds.length === 0) return {};
    const placeholders = agentIds.map(() => "?").join(",");
    const triggerFilter = trigger === undefined ? "" : " AND trigger = ?";
    const rows = this.db
      .prepare(
        `SELECT agent_id, MAX(started_at) AS last_started_at FROM runs
         WHERE agent_id IN (${placeholders})${triggerFilter} GROUP BY agent_id`,
      )
      .all(
        ...agentIds,
        ...(trigger === undefined ? [] : [trigger]),
      ) as Record<string, unknown>[];
    const out: Record<string, number> = {};
    for (const row of rows) {
      const last = Number(row.last_started_at);
      if (Number.isFinite(last)) out[row.agent_id as string] = last;
    }
    return out;
  }

  async sumAgentCostSince(agentId: string, sinceMs: number): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_cost_usdc), 0) AS total FROM runs
         WHERE agent_id = ? AND started_at >= ?`,
      )
      .get(agentId, sinceMs) as Record<string, unknown> | undefined;
    return Number(row?.total ?? 0);
  }

  async createCredit(input: {
    ownerId: string;
    deltaUsdc: number;
    reason: string;
    tx?: string | null;
  }): Promise<CreditRecord> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const tx = input.tx ?? null;
    this.db
      .prepare(`INSERT INTO credits (id, owner_id, delta_usdc, reason, tx, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, input.ownerId, input.deltaUsdc, input.reason, tx, createdAt);
    return { id, ownerId: input.ownerId, deltaUsdc: input.deltaUsdc, reason: input.reason, tx, createdAt };
  }

  async recordStripeRevenueEvent(
    input: StripeRevenueEventInput,
  ): Promise<StripeRevenueWriteResult> {
    const occurredAtMs = stripeOccurredAtMs(input.occurredAt);
    const now = Date.now();
    if (
      occurredAtMs < Date.UTC(2000, 0, 1)
      || occurredAtMs > now + 5 * 60 * 1_000
      || !Number.isSafeInteger(input.amountTotalCents)
      || input.amountTotalCents <= 0
      || input.currency !== "USD"
      || !/^evt_[A-Za-z0-9_]+$/u.test(input.providerEventId)
      || !/^pi_[A-Za-z0-9_]+$/u.test(input.providerPaymentIntentId)
    ) {
      throw new Error("Invalid Stripe revenue event");
    }
    if (
      input.kind === "payment"
      && (
        !/^cs_[A-Za-z0-9_]+$/u.test(input.providerCheckoutSessionId)
        || input.terminalStatus !== "paid"
        || !Number.isFinite(input.creditGrantUsdc)
        || input.creditGrantUsdc <= 0
        || roundCredit(input.creditGrantUsdc) <= 0
        || input.creditGrantUsdc
          > (input.amountTotalCents / 100) * 1.2
        || (
          input.providerProductId !== null
          && !/^prod_[A-Za-z0-9_]+$/u.test(input.providerProductId)
        )
        || (
          input.providerPriceId !== null
          && !/^price_[A-Za-z0-9_]+$/u.test(input.providerPriceId)
        )
      )
    ) {
      throw new Error("Invalid Stripe payment receipt");
    }
    if (
      input.kind === "refund"
      && (
        !/^re_[A-Za-z0-9_]+$/u.test(input.providerRefundId)
        || input.terminalStatus !== "succeeded"
      )
    ) {
      throw new Error("Invalid Stripe refund receipt");
    }

    const append = this.db.transaction((): StripeRevenueWriteResult => {
      const paymentOwnerId = input.kind === "payment"
        ? resolveStripeOwnerAlias(this.db, input.ownerId)
        : null;
      const eventConflict = this.db
        .prepare("SELECT id FROM stripe_revenue_receipts WHERE provider_event_id = ?")
        .get(input.providerEventId) as { id: string } | undefined;

      if (input.kind === "payment") {
        const existing = this.db
          .prepare(
            `SELECT * FROM stripe_revenue_receipts
             WHERE kind = 'payment' AND provider_checkout_session_id = ?`,
          )
          .get(input.providerCheckoutSessionId) as SqliteStripeRevenueReceiptRow | undefined;
        if (existing) {
          if (
            resolveStripeOwnerAlias(this.db, existing.owner_id)
              !== paymentOwnerId
            || existing.provider_payment_intent_id !== input.providerPaymentIntentId
            || existing.amount_total_cents !== input.amountTotalCents
            || existing.currency !== input.currency
            || existing.terminal_status !== input.terminalStatus
            || existing.provider_product_id !== input.providerProductId
            || existing.provider_price_id !== input.providerPriceId
            || existing.credit_delta_usdc !== roundCredit(input.creditGrantUsdc)
            || (eventConflict !== undefined && eventConflict.id !== existing.id)
          ) {
            throw new Error("Stripe payment receipt conflict");
          }
          return {
            recorded: false,
            creditDeltaUsdc: existing.credit_delta_usdc,
            refundState: existing.refund_state,
          };
        }
        if (eventConflict) throw new Error("Stripe provider event conflict");

        const receiptId = randomUUID();
        const creditId = randomUUID();
        const creditDeltaUsdc = roundCredit(input.creditGrantUsdc);
        const previous = this.db
          .prepare(
            `SELECT source_revision_at FROM stripe_revenue_receipts
             ORDER BY source_revision_at DESC LIMIT 1`,
          )
          .get() as { source_revision_at: string } | undefined;
        const previousMs = previous ? Date.parse(previous.source_revision_at) : 0;
        const sourceRevisionAt = new Date(
          Math.max(now, occurredAtMs, previousMs + 1),
        ).toISOString();

        this.db
          .prepare(
            `INSERT INTO credits
               (id, owner_id, delta_usdc, reason, tx, created_at)
             VALUES (?, ?, ?, 'stripe-topup', ?, ?)`,
          )
          .run(
            creditId,
            paymentOwnerId,
            creditDeltaUsdc,
            `stripe-receipt:${receiptId}`,
            sourceRevisionAt,
          );
        this.db
          .prepare(
            `INSERT INTO stripe_revenue_receipts (
               id, kind, owner_id, provider_event_id,
               provider_checkout_session_id, provider_payment_intent_id,
               provider_refund_id, amount_total_cents, currency,
               terminal_status, refund_state, provider_product_id,
               provider_price_id, occurred_at, source_revision_at,
               credit_delta_usdc, credit_id, parent_receipt_id
             ) VALUES (
               ?, 'payment', ?, ?, ?, ?, NULL, ?, ?, 'paid', 'none',
               ?, ?, ?, ?, ?, ?, NULL
             )`,
          )
          .run(
            receiptId,
            paymentOwnerId,
            input.providerEventId,
            input.providerCheckoutSessionId,
            input.providerPaymentIntentId,
            input.amountTotalCents,
            input.currency,
            input.providerProductId,
            input.providerPriceId,
            input.occurredAt,
            sourceRevisionAt,
            creditDeltaUsdc,
            creditId,
          );
        return { recorded: true, creditDeltaUsdc, refundState: "none" };
      }

      const existing = this.db
        .prepare(
          `SELECT * FROM stripe_revenue_receipts
           WHERE kind = 'refund' AND provider_refund_id = ?`,
        )
        .get(input.providerRefundId) as SqliteStripeRevenueReceiptRow | undefined;
      if (existing) {
        if (
          existing.provider_payment_intent_id !== input.providerPaymentIntentId
          || existing.amount_total_cents !== input.amountTotalCents
          || existing.currency !== input.currency
          || existing.terminal_status !== input.terminalStatus
          || (eventConflict !== undefined && eventConflict.id !== existing.id)
        ) {
          throw new Error("Stripe refund receipt conflict");
        }
        return {
          recorded: false,
          creditDeltaUsdc: existing.credit_delta_usdc,
          refundState: existing.refund_state,
        };
      }
      if (eventConflict) throw new Error("Stripe provider event conflict");

      const payment = this.db
        .prepare(
          `SELECT * FROM stripe_revenue_receipts
           WHERE kind = 'payment' AND provider_payment_intent_id = ?`,
        )
        .get(input.providerPaymentIntentId) as SqliteStripeRevenueReceiptRow | undefined;
      if (!payment) {
        return {
          recorded: false,
          creditDeltaUsdc: 0,
          refundState: "none",
        };
      }
      if (payment.currency !== input.currency) {
        throw new Error("Stripe refund currency conflicts with its payment");
      }

      const paymentCredit = this.db
        .prepare(
          `SELECT owner_id, delta_usdc, reason, tx
           FROM credits
           WHERE id = ?`,
        )
        .get(payment.credit_id) as {
          owner_id: string;
          delta_usdc: number;
          reason: string;
          tx: string | null;
        } | undefined;
      if (
        !paymentCredit
        || paymentCredit.owner_id.length === 0
        || Number(paymentCredit.delta_usdc) !== payment.credit_delta_usdc
        || paymentCredit.reason !== "stripe-topup"
        || paymentCredit.tx !== `stripe-receipt:${payment.id}`
      ) {
        throw new Error("Stripe payment credit linkage is invalid");
      }
      const refundOwnerId = paymentCredit.owner_id;

      const prior = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(amount_total_cents), 0) AS amount_total_cents,
             COALESCE(SUM(-credit_delta_usdc), 0) AS reversed_credit_usdc
           FROM stripe_revenue_receipts
           WHERE kind = 'refund' AND parent_receipt_id = ?`,
        )
        .get(payment.id) as {
          amount_total_cents: number;
          reversed_credit_usdc: number;
        };
      const refundedCents = Number(prior.amount_total_cents) + input.amountTotalCents;
      if (refundedCents > payment.amount_total_cents) {
        throw new Error("Stripe refunds exceed the recorded payment");
      }
      const refundState: StripeRevenueRefundState =
        refundedCents === payment.amount_total_cents ? "full" : "partial";
      const targetReversedCredit = refundState === "full"
        ? payment.credit_delta_usdc
        : roundCredit(
          payment.credit_delta_usdc * refundedCents / payment.amount_total_cents,
        );
      const creditDeltaUsdc = -roundCredit(
        targetReversedCredit - Number(prior.reversed_credit_usdc),
      );
      if (!(creditDeltaUsdc < 0)) {
        throw new Error("Stripe refund credit reversal is not positive");
      }

      const receiptId = randomUUID();
      const creditId = randomUUID();
      const previous = this.db
        .prepare(
          `SELECT source_revision_at FROM stripe_revenue_receipts
           ORDER BY source_revision_at DESC LIMIT 1`,
        )
        .get() as { source_revision_at: string } | undefined;
      const previousMs = previous ? Date.parse(previous.source_revision_at) : 0;
      const sourceRevisionAt = new Date(
        Math.max(now, occurredAtMs, previousMs + 1),
      ).toISOString();

      this.db
        .prepare(
          `INSERT INTO credits
             (id, owner_id, delta_usdc, reason, tx, created_at)
           VALUES (?, ?, ?, 'stripe-refund', ?, ?)`,
        )
        .run(
          creditId,
          refundOwnerId,
          creditDeltaUsdc,
          `stripe-receipt:${receiptId}`,
          sourceRevisionAt,
        );
      this.db
        .prepare(
          `INSERT INTO stripe_revenue_receipts (
             id, kind, owner_id, provider_event_id,
             provider_checkout_session_id, provider_payment_intent_id,
             provider_refund_id, amount_total_cents, currency,
             terminal_status, refund_state, provider_product_id,
             provider_price_id, occurred_at, source_revision_at,
             credit_delta_usdc, credit_id, parent_receipt_id
           ) VALUES (
             ?, 'refund', ?, ?, NULL, ?, ?, ?, ?, 'succeeded', ?,
             ?, ?, ?, ?, ?, ?, ?
           )`,
        )
        .run(
          receiptId,
          payment.owner_id,
          input.providerEventId,
          input.providerPaymentIntentId,
          input.providerRefundId,
          input.amountTotalCents,
          input.currency,
          refundState,
          payment.provider_product_id,
          payment.provider_price_id,
          input.occurredAt,
          sourceRevisionAt,
          creditDeltaUsdc,
          creditId,
          payment.id,
        );
      return { recorded: true, creditDeltaUsdc, refundState };
    });

    return append.immediate();
  }

  async hasEverPaid(ownerId: string): Promise<boolean> {
    // Non-Stripe positive grants remain lifetime evidence. Stripe eligibility
    // is the retained topup/bonus value after Stripe refund reversals; gateway
    // spend rows never revoke it, while a full provider refund does.
    const row = this.db
      .prepare(
        `SELECT CASE
           WHEN EXISTS (
             SELECT 1
             FROM credits AS candidate
             WHERE candidate.owner_id = ?
               AND candidate.delta_usdc > 0
               AND candidate.reason NOT IN (
                 'stripe-topup',
                 'stripe-refund'
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM stripe_revenue_receipts AS linked_receipt
                 WHERE linked_receipt.credit_id = candidate.id
               )
           ) THEN 1
           WHEN ROUND(COALESCE((
             SELECT SUM(receipts.credit_delta_usdc)
             FROM stripe_revenue_receipts AS receipts
             JOIN credits AS linked_credit
               ON linked_credit.id = receipts.credit_id
             WHERE linked_credit.owner_id = ?
           ), 0), 8) > 0 THEN 1
           ELSE 0
         END AS paid`,
      )
      .get(ownerId, ownerId) as { paid: number };
    return row.paid === 1;
  }

  async getCreditBalance(ownerId: string): Promise<number> {
    try {
      const row = this.db
        .prepare(`SELECT COALESCE(SUM(delta_usdc), 0) AS total FROM credits WHERE owner_id = ?`)
        .get(ownerId) as Record<string, unknown> | undefined;
      return Number(row?.total ?? 0);
    } catch {
      return 0;
    }
  }

  async getCreditByTx(ownerId: string, tx: string): Promise<CreditRecord | null> {
    try {
      const row = this.db
        .prepare(`SELECT * FROM credits WHERE owner_id = ? AND tx = ? LIMIT 1`)
        .get(ownerId, tx) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        ownerId: row.owner_id as string,
        deltaUsdc: Number(row.delta_usdc),
        reason: row.reason as string,
        tx: row.tx as string | null,
        createdAt: row.created_at as string,
      };
    } catch {
      return null;
    }
  }

  async getLastPromoOutput(
    agentId: string,
  ): Promise<{ campaignId: string; campaignUrl: string; name: string } | null> {
    try {
      // Find the most-recent completed run for this agent, then scan its steps
      // for any node_type that includes "promo" and has a campaignUrl in output.
      const runRow = this.db
        .prepare(
          `SELECT id FROM runs WHERE agent_id = ? AND status = 'done'
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(agentId) as Record<string, unknown> | undefined;
      if (!runRow) return null;

      const stepRows = this.db
        .prepare(
          `SELECT output FROM run_steps
           WHERE run_id = ? AND node_type LIKE '%promo%' AND output IS NOT NULL`,
        )
        .all(runRow.id as string) as Record<string, unknown>[];

      for (const row of stepRows) {
        const promo = parsePromoOutput(row.output);
        if (promo) return promo;
      }
      return null;
    } catch {
      return null;
    }
  }

  async adoptOwner(fromOwnerId: string, toOwnerId: string): Promise<void> {
    if (fromOwnerId === toOwnerId) return;
    const adoptedAt = Date.now();
    const move = this.db.transaction(() => {
      const existingAlias = this.db
        .prepare(
          `SELECT to_owner_id
           FROM stripe_owner_adoptions
           WHERE from_owner_id = ?`,
        )
        .get(fromOwnerId) as { to_owner_id: string } | undefined;
      if (existingAlias && existingAlias.to_owner_id !== toOwnerId) {
        const existingTarget = resolveStripeOwnerAlias(
          this.db,
          existingAlias.to_owner_id,
        );
        const requestedTarget = resolveStripeOwnerAlias(this.db, toOwnerId);
        if (existingTarget !== requestedTarget) {
          throw new Error(
            "Stripe owner adoption conflicts with prior ownership",
          );
        }
      }
      const requested = stripeOwnerAliasResolution(this.db, toOwnerId);
      const effectiveTarget = requested.ownerId;
      if (effectiveTarget === fromOwnerId) {
        throw new Error("Stripe owner adoption would create a cycle");
      }
      if (
        !existingAlias
        && maxStripeOwnerAncestorDepth(this.db, fromOwnerId)
          + 1
          + requested.depth > 31
      ) {
        throw new Error("Stripe owner adoption chain is too deep");
      }
      this.db
        .prepare(`UPDATE flows SET owner_id = ? WHERE owner_id = ?`)
        .run(effectiveTarget, fromOwnerId);
      this.db
        .prepare(`UPDATE usage SET owner_id = ? WHERE owner_id = ?`)
        .run(effectiveTarget, fromOwnerId);
      this.db
        .prepare(`UPDATE credits SET owner_id = ? WHERE owner_id = ?`)
        .run(effectiveTarget, fromOwnerId);
      this.db
        .prepare(`UPDATE connections
          SET owner_id = ?,
              lifecycle_revision = lifecycle_revision + 1,
              updated_at = MAX(updated_at + 1, ?)
          WHERE owner_id = ?`)
        .run(effectiveTarget, adoptedAt, fromOwnerId);
      // Resource rows participate in this same workspace transaction. Their
      // immutable identity/content stays fixed; adoption changes owner context.
      this.db
        .prepare(`UPDATE resource_releases SET owner_id = ? WHERE owner_id = ?`)
        .run(effectiveTarget, fromOwnerId);
      this.db
        .prepare(`UPDATE resource_run_receipts SET owner_id = ? WHERE owner_id = ?`)
        .run(effectiveTarget, fromOwnerId);
      this.db
        .prepare(
          `UPDATE resource_products
           SET owner_id = ?, updated_at = ?
           WHERE owner_id = ?`,
        )
        .run(effectiveTarget, new Date(adoptedAt).toISOString(), fromOwnerId);
      const targetWallet = this.db
        .prepare(`SELECT owner_id FROM wallets WHERE owner_id = ?`)
        .get(effectiveTarget);
      if (!targetWallet) {
        this.db
          .prepare(`UPDATE wallets SET owner_id = ? WHERE owner_id = ?`)
          .run(effectiveTarget, fromOwnerId);
      }
      if (!existingAlias) {
        this.db
          .prepare(
            `INSERT INTO stripe_owner_adoptions
               (from_owner_id, to_owner_id, adopted_at)
             VALUES (?, ?, ?)`,
          )
          .run(
            fromOwnerId,
            toOwnerId,
            new Date(adoptedAt).toISOString(),
          );
      }
    });
    move();
  }

  async ping(): Promise<void> {
    this.db.prepare("SELECT 1").get();
  }

  async recordHealthCheck(input: RecordHealthCheckInput): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO health_checks
             (id, status, db_ok, db_latency_ms, gateway_ok, gateway_latency_ms,
              facilitator_ok, facilitator_latency_ms, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.status,
          input.dbOk ? 1 : 0,
          Math.round(input.dbLatencyMs),
          input.gatewayOk ? 1 : 0,
          Math.round(input.gatewayLatencyMs),
          input.facilitatorOk ? 1 : 0,
          Math.round(input.facilitatorLatencyMs),
          new Date().toISOString(),
        );
    } catch (error) {
      // Table may not exist yet (migration pending) — dark-deploy safe.
      console.error("health_checks write failed", error);
    }
  }

  async getHealthUptime(sinceMs: number): Promise<HealthUptimeStats> {
    const empty: HealthUptimeStats = {
      total: 0,
      ok: 0,
      degraded: 0,
      down: 0,
      firstAt: null,
      lastAt: null,
      avgDbLatencyMs: null,
      avgGatewayLatencyMs: null,
      avgFacilitatorLatencyMs: null,
    };
    try {
      const since = new Date(sinceMs).toISOString();
      const row = this.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
             SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
             MIN(checked_at) AS first_at,
             MAX(checked_at) AS last_at,
             AVG(db_latency_ms) AS avg_db,
             AVG(gateway_latency_ms) AS avg_gateway,
             AVG(facilitator_latency_ms) AS avg_facilitator
           FROM health_checks WHERE checked_at >= ?`,
        )
        .get(since) as Record<string, unknown> | undefined;
      const total = Number(row?.total ?? 0);
      if (!row || total === 0) return empty;
      return {
        total,
        ok: Number(row.ok ?? 0),
        degraded: Number(row.degraded ?? 0),
        down: Number(row.down ?? 0),
        firstAt: (row.first_at as string | null) ?? null,
        lastAt: (row.last_at as string | null) ?? null,
        avgDbLatencyMs: row.avg_db == null ? null : Math.round(Number(row.avg_db)),
        avgGatewayLatencyMs:
          row.avg_gateway == null ? null : Math.round(Number(row.avg_gateway)),
        avgFacilitatorLatencyMs:
          row.avg_facilitator == null ? null : Math.round(Number(row.avg_facilitator)),
      };
    } catch {
      // Table may not exist yet (migration pending) — dark-deploy safe.
      return empty;
    }
  }

  async getRunOutcomeStats(sinceMs: number): Promise<RunOutcomeStats> {
    const statusRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM runs
         WHERE agent_id IS NOT NULL AND started_at >= ? GROUP BY status`,
      )
      .all(sinceMs) as Array<{ status: string; n: number }>;
    let done = 0;
    let errored = 0;
    let running = 0;
    for (const r of statusRows) {
      if (r.status === "done") done = Number(r.n);
      else if (r.status === "error") errored = Number(r.n);
      else if (r.status === "running") running = Number(r.n);
    }
    const agentsRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT agent_id) AS n FROM runs
         WHERE agent_id IS NOT NULL AND started_at >= ?`,
      )
      .get(sinceMs) as { n: number } | undefined;
    const durationRows = this.db
      .prepare(
        `SELECT (finished_at - started_at) AS d FROM runs
         WHERE agent_id IS NOT NULL AND started_at >= ?
           AND finished_at IS NOT NULL AND finished_at >= started_at`,
      )
      .all(sinceMs) as Array<{ d: number }>;
    return {
      total: done + errored + running,
      done,
      error: errored,
      running,
      medianDurationMs: medianOf(durationRows.map((r) => Number(r.d))),
      agentsLive: Number(agentsRow?.n ?? 0),
    };
  }

  async createProspect(record: ProspectRecord): Promise<ProspectRecord> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    this.db.prepare(
      `INSERT INTO prospect_records
         (id, owner_id, domain, stage, record_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.id,
      parsed.ownerId,
      parsed.domain,
      parsed.stage,
      JSON.stringify(parsed),
      parsed.revision,
      parsed.createdAt,
      parsed.updatedAt,
    );
    return parsed;
  }

  async getProspect(id: string, ownerId: string): Promise<ProspectRecord | null> {
    const row = this.db.prepare(
      "SELECT domain, stage, record_json, revision, created_at, updated_at FROM prospect_records WHERE id = ? AND owner_id = ?",
    ).get(id, ownerId) as { domain: string; stage: string; record_json: string; revision: number; created_at: string; updated_at: string } | undefined;
    if (!row) return null;
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(JSON.parse(row.record_json)));
    if (row.domain !== parsed.domain || row.stage !== parsed.stage || row.revision !== parsed.revision || row.created_at !== parsed.createdAt || row.updated_at !== parsed.updatedAt) throw new Error("Prospect indexed columns drift from record JSON");
    return parsed;
  }

  async listProspects(ownerId: string): Promise<ProspectRecord[]> {
    const rows = this.db.prepare(
      "SELECT domain, stage, record_json, revision, created_at, updated_at FROM prospect_records WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 500",
    ).all(ownerId) as Array<{ domain: string; stage: string; record_json: string; revision: number; created_at: string; updated_at: string }>;
    return rows.map((row) => {
      const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(JSON.parse(row.record_json)));
      if (row.domain !== parsed.domain || row.stage !== parsed.stage || row.revision !== parsed.revision || row.created_at !== parsed.createdAt || row.updated_at !== parsed.updatedAt) throw new Error("Prospect indexed columns drift from record JSON");
      return parsed;
    });
  }

  async updateProspect(record: ProspectRecord, expectedRevision: number): Promise<ProspectRecord | null> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    const result = this.db.prepare(
      `UPDATE prospect_records
       SET stage = ?, record_json = ?, revision = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND revision = ?`,
    ).run(
      parsed.stage,
      JSON.stringify(parsed),
      parsed.revision,
      parsed.updatedAt,
      parsed.id,
      parsed.ownerId,
      expectedRevision,
    );
    return result.changes === 1 ? parsed : null;
  }

  async updateProspectUnlessSuppressed(record: ProspectRecord, expectedRevision: number, emailDigest: string): Promise<ProspectRecord | null> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    return this.db.transaction((): ProspectRecord | null => {
      if (this.db.prepare("SELECT 1 FROM prospect_recipient_suppressions WHERE owner_id = ? AND email_sha256 = ?").get(parsed.ownerId, emailDigest)) return null;
      const result = this.db.prepare(`UPDATE prospect_records SET stage = ?, record_json = ?, revision = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?`)
        .run(parsed.stage, JSON.stringify(parsed), parsed.revision, parsed.updatedAt, parsed.id, parsed.ownerId, expectedRevision);
      return result.changes === 1 ? parsed : null;
    }).immediate();
  }

  async isProspectRecipientSuppressed(ownerId: string, emailDigest: string): Promise<boolean> {
    const row = this.db.prepare(
      "SELECT 1 AS found FROM prospect_recipient_suppressions WHERE owner_id = ? AND email_sha256 = ?",
    ).get(ownerId, emailDigest) as { found: number } | undefined;
    return row?.found === 1;
  }

  async optOutProspect(record: ProspectRecord, expectedRevision: number, emailDigest: string): Promise<ProspectRecord | null> {
    return this.suppressProspect(record, expectedRevision, emailDigest, "opt-out");
  }

  async suppressProspect(record: ProspectRecord, expectedRevision: number, emailDigest: string, reason: "opt-out" | "operator"): Promise<ProspectRecord | null> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    const optOut = this.db.transaction((): ProspectRecord | null => {
      const result = this.db.prepare(
        `UPDATE prospect_records
         SET stage = ?, record_json = ?, revision = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND revision = ?`,
      ).run(parsed.stage, JSON.stringify(parsed), parsed.revision, parsed.updatedAt, parsed.id, parsed.ownerId, expectedRevision);
      if (result.changes !== 1) return null;
      this.db.prepare(
        `INSERT INTO prospect_recipient_suppressions (owner_id, email_sha256, reason, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (owner_id, email_sha256) DO NOTHING`,
      ).run(parsed.ownerId, emailDigest, reason, parsed.suppression.recordedAt);
      return parsed;
    });
    return optOut();
  }

  async redactProspect(id: string, ownerId: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM prospect_records WHERE id = ? AND owner_id = ?").run(id, ownerId).changes === 1;
  }
}
