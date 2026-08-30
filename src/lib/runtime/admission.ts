import { preflightV2Execution, topoSort } from "@/lib/flow/engine";
import { isFlowGraphV2, parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { NODE_DEFINITION_BY_TYPE } from "@/lib/flow/node-definitions";
import { NODE_DEFS } from "@/lib/flow/registry";
import { hashCallableInterface, normalizeSubflowReference, sha256Utf8 } from "@/lib/flow/subflow-reference";
import type { ResolvedSubflow, SubflowResolver } from "@/lib/flow/subflow-resolver";
import type { NodeType, SubflowReference, SupportedFlowGraph } from "@/lib/flow/types";
import {
  DURABLE_GRAPH_LIMITS,
  DurableGraphAuditError,
  auditDurableGraph,
  canonicalDurableGraphJson,
  createDurableGraphAuditTotals,
} from "./durable-graph-audit";

export { DURABLE_GRAPH_LIMITS } from "./durable-graph-audit";

/**
 * This table is deliberately exhaustive. A new canonical node cannot become
 * durable merely by acquiring superficially safe metadata: it must receive an
 * explicit replay review here and in the enumeration test.
 */
export const DURABLE_NODE_ADMISSION = Object.freeze({
  schedule: "direct",
  webhook: "refuse",
  input: "direct",
  output: "direct",
  "suede.styleCoach": "refuse",
  "suede.lyrics": "refuse",
  "suede.generateSong": "refuse",
  "suede.analyze": "refuse",
  "suede.stems": "refuse",
  "suede.midi": "refuse",
  "suede.mastering": "refuse",
  "suede.rightsLookup": "refuse",
  "suede.chainChat": "refuse",
  llm: "refuse",
  // Reach the model provider, exactly like llm: never replay.
  "ai.classify": "refuse",
  "ai.extract": "refuse",
  "suede.registerIp": "refuse",
  "suede.royaltySplit": "refuse",
  http: "refuse",
  transform: "direct",
  "suede.promo": "refuse",
  "suede.promoClaims": "refuse",
  branch: "direct",
  // Pure, deterministic reducers/routers: no I/O, so replay is identical.
  "logic.switch": "direct",
  "logic.aggregate": "direct",
  subflow: "closure",
  loop: "closure",
  "api.operation": "refuse",
  // Owner-scoped database reads are not replay-self-contained.
  "resource.query": "refuse",
  "docs.extractText": "direct",
  "docs.extractDocx": "direct",
  "docs.knowledgeSearch": "direct",
  "docs.generateReportPdf": "refuse",
  "data.parseSpreadsheet": "direct",
  "data.filterRows": "refuse",
  "data.generateSpreadsheet": "refuse",
  "web.fetchUrl": "refuse",
  "finance.generateInvoicePdf": "direct",
  "comms.slackMessage": "refuse",
  "comms.crmWebhook": "refuse",
  "devops.githubIssue": "refuse",
  // Reaches GitHub over the network: never replay.
  "devops.githubRead": "refuse",
  "devops.githubWorkflowDispatch": "refuse",
} satisfies Record<NodeType, "direct" | "closure" | "refuse">);

export type DurableAdmissionFailureCode =
  | "invalid-json"
  | "invalid-graph"
  | "invalid-node"
  | "unknown-node"
  | "unsafe-node"
  | "secret-binding"
  | "variable-binding"
  | "unresolved-reference"
  | "recursive-reference"
  | "closure-limit";

export type DurableGraphAdmission =
  | {
      readonly ok: true;
      readonly graphCount: number;
      readonly nodeCount: number;
      readonly executionPackage: DurableExecutionPackage;
    }
  | {
      readonly ok: false;
      readonly code: DurableAdmissionFailureCode;
      readonly reason: string;
    };

export type DurableExecutionGraphIdentity =
  | { readonly kind: "root"; readonly graphId: string }
  | { readonly kind: "legacy"; readonly flowId: string }
  | {
      readonly kind: "draft";
      readonly flowId: string;
      readonly interfaceHash: string;
    }
  | {
      readonly kind: "pinned";
      readonly flowId: string;
      readonly versionId: string;
      readonly interfaceHash: string;
      readonly pinnedContentHash: string;
    };

export interface DurableExecutionGraphSnapshot {
  readonly key: string;
  readonly identity: DurableExecutionGraphIdentity;
  readonly canonicalJson: string;
  readonly byteLength: number;
  /** Exact SHA-256 of canonicalJson, distinct from a pinned semantic hash. */
  readonly contentHash: string;
  readonly graph: SupportedFlowGraph;
}

export interface DurableExecutionPackage {
  readonly schemaVersion: 1;
  readonly rootKey: string;
  readonly graphs: readonly DurableExecutionGraphSnapshot[];
}

export interface DurableGraphAdmissionResolvers {
  readonly loadSubflow?: (
    flowId: string,
    signal?: AbortSignal,
  ) => Promise<SupportedFlowGraph>;
  readonly resolveSubflow?: SubflowResolver;
  readonly signal?: AbortSignal;
}

class AdmissionRefusal extends Error {
  constructor(
    readonly code: DurableAdmissionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AdmissionRefusal";
  }
}

function refuse(code: DurableAdmissionFailureCode, reason: string): never {
  throw new AdmissionRefusal(code, reason);
}

function runtimeDefinition(type: NodeType): (typeof NODE_DEFS)[number] {
  const matches = NODE_DEFS.filter((candidate) => candidate.type === type);
  if (matches.length !== 1) {
    return refuse("unsafe-node", "Canonical runtime node metadata is ambiguous.");
  }
  return matches[0]!;
}

function exactEffects(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function assertReviewedMetadata(type: NodeType, disposition: "direct" | "closure"): void {
  const definition = NODE_DEFINITION_BY_TYPE[type];
  const runtime = runtimeDefinition(type);
  if (
    runtime.definition !== definition ||
    runtime.type !== type ||
    runtime.costBearing !== false ||
    runtime.sideEffecting !== false ||
    runtime.priceUsdc !== undefined
  ) {
    refuse("unsafe-node", "Canonical runtime node metadata drifted outside the reviewed boundary.");
  }

  if (disposition === "direct") {
    if (
      definition.cost.kind !== "free" ||
      definition.effects.length !== 0 ||
      definition.permissions.length !== 0 ||
      definition.capabilityMode !== "static" ||
      definition.testMode !== "native" ||
      definition.retry !== "safe"
    ) {
      refuse("unsafe-node", "A direct node no longer has replay-safe durable metadata.");
    }
    return;
  }

  const inheritedEffects = ["read", "write", "delete", "send", "spend", "publish", "settle"];
  if (
    definition.cost.kind !== "variable" ||
    !exactEffects(definition.effects, inheritedEffects) ||
    definition.permissions.length !== 0 ||
    definition.capabilityMode !== "inherits-graph" ||
    definition.testMode !== "native" ||
    definition.retry !== "idempotency-required"
  ) {
    refuse("unsafe-node", "A closure node no longer has reviewed inherited metadata.");
  }
}

function assertNodeParams(type: NodeType, params: unknown): void {
  const result = runtimeDefinition(type).paramsSchema.safeParse(params);
  if (!result.success) {
    refuse("invalid-node", "A durable node has invalid canonical parameters.");
  }
}

function assertBindingsAndVariables(graph: SupportedFlowGraph): void {
  if (!isFlowGraphV2(graph)) return;
  const variables = new Set(graph.variables.map((variable) => variable.id));
  if (graph.variables.some((variable) => variable.sensitive === true)) {
    refuse("variable-binding", "Sensitive durable graph variables are not admitted.");
  }
  const inspect = (binding: { readonly kind: string; readonly variableId?: string }): void => {
    if (binding.kind === "secret") {
      refuse("secret-binding", "Secret-bound durable graphs are not admitted.");
    }
    if (binding.kind === "variable" && (
      typeof binding.variableId !== "string" || !variables.has(binding.variableId)
    )) {
      refuse("variable-binding", "A durable graph variable binding is unresolved.");
    }
  };
  for (const node of graph.nodes) {
    for (const binding of Object.values(node.bindings)) inspect(binding);
  }
  for (const edge of graph.edges) {
    if (edge.condition) inspect(edge.condition);
  }
}

function typedCacheKey(reference: SubflowReference): string {
  return executionIdentityKey(reference.kind === "draft"
    ? {
        kind: "draft",
        flowId: reference.flowId,
        interfaceHash: reference.interfaceHash,
      }
    : {
        kind: "pinned",
        flowId: reference.flowId,
        versionId: reference.versionId,
        interfaceHash: reference.interfaceHash,
        pinnedContentHash: reference.contentHash,
      });
}

function legacyCacheKey(flowId: string): string {
  return executionIdentityKey({ kind: "legacy", flowId });
}

function executionIdentityKey(identity: DurableExecutionGraphIdentity): string {
  switch (identity.kind) {
    case "root":
      return JSON.stringify(["root", identity.graphId]);
    case "legacy":
      return JSON.stringify(["legacy", identity.flowId]);
    case "draft":
      return JSON.stringify(["draft", identity.flowId, identity.interfaceHash]);
    case "pinned":
      return JSON.stringify([
        "pinned",
        identity.flowId,
        identity.versionId,
        identity.interfaceHash,
        identity.pinnedContentHash,
      ]);
  }
}

function identityForReference(reference: SubflowReference): DurableExecutionGraphIdentity {
  return reference.kind === "draft"
    ? Object.freeze({
        kind: "draft" as const,
        flowId: reference.flowId,
        interfaceHash: reference.interfaceHash,
      })
    : Object.freeze({
        kind: "pinned" as const,
        flowId: reference.flowId,
        versionId: reference.versionId,
        interfaceHash: reference.interfaceHash,
        pinnedContentHash: reference.contentHash,
      });
}

function freezeDeep<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function createSnapshot(
  raw: SupportedFlowGraph,
  requestedIdentity: DurableExecutionGraphIdentity | null,
): DurableExecutionGraphSnapshot {
  const canonicalJson = canonicalDurableGraphJson(raw);
  const reparsed = JSON.parse(canonicalJson) as unknown;
  const graph = freezeDeep(reparsed as SupportedFlowGraph);
  const identity = requestedIdentity ?? Object.freeze({
    kind: "root" as const,
    graphId: graph.id,
  });
  const contentHash = sha256Utf8(canonicalJson);
  if (sha256Utf8(JSON.stringify(graph)) !== contentHash) {
    refuse("invalid-json", "The durable graph canonical content hash is unstable.");
  }
  return Object.freeze({
    key: executionIdentityKey(identity),
    identity: freezeDeep({ ...identity }),
    canonicalJson,
    byteLength: new TextEncoder().encode(canonicalJson).byteLength,
    contentHash,
    graph,
  });
}

function awaitWithSignal<Value>(
  promise: Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<Value>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function assertResolvedReceipt(reference: SubflowReference, resolved: ResolvedSubflow): void {
  if (
    resolved.flowId !== reference.flowId ||
    hashCallableInterface(resolved.callableInterface) !== reference.interfaceHash
  ) {
    refuse("unresolved-reference", "A typed durable graph receipt does not match its reference.");
  }
  if (reference.kind === "pinned") {
    if (
      resolved.versionId !== reference.versionId ||
      resolved.semanticHash !== reference.contentHash
    ) {
      refuse("unresolved-reference", "A pinned durable graph receipt does not match its immutable reference.");
    }
  } else if (resolved.versionId !== undefined) {
    refuse("unresolved-reference", "A draft durable graph receipt unexpectedly resolved as pinned.");
  }
}

/**
 * Resolve and review the complete execution closure before any durable row is
 * created. All uncertainty is a refusal; this function never guesses that a
 * missing node, reference, or metadata field is safe.
 */
export async function admitDurableGraph(
  graph: SupportedFlowGraph,
  resolvers: DurableGraphAdmissionResolvers = {},
): Promise<DurableGraphAdmission> {
  const totals = createDurableGraphAuditTotals();
  const snapshots = new Map<string, DurableExecutionGraphSnapshot>();
  const legacyCache = new Map<string, Promise<SupportedFlowGraph>>();
  const typedCache = new Map<string, Promise<ResolvedSubflow>>();
  const validated = new Set<string>();

  const resolveLegacy = (flowId: string): Promise<SupportedFlowGraph> => {
    const key = legacyCacheKey(flowId);
    const cached = legacyCache.get(key);
    if (cached) return cached;
    if (!resolvers.loadSubflow) {
      return Promise.reject(new Error("loader unavailable"));
    }
    const pending = Promise.resolve().then(() => resolvers.signal
      ? resolvers.loadSubflow!(flowId, resolvers.signal)
      : resolvers.loadSubflow!(flowId));
    legacyCache.set(key, pending);
    return pending;
  };

  const resolveTyped = (reference: SubflowReference): Promise<ResolvedSubflow> => {
    const key = typedCacheKey(reference);
    const cached = typedCache.get(key);
    if (cached) return cached;
    if (!resolvers.resolveSubflow) {
      return Promise.reject(new Error("resolver unavailable"));
    }
    const pending = Promise.resolve().then(() => resolvers.signal
      ? resolvers.resolveSubflow!(reference, resolvers.signal)
      : resolvers.resolveSubflow!(reference));
    typedCache.set(key, pending);
    return pending;
  };

  const visit = async (
    raw: SupportedFlowGraph,
    requestedIdentity: DurableExecutionGraphIdentity | null,
    ancestry: readonly string[],
    depth: number,
  ): Promise<DurableExecutionGraphSnapshot> => {
    resolvers.signal?.throwIfAborted();
    const requestedKey = requestedIdentity ? executionIdentityKey(requestedIdentity) : null;
    if (requestedKey) {
      const existing = snapshots.get(requestedKey);
      if (existing && validated.has(requestedKey)) return existing;
    }

    try {
      auditDurableGraph(raw, totals);
    } catch (error) {
      if (error instanceof DurableGraphAuditError) {
        refuse(error.kind, error.kind === "invalid-json"
          ? "The durable graph is not strict canonical JSON."
          : "The durable graph closure exceeds a safety limit.");
      }
      throw error;
    }
    if (depth > DURABLE_GRAPH_LIMITS.maxClosureDepth) {
      refuse("closure-limit", "The durable graph closure exceeds its nesting limit.");
    }

    let snapshot: DurableExecutionGraphSnapshot;
    try {
      snapshot = createSnapshot(raw, requestedIdentity);
    } catch (error) {
      if (error instanceof AdmissionRefusal) throw error;
      refuse("invalid-json", "The durable graph canonical snapshot is invalid.");
    }
    const graphKey = snapshot.key;
    const existing = snapshots.get(graphKey);
    if (existing && validated.has(graphKey)) return existing;
    const frozenGraph = snapshot.graph;

    const rawNodes = (frozenGraph as { readonly nodes: readonly { readonly type?: unknown }[] }).nodes;
    for (const node of rawNodes) {
      const type = node.type;
      if (
        typeof type !== "string" ||
        !Object.hasOwn(DURABLE_NODE_ADMISSION, type) ||
        !Object.hasOwn(NODE_DEFINITION_BY_TYPE, type)
      ) {
        refuse("unknown-node", "The durable graph contains an unknown node type.");
      }
      if (DURABLE_NODE_ADMISSION[type as NodeType] === "refuse") {
        refuse("unsafe-node", "The durable graph contains a node outside the replay-safe boundary.");
      }
    }

    let parsed: SupportedFlowGraph;
    try {
      parsed = parseSupportedFlowGraph(frozenGraph);
    } catch {
      refuse("invalid-graph", "The durable graph contract is invalid.");
    }
    assertBindingsAndVariables(parsed);
    try {
      if (isFlowGraphV2(parsed)) preflightV2Execution(parsed, Object.fromEntries(
        NODE_DEFS.map((definition) => [definition.type, definition]),
      ));
      const nodeIds = new Set(parsed.nodes.map((node) => node.id));
      const edgeIds = new Set(parsed.edges.map((edge) => edge.id));
      if (
        nodeIds.size !== parsed.nodes.length ||
        edgeIds.size !== parsed.edges.length ||
        parsed.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
      ) {
        throw new Error("invalid graph identity");
      }
      topoSort(parsed);
    } catch {
      refuse("invalid-graph", "The durable graph cannot be ordered.");
    }

    const currentAncestry = ancestry.length === 0 ? [parsed.id] : ancestry;
    for (const node of parsed.nodes) {
      resolvers.signal?.throwIfAborted();
      const type = node.type;
      const disposition = DURABLE_NODE_ADMISSION[type];
      if (disposition === "refuse") {
        refuse("unsafe-node", "The durable graph contains a node outside the replay-safe boundary.");
      }
      assertReviewedMetadata(type, disposition);
      assertNodeParams(type, node.params);
      if (disposition === "direct") continue;

      let normalized: ReturnType<typeof normalizeSubflowReference>;
      try {
        normalized = normalizeSubflowReference(node.params);
      } catch {
        refuse("invalid-node", "A durable closure node has an invalid reference.");
      }
      const flowId = normalized.kind === "typed" ? normalized.reference.flowId : normalized.flowId;
      if (currentAncestry.includes(flowId)) {
        refuse("recursive-reference", "Recursive durable graph references are not admitted.");
      }

      let child: SupportedFlowGraph;
      try {
        if (normalized.kind === "typed") {
          const resolved = await awaitWithSignal(resolveTyped(normalized.reference), resolvers.signal);
          assertResolvedReceipt(normalized.reference, resolved);
          child = resolved.graph;
        } else {
          child = await awaitWithSignal(resolveLegacy(flowId), resolvers.signal);
        }
        resolvers.signal?.throwIfAborted();
      } catch (error) {
        if (error instanceof AdmissionRefusal) throw error;
        if (resolvers.signal?.aborted) resolvers.signal.throwIfAborted();
        refuse("unresolved-reference", "A durable graph descendant could not be resolved.");
      }
      const childIdentity = normalized.kind === "typed"
        ? identityForReference(normalized.reference)
        : Object.freeze({ kind: "legacy" as const, flowId });
      const childSnapshot = await visit(
        child,
        childIdentity,
        [...currentAncestry, flowId],
        depth + 1,
      );
      if (normalized.kind === "typed") {
        const typedGraph = parseSupportedFlowGraph(childSnapshot.graph);
        if (
          !isFlowGraphV2(typedGraph) ||
          !typedGraph.callableInterface ||
          hashCallableInterface(typedGraph.callableInterface) !== normalized.reference.interfaceHash
        ) {
          refuse("unresolved-reference", "A typed durable graph does not match its callable receipt.");
        }
      }
    }
    validated.add(graphKey);
    snapshots.set(graphKey, snapshot);
    return snapshot;
  };

  try {
    const root = await visit(graph, null, [], 0);
    const descendants = [...snapshots.values()]
      .filter((entry) => entry.key !== root.key)
      .sort((left, right) => left.key.localeCompare(right.key));
    const executionPackage = Object.freeze({
      schemaVersion: 1 as const,
      rootKey: root.key,
      graphs: Object.freeze([root, ...descendants]),
    });
    return Object.freeze({
      ok: true as const,
      graphCount: totals.graphs,
      nodeCount: totals.nodes,
      executionPackage,
    });
  } catch (error) {
    if (error instanceof AdmissionRefusal) {
      return Object.freeze({ ok: false as const, code: error.code, reason: error.message });
    }
    throw error;
  }
}
