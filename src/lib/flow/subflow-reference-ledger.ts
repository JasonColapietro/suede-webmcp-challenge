import { normalizeSubflowReference, sha256Utf8 } from "./subflow-reference";
import { FlowGraphV1Schema, FlowGraphV2Schema } from "./graph-schema";
import {
  SubflowResolveProjectionSchema,
  SubflowResolveRequestSchema,
  type SubflowResolveProjection,
} from "./subflow-api";
import type { FlowNode, FlowNodeV2, JsonValue, SubflowReference, SupportedFlowGraph } from "./types";

export type StudioReferenceAction =
  | "save"
  | "retry-save"
  | "version"
  | "run"
  | "launch"
  | "workbook-navigation"
  | "global-navigation";

export type ReferenceGraphTransition = "load" | "edit" | "undo" | "redo" | "paste" | "duplicate" | "reset";

export interface StudioReferenceBlocker {
  readonly action: StudioReferenceAction;
  readonly nodeIds: readonly string[];
  readonly message: string;
}

export interface PendingSubflowReference {
  readonly nodeId: string;
  readonly reference: SubflowReference;
  readonly fingerprint: string;
}

export interface ResolvedPendingSubflowReference {
  readonly nodeId: string;
  readonly requestedFingerprint: string;
  readonly projection: SubflowResolveProjection;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const input = value as Readonly<Record<string, JsonValue>>;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalize(input[key] as JsonValue)]));
  }
  return value;
}

function parseBoundedReference(reference: unknown): SubflowReference {
  return SubflowResolveRequestSchema.parse({
    parentFlowId: "fingerprint-parent",
    nodeId: "fingerprint-node",
    reference,
  }).reference;
}

function safeBoundedReference(reference: unknown): SubflowReference | null {
  const parsed = SubflowResolveRequestSchema.safeParse({
    parentFlowId: "fingerprint-parent",
    nodeId: "fingerprint-node",
    reference,
  });
  return parsed.success ? parsed.data.reference : null;
}

export function referenceFingerprint(reference: SubflowReference): string {
  const parsed = parseBoundedReference(reference);
  return sha256Utf8(JSON.stringify(canonicalize(parsed as unknown as JsonValue)));
}

function typedReferences(graph: SupportedFlowGraph): ReadonlyMap<string, SubflowReference> {
  const result = new Map<string, SubflowReference>();
  for (const node of graph.nodes) {
    if (node.type !== "subflow" && node.type !== "loop") continue;
    const parsed = safeBoundedReference(node.params.reference);
    if (parsed) result.set(node.id, parsed);
  }
  return result;
}

interface ResolutionReceipt {
  readonly parentFlowId: string;
  readonly fingerprint: string;
}

export class SubflowReferenceLedger {
  private parentFlowId: string;
  private references: ReadonlyMap<string, SubflowReference>;
  private readonly receipts = new Map<string, ResolutionReceipt>();

  constructor(parentFlowId: string, graph: SupportedFlowGraph) {
    this.parentFlowId = parentFlowId;
    this.references = typedReferences(graph);
  }

  reconcile(parentFlowId: string, graph: SupportedFlowGraph, transition: ReferenceGraphTransition): void {
    const nextReferences = typedReferences(graph);
    if (parentFlowId !== this.parentFlowId || transition === "load" || transition === "undo" || transition === "redo" || transition === "reset") {
      this.receipts.clear();
    } else {
      for (const [nodeId, receipt] of this.receipts) {
        const next = nextReferences.get(nodeId);
        if (!next || receipt.fingerprint !== referenceFingerprint(next)) this.receipts.delete(nodeId);
      }
    }
    this.parentFlowId = parentFlowId;
    this.references = nextReferences;
  }

  markResolved(parentFlowId: string, nodeId: string, reference: SubflowReference): boolean {
    const current = this.references.get(nodeId);
    if (parentFlowId !== this.parentFlowId || !current) return false;
    const fingerprint = referenceFingerprint(reference);
    if (fingerprint !== referenceFingerprint(current)) return false;
    this.receipts.set(nodeId, { parentFlowId, fingerprint });
    return true;
  }

  unresolvedNodeIds(graph: SupportedFlowGraph): readonly string[] {
    const current = typedReferences(graph);
    return [...current.entries()]
      .filter(([nodeId, reference]) => {
        const receipt = this.receipts.get(nodeId);
        return receipt?.parentFlowId !== this.parentFlowId || receipt.fingerprint !== referenceFingerprint(reference);
      })
      .map(([nodeId]) => nodeId)
      .sort();
  }

