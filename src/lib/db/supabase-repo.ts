/** Supabase implementation of FlowRepo. Uses a server-only credential boundary. */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePromoOutput } from "../promo-output";
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
import { filterDue, parseCron } from "../cron";
import { isFlowGraphV2, parseSupportedFlowGraph } from "../flow/graph-schema";
import type {
  FlowCallableInterface,
  SubflowReference,
  SupportedFlowGraph,
} from "../flow/types";
import { hashCallableInterface, normalizeSubflowReference } from "../flow/subflow-reference";
import type {
  SubflowBreadcrumb,
  SubflowBreadcrumbRepository,
} from "../flow/subflow-breadcrumbs";
import { hashFlowGraph } from "../projects/hash";
import {
  mutationValueWithinBudget,
  type FlowMutationInput,
  type FlowMutationResult,
} from "../flow/flow-mutation-service";
import {
  AP2_REPLAY_STORE_ATTESTATION,
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
  GuidedFlowMutationInput,
  HealthUptimeStats,
  RecordHealthCheckInput,
  ReserveAp2AuthorizationInput,
  ReserveAp2AuthorizationResult,
  RunOutcomeStats,
  RunRecord,
  RunStepRecord,
  SaveFlowInput,
  ScheduleRecord,
  ScrubExpiredAp2TerminalEvidenceInput,
  SettlementRecord,
  SiteVerificationRecord,
  SiteVerificationRequirement,
  StripeRevenueEventInput,
  StripeRevenueRefundState,
  StripeRevenueWriteResult,
  TransitionAp2AuthorizationInput,
  UpdateAgentInput,
  UpdateEmployeeInput,
  UpsertAgentListingInput,
  UsageRecord,
  WalletRecord,
} from "./repo";
import { createServerSupabaseClient } from "./supabase-server-client";
import type {
  CreateModerationReportInput,
  ModerationQueueQuery,
  ModerationReportRecord,
  ModerationReason,
  ModerationStatus,
  ModerationSubjectType,
  UpdateModerationReportInput,
} from "../moderation/types";

function toMs(ts: string | null): number | null {
  return ts ? new Date(ts).getTime() : null;
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

/** Missing company tables are the one deliberate dark-deploy exception. */
function isMissingCompanyTableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return code === "42P01" || code === "PGRST205";
}

function databaseError(error: unknown, fallback: string): Error {
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.length > 0) return new Error(message);
  }
  return error instanceof Error ? error : new Error(fallback);
}

// Breadcrumb graph handling mirrors sqlite-repo. The sqlite store persists
// graphs as JSON text and caps size in SQL; Supabase columns are jsonb, so
// rows arrive parsed and the byte cap is enforced here after serialization.
const MAX_BREADCRUMB_GRAPH_BYTES = 2 * 1024 * 1024;

type BreadcrumbGraphReference =
  | { readonly kind: "legacy"; readonly flowId: string }
  | SubflowReference;

function breadcrumbCallableInterfaceOf(graph: SupportedFlowGraph): FlowCallableInterface | undefined {
  return isFlowGraphV2(graph) ? graph.callableInterface : undefined;
}

function safeParseJsonbGraph(raw: unknown): SupportedFlowGraph | null {
  try {
    const decoded: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (decoded === null || decoded === undefined) return null;
    if (Buffer.byteLength(JSON.stringify(decoded), "utf8") > MAX_BREADCRUMB_GRAPH_BYTES) return null;
    if (!mutationValueWithinBudget(decoded)) return null;
    return parseSupportedFlowGraph(decoded);
  } catch {
    return null;
  }
}

function breadcrumbGraphReferences(graph: SupportedFlowGraph): BreadcrumbGraphReference[] {
  const references: BreadcrumbGraphReference[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "subflow" && node.type !== "loop") continue;
    const normalized = normalizeSubflowReference(node.params);
    references.push(normalized.kind === "typed" ? normalized.reference : normalized);
  }
  return references;
}

function breadcrumbReferenceReceiptMatches(
  reference: BreadcrumbGraphReference,
  graph: SupportedFlowGraph,
  semanticHash?: string,
): boolean {
  if (reference.kind === "legacy") return true;
  const callable = breadcrumbCallableInterfaceOf(graph);
  if (!callable || hashCallableInterface(callable) !== reference.interfaceHash) return false;
  return reference.kind !== "pinned" || semanticHash === reference.contentHash;
}

/** Given "YYYY-MM", return the ISO prefix for the start of the next month. */
function nextMonthPrefix(monthPrefix: string): string {
  const [year, month] = monthPrefix.split("-").map(Number) as [number, number];
  const next = new Date(year, month, 1); // month is 1-based here, so this is first day of next month
  return next.toISOString().slice(0, 10) + "T00:00:00.000Z";
}

export class SupabaseRepo implements FlowRepo {
  private readonly db: SupabaseClient;

  constructor(client: SupabaseClient = createServerSupabaseClient()) {
    this.db = client;
  }

  async saveFlow(input: SaveFlowInput): Promise<FlowRecord> {
    const result = await this.mutateFlow({
      ...(input.id ? { id: input.id } : {}),
      ownerId: input.ownerId,
      name: input.name,
      graph: input.graph,
    });
    if (result.status === "saved") return result.flow;
    if (result.status === "conflict" || result.status === "not-found") {
      throw new Error("Flow ownership conflict");
    }
    throw new Error("Invalid flow mutation");
  }

  async getFlow(id: string): Promise<FlowRecord | null> {
    const { data } = await this.db.from("flows").select().eq("id", id).maybeSingle();
    return data ? this.toFlow(data) : null;
  }

  async listFlowsByIds(ids: readonly string[]): Promise<FlowRecord[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const { data, error } = await this.db.from("flows").select().in("id", uniqueIds);
    if (error) throw databaseError(error, "Failed to list catalog flows");
    return (data ?? []).map((row) => this.toFlow(row));
  }

  async getOwnedFlow(id: string, ownerId: string): Promise<FlowRecord | null> {
    const { data } = await this.db
      .from("flows")
      .select()
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    return data ? this.toFlow(data) : null;
  }

