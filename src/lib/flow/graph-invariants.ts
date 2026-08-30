import { GraphCommandError } from "./graph-command-types";
import type { FlowEdge, FlowEdgeV2, SupportedFlowGraph } from "./types";

type GraphEdge = FlowEdge | FlowEdgeV2;

function collisionKey(edge: GraphEdge): string {
  return JSON.stringify([edge.target, edge.targetHandle ?? null]);
}

export function hasHandleCollision(
  edges: readonly GraphEdge[],
  target: string,
  targetHandle: string | null | undefined,
): boolean {
  const key = JSON.stringify([target, targetHandle ?? null]);
  return edges.some((edge) => collisionKey(edge) === key);
}

export function wouldCreateCycle(
  edges: readonly GraphEdge[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const seen = new Set([target]);
  const stack = [target];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === source) return true;
    for (const next of outgoing.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

export function targetHandleCollisionMultiset(edges: readonly GraphEdge[]): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const edge of edges) {
    const key = collisionKey(edge);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return new Map([...totals].filter(([, count]) => count > 1));
}

export function assertCollisionMultisetNotWorsened(
  before: readonly GraphEdge[],
  after: readonly GraphEdge[],
): void {
  const prior = targetHandleCollisionMultiset(before);
  for (const [key, count] of targetHandleCollisionMultiset(after)) {
    if (count > (prior.get(key) ?? 1)) {
      throw new GraphCommandError(`Target handle collision introduced or worsened at ${key}`);
    }
  }
}

export function assertAuthoredEdgeHasNoTargetHandleCollision(
  edges: readonly GraphEdge[],
  edge: GraphEdge,
): void {
  const key = collisionKey(edge);
  if (hasHandleCollision(edges, edge.target, edge.targetHandle)) {
    throw new GraphCommandError(`Target handle collision at ${key}`);
  }
}

export function assertGraphInvariants(graph: SupportedFlowGraph): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) throw new GraphCommandError(`Duplicate node ID "${node.id}"`);
    nodeIds.add(node.id);
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      throw new GraphCommandError(`Node "${node.id}" position must be finite`);
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) throw new GraphCommandError(`Duplicate edge ID "${edge.id}"`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new GraphCommandError(`Edge "${edge.id}" has a dangling endpoint`);
    }
  }

  const indegree = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] as string;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (visited !== graph.nodes.length) throw new GraphCommandError("Graph contains a directed cycle");
}