  receiptNodeIds(): readonly string[] {
    return [...this.receipts.keys()].sort();
  }

  blocker(action: StudioReferenceAction, graph: SupportedFlowGraph): StudioReferenceBlocker | null {
    const nodeIds = this.unresolvedNodeIds(graph);
    if (nodeIds.length === 0) return null;
    return {
      action,
      nodeIds,
      message: `Verify ${nodeIds.length} reusable flow ${nodeIds.length === 1 ? "reference" : "references"} before continuing.`,
    };
  }
}

interface DetachedContents {
  readonly nodes: readonly (FlowNode | FlowNodeV2)[];
  readonly requests: readonly PendingSubflowReference[];
}

const DETACHED_CONTENTS = new WeakMap<DetachedPendingNodeSet, DetachedContents>();

function clonePending(entry: PendingSubflowReference): PendingSubflowReference {
  const reference = parseBoundedReference(entry.reference);
  const fingerprint = referenceFingerprint(reference);
  if (fingerprint !== entry.fingerprint) throw new Error(`Pending reference fingerprint mismatch for node "${entry.nodeId}"`);
  return { nodeId: entry.nodeId, reference, fingerprint };
}

function withoutSecretBindings(node: FlowNode | FlowNodeV2): FlowNode | FlowNodeV2 {
  if (!("bindings" in node)) return { ...node, params: { ...node.params }, position: { ...node.position } };
  const bindings = Object.fromEntries(
    Object.entries(node.bindings).filter(([, binding]) => binding.kind !== "secret"),
  );
  return { ...node, params: { ...node.params }, bindings, position: { ...node.position } };
}

export class DetachedPendingNodeSet {
  readonly requiresResolutionBeforePersistence = true;
  readonly #nodes: readonly (FlowNode | FlowNodeV2)[];
  readonly #requests: readonly PendingSubflowReference[];

  private constructor(nodes: readonly (FlowNode | FlowNodeV2)[], requests: readonly PendingSubflowReference[]) {
    this.#nodes = nodes.map(withoutSecretBindings);
    this.#requests = requests.map(clonePending);
    DETACHED_CONTENTS.set(this, { nodes: this.#nodes, requests: this.#requests });
  }

  static fromNodes(nodes: readonly (FlowNode | FlowNodeV2)[]): DetachedPendingNodeSet {
    const requests: PendingSubflowReference[] = [];
    const detached = nodes.map((input) => {
      const node = withoutSecretBindings(input);
      if (node.type !== "subflow" && node.type !== "loop") return node;
      const ownsReference = Object.hasOwn(node.params, "reference");
      const reference = safeBoundedReference(node.params.reference);
      if (!ownsReference) {
        try {
          normalizeSubflowReference(node.params);
        } catch (error) {
          throw new Error(`Reusable-flow node "${node.id}" has an invalid legacy reference`, { cause: error });
        }
        return node;
      }
      if (!reference) throw new Error(`Reusable-flow node "${node.id}" has an invalid typed reference`);
      try {
        normalizeSubflowReference(node.params);
      } catch (error) {
        throw new Error(`Reusable-flow node "${node.id}" has an invalid typed reference`, { cause: error });
      }
      if (!Object.hasOwn(node, "bindings")) {
        throw new Error(`Typed pending node "${node.id}" must be a v2 node with bindings`);
      }
      requests.push({ nodeId: node.id, reference, fingerprint: referenceFingerprint(reference) });
      const { reference: _reference, ...params } = node.params;
      return { ...node, params } as FlowNode | FlowNodeV2;
    });
    return new DetachedPendingNodeSet(detached, requests);
  }

  requests(): readonly PendingSubflowReference[] {
    return this.#requests.map(clonePending);
  }

  remap(nodeIdMap: Readonly<Record<string, string>>): DetachedPendingNodeSet {
    const sourceIds = this.#nodes.map((node) => node.id);
    if (Object.keys(nodeIdMap).length !== sourceIds.length ||
        sourceIds.some((nodeId) => !Object.hasOwn(nodeIdMap, nodeId))) {
      throw new Error("Detached node ID map must be exact");
    }
    const mappedIds = new Set<string>();
    const mappedId = (sourceId: string): string => {
      const nodeId = nodeIdMap[sourceId];
      if (typeof nodeId !== "string" || nodeId.length === 0 ||
          new TextEncoder().encode(nodeId).byteLength > 128) {
        throw new Error(`Remapped detached node ID for "${sourceId}" is invalid`);
      }
      return nodeId;
    };
    const nodes = this.#nodes.map((node) => {
      const nodeId = mappedId(node.id);
      if (mappedIds.has(nodeId)) throw new Error(`Remapped detached node ID "${nodeId}" is duplicated`);
      mappedIds.add(nodeId);
      if (!("bindings" in node)) return { ...node, id: nodeId };
      const bindings = Object.fromEntries(Object.entries(node.bindings).map(([key, binding]) => {
        if (binding.kind !== "port") return [key, binding];
        if (!Object.hasOwn(nodeIdMap, binding.nodeId)) {
          throw new Error(`Detached port binding references external node "${binding.nodeId}"`);
        }
        return [key, { ...binding, nodeId: mappedId(binding.nodeId) }];
      }));
      return { ...node, id: nodeId, bindings };
    });
    const requests = this.#requests.map((entry) => ({ ...entry, nodeId: mappedId(entry.nodeId) }));
    return new DetachedPendingNodeSet(nodes, requests);
  }