  async listFlows(ownerId: string): Promise<FlowRecord[]> {
    const { data, error } = await this.db
      .from("flows")
      .select()
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false });
    if (error) throw databaseError(error, "Failed to list flows");
    return (data ?? []).map((r) => this.toFlow(r));
  }

  async readSubflowBreadcrumbs(
    input: Parameters<SubflowBreadcrumbRepository["readSubflowBreadcrumbs"]>[0],
  ): ReturnType<SubflowBreadcrumbRepository["readSubflowBreadcrumbs"]> {
    const direct = input.trail.length === 0;
    const requested = direct ? [{ flowId: input.currentFlowId }] : input.trail;
    if (requested.length < 1 || requested.length > 32 ||
        requested.at(-1)?.flowId !== input.currentFlowId ||
        new Set(requested.map(({ flowId }) => flowId)).size !== requested.length) return null;

    const ids = requested.map(({ flowId }) => flowId);
    // Owner-scoped fetch: every flow in the trail must belong to the caller,
    // which also anchors the version reads below to owned flows only.
    const { data, error } = await this.db
      .from("flows")
      .select("id, name, graph")
      .eq("owner_id", input.ownerId)
      .in("id", ids);
    if (error) throw databaseError(error, "Failed to read breadcrumb flows");
    const rows = data ?? [];
    if (rows.length !== ids.length) return null;

    const flows = new Map<string, { readonly name: string; readonly graph: SupportedFlowGraph }>();
    for (const row of rows as Array<{ id: unknown; name: unknown; graph: unknown }>) {
      if (typeof row.id !== "string" || typeof row.name !== "string" ||
          row.id.length < 1 || Buffer.byteLength(row.id, "utf8") > 512 ||
          row.name.length < 1 || row.name.length > 200 || Buffer.byteLength(row.name, "utf8") > 200) return null;
      const graph = safeParseJsonbGraph(row.graph);
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
        // Ownership already established: item.flowId survived the owner-scoped
        // flows fetch above, so a version row keyed to it is owned too.
        const { data: versionRow, error: versionError } = await this.db
          .from("flow_versions")
          .select("version_number, semantic_hash, graph")
          .eq("id", item.versionId)
          .eq("flow_id", item.flowId)
          .maybeSingle();
        if (versionError) throw databaseError(versionError, "Failed to read breadcrumb version");
        if (!versionRow) return null;
        const versionNumber: unknown = versionRow.version_number;
        if (!Number.isSafeInteger(versionNumber) || Number(versionNumber) < 1 ||
            versionRow.semantic_hash !== item.contentHash) return null;
        const versionGraph = safeParseJsonbGraph(versionRow.graph);
        if (!versionGraph || hashFlowGraph(versionGraph, { semantic: true }) !== item.contentHash) return null;
        pin = { versionNumber: Number(versionNumber), graph: versionGraph };
      }
      effectiveGraphs.set(item.flowId, pin?.graph ?? flow.graph);

      if (index > 0) {
        const parentGraph = effectiveGraphs.get(requested[index - 1]!.flowId);
        if (!parentGraph) return null;
        let references: BreadcrumbGraphReference[];
        try {
          references = breadcrumbGraphReferences(parentGraph);
        } catch {
          return null;
        }
        const matches = references.some((reference) => {
          if (reference.kind === "legacy" || reference.flowId !== item.flowId) return false;
          if (pin === null) {
            return reference.kind === "draft" &&
              breadcrumbReferenceReceiptMatches(reference, flow.graph);
          }
          return reference.kind === "pinned" &&
            reference.versionId === item.versionId &&
            reference.contentHash === item.contentHash &&
            breadcrumbReferenceReceiptMatches(reference, pin.graph, item.contentHash);
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
  }

  async deleteFlow(id: string, ownerId: string): Promise<boolean> {
    // Ownership check up front; the dependent deletes below are keyed on the
    // flow id only after this row is confirmed to belong to the caller.
    const { data: owned, error: ownedError } = await this.db
      .from("flows")
      .select("id")
      .eq("id", id)
      .eq("owner_id", ownerId);
    if (ownedError) throw new Error(ownedError.message);
    if ((owned ?? []).length === 0) return false;
    // Deploy-on-launch writes version/deployment/binding rows whose foreign
    // keys are `on delete no action` in prod (phase-1-projects-and-versions),
    // so a launched flow can only be deleted child-first. Missing tables are
    // tolerated (pre-migration prod) — flows cascade agents/runs themselves.
    const { data: versions } = await this.db
      .from("flow_versions")
      .select("id")
      .eq("flow_id", id);
    const versionIds = (versions ?? []).map((v) => (v as { id: string }).id);
    if (versionIds.length > 0) {
      await this.db.from("dependency_pins").delete().in("flow_version_id", versionIds);
    }
    await this.db.from("deployments").delete().eq("flow_id", id);
    await this.db.from("flow_versions").delete().eq("flow_id", id);
    await this.db.from("flow_project_bindings").delete().eq("flow_id", id);
    const { data, error } = await this.db
      .from("flows")
      .delete()
      .eq("id", id)
      .eq("owner_id", ownerId)
      .select("id");
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }

  /**
   * Narrow v1: covers a flow graph with no cross-flow ("subflow") references,
   * which is every template in the seed catalog. Cross-flow references need
   * the bounded-DFS cycle detection and impact-receipt gating that
   * SqliteRepo's mutateFlowInCurrentTransaction implements (see that method
   * for the full semantics) — Postgres doesn't get that closure logic here,
   * so a graph containing a `subflow` node is refused with "invalid-reference"
   * rather than silently accepted without cycle protection. Owner-scoped
   * select-then-write below is optimistic-concurrency, not a single ACID
   * transaction; the `.eq("owner_id", ...)` filter on the write is what keeps
   * a caller from ever mutating another owner's row, and a row-count/error
   * check after the write reports a lost race as "conflict" instead of
   * silently succeeding.
   */
  async mutateFlow(input: FlowMutationInput): Promise<FlowMutationResult> {
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

    // Cross-flow references are out of scope for this narrow driver path —
    // both Subflow and Loop can execute another flow, so refuse either rather
    // than accepting an unvalidated ownership or cycle risk.
    if (acceptedGraph.nodes.some((node) => node.type === "subflow" || node.type === "loop")) {
      return { status: "invalid-reference" };
    }
    // The impact-receipt flow only exists to gate a breaking change to a
    // subflow other flows depend on; unreachable once subflow refs are
    // refused above, so any caller-supplied receipt here is stale/foreign.
    if (input.impactReceipt !== undefined) {
      return { status: "invalid-reference" };
    }

    const id = input.id ?? randomUUID();
    const { data: existingRow, error: existingError } = await this.db
      .from("flows")
      .select()
      .eq("id", id)
      .eq("owner_id", input.ownerId)
      .maybeSingle();

    if (existingError) return { status: "conflict" };
    if (input.mustExist && !existingRow) return { status: "not-found" };
    if (input.createOnly && existingRow) return { status: "conflict" };
    const existingUpdatedAt = existingRow
      ? toMs(existingRow.updated_at as string)
      : null;
    if (input.expectedUpdatedAt !== undefined) {
      if (!existingRow) return { status: "conflict" };
      if (existingUpdatedAt !== input.expectedUpdatedAt) return { status: "conflict" };
    }

    if (input.validateOnly) {
      if (!existingRow) return { status: "not-found" };
      const existingFlow = this.toFlow(existingRow);
      if (
        existingFlow.name !== input.name ||
        JSON.stringify(existingFlow.graph) !== JSON.stringify(acceptedGraph)
      ) {
        return { status: "conflict" };
      }
      return { status: "saved", flow: existingFlow };
    }

    const updatedAtIso = new Date(
      existingRow ? Math.max(Date.now(), (existingUpdatedAt ?? -1) + 1) : Date.now(),
    ).toISOString();
    if (existingRow) {
      const update = this.db
        .from("flows")
        .update({ name: input.name, graph: acceptedGraph, updated_at: updatedAtIso })
        .eq("id", id)
        .eq("owner_id", input.ownerId);
      const constrained = input.expectedUpdatedAt === undefined
        ? update
        : update.eq("updated_at", existingRow.updated_at);
      const { data, error } = await constrained
        .select()
        .maybeSingle();
      if (error || !data) return { status: "conflict" };
      return { status: "saved", flow: this.toFlow(data) };
    }

    const { data, error } = await this.db
      .from("flows")
      .insert({ id, owner_id: input.ownerId, name: input.name, graph: acceptedGraph, updated_at: updatedAtIso })
      .select()
      .maybeSingle();
    if (error || !data) return { status: "conflict" };
    return { status: "saved", flow: this.toFlow(data) };
  }

  async mutateGuidedFlow(input: GuidedFlowMutationInput): Promise<FlowMutationResult> {
    if (
      !mutationValueWithinBudget(input.graph) ||
      typeof input.id !== "string" || input.id.length < 1 || input.id.length > 512 ||
      input.mustExist !== true ||
      typeof input.ownerId !== "string" || input.ownerId.length < 1 || input.ownerId.length > 512 ||
      typeof input.name !== "string" || input.name.length < 1 || input.name.trim() !== input.name ||
      Buffer.byteLength(input.name, "utf8") > 200 ||
      !Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt! < 0 ||
      !Number.isFinite(input.priceUsdc) || input.priceUsdc < 0 ||
      (input.scheduleCron !== null && parseCron(input.scheduleCron) === null) ||
      input.impactReceipt !== undefined || input.validateOnly === true
    ) return { status: "invalid-reference" };
    let acceptedGraph: SupportedFlowGraph;
    try {
      acceptedGraph = parseSupportedFlowGraph(input.graph);
    } catch {
      return { status: "invalid-reference" };
    }
    if (acceptedGraph.nodes.some((node) => node.type === "subflow" || node.type === "loop")) {
      return { status: "invalid-reference" };
    }
    const { data, error } = await this.db.rpc("agent_studio_mutate_guided_flow", {
      p_owner_id: input.ownerId,
      p_flow_id: input.id,
      p_expected_updated_at: new Date(input.expectedUpdatedAt!).toISOString(),
      p_name: input.name,
      p_graph: acceptedGraph,
      p_price_usdc: input.priceUsdc,
      p_schedule_cron: input.scheduleCron,
    });
    if (error) throw databaseError(error, "Failed to mutate Guided flow");
    if (typeof data !== "string") return { status: "conflict" };
    const updatedAt = toMs(data);
    if (updatedAt === null) return { status: "conflict" };
    return {
      status: "saved",
      flow: {
        id: input.id,
        ownerId: input.ownerId,
        name: input.name,
        graph: acceptedGraph,
        updatedAt,
      },
    };
  }

  private toFlow(row: Record<string, unknown>): FlowRecord {
    return {
      id: row.id as string,
      ownerId: row.owner_id as string,
      name: row.name as string,
      graph: parseSupportedFlowGraph(row.graph),
      updatedAt: toMs(row.updated_at as string) ?? Date.now(),
    };
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const { data, error } = await this.db
      .from("agents")
      .insert({
        flow_id: input.flowId,
        slug: input.slug,
        status: input.status ?? "draft",
        price_usdc: input.priceUsdc ?? 0,
        // Explicit false: new agents start with settlement OFF (owner opts
        // in). Never rely on the column default here, and never reinterpret
        // NULL - pre-existing NULL rows must stay LIVE (Phase 9 note in
        // toAgent below).
        settlement_live: false,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return this.toAgent(data);
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const { data } = await this.db.from("agents").select().eq("id", id).maybeSingle();
    return data ? this.toAgent(data) : null;
  }

  async getAgentBySlug(slug: string): Promise<AgentRecord | null> {
    const { data } = await this.db.from("agents").select().eq("slug", slug).maybeSingle();
    return data ? this.toAgent(data) : null;
  }

  async getAgentByFlowId(flowId: string): Promise<AgentRecord | null> {
    const { data } = await this.db
      .from("agents")
      .select()
      .eq("flow_id", flowId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return data ? this.toAgent(data) : null;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<AgentRecord | null> {
    const patch: Record<string, unknown> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.priceUsdc !== undefined) patch.price_usdc = input.priceUsdc;
    if (input.settlementLive !== undefined) patch.settlement_live = input.settlementLive;
    if (Object.keys(patch).length === 0) return this.getAgent(id);
    const { data, error } = await this.db
      .from("agents")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.toAgent(data) : null;
  }

  async listLiveAgents(): Promise<AgentRecord[]> {
    const { data } = await this.db
      .from("agents")
      .select()
      .eq("status", "live")
      .order("created_at", { ascending: false });
    return (data ?? []).map((r) => this.toAgent(r));
  }

  async listLiveAgentsWithFlows(): Promise<import("./repo").LiveAgentFlowRecord[]> {
    const { data, error } = await this.db
      .from("agents")
      .select("*, flow:flows!inner(*)")
      .eq("status", "live")
      .order("created_at", { ascending: false });
    if (error) throw databaseError(error, "Failed to list live catalog sources");
    return (data ?? []).map((row) => {
      const flow = row.flow;
      if (flow === null || typeof flow !== "object" || Array.isArray(flow)) {
        throw new Error("Invalid live catalog flow relation");
      }
      return {
        agent: this.toAgent(row),
        flow: this.toFlow(flow as Record<string, unknown>),
      };
    });
  }

  async listAgentsByOwner(ownerId: string): Promise<AgentRecord[]> {
    const { data: flowRows } = await this.db
      .from("flows")
      .select("id")
      .eq("owner_id", ownerId);
    const flowIds = (flowRows ?? []).map((r) => r.id as string);
    if (flowIds.length === 0) return [];
    const { data } = await this.db
      .from("agents")
      .select()
      .in("flow_id", flowIds)
      .order("created_at", { ascending: false });
    return (data ?? []).map((r) => this.toAgent(r));
  }

  private toAgent(row: Record<string, unknown>): AgentRecord {
    return {
      id: row.id as string,
      flowId: row.flow_id as string,
      slug: row.slug as string,
      status: row.status as "draft" | "live",
      priceUsdc: Number(row.price_usdc ?? 0),
      createdAt: toMs(row.created_at as string) ?? Date.now(),
      // SEMANTICS (do not flip back to opt-in — see AI_HANDOFF Phase 9 hotfix):
      // settlement_live is an opt-OUT toggle. Missing column / NULL = LIVE,
      // because prod ran fully live (gate + settle) before this column existed;
      // "missing = off" silently disabled the x402 402 GATE platform-wide and
      // made every priced agent free to call. Only an explicit false (owner
      // toggled off) disables settlement. The global X402_SKIP_SETTLEMENT env
      // remains the master kill-switch — per-agent opt-in on top of it is not
      // a safety layer, it is an outage of the payment gate.
      settlementLive: row.settlement_live !== false,
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const { data, error } = await this.db
      .from("runs")
      .insert({
        ...(input.id ? { id: input.id } : {}),
        flow_id: input.flowId,
        agent_id: input.agentId ?? null,
        trigger: input.trigger,
        trigger_input: input.triggerInput ?? null,
        run_variables: input.runVariables ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return this.toRun(data);
  }

  async appendStep(step: AppendStepInput): Promise<void> {
    const { error } = await this.db.from("run_steps").insert({
      run_id: step.runId,
      node_id: step.nodeId,
      node_type: step.nodeType,
      status: step.status,
      cost_usdc: step.costUsdc,
      output: step.output ?? null,
      error: step.error ?? null,
    });
    if (error) throw new Error(error.message);
  }

  async finishRun(id: string, status: "done" | "error", totalCostUsdc: number): Promise<void> {
    await this.db
      .from("runs")
      .update({ status, total_cost_usdc: totalCostUsdc, finished_at: new Date().toISOString() })
      .eq("id", id);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const { data } = await this.db.from("runs").select().eq("id", id).maybeSingle();
    return data ? this.toRun(data) : null;
  }

  async listRuns(flowId: string): Promise<RunRecord[]> {
    const { data, error } = await this.db
      .from("runs")
      .select()
      .eq("flow_id", flowId)
      .order("started_at", { ascending: false });
    // Runs are a core table, not part of the deliberate company-table
    // dark-deploy exception. Treat every read error as fatal so callers do
    // not mistake an unavailable run history for zero spend or a free pass
    // through the fire-cost threshold.
    if (error) throw databaseError(error, "Failed to list runs");
    return (data ?? []).map((r) => this.toRun(r));
  }

  async listRunsByOwner(ownerId: string, limit: number): Promise<RunRecord[]> {
    const { data: flowRows } = await this.db
      .from("flows")
      .select("id")
      .eq("owner_id", ownerId);
    const flowIds = (flowRows ?? []).map((r) => r.id as string);
    if (flowIds.length === 0) return [];
    const { data } = await this.db
      .from("runs")
      .select()
      .in("flow_id", flowIds)
      .order("started_at", { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => this.toRun(r));
  }

  async countRunsByAgent(agentIds: string[], trigger?: string): Promise<Record<string, number>> {
    if (agentIds.length === 0) return {};
    let query = this.db.from("runs").select("agent_id").in("agent_id", agentIds);
    if (trigger !== undefined) query = query.eq("trigger", trigger);
    const { data } = await query.limit(5000);
    const out: Record<string, number> = {};
    for (const row of data ?? []) {
      const id = row.agent_id as string | null;
      if (id) out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  }

  private toRun(row: Record<string, unknown>): RunRecord {
    return {
      id: row.id as string,
      flowId: row.flow_id as string,
      agentId: (row.agent_id as string) ?? null,
      trigger: row.trigger as string,
      status: row.status as "running" | "done" | "error",
      totalCostUsdc: Number(row.total_cost_usdc ?? 0),
      startedAt: toMs(row.started_at as string) ?? Date.now(),
      finishedAt: toMs(row.finished_at as string),
      settledAt: (row.settled_at as string) ?? null,
      triggerInput: row.trigger_input ?? null,
      runVariables: row.run_variables ?? null,
    };
  }

  async listRunSteps(runId: string): Promise<RunStepRecord[]> {
    const { data, error } = await this.db
      .from("run_steps")
      .select()
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    // Run steps are part of the core execution ledger. Returning an empty
    // list on read failure would make a persisted error/output disappear
    // from company activity, so this read must fail closed.
    if (error) throw databaseError(error, "Failed to list run steps");
    return (data ?? []).map((row) => ({
      id: row.id as string,
      runId: row.run_id as string,
      nodeId: row.node_id as string,
      nodeType: row.node_type as string,
      status: row.status as string,
      costUsdc: Number(row.cost_usdc ?? 0),
      output: row.output ?? null,
      error: (row.error as string) ?? null,
    }));
  }

  private toModerationReport(row: Record<string, unknown>): ModerationReportRecord {
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
    const now = new Date().toISOString();
    const { data, error } = await this.db.from("moderation_reports").insert({
      id: randomUUID(),
      reporter_owner_id: input.reporterOwnerId,
      subject_owner_id: input.subjectOwnerId,
      subject_type: input.subjectType,
      flow_id: input.flowId ?? null,
      run_id: input.runId ?? null,
      node_id: input.nodeId ?? null,
      agent_id: input.agentId ?? null,
      reason: input.reason,
      status: "open",
      created_at: now,
      updated_at: now,
    }).select().single();
    if (error) throw databaseError(error, "Failed to create moderation report");
    return this.toModerationReport(data);
  }

  async listModerationReports(query: ModerationQueueQuery): Promise<ModerationReportRecord[]> {
    let request = this.db.from("moderation_reports").select()
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit);
    if (query.status) request = request.eq("status", query.status);
    const { data, error } = await request;
    if (error) throw databaseError(error, "Failed to list moderation reports");
    return (data ?? []).map((row) => this.toModerationReport(row));
  }

  async updateModerationReport(
    id: string,
    input: UpdateModerationReportInput,
  ): Promise<ModerationReportRecord | null> {
    const { data: current, error: readError } = await this.db
      .from("moderation_reports")
      .select("reviewer_notes")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw databaseError(readError, "Failed to read moderation report");
    if (!current) return null;
    const now = new Date().toISOString();
    const { data, error } = await this.db.from("moderation_reports").update({
      status: input.status,
      reviewer_notes: input.reviewerNotes === undefined
        ? (current.reviewer_notes as string | null) ?? null
        : input.reviewerNotes,
      reviewed_by: input.reviewedBy,
      updated_at: now,
      reviewed_at: now,
    }).eq("id", id).select().maybeSingle();
    if (error) throw databaseError(error, "Failed to update moderation report");
    return data ? this.toModerationReport(data) : null;
  }

  private toSchedule(row: Record<string, unknown>): ScheduleRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      cron: row.cron as string,
      enabled: Boolean(row.enabled),
      lastRunAt: toMs(row.last_run_at as string),
    };
  }

  async upsertSchedule(input: {
    agentId: string;
    cron: string;
    enabled: boolean;
  }): Promise<ScheduleRecord> {
    // schedules.agent_id has no unique index, so upsert is select-then-write.
    const existing = (await this.listSchedulesByAgents([input.agentId]))[0];
    if (existing) {
      const { data, error } = await this.db
        .from("schedules")
        .update({ cron: input.cron, enabled: input.enabled })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return this.toSchedule(data);
    }
    const { data, error } = await this.db
      .from("schedules")
      .insert({ agent_id: input.agentId, cron: input.cron, enabled: input.enabled })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return this.toSchedule(data);
  }

  async listSchedulesByAgents(agentIds: string[]): Promise<ScheduleRecord[]> {
    if (agentIds.length === 0) return [];
    const { data } = await this.db.from("schedules").select().in("agent_id", agentIds);
    return (data ?? []).map((row) => this.toSchedule(row));
  }

  async dueSchedules(now: number): Promise<ScheduleRecord[]> {
    const { data } = await this.db.from("schedules").select().eq("enabled", true);
    return filterDue(
      (data ?? []).map((row) => this.toSchedule(row)),
      now,
    );
  }

  async markScheduleRun(id: string, at: number): Promise<void> {
    await this.db.from("schedules").update({ last_run_at: new Date(at).toISOString() }).eq("id", id);
  }

  async getWallet(ownerId: string): Promise<WalletRecord | null> {
    const { data } = await this.db.from("wallets").select().eq("owner_id", ownerId).maybeSingle();
    if (!data) return null;
    return {
      ownerId: data.owner_id as string,
      address: data.address as string,
      network: data.network as string,
      label: (data.label as string) ?? null,
    };
  }

  async listWalletsByOwners(ownerIds: readonly string[]): Promise<WalletRecord[]> {
    const uniqueOwnerIds = [...new Set(ownerIds)];
    if (uniqueOwnerIds.length === 0) return [];
    const { data, error } = await this.db
      .from("wallets")
      .select()
      .in("owner_id", uniqueOwnerIds);
    if (error) throw databaseError(error, "Failed to list catalog wallets");
    return (data ?? []).map((row) => ({
      ownerId: row.owner_id as string,
      address: row.address as string,
      network: row.network as string,
      label: (row.label as string) ?? null,
    }));
  }

  async saveWallet(input: {
    ownerId: string;
    address: string;
    network?: string;
    label?: string;
  }): Promise<WalletRecord> {
    const row = {
      owner_id: input.ownerId,
      address: input.address,
      network: input.network ?? "base-mainnet",
      label: input.label ?? null,
    };
    const { data, error } = await this.db
      .from("wallets")
      .upsert(row, { onConflict: "owner_id" })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return {
      ownerId: data.owner_id as string,
      address: data.address as string,
      network: data.network as string,
      label: (data.label as string) ?? null,
    };
  }

  async upsertRelayEndpoint(input: {
    agentId: string;
    url: string;
    secret: string;
    protocolVersion?: 1 | 2;
  }): Promise<import("./repo").RelayEndpointRecord> {
    const createdAt = new Date().toISOString();
    const protocolVersion = input.protocolVersion ?? 1;
    const row: Record<string, unknown> = {
      agent_id: input.agentId,
      url: input.url,
      secret: input.secret,
      created_at: createdAt,
      ...(protocolVersion === 2 ? { protocol_version: 2 } : {}),
    };
    const { data, error } = await this.db
      .from("relay_endpoints")
      .upsert(
        row,
        { onConflict: "agent_id" },
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    return {
      agentId: data.agent_id as string,
      url: data.url as string,
      secret: data.secret as string,
      protocolVersion: data.protocol_version === 2 ? 2 : 1,
      createdAt: data.created_at as string,
    };
  }

  async upsertSiteVerification(input: {
    ownerId: string;
    host: string;
    method: string;
  }): Promise<import("./repo").SiteVerificationRecord> {
    const verifiedAt = new Date().toISOString();
    const { data, error } = await this.db
      .from("site_verifications")
      .upsert(
        { owner_id: input.ownerId, host: input.host, method: input.method, verified_at: verifiedAt },
        { onConflict: "owner_id,host" },
      )
      .select()
      .single();
    // Throws until the migration lands (docs/migrations/site-verifications.sql).
    // Verify then fails loudly with a provisioning message — the safe failure,
    // since an unverifiable agent simply stays unlisted.
    if (error) throw new Error(error.message);
    return {
      ownerId: data.owner_id as string,
      host: data.host as string,
      method: data.method as string,
      verifiedAt: data.verified_at as string,
    };
  }

  async getSiteVerification(
    ownerId: string,
    host: string,
  ): Promise<import("./repo").SiteVerificationRecord | null> {
    try {
      const { data } = await this.db
        .from("site_verifications")
        .select()
        .eq("owner_id", ownerId)
        .eq("host", host)
        .maybeSingle();
      if (!data) return null;
      return {
        ownerId: data.owner_id as string,
        host: data.host as string,
        method: data.method as string,
        verifiedAt: data.verified_at as string,
      };
    } catch {
      // Table may not exist yet (migration pending). Unverified — and
      // therefore unlisted — is the fail-closed direction here.
      return null;
    }
  }

  async listSiteVerificationsByOwnersAndHosts(
    requirements: readonly SiteVerificationRequirement[],
  ): Promise<SiteVerificationRecord[]> {
    const exactPairs = new Set(
      requirements.map(({ ownerId, host }) => JSON.stringify([ownerId, host])),
    );
    if (exactPairs.size === 0) return [];
    const ownerIds = [...new Set(requirements.map(({ ownerId }) => ownerId))];
    const hosts = [...new Set(requirements.map(({ host }) => host))];
    const { data, error } = await this.db
      .from("site_verifications")
      .select()
      .in("owner_id", ownerIds)
      .in("host", hosts);
    if (error) {
      throw databaseError(error, "Failed to list site verification proofs");
    }
    return (data ?? []).flatMap((row) => {
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

  async getRelayEndpoint(agentId: string): Promise<import("./repo").RelayEndpointRecord | null> {
    try {
      const { data } = await this.db
        .from("relay_endpoints")
        .select()
        .eq("agent_id", agentId)
        .maybeSingle();
      if (!data) return null;
      return {
        agentId: data.agent_id as string,
        url: data.url as string,
        secret: data.secret as string,
        protocolVersion: data.protocol_version === 2 ? 2 : 1,
        createdAt: data.created_at as string,
      };
    } catch {
      // Table may not exist yet (migration pending). Treat as no relay.
      return null;
    }
  }

  async upsertWebhookEndpoint(input: {
    agentId: string;
    secretHash: string;
  }): Promise<import("./repo").WebhookEndpointRecord> {
    const createdAt = new Date().toISOString();
    const { data, error } = await this.db
      .from("webhook_endpoints")
      .upsert(
        { agent_id: input.agentId, secret_hash: input.secretHash, created_at: createdAt },
        { onConflict: "agent_id" },
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    return {
      agentId: data.agent_id as string,
      secretHash: data.secret_hash as string,
      createdAt: data.created_at as string,
    };
  }

  async getWebhookEndpoint(agentId: string): Promise<import("./repo").WebhookEndpointRecord | null> {
    try {
      const { data } = await this.db
        .from("webhook_endpoints")
        .select()
        .eq("agent_id", agentId)
        .maybeSingle();
      if (!data) return null;
      return {
        agentId: data.agent_id as string,
        secretHash: data.secret_hash as string,
        createdAt: data.created_at as string,
      };
    } catch {
      // Table may not exist yet (migration pending). Treat as no webhook configured.
      return null;
    }
  }

  async deleteWebhookEndpoint(agentId: string): Promise<boolean> {
    try {
      const { data, error } = await this.db
        .from("webhook_endpoints")
        .delete()
        .eq("agent_id", agentId)
        .select("agent_id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    } catch {
      // Table may not exist yet (migration pending). Nothing to delete.
      return false;
    }
  }

  async stampRunSettled(runId: string, settledAt: string): Promise<void> {
    await this.db.from("runs").update({ settled_at: settledAt }).eq("id", runId);
  }

  async recordSettlement(input: Omit<SettlementRecord, "createdAt">): Promise<void> {
    try {
      const { error } = await this.db.from("settlements").upsert(
        {
          run_id: input.runId,
          agent_id: input.agentId,
          owner_id: input.ownerId,
          gross_usdc: input.grossUsdc,
          creator_usdc: input.creatorUsdc,
          platform_usdc: input.platformUsdc,
          pay_to: input.payTo,
          payout_source: input.payoutSource,
          payer: input.payer,
          tx: input.tx,
          created_at: new Date().toISOString(),
        },
        { onConflict: "run_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
    } catch (error) {
      // Table may not exist yet (migration pending), or a transient write
      // failure — the payment already settled on-chain, so log and continue.
      console.error("settlement ledger write failed", input.runId, error);
    }
  }

  async getSettlementByRun(runId: string): Promise<SettlementRecord | null> {
    try {
      const { data, error } = await this.db
        .from("settlements")
        .select()
        .eq("run_id", runId)
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return {
        runId: String(data.run_id),
        agentId: String(data.agent_id),
        ownerId: String(data.owner_id),
        grossUsdc: Number(data.gross_usdc),
        creatorUsdc: Number(data.creator_usdc),
        platformUsdc: Number(data.platform_usdc),
        payTo: String(data.pay_to),
        payoutSource: data.payout_source as "creator" | "platform",
        payer: (data.payer as string | null) ?? null,
        tx: (data.tx as string | null) ?? null,
        createdAt: String(data.created_at),
      };
    } catch {
      return null;
    }
  }

  async reserveAp2Authorization(
    input: ReserveAp2AuthorizationInput,
  ): Promise<ReserveAp2AuthorizationResult> {
    const createdAt = new Date().toISOString();
    const authorization: Ap2AuthorizationRecord = {
      id: randomUUID(),
      ...input,
      state: "authorized",
      decisionCode: null,
      receiptJson: null,
      resultJson: null,
      runId: null,
      tx: null,
      createdAt,
      updatedAt: createdAt,
    };
    const { error } = await this.db.from("ap2_authorizations").insert({
      id: authorization.id,
      mandate_reference: authorization.mandateReference,
      payment_nonce_hash: authorization.paymentNonceHash,
      request_digest: authorization.requestDigest,
      issuer: authorization.issuer,
      subject_id: authorization.subjectId,
      checkout_hash: authorization.checkoutHash,
      agent_id: authorization.agentId,
      flow_id: authorization.flowId,
      deployment_id: authorization.deploymentId,
      network: authorization.network,
      asset: authorization.asset,
      amount_atomic: authorization.amountAtomic,
      amount_minor_usd: authorization.amountMinorUsd,
      payee_id: authorization.payeeId,
      pay_to: authorization.payTo,
      payer: authorization.payer,
      state: authorization.state,
      decision_code: null,
      receipt_json: null,
      result_json: null,
      expires_at: authorization.expiresAt,
      payment_valid_before: authorization.paymentValidBefore,
      run_id: null,
      tx: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    if (!error) return { status: "reserved", authorization };

    const code = typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : null;
    if (code !== "23505") {
      throw databaseError(error, "Failed to reserve AP2 authorization");
    }
    const existing = await this.getAp2AuthorizationByMandateReference(
      input.mandateReference,
    );
    if (!existing) return { status: "conflict", authorization: null };
    if (
      existing.requestDigest === input.requestDigest &&
      existing.paymentNonceHash === input.paymentNonceHash
    ) {
      return { status: "exact-retry", authorization: existing };
    }
    return { status: "conflict", authorization: existing };
  }

  async getAp2AuthorizationByMandateReference(
    mandateReference: string,
  ): Promise<Ap2AuthorizationRecord | null> {
    const { data, error } = await this.db
      .from("ap2_authorizations")
      .select()
      .eq("mandate_reference", mandateReference)
      .limit(1)
      .maybeSingle();
    if (error) throw databaseError(error, "Failed to read AP2 authorization");
    return data ? this.toAp2Authorization(data) : null;
  }

  async transitionAp2Authorization(
    input: TransitionAp2AuthorizationInput,
  ): Promise<Ap2AuthorizationRecord | null> {
    if (!isAp2AuthorizationTransitionAllowed(input.fromState, input.toState)) {
      throw new Error(`Invalid AP2 authorization transition: ${input.fromState} -> ${input.toState}`);
    }

    const patch: Record<string, unknown> = {
      state: input.toState,
      updated_at: new Date().toISOString(),
    };
    const append = (property: keyof TransitionAp2AuthorizationInput, column: string): void => {
      if (Object.prototype.hasOwnProperty.call(input, property)) patch[column] = input[property] ?? null;
    };
    append("decisionCode", "decision_code");
    append("receiptJson", "receipt_json");
    append("resultJson", "result_json");
    append("runId", "run_id");
    append("tx", "tx");

    const { data, error } = await this.db
      .from("ap2_authorizations")
      .update(patch)
      .eq("id", input.id)
      .eq("state", input.fromState)
      .select()
      .limit(1)
      .maybeSingle();
    if (error) throw databaseError(error, "Failed to transition AP2 authorization");
    return data ? this.toAp2Authorization(data) : null;
  }

  async scrubExpiredAp2TerminalEvidence(
    input: ScrubExpiredAp2TerminalEvidenceInput,
  ): Promise<number> {
    assertValidAp2EvidenceScrubInput(input);
    const terminalStates = ["completed", "rejected", "failed"] as const;
    const eligibleEvidence =
      "result_json.not.is.null,receipt_json->evidenceRetention->>status.is.null,"
      + "receipt_json->evidenceRetention->>status.neq.expired";
    const { data, error } = await this.db
      .from("ap2_authorizations")
      .select("id,state,receipt_json,result_json,updated_at")
      .in("state", [...terminalStates])
      .lt("updated_at", input.terminalBefore)
      .or(eligibleEvidence)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(input.limit);
    if (error) throw databaseError(error, "Failed to select expired AP2 terminal evidence");

    let scrubbed = 0;
    for (const row of data ?? []) {
      const receipt = (row.receipt_json as Ap2SanitizedJson | null) ?? null;
      if (isAp2TerminalEvidenceExpired(receipt)) continue;
      const compacted = compactExpiredAp2TerminalEvidence(receipt, input.scrubbedAt);
      if (!compacted) continue;
      const { error: updateError } = await this.db
        .from("ap2_authorizations")
        .update({ receipt_json: compacted, result_json: null })
        .eq("id", row.id)
        .in("state", [...terminalStates])
        .lt("updated_at", input.terminalBefore)
        .or(eligibleEvidence);
      if (updateError) {
        throw databaseError(updateError, "Failed to scrub expired AP2 terminal evidence");
      }
      scrubbed += 1;
    }
    return scrubbed;
  }

  private toAp2Authorization(row: Record<string, unknown>): Ap2AuthorizationRecord {
    return {
      id: String(row.id),
      mandateReference: String(row.mandate_reference),
      paymentNonceHash: String(row.payment_nonce_hash),
      requestDigest: String(row.request_digest),
      issuer: String(row.issuer),
      subjectId: (row.subject_id as string | null) ?? null,
      checkoutHash: String(row.checkout_hash),
      agentId: String(row.agent_id),
      flowId: String(row.flow_id),
      deploymentId: String(row.deployment_id),
      network: String(row.network),
      asset: String(row.asset),
      amountAtomic: String(row.amount_atomic),
      amountMinorUsd: Number(row.amount_minor_usd),
      payeeId: String(row.payee_id),
      payTo: String(row.pay_to),
      payer: String(row.payer),
      state: row.state as Ap2AuthorizationRecord["state"],
      decisionCode: (row.decision_code as string | null) ?? null,
      receiptJson: (row.receipt_json as Ap2AuthorizationRecord["receiptJson"]) ?? null,
      resultJson: (row.result_json as Ap2AuthorizationRecord["resultJson"]) ?? null,
      expiresAt: String(row.expires_at),
      paymentValidBefore: String(row.payment_valid_before),
      runId: (row.run_id as string | null) ?? null,
      tx: (row.tx as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async checkAp2ReplayStoreReady(): Promise<boolean> {
    try {
      const { data, error } = await this.db.rpc(
        "agent_studio_ap2_replay_store_attestation",
      );
      return !error && data === AP2_REPLAY_STORE_ATTESTATION;
    } catch {
      return false;
    }
  }

  async listAgentListings(agentId: string): Promise<AgentListingRecord[]> {
    try {
      const { data, error } = await this.db
        .from("agent_listings")
        .select()
        .eq("agent_id", agentId)
        .order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => this.toAgentListing(row));
    } catch {
      // Table may not exist yet (migration pending) — dark-deploy safe.
      return [];
    }
  }

  async upsertAgentListing(input: UpsertAgentListingInput): Promise<AgentListingRecord> {
    const now = new Date().toISOString();
    const fallback: AgentListingRecord = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      venueId: input.venueId,
      status: input.status,
      externalUrl: input.externalUrl ?? null,
      submittedAt: now,
      updatedAt: now,
    };
    try {
      // Preserve the original submittedAt when a prior row exists; only status,
      // externalUrl, and updatedAt change on a repeat submission.
      const existing = await this.db
        .from("agent_listings")
        .select("id, submitted_at")
        .eq("agent_id", input.agentId)
        .eq("venue_id", input.venueId)
        .limit(1)
        .maybeSingle();
      const id = (existing.data?.id as string | undefined) ?? fallback.id;
      const submittedAt = (existing.data?.submitted_at as string | undefined) ?? now;
      const { data, error } = await this.db
        .from("agent_listings")
        .upsert(
          {
            id,
            agent_id: input.agentId,
            venue_id: input.venueId,
            status: input.status,
            external_url: input.externalUrl ?? null,
            submitted_at: submittedAt,
            updated_at: now,
          },
          { onConflict: "agent_id,venue_id" },
        )
        .select()
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? this.toAgentListing(data) : { ...fallback, id, submittedAt };
    } catch (error) {
      // Table may not exist yet (migration pending) — return the in-memory
      // record so the submit route can still respond, and log the write miss.
      console.error("agent_listings write failed", input.agentId, input.venueId, error);
      return fallback;
    }
  }

  async appendCeoMessage(input: CreateCeoMessageInput): Promise<CeoMessageRecord> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const proposal = input.proposal ?? null;
    const { error } = await this.db.from("company_ceo_messages").insert({
      id,
      company_id: input.companyId,
      role: input.role,
      content: input.content,
      proposal,
      created_at: createdAt,
    });
    if (error) throw new Error(error.message);
    return { id, companyId: input.companyId, role: input.role, content: input.content, proposal, createdAt };
  }

  async listCeoMessages(companyId: string, limit: number): Promise<CeoMessageRecord[]> {
    // Tie-break on seq, not id — id is a random UUID and two turns
    // appended within the same request commonly share one millisecond of
    // created_at resolution. seq is a generated-always identity column,
    // so it reliably preserves insertion order under that tie.
    const { data, error } = await this.db
      .from("company_ceo_messages")
      .select()
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .order("seq", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? [])
      .map((row) => ({
        id: row.id as string,
        companyId: row.company_id as string,
        role: row.role as CeoMessageRole,
        content: row.content as string,
        proposal: (row.proposal as unknown) ?? null,
        createdAt: row.created_at as string,
      }))
      .reverse();
  }

  private toAgentListing(row: Record<string, unknown>): AgentListingRecord {
    return {
      id: String(row.id),
      agentId: String(row.agent_id),
      venueId: String(row.venue_id),
      status: row.status as AgentListingRecord["status"],
      externalUrl: (row.external_url as string | null) ?? null,
      submittedAt: String(row.submitted_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toCompany(row: Record<string, unknown>): CompanyRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      name: String(row.name),
      mission: String(row.mission),
      status: row.status as CompanyStatus,
      fireCostThresholdUsdc: row.fire_cost_threshold_usdc === null
        ? null
        : Number(row.fire_cost_threshold_usdc),
      createdAt: String(row.created_at),
    };
  }

  private toDepartment(row: Record<string, unknown>): DepartmentRecord {
    return {
      id: String(row.id),
      companyId: String(row.company_id),
      name: String(row.name),
      monthlyBudgetUsdc: row.monthly_budget_usdc === null
        ? null
        : Number(row.monthly_budget_usdc),
    };
  }

  private toEmployee(row: Record<string, unknown>): EmployeeRecord {
    return {
      agentId: String(row.agent_id),
      companyId: String(row.company_id),
      departmentId: String(row.department_id),
      jobDescription: String(row.job_description),
      publishGated: Boolean(row.publish_gated),
      monthlyBudgetUsdc: row.monthly_budget_usdc === null
        ? null
        : Number(row.monthly_budget_usdc),
      // == null also covers undefined, i.e. a production schema where the
      // additive pay_to column has not been applied yet — reads stay safe.
      payTo: row.pay_to == null ? null : String(row.pay_to),
      // Same contract for the org-chart and heartbeat columns: a production
      // schema without them yields the pre-column reading — role null (which
      // resolveEffectiveRole interprets, rather than 'worker' which would
      // orphan the whole chart), no manager, idle, and no heartbeat.
      role: parseEmployeeRole(row.role),
      reportsTo: row.reports_to == null ? null : String(row.reports_to),
      lifecycleStatus: parseLifecycleStatus(row.lifecycle_status),
      heartbeatEnabled: row.heartbeat_enabled == null ? false : Boolean(row.heartbeat_enabled),
      heartbeatIntervalSeconds: row.heartbeat_interval_seconds == null
        ? null
        : Number(row.heartbeat_interval_seconds),
      lastHeartbeatAt: row.last_heartbeat_at == null ? null : String(row.last_heartbeat_at),
    };
  }

  private toApproval(row: Record<string, unknown>): ApprovalRecord {
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
      id: String(row.id),
      companyId: String(row.company_id),
      kind: row.kind as ApprovalKind,
      subjectId: String(row.subject_id),
      status: row.status as ApprovalStatus,
      reason: (row.reason as string | null) ?? null,
      actionSummary: (row.action_summary as string | null) ?? null,
      costSnapshot,
      createdAt: String(row.created_at),
      decidedAt: (row.decided_at as string | null) ?? null,
    };
  }

  async createCompany(input: {
    ownerId: string;
    name: string;
    mission: string;
  }): Promise<CompanyRecord> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const { data, error } = await this.db
      .from("companies")
      .insert({
        id,
        owner_id: input.ownerId,
        name: input.name,
        mission: input.mission,
        status: "draft",
        fire_cost_threshold_usdc: null,
        created_at: createdAt,
      })
      .select()
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to create company");
    return this.toCompany(data);
  }

  async getCompany(id: string): Promise<CompanyRecord | null> {
    try {
      const { data, error } = await this.db
        .from("companies")
        .select()
        .eq("id", id)
        .maybeSingle();
      if (error) {
        if (isMissingCompanyTableError(error)) return null;
        throw databaseError(error, "Failed to read company");
      }
      if (!data) return null;
      return this.toCompany(data);
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return null;
      throw error;
    }
  }

  async listCompaniesByOwner(ownerId: string): Promise<CompanyRecord[]> {
    try {
      const { data, error } = await this.db
        .from("companies")
        .select()
        .eq("owner_id", ownerId)
        .order("created_at", { ascending: false });
      if (error) {
        if (isMissingCompanyTableError(error)) return [];
        throw databaseError(error, "Failed to list companies");
      }
      return (data ?? []).map((row) => this.toCompany(row));
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return [];
      throw databaseError(error, "Failed to list companies");
    }
  }

  async updateCompany(
    id: string,
    input: {
      name?: string;
      mission?: string;
      status?: CompanyStatus;
      fireCostThresholdUsdc?: number | null;
    },
  ): Promise<CompanyRecord | null> {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.mission !== undefined) patch.mission = input.mission;
    if (input.status !== undefined) patch.status = input.status;
    if (input.fireCostThresholdUsdc !== undefined) {
      patch.fire_cost_threshold_usdc = input.fireCostThresholdUsdc;
    }
    if (Object.keys(patch).length === 0) return this.getCompany(id);
    const { data, error } = await this.db
      .from("companies")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.toCompany(data) : null;
  }

  async createDepartment(input: {
    companyId: string;
    name: string;
    monthlyBudgetUsdc?: number | null;
  }): Promise<DepartmentRecord> {
    const id = crypto.randomUUID();
    const { data, error } = await this.db
      .from("company_departments")
      .insert({
        id,
        company_id: input.companyId,
        name: input.name,
        monthly_budget_usdc: input.monthlyBudgetUsdc ?? null,
      })
      .select()
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to create department");
    return this.toDepartment(data);
  }

  async listDepartments(companyId: string): Promise<DepartmentRecord[]> {
    try {
      const { data, error } = await this.db
        .from("company_departments")
        .select()
        .eq("company_id", companyId);
      if (error) {
        if (isMissingCompanyTableError(error)) return [];
        throw databaseError(error, "Failed to list company departments");
      }
      return (data ?? []).map((row) => this.toDepartment(row));
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return [];
      throw databaseError(error, "Failed to list company departments");
    }
  }

  async setDepartmentBudget(id: string, monthlyBudgetUsdc: number | null): Promise<void> {
    const { error } = await this.db
      .from("company_departments")
      .update({ monthly_budget_usdc: monthlyBudgetUsdc })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  async addEmployee(input: EmployeeRecord): Promise<void> {
    const row: Record<string, unknown> = {
      agent_id: input.agentId,
      company_id: input.companyId,
      department_id: input.departmentId,
      job_description: input.jobDescription,
      publish_gated: input.publishGated,
      monthly_budget_usdc: input.monthlyBudgetUsdc,
    };
    // Dark-deploy safe: only send pay_to when set, so hires keep working
    // before the additive company_employees.pay_to migration is applied.
    if (input.payTo !== null) row.pay_to = input.payTo;
    // Identical contract for the org-chart and heartbeat columns. A field at
    // its column default is omitted entirely, so a hire against a production
    // schema that still lacks these columns inserts exactly the eight it has
    // always inserted; only a caller that actually chose a non-default value
    // gets the loud failure.
    //
    // The default comparison is load-bearing, not belt-and-braces. Every
    // repository read populates all six, so `lifecycleStatus` arrives as
    // "idle" and `heartbeatEnabled` as false rather than undefined on any
    // read-then-re-add path. Testing those two against undefined alone would
    // put both columns in the insert and 500 every such hire until the
    // migration lands.
    if (input.role != null) row.role = input.role;
    if (input.reportsTo != null) row.reports_to = input.reportsTo;
    if (input.lifecycleStatus != null && input.lifecycleStatus !== "idle") {
      row.lifecycle_status = input.lifecycleStatus;
    }
    if (input.heartbeatEnabled != null && input.heartbeatEnabled !== false) {
      row.heartbeat_enabled = input.heartbeatEnabled;
    }
    if (input.heartbeatIntervalSeconds != null) {
      row.heartbeat_interval_seconds = input.heartbeatIntervalSeconds;
    }
    if (input.lastHeartbeatAt != null) row.last_heartbeat_at = input.lastHeartbeatAt;
    const { error } = await this.db.from("company_employees").upsert(
      row,
      { onConflict: "agent_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
  }

  async listEmployees(companyId: string): Promise<EmployeeRecord[]> {
    try {
      const { data, error } = await this.db
        .from("company_employees")
        .select()
        .eq("company_id", companyId)
        .is("removed_at", null);
      if (error) {
        if (isMissingCompanyTableError(error)) return [];
        throw databaseError(error, "Failed to list company employees");
      }
      return (data ?? []).map((row) => this.toEmployee(row));
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return [];
      throw databaseError(error, "Failed to list company employees");
    }
  }

  async listCompanyEmployeeHistory(companyId: string): Promise<EmployeeRecord[]> {
    try {
      const { data, error } = await this.db
        .from("company_employees")
        .select()
        .eq("company_id", companyId);
      if (error) {
        if (isMissingCompanyTableError(error)) return [];
        throw databaseError(error, "Failed to list company employee history");
      }
      return (data ?? []).map((row) => this.toEmployee(row));
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return [];
      throw databaseError(error, "Failed to list company employee history");
    }
  }

  async getEmployeeByAgent(agentId: string): Promise<EmployeeRecord | null> {
    try {
      const { data, error } = await this.db
        .from("company_employees")
        .select()
        .eq("agent_id", agentId)
        .is("removed_at", null)
        .maybeSingle();
      if (error) {
        if (isMissingCompanyTableError(error)) return null;
        throw databaseError(error, "Failed to read company employee");
      }
      if (!data) return null;
      return this.toEmployee(data);
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return null;
      throw error;
    }
  }

  async removeEmployee(agentId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("company_employees")
      .update({ removed_at: new Date().toISOString() })
      .eq("agent_id", agentId)
      .is("removed_at", null)
      .select("agent_id");
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }

  async updateEmployee(agentId: string, input: UpdateEmployeeInput): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.jobDescription !== undefined) patch.job_description = input.jobDescription;
    if (input.monthlyBudgetUsdc !== undefined) {
      patch.monthly_budget_usdc = input.monthlyBudgetUsdc;
    }
    if (input.departmentId !== undefined) patch.department_id = input.departmentId;
    // Included only when explicitly provided — a wallet write against a
    // production schema without the pay_to column fails loudly (surfaced as
    // a 500 by the PATCH route) rather than silently dropping the address.
    if (input.payTo !== undefined) patch.pay_to = input.payTo;
    // Same rule for the org-chart and heartbeat columns: an unnamed field is
    // never written, and a named one is never silently dropped.
    if (input.role !== undefined) patch.role = input.role;
    if (input.reportsTo !== undefined) patch.reports_to = input.reportsTo;
    if (input.lifecycleStatus !== undefined) patch.lifecycle_status = input.lifecycleStatus;
    if (input.heartbeatEnabled !== undefined) patch.heartbeat_enabled = input.heartbeatEnabled;
    if (input.heartbeatIntervalSeconds !== undefined) {
      patch.heartbeat_interval_seconds = input.heartbeatIntervalSeconds;
    }
    if (input.lastHeartbeatAt !== undefined) patch.last_heartbeat_at = input.lastHeartbeatAt;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.db
      .from("company_employees")
      .update(patch)
      .eq("agent_id", agentId);
    if (error) throw new Error(error.message);
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const { data, error } = await this.db
      .from("company_approvals")
      .insert({
        id,
        company_id: input.companyId,
        kind: input.kind,
        subject_id: input.subjectId,
        status: "pending",
        reason: null,
        action_summary: input.actionSummary ?? null,
        cost_basis: input.costSnapshot?.basis ?? null,
        cost_usdc: input.costSnapshot?.amountUsdc ?? null,
        cost_note: input.costSnapshot?.note ?? null,
        created_at: createdAt,
        decided_at: null,
      })
      .select()
      .single();
    if (error || !data) throw new Error(error?.message ?? "Failed to create approval");
    return this.toApproval(data);
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    try {
      const { data, error } = await this.db
        .from("company_approvals")
        .select()
        .eq("id", id)
        .maybeSingle();
      if (error) {
        if (isMissingCompanyTableError(error)) return null;
        throw databaseError(error, "Failed to read company approval");
      }
      if (!data) return null;
      return this.toApproval(data);
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return null;
      throw databaseError(error, "Failed to read company approval");
    }
  }

  async listApprovals(companyId: string, status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    try {
      let query = this.db
        .from("company_approvals")
        .select()
        .eq("company_id", companyId);
      if (status !== undefined) query = query.eq("status", status);
      const { data, error } = await query.order("created_at", { ascending: false });
      if (error) {
        if (isMissingCompanyTableError(error)) return [];
        throw databaseError(error, "Failed to list company approvals");
      }
      return (data ?? []).map((row) => this.toApproval(row));
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return [];
      throw databaseError(error, "Failed to list company approvals");
    }
  }

  async listCompanyActivity(input: CompanyActivityQuery): Promise<CompanyActivityPage> {
    const fetchLimit = input.limit + 1;
    const cursorPrefix = input.cursor?.id.split(":", 1)[0];
    const cursorRawId = input.cursor?.id.slice((cursorPrefix?.length ?? -1) + 1);
    const runStatuses = new Set(["running", "done", "error"]);
    const approvalStatuses = new Set(["pending", "approved", "rejected", "consumed"]);
    const records: CompanyActivityRecord[] = [];

    let membershipQuery = this.db
      .from("company_employees")
      .select("agent_id,department_id")
      .eq("company_id", input.companyId);
    if (input.employeeId) membershipQuery = membershipQuery.eq("agent_id", input.employeeId);
    if (input.departmentId) membershipQuery = membershipQuery.eq("department_id", input.departmentId);
    const { data: membershipRows, error: membershipError } = await membershipQuery;
    if (membershipError) {
      if (isMissingCompanyTableError(membershipError)) return { records: [], hasMore: false };
      throw databaseError(membershipError, "Failed to scope company activity membership");
    }
    const membershipByAgent = new Map(
      (membershipRows ?? []).map((row) => [
        String(row.agent_id),
        String(row.department_id),
      ]),
    );
    const agentIds = [...membershipByAgent.keys()];

    if (agentIds.length > 0 && (!input.status || runStatuses.has(input.status))) {
      let runQuery = this.db
        .from("runs")
        .select()
        .in("agent_id", agentIds)
        .gte("started_at", new Date(input.fromMs).toISOString())
        .lt("started_at", new Date(input.toMs).toISOString());
      if (input.status) runQuery = runQuery.eq("status", input.status);
      if (input.cursor) {
        const cursorIso = input.cursor.occurredAt;
        if (cursorPrefix === "run") {
          runQuery = runQuery.or(
            `started_at.lt.${cursorIso},and(started_at.eq.${cursorIso},id.lt.${cursorRawId ?? ""})`,
          );
        } else if (cursorPrefix === "approval") {
          runQuery = runQuery.lt("started_at", cursorIso);
        }
      }
      const { data, error } = await runQuery
        .order("started_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(fetchLimit);
      if (error) throw databaseError(error, "Failed to list company activity runs");
      for (const row of data ?? []) {
        const agentId = String(row.agent_id);
        records.push({
          id: `run:${String(row.id)}`,
          kind: "run",
          employeeId: agentId,
          departmentId: membershipByAgent.get(agentId) ?? null,
          status: row.status as CompanyActivityRecord["status"],
          occurredAt: String(row.started_at),
          trigger: String(row.trigger),
          costUsdc: Number(row.total_cost_usdc ?? 0),
          approvalKind: null,
          reason: null,
          receipt: null,
        });
      }
    }

    const employeeFiltered = Boolean(input.employeeId || input.departmentId);
    if ((!employeeFiltered || agentIds.length > 0) && (!input.status || approvalStatuses.has(input.status))) {
      let approvalQuery = this.db
        .from("company_approvals")
        .select()
        .eq("company_id", input.companyId)
        .gte("created_at", new Date(input.fromMs).toISOString())
        .lt("created_at", new Date(input.toMs).toISOString());
      if (employeeFiltered) approvalQuery = approvalQuery.in("subject_id", agentIds);
      if (input.status) approvalQuery = approvalQuery.eq("status", input.status);
      if (input.cursor) {
        const cursorIso = input.cursor.occurredAt;
        if (cursorPrefix === "approval") {
          approvalQuery = approvalQuery.or(
            `created_at.lt.${cursorIso},and(created_at.eq.${cursorIso},id.lt.${cursorRawId ?? ""})`,
          );
        } else if (cursorPrefix === "run") {
          approvalQuery = approvalQuery.lte("created_at", cursorIso);
        }
      }
      const { data, error } = await approvalQuery
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(fetchLimit);
      if (error) {
        if (!isMissingCompanyTableError(error)) {
          throw databaseError(error, "Failed to list company activity approvals");
        }
      } else {
        for (const row of data ?? []) {
          const subjectId = String(row.subject_id);
          const departmentId = membershipByAgent.get(subjectId) ?? null;
          records.push({
            id: `approval:${String(row.id)}`,
            kind: "approval",
            employeeId: departmentId === null ? null : subjectId,
            departmentId,
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
      const { data, error } = await this.db.from("settlements").select().in("run_id", runIds);
      if (error) {
        if (!isMissingCompanyTableError(error)) {
          throw databaseError(error, "Failed to list company activity settlements");
        }
      } else {
        const settlements = new Map((data ?? []).map((row) => [String(row.run_id), row]));
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
    }
    return { records: selected, hasMore };
  }

  async decideApproval(
    id: string,
    decision: "approved" | "rejected",
    reason?: string | null,
  ): Promise<ApprovalRecord | null> {
    const { data, error } = await this.db
      .from("company_approvals")
      .update({
        status: decision,
        reason: reason ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "pending")
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.toApproval(data) : null;
  }

  async consumeApproval(id: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("company_approvals")
      .update({ status: "consumed" })
      .eq("id", id)
      .eq("status", "approved")
      .select();
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }

  async restoreApproval(id: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("company_approvals")
      .update({ status: "approved" })
      .eq("id", id)
      .eq("status", "consumed")
      .select();
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }

  async sumCostByAgents(
    agentIds: string[],
    sinceMs: number,
    untilMs?: number,
  ): Promise<number> {
    if (agentIds.length === 0) return 0;
    try {
      let query = this.db
        .from("runs")
        .select("total_cost_usdc")
        .in("agent_id", agentIds)
        .gte("started_at", new Date(sinceMs).toISOString());
      if (untilMs !== undefined) {
        query = query.lt("started_at", new Date(untilMs).toISOString());
      }
      const { data, error } = await query;
      // This query reads the core runs ledger, not a company migration
      // table. Missing-table and schema-cache errors are fatal here too;
      // otherwise budget gates could treat unavailable spend as zero.
      if (error) throw databaseError(error, "Failed to sum company agent costs");
      return (data ?? []).reduce(
        (sum, row) => sum + Number(row.total_cost_usdc ?? 0),
        0,
      );
    } catch (error: unknown) {
      throw databaseError(error, "Failed to sum company agent costs");
    }
  }

  async listSettlementsByAgents(
    agentIds: string[],
    fromIso: string,
    toIso: string,
  ): Promise<SettlementRecord[]> {
    if (agentIds.length === 0) return [];
    try {
      const { data, error } = await this.db
        .from("settlements")
        .select()
        .in("agent_id", agentIds)
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .order("created_at", { ascending: false });
      if (error) {
        if (isMissingCompanyTableError(error)) return [];
        throw databaseError(error, "Failed to list company settlements");
      }
      return (data ?? []).map((row) => ({
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
      }));
    } catch (error: unknown) {
      if (isMissingCompanyTableError(error)) return [];
      throw databaseError(error, "Failed to list company settlements");
    }
  }

  async createUsage(input: {
    ownerId: string;
    kind: string;
    units: number;
    costUsdc: number;
  }): Promise<UsageRecord> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const { error } = await this.db.from("usage").insert({
      id,
      owner_id: input.ownerId,
      kind: input.kind,
      units: input.units,
      cost_usdc: input.costUsdc,
      created_at: createdAt,
    });
    if (error) throw new Error(error.message);
    return {
      id,
      ownerId: input.ownerId,
      kind: input.kind,
      units: input.units,
      costUsdc: input.costUsdc,
      createdAt,
    };
  }

  async sumMonthlyUsage(ownerId: string, kind: string): Promise<number> {
    // Supabase: filter on ISO prefix "YYYY-MM"
    const monthPrefix = new Date().toISOString().slice(0, 7); // "2026-06"
    const { data, error } = await this.db
      .from("usage")
      .select("units")
      .eq("owner_id", ownerId)
      .eq("kind", kind)
      .gte("created_at", `${monthPrefix}-01T00:00:00.000Z`)
      .lt("created_at", nextMonthPrefix(monthPrefix));
    if (error) throw new Error(error.message);
    return (data ?? []).reduce((sum, row) => sum + Number(row.units ?? 0), 0);
  }

  async countSettledRunsByAgent(agentIds: string[]): Promise<Record<string, number>> {
    if (agentIds.length === 0) return {};
    try {
      const { data } = await this.db
        .from("runs")
        .select("agent_id")
        .in("agent_id", agentIds)
        .not("settled_at", "is", null)
        .limit(5000);
      const out: Record<string, number> = {};
      for (const row of data ?? []) {
        const id = row.agent_id as string | null;
        if (id) out[id] = (out[id] ?? 0) + 1;
      }
      return out;
    } catch {
      return {};
    }
  }

  async lastAgentCallAt(
    agentIds: string[],
    trigger?: string,
  ): Promise<Record<string, number>> {
    if (agentIds.length === 0) return {};
    try {
      let query = this.db
        .from("runs")
        .select("agent_id, started_at")
        .in("agent_id", agentIds);
      if (trigger !== undefined) query = query.eq("trigger", trigger);
      const { data } = await query
        .order("started_at", { ascending: false })
        .limit(5000);
      const out: Record<string, number> = {};
      for (const row of data ?? []) {
        const id = row.agent_id as string | null;
        if (!id || out[id] !== undefined) continue;
        const ms = toMs((row.started_at as string | null) ?? null);
        if (ms !== null) out[id] = ms;
      }
      return out;
    } catch {
      return {};
    }
  }

  async sumAgentCostSince(agentId: string, sinceMs: number): Promise<number> {
    const { data, error } = await this.db
      .from("runs")
      .select("total_cost_usdc")
      .eq("agent_id", agentId)
      .gte("started_at", new Date(sinceMs).toISOString());
    if (error) throw new Error(error.message);
    return (data ?? []).reduce((sum, row) => sum + Number(row.total_cost_usdc ?? 0), 0);
  }

  async createCredit(input: {
    ownerId: string;
    deltaUsdc: number;
    reason: string;
    tx?: string | null;
  }): Promise<CreditRecord> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const tx = input.tx ?? null;
    const { data, error } = await this.db.from("credits").insert({
      id,
      owner_id: input.ownerId,
      delta_usdc: input.deltaUsdc,
      reason: input.reason,
      tx,
      created_at: createdAt,
    }).select().single();
    if (error) {
      if (error.code === "23505" && tx !== null) {
        const existing = await this.getCreditByTx(input.ownerId, tx);
        if (
          existing && existing.deltaUsdc === input.deltaUsdc &&
          existing.reason === input.reason
        ) return existing;
        if (existing) throw new Error("Credit transaction conflict");
      }
      throw new Error(error.message);
    }
    return {
      id: String(data.id),
      ownerId: String(data.owner_id),
      deltaUsdc: Number(data.delta_usdc),
      reason: String(data.reason),
      tx: (data.tx as string | null) ?? null,
      createdAt: String(data.created_at),
    };
  }

  async recordStripeRevenueEvent(
    input: StripeRevenueEventInput,
  ): Promise<StripeRevenueWriteResult> {
    const { data, error } = await this.db.rpc(
      "agent_studio_record_stripe_revenue_event",
      {
        p_kind: input.kind,
        p_provider_event_id: input.providerEventId,
        p_owner_id: input.kind === "payment" ? input.ownerId : null,
        p_checkout_session_id:
          input.kind === "payment" ? input.providerCheckoutSessionId : null,
        p_payment_intent_id: input.providerPaymentIntentId,
        p_refund_id: input.kind === "refund" ? input.providerRefundId : null,
        p_amount_total_cents: input.amountTotalCents,
        p_currency: input.currency,
        p_terminal_status: input.terminalStatus,
        p_product_id: input.kind === "payment" ? input.providerProductId : null,
        p_price_id: input.kind === "payment" ? input.providerPriceId : null,
        p_occurred_at: input.occurredAt,
        p_credit_grant_usdc:
          input.kind === "payment" ? input.creditGrantUsdc : null,
      },
    );
    if (error) throw new Error(error.message);
    const candidate = Array.isArray(data) ? data[0] : data;
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("Stripe revenue RPC returned no result");
    }
    const recorded = Reflect.get(candidate, "recorded");
    const rawCreditDelta = Reflect.get(candidate, "credit_delta_usdc");
    const refundState = Reflect.get(candidate, "refund_state");
    const creditDeltaUsdc =
      typeof rawCreditDelta === "number"
        ? rawCreditDelta
        : typeof rawCreditDelta === "string"
          ? Number(rawCreditDelta)
          : Number.NaN;
    if (
      typeof recorded !== "boolean"
      || !Number.isFinite(creditDeltaUsdc)
      || !["none", "partial", "full"].includes(String(refundState))
    ) {
      throw new Error("Stripe revenue RPC returned an invalid result");
    }
    const state = String(refundState) as StripeRevenueRefundState;
    const semanticallyValid = input.kind === "payment"
      ? state === "none" && creditDeltaUsdc > 0
      : state === "none"
        ? !recorded && creditDeltaUsdc === 0
        : creditDeltaUsdc < 0;
    if (!semanticallyValid) {
      throw new Error("Stripe revenue RPC returned an invalid result");
    }
    return {
      recorded,
      creditDeltaUsdc,
      refundState: state,
    };
  }

  async getCreditBalance(ownerId: string): Promise<number> {
    const { data, error } = await this.db
      .from("credits")
      .select("delta_usdc")
      .eq("owner_id", ownerId)
      .limit(5000);
    if (error) throw new Error(error.message);
    return (data ?? []).reduce((sum, row) => sum + Number(row.delta_usdc ?? 0), 0);
  }

  async hasEverPaid(ownerId: string): Promise<boolean> {
    // The guarded aggregate keeps the funded-model hot path exact and bounded:
    // ordinary spend is ignored, while a full Stripe refund revokes only the
    // Stripe-derived entitlement.
    const { data, error } = await this.db.rpc(
      "agent_studio_has_paid_entitlement",
      { p_owner_id: ownerId },
    );
    if (error) throw new Error(error.message);
    if (typeof data !== "boolean") {
      throw new Error("Paid-entitlement RPC returned an invalid result");
    }
    return data;
  }

  async getCreditByTx(ownerId: string, tx: string): Promise<CreditRecord | null> {
    const { data, error } = await this.db
      .from("credits")
      .select()
      .eq("owner_id", ownerId)
      .eq("tx", tx)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      id: data.id as string,
      ownerId: data.owner_id as string,
      deltaUsdc: Number(data.delta_usdc),
      reason: data.reason as string,
      tx: (data.tx as string | null) ?? null,
      createdAt: data.created_at as string,
    };
  }

  async getLastPromoOutput(
    agentId: string,
  ): Promise<{ campaignId: string; campaignUrl: string; name: string } | null> {
    try {
      // Find the most-recent completed run for this agent.
      const { data: runRows } = await this.db
        .from("runs")
        .select("id")
        .eq("agent_id", agentId)
        .eq("status", "done")
        .order("started_at", { ascending: false })
        .limit(1);
      if (!runRows || runRows.length === 0) return null;
      const runId = runRows[0].id as string;

      // Find run_steps whose node_type contains "promo" and has a non-null output.
      const { data: stepRows } = await this.db
        .from("run_steps")
        .select("output")
        .eq("run_id", runId)
        .ilike("node_type", "%promo%")
        .not("output", "is", null);

      for (const row of stepRows ?? []) {
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
    if (fromOwnerId.trim().length === 0 || toOwnerId.trim().length === 0) {
      throw new TypeError("Owner ids are required for workspace adoption");
    }
    const { error } = await this.db.rpc("agent_studio_adopt_owner_with_connections", {
      p_from_owner_id: fromOwnerId,
      p_to_owner_id: toOwnerId,
    });
    if (error) throw new Error(`adoptOwner: ${error.message}`);
  }

  async ping(): Promise<void> {
    // Bounded, non-mutating liveness read on a small table. Throws when the
    // datastore is unreachable so the health probe records a "down".
    const { error } = await this.db.from("agents").select("id").limit(1);
    if (error) throw new Error(error.message);
  }

  async recordHealthCheck(input: RecordHealthCheckInput): Promise<void> {
    try {
      const { error } = await this.db.from("health_checks").insert({
        status: input.status,
        db_ok: input.dbOk,
        db_latency_ms: Math.round(input.dbLatencyMs),
        gateway_ok: input.gatewayOk,
        gateway_latency_ms: Math.round(input.gatewayLatencyMs),
        facilitator_ok: input.facilitatorOk,
        facilitator_latency_ms: Math.round(input.facilitatorLatencyMs),
        checked_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
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
      const sinceIso = new Date(sinceMs).toISOString();
      const { data, error } = await this.db
        .from("health_checks")
        .select(
          "status, db_latency_ms, gateway_latency_ms, facilitator_latency_ms, checked_at",
        )
        .gte("checked_at", sinceIso)
        .order("checked_at", { ascending: true })
        .limit(100_000);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      if (rows.length === 0) return empty;
      let ok = 0;
      let degraded = 0;
      let down = 0;
      let dbSum = 0;
      let dbN = 0;
      let gwSum = 0;
      let gwN = 0;
      let faSum = 0;
      let faN = 0;
      for (const r of rows) {
        const s = String(r.status);
        if (s === "ok") ok += 1;
        else if (s === "degraded") degraded += 1;
        else if (s === "down") down += 1;
        if (r.db_latency_ms != null) {
          dbSum += Number(r.db_latency_ms);
          dbN += 1;
        }
        if (r.gateway_latency_ms != null) {
          gwSum += Number(r.gateway_latency_ms);
          gwN += 1;
        }
        if (r.facilitator_latency_ms != null) {
          faSum += Number(r.facilitator_latency_ms);
          faN += 1;
        }
      }
      return {
        total: rows.length,
        ok,
        degraded,
        down,
        firstAt: String(rows[0].checked_at),
        lastAt: String(rows[rows.length - 1].checked_at),
        avgDbLatencyMs: dbN ? Math.round(dbSum / dbN) : null,
        avgGatewayLatencyMs: gwN ? Math.round(gwSum / gwN) : null,
        avgFacilitatorLatencyMs: faN ? Math.round(faSum / faN) : null,
      };
    } catch {
      // Table may not exist yet (migration pending) — dark-deploy safe.
      return empty;
    }
  }

  async getRunOutcomeStats(sinceMs: number): Promise<RunOutcomeStats> {
    const sinceIso = new Date(sinceMs).toISOString();
    const { data, error } = await this.db
      .from("runs")
      .select("status, started_at, finished_at, agent_id")
      .not("agent_id", "is", null)
      .gte("started_at", sinceIso)
      .limit(100_000);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    let done = 0;
    let errored = 0;
    let running = 0;
    const agents = new Set<string>();
    const durations: number[] = [];
    for (const r of rows) {
      const s = String(r.status);
      if (s === "done") done += 1;
      else if (s === "error") errored += 1;
      else if (s === "running") running += 1;
      const agentId = r.agent_id as string | null;
      if (agentId) agents.add(agentId);
      const startedAt = toMs(r.started_at as string | null);
      const finishedAt = toMs(r.finished_at as string | null);
      if (startedAt != null && finishedAt != null && finishedAt >= startedAt) {
        durations.push(finishedAt - startedAt);
      }
    }
    return {
      total: done + errored + running,
      done,
      error: errored,
      running,
      medianDurationMs: medianOf(durations),
      agentsLive: agents.size,
    };
  }

  async createProspect(record: ProspectRecord): Promise<ProspectRecord> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    const { error } = await this.db.from("prospect_records").insert({
      id: parsed.id,
      owner_id: parsed.ownerId,
      domain: parsed.domain,
      stage: parsed.stage,
      record_json: parsed,
      revision: parsed.revision,
      created_at: parsed.createdAt,
      updated_at: parsed.updatedAt,
    });
    if (error) throw databaseError(error, "Could not create prospect");
    return parsed;
  }

  async getProspect(id: string, ownerId: string): Promise<ProspectRecord | null> {
    const { data, error } = await this.db
      .from("prospect_records")
      .select("domain,stage,record_json,revision,created_at,updated_at")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (error) throw databaseError(error, "Could not read prospect");
    if (!data) return null;
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(data.record_json));
    if (data.domain !== parsed.domain || data.stage !== parsed.stage || data.revision !== parsed.revision || data.created_at !== parsed.createdAt || data.updated_at !== parsed.updatedAt) throw new Error("Prospect indexed columns drift from record JSON");
    return parsed;
  }

  async listProspects(ownerId: string): Promise<ProspectRecord[]> {
    const { data, error } = await this.db
      .from("prospect_records")
      .select("domain,stage,record_json,revision,created_at,updated_at")
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw databaseError(error, "Could not list prospects");
    return (data ?? []).map((row) => {
      const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(row.record_json));
      if (row.domain !== parsed.domain || row.stage !== parsed.stage || row.revision !== parsed.revision || row.created_at !== parsed.createdAt || row.updated_at !== parsed.updatedAt) throw new Error("Prospect indexed columns drift from record JSON");
      return parsed;
    });
  }

  async updateProspect(record: ProspectRecord, expectedRevision: number): Promise<ProspectRecord | null> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    const { data, error } = await this.db
      .from("prospect_records")
      .update({
        stage: parsed.stage,
        record_json: parsed,
        revision: parsed.revision,
        updated_at: parsed.updatedAt,
      })
      .eq("id", parsed.id)
      .eq("owner_id", parsed.ownerId)
      .eq("revision", expectedRevision)
      .select("id")
      .maybeSingle();
    if (error) throw databaseError(error, "Could not update prospect");
    return data ? parsed : null;
  }

  async updateProspectUnlessSuppressed(record: ProspectRecord, expectedRevision: number, emailDigest: string): Promise<ProspectRecord | null> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    const { data, error } = await this.db.rpc("agent_studio_update_prospect_unless_suppressed", {
      p_id: parsed.id, p_owner_id: parsed.ownerId, p_expected_revision: expectedRevision,
      p_record_json: parsed, p_stage: parsed.stage, p_revision: parsed.revision,
      p_updated_at: parsed.updatedAt, p_email_sha256: emailDigest,
    });
    if (error) throw databaseError(error, "Could not update prospect safely");
    return data === true ? parsed : null;
  }

  async isProspectRecipientSuppressed(ownerId: string, emailDigest: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("prospect_recipient_suppressions")
      .select("email_sha256")
      .eq("owner_id", ownerId)
      .eq("email_sha256", emailDigest)
      .maybeSingle();
    if (error) throw databaseError(error, "Could not check prospect suppression");
    return data !== null;
  }

  async optOutProspect(record: ProspectRecord, expectedRevision: number, emailDigest: string): Promise<ProspectRecord | null> {
    return this.suppressProspect(record, expectedRevision, emailDigest, "opt-out");
  }

  async suppressProspect(record: ProspectRecord, expectedRevision: number, emailDigest: string, reason: "opt-out" | "operator"): Promise<ProspectRecord | null> {
    const parsed = validateProspectIntegrity(ProspectRecordSchema.parse(record));
    const { data, error } = await this.db.rpc("agent_studio_opt_out_prospect", {
      p_id: parsed.id,
      p_owner_id: parsed.ownerId,
      p_expected_revision: expectedRevision,
      p_record_json: parsed,
      p_stage: parsed.stage,
      p_revision: parsed.revision,
      p_updated_at: parsed.updatedAt,
      p_email_sha256: emailDigest,
      p_recorded_at: parsed.suppression.recordedAt,
      p_reason: reason,
    });
    if (error) throw databaseError(error, "Could not opt out prospect");
    return data === true ? parsed : null;
  }

  async redactProspect(id: string, ownerId: string): Promise<boolean> {
    const { data, error } = await this.db.rpc("agent_studio_redact_prospect", {
      p_id: id,
      p_owner_id: ownerId,
    });
    if (error) throw databaseError(error, "Could not redact prospect");
    return data === true;
  }
}
