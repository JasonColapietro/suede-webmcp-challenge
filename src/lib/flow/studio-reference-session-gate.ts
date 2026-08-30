import {
  SubflowReferenceLedger,
  type ReferenceGraphTransition,
  type StudioReferenceAction,
  type StudioReferenceBlocker,
} from "./subflow-reference-ledger";
import type { SubflowReference, SupportedFlowGraph } from "./types";

const UNPERSISTED_PARENT = "studio-unpersisted-parent";
const REFERENCE_BOOTSTRAP_MARKER = "studioReferenceBootstrap";
const MAX_DEFERRED_GRAPHS = 8;

const stagedGraphs = new Map<string, SupportedFlowGraph>();
const boundRows = new Map<string, string>();
const tokenRows = new Map<string, string>();

function cloneGraph<T extends SupportedFlowGraph>(graph: T): T {
  return structuredClone(graph);
}

function trimStagedGraphs(): void {
  while (stagedGraphs.size > MAX_DEFERRED_GRAPHS) {
    const first = stagedGraphs.keys().next().value as string | undefined;
    if (first === undefined) return;
    discardReferenceBootstrapGraph(first);
  }
}

function bootstrapToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `reference-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createReferenceBootstrapGraph<T extends SupportedFlowGraph>(graph: T): T {
  if ("schemaVersion" in graph) {
    return {
      schemaVersion: 2,
      id: graph.id,
      name: graph.name,
      nodes: [],
      edges: [],
      variables: [],
      groups: [],
      annotations: [],
      meta: { [REFERENCE_BOOTSTRAP_MARKER]: true },
    } as unknown as T;
  }
  return {
    id: graph.id,
    name: graph.name,
    nodes: [],
    edges: [],
    meta: { [REFERENCE_BOOTSTRAP_MARKER]: true },
  } as unknown as T;
}

export function hasReferenceBootstrapMarker(graph: SupportedFlowGraph): boolean {
  return graph.meta?.[REFERENCE_BOOTSTRAP_MARKER] === true;
}

export function stageReferenceBootstrapGraph(graph: SupportedFlowGraph): string {
  const token = bootstrapToken();
  stagedGraphs.set(token, cloneGraph(graph));
  trimStagedGraphs();
  return token;
}

export function updateReferenceBootstrapGraph(token: string, graph: SupportedFlowGraph): boolean {
  if (!stagedGraphs.has(token)) return false;
  stagedGraphs.set(token, cloneGraph(graph));
  return true;
}

export function discardReferenceBootstrapGraph(token: string): void {
  stagedGraphs.delete(token);
  const rowId = tokenRows.get(token);
  tokenRows.delete(token);
  if (rowId !== undefined && boundRows.get(rowId) === token) boundRows.delete(rowId);
}

export function bindReferenceBootstrapGraph(token: string, parentFlowId: string): boolean {
  if (parentFlowId.length === 0) return false;
  if (!stagedGraphs.has(token)) return false;
  const priorRow = tokenRows.get(token);
  if (priorRow !== undefined && boundRows.get(priorRow) === token) boundRows.delete(priorRow);
  const priorToken = boundRows.get(parentFlowId);
  if (priorToken !== undefined && priorToken !== token) discardReferenceBootstrapGraph(priorToken);
  tokenRows.set(token, parentFlowId);
  boundRows.set(parentFlowId, token);
  return true;
}

export function consumeReferenceBootstrapGraph(parentFlowId: string): SupportedFlowGraph | null {
  const token = boundRows.get(parentFlowId);
  if (!token) return null;
  const graph = stagedGraphs.get(token);
  discardReferenceBootstrapGraph(token);
  return graph ? cloneGraph(graph) : null;
}

export function peekReferenceBootstrapGraph(parentFlowId: string): SupportedFlowGraph | null {
  const token = boundRows.get(parentFlowId);
  if (!token) return null;
  const graph = stagedGraphs.get(token);
  return graph ? cloneGraph(graph) : null;
}

export function discardBoundReferenceBootstrapGraph(parentFlowId: string): boolean {
  const token = boundRows.get(parentFlowId);
  if (!token) return false;
  discardReferenceBootstrapGraph(token);
  return true;
}

export class StudioReferenceSessionGate {
  private parentFlowId: string | null = null;
  private graph: SupportedFlowGraph | null = null;
  private ledger: SubflowReferenceLedger | null = null;

  reset(parentFlowId: string | null, graph: SupportedFlowGraph): void {
    this.parentFlowId = parentFlowId;
    this.graph = graph;
    this.ledger = new SubflowReferenceLedger(parentFlowId ?? UNPERSISTED_PARENT, graph);
  }

  reconcile(
    parentFlowId: string | null,
    graph: SupportedFlowGraph,
    transition: ReferenceGraphTransition,
  ): void {
    if (this.ledger === null || parentFlowId !== this.parentFlowId || transition === "load") {
      this.reset(parentFlowId, graph);
      return;
    }
    this.parentFlowId = parentFlowId;
    this.graph = graph;
    this.ledger.reconcile(parentFlowId ?? UNPERSISTED_PARENT, graph, transition);
  }

  markResolved(
    parentFlowId: string | null,
    nodeId: string,
    reference: SubflowReference,
  ): boolean {
    if (parentFlowId === null || parentFlowId !== this.parentFlowId || this.ledger === null) return false;
    return this.ledger.markResolved(parentFlowId, nodeId, reference);
  }

  blocker(action: StudioReferenceAction): StudioReferenceBlocker | null {
    return this.ledger && this.graph ? this.ledger.blocker(action, this.graph) : null;
  }
}