  toJSON(): undefined {
    return undefined;
  }
}

export function stripTypedReferencesForPendingResolution(
  nodes: readonly (FlowNode | FlowNodeV2)[],
): DetachedPendingNodeSet {
  return DetachedPendingNodeSet.fromNodes(nodes);
}

export function materializeResolvedPendingNodes(
  detached: DetachedPendingNodeSet,
  resolutions: readonly ResolvedPendingSubflowReference[],
): readonly (FlowNode | FlowNodeV2)[] {
  const stored = DETACHED_CONTENTS.get(detached);
  if (!stored) throw new Error("Detached pending node package is invalid");
  const contents = {
    nodes: stored.nodes.map(withoutSecretBindings),
    requests: stored.requests.map(clonePending),
  };
  const pendingByNode = new Map(contents.requests.map((entry) => [entry.nodeId, entry]));
  const resolvedByNode = new Map<string, SubflowReference>();
  if (pendingByNode.size !== contents.requests.length) throw new Error("Pending reference node IDs must be unique");

  for (const resolution of resolutions) {
    if (resolvedByNode.has(resolution.nodeId)) throw new Error(`Duplicate resolution for node "${resolution.nodeId}"`);
    const entry = pendingByNode.get(resolution.nodeId);
    if (!entry) throw new Error(`Resolution names unknown pending node "${resolution.nodeId}"`);
    const projection = SubflowResolveProjectionSchema.parse(resolution.projection);
    if (projection.issues.length !== 0) throw new Error(`Resolution for node "${resolution.nodeId}" contains drift`);
    if (resolution.requestedFingerprint !== entry.fingerprint ||
        referenceFingerprint(projection.reference) !== entry.fingerprint) {
      throw new Error(`Resolution fingerprint mismatch for node "${resolution.nodeId}"`);
    }
    resolvedByNode.set(resolution.nodeId, projection.reference);
  }
  if (resolvedByNode.size !== pendingByNode.size) throw new Error("Every pending reference must have an exact resolution");

  const seenPendingNodes = new Set<string>();
  const materialized = contents.nodes.map((node) => {
    const reference = resolvedByNode.get(node.id);
    if (!reference) return node;
    if (seenPendingNodes.has(node.id)) throw new Error(`Detached node ID "${node.id}" is duplicated`);
    seenPendingNodes.add(node.id);
    if ((node.type !== "subflow" && node.type !== "loop") || !Object.hasOwn(node, "bindings") ||
        Object.hasOwn(node.params, "reference") || Object.hasOwn(node.params, "flowId")) {
      throw new Error(`Pending node "${node.id}" is not a detached reusable-flow node`);
    }
    return { ...node, params: { ...node.params, reference } } as FlowNode | FlowNodeV2;
  });
  if (seenPendingNodes.size !== pendingByNode.size) throw new Error("A pending reference has no detached node");
  const hasV2Nodes = materialized.some((node) => Object.hasOwn(node, "bindings"));
  const hasV1Nodes = materialized.some((node) => !Object.hasOwn(node, "bindings"));
  if (pendingByNode.size === 0 && hasV1Nodes && hasV2Nodes) {
    throw new Error("Detached nodes must use one graph version");
  }
  if (pendingByNode.size === 0 && !hasV2Nodes) {
    return FlowGraphV1Schema.parse({
      id: "detached-pending-materialized",
      name: "Detached pending materialization",
      nodes: materialized,
      edges: [],
    }).nodes;
  }
  const v2Nodes = materialized.map((node) => Object.hasOwn(node, "bindings")
    ? node
    : { ...node, bindings: {} });
  return FlowGraphV2Schema.parse({
    schemaVersion: 2,
    id: "detached-pending-materialized",
    name: "Detached pending materialization",
    nodes: v2Nodes,
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  }).nodes;
}
