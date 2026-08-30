import { GraphCommandError, type Point } from "./graph-command-types";
import { assertGraphInvariants } from "./graph-invariants";
import type { SupportedFlowGraph } from "./types";

const ORIGIN = { x: 80, y: 80 } as const;
const HORIZONTAL_PITCH = 300;
const VERTICAL_PITCH = 150;
const codeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function average(indices: readonly number[]): number {
  return indices.length === 0 ? Number.POSITIVE_INFINITY : indices.reduce((sum, value) => sum + value, 0) / indices.length;
}

export function layoutGraph(graph: SupportedFlowGraph): Record<string, Point> {
  assertGraphInvariants(graph);
  const ids = graph.nodes.map((node) => node.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) throw new GraphCommandError("Graph contains a duplicate node ID");

  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  const incoming = new Map(ids.map((id) => [id, [] as string[]]));
  const undirected = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) {
      throw new GraphCommandError(`Edge "${edge.id}" has a dangling endpoint`);
    }
    (outgoing.get(edge.source) as string[]).push(edge.target);
    (incoming.get(edge.target) as string[]).push(edge.source);
    (undirected.get(edge.source) as Set<string>).add(edge.target);
    (undirected.get(edge.target) as Set<string>).add(edge.source);
  }
  for (const values of outgoing.values()) values.sort(codeUnitCompare);
  for (const values of incoming.values()) values.sort(codeUnitCompare);

  const remaining = new Set(ids);
  const components: string[][] = [];
  while (remaining.size > 0) {
    const seed = [...remaining].sort(codeUnitCompare)[0] as string;
    const component: string[] = [];
    const queue = [seed];
    remaining.delete(seed);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index] as string;
      component.push(id);
      for (const neighbor of [...(undirected.get(id) as Set<string>)].sort(codeUnitCompare)) {
        if (remaining.delete(neighbor)) queue.push(neighbor);
      }
    }
    component.sort(codeUnitCompare);
    components.push(component);
  }
  components.sort((left, right) => codeUnitCompare(left[0] as string, right[0] as string));

  const positions: Record<string, Point> = {};
  let componentRowOffset = 0;
  for (const component of components) {
    const componentSet = new Set(component);
    const indegree = new Map(component.map((id) => [id, (incoming.get(id) as string[]).filter((parent) => componentSet.has(parent)).length]));
    const ready = component.filter((id) => indegree.get(id) === 0).sort(codeUnitCompare);
    const topological: string[] = [];
    while (ready.length > 0) {
      const id = ready.shift() as string;
      topological.push(id);
      for (const target of outgoing.get(id) as string[]) {
        if (!componentSet.has(target)) continue;
        const next = (indegree.get(target) as number) - 1;
        indegree.set(target, next);
        if (next === 0) {
          ready.push(target);
          ready.sort(codeUnitCompare);
        }
      }
    }
    if (topological.length !== component.length) throw new GraphCommandError("Graph contains a directed cycle");

    const rank = new Map(component.map((id) => [id, 0]));
    for (const id of topological) {
      for (const target of outgoing.get(id) as string[]) {
        if (componentSet.has(target)) rank.set(target, Math.max(rank.get(target) as number, (rank.get(id) as number) + 1));
      }
    }
    const maximumRank = Math.max(0, ...rank.values());
    const layers = Array.from({ length: maximumRank + 1 }, (_, layer) => component.filter((id) => rank.get(id) === layer).sort(codeUnitCompare));

    const orderIndex = (): Map<string, number> => new Map(layers.flatMap((layer) => layer.map((id, index) => [id, index] as const)));
    for (let sweep = 0; sweep < 4; sweep += 1) {
      for (let layer = 1; layer < layers.length; layer += 1) {
        const prior = orderIndex();
        layers[layer]?.sort((left, right) => {
          const leftScore = average((incoming.get(left) as string[]).map((id) => prior.get(id)).filter((value): value is number => value !== undefined));
          const rightScore = average((incoming.get(right) as string[]).map((id) => prior.get(id)).filter((value): value is number => value !== undefined));
          return leftScore - rightScore || codeUnitCompare(left, right);
        });
      }
      for (let layer = layers.length - 2; layer >= 0; layer -= 1) {
        const later = orderIndex();
        layers[layer]?.sort((left, right) => {
          const leftScore = average((outgoing.get(left) as string[]).map((id) => later.get(id)).filter((value): value is number => value !== undefined));
          const rightScore = average((outgoing.get(right) as string[]).map((id) => later.get(id)).filter((value): value is number => value !== undefined));
          return leftScore - rightScore || codeUnitCompare(left, right);
        });
      }
    }

    const rows = Math.max(1, ...layers.map((layer) => layer.length));
    layers.forEach((layer, layerIndex) => layer.forEach((id, rowIndex) => {
      positions[id] = {
        x: ORIGIN.x + layerIndex * HORIZONTAL_PITCH,
        y: ORIGIN.y + (componentRowOffset + rowIndex) * VERTICAL_PITCH,
      };
    }));
    componentRowOffset += rows;
  }
  return positions;
}

/**
 * Top-down variant of layoutGraph for hierarchy displays (org charts): swaps
 * the axes of the returned positions so rank (depth) drives the vertical
 * axis instead of the horizontal one. Does not modify layoutGraph itself.
 */
export function layoutGraphTopDown(graph: SupportedFlowGraph): Record<string, Point> {
  const positions = layoutGraph(graph);
  return Object.fromEntries(
    Object.entries(positions).map(([id, point]) => [id, { x: point.y, y: point.x }]),
  );
}
