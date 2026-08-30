import { createAuthoringNodePortResolver, type ValidatedNodePortResolver } from "./node-ports";
import type { FlowEdgeV2, FlowGraphV2, FlowNodeV2, ValueBinding } from "./types";

export type FlowTestScope =
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "to-node"; readonly nodeId: string }
  | { readonly kind: "from-node"; readonly nodeId: string };

interface BoundaryPinBase {
  readonly key: string;
  readonly sourceNodeId: string;
  readonly sourcePortId: string;
  readonly targetNodeId: string;
}

export interface EdgeInputBoundaryPin extends BoundaryPinBase {
  readonly kind: "edge-input";
  readonly edgeId: string;
  readonly targetPortId: string;
}

export interface NodeBindingBoundaryPin extends BoundaryPinBase {
  readonly kind: "node-binding";
  readonly bindingKey: string;
  readonly path?: string;
}

export interface EdgeConditionBoundaryPin extends BoundaryPinBase {
  readonly kind: "edge-condition";
  readonly edgeId: string;
  readonly path?: string;
  readonly expected: "boolean";
}

export type FlowTestBoundaryPin =
  | EdgeInputBoundaryPin
  | NodeBindingBoundaryPin
  | EdgeConditionBoundaryPin;

export interface PlannedFlowTestScope {
  readonly status: "planned";
  readonly scope: FlowTestScope;
  readonly executionOrder: readonly string[];
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly boundaryPins: readonly FlowTestBoundaryPin[];
  readonly boundaryNodeIds: readonly string[];
  readonly unreachableNodeIds: readonly string[];
  readonly disabledNodeIds: readonly string[];
}

export type DisabledFlowTestScope =
  | {
      readonly status: "disabled";
      readonly code: "MISSING_NODE";
      readonly message: string;
    }
  | {
      readonly status: "disabled";
      readonly code: "INVALID_GRAPH";
      readonly message: string;
    }
  | {
      readonly status: "disabled";
      readonly code: "CYCLE";
      readonly message: string;
      readonly cycleNodeIds: readonly string[];
    };

export type FlowTestScopeResult = PlannedFlowTestScope | DisabledFlowTestScope;

type Dependency =
  | { readonly kind: "edge"; readonly producer: string; readonly consumer: string; readonly edge: FlowEdgeV2 }
  | {
      readonly kind: "binding";
      readonly producer: string;
      readonly consumer: string;
      readonly bindingKey: string;
      readonly binding: Extract<ValueBinding, { readonly kind: "port" }>;
    }
  | {
      readonly kind: "condition";
      readonly producer: string;
      readonly consumer: string;
      readonly edge: FlowEdgeV2;
      readonly binding: Extract<ValueBinding, { readonly kind: "port" }>;
    };

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sorted = (values: Iterable<string>): string[] => [...values].sort(compare);

function invalid(message: string): DisabledFlowTestScope {
  return { status: "disabled", code: "INVALID_GRAPH", message };
}

function collectDependencies(graph: FlowGraphV2): Dependency[] | DisabledFlowTestScope {
  const dependencies: Dependency[] = [];
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) return invalid(`Duplicate edge ID "${edge.id}".`);
    edgeIds.add(edge.id);
    dependencies.push({ kind: "edge", producer: edge.source, consumer: edge.target, edge });
    if (edge.condition?.kind === "port") {
      dependencies.push({
        kind: "condition",
        producer: edge.condition.nodeId,
        consumer: edge.target,
        edge,
        binding: edge.condition,
      });
    }
  }
  for (const node of graph.nodes) {
    for (const [bindingKey, binding] of Object.entries(node.bindings)) {
      if (binding.kind !== "port") continue;
      dependencies.push({
        kind: "binding",
        producer: binding.nodeId,
        consumer: node.id,
        bindingKey,
        binding,
      });
    }
  }
  return dependencies;
}

function directionalClosure(
  target: string,
  kind: FlowTestScope["kind"],
  dependencies: readonly Dependency[],
): Set<string> {
  const included = new Set([target]);
  if (kind === "node") return included;
  const adjacency = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    const from = kind === "to-node" ? dependency.consumer : dependency.producer;
    const to = kind === "to-node" ? dependency.producer : dependency.consumer;
    const neighbors = adjacency.get(from) ?? new Set<string>();
    neighbors.add(to);
    adjacency.set(from, neighbors);
  }
  const queue = [target];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const next of sorted(adjacency.get(current) ?? [])) {
      if (!included.has(next)) {
        included.add(next);
        queue.push(next);
      }
    }
  }
  return included;
}

function validateRelevantPorts(
  graph: FlowGraphV2,
  nodes: ReadonlyMap<string, FlowNodeV2>,
  dependencies: readonly Dependency[],
  included: ReadonlySet<string>,
  resolveGraphPorts?: ValidatedNodePortResolver,
): DisabledFlowTestScope | null {
  const resolvePorts = resolveGraphPorts ?? createAuthoringNodePortResolver(graph);
  const ports = new Map<string, ReturnType<typeof resolvePorts>>();
  const getPorts = (nodeId: string) => {
    const existing = ports.get(nodeId);
    if (existing) return existing;
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`Missing node "${nodeId}".`);
    const value = resolvePorts(node);
    ports.set(nodeId, value);
    return value;
  };
  try {
    for (const dependency of dependencies) {
      if (!included.has(dependency.consumer)) continue;
      const sourcePortId = dependency.kind === "edge"
        ? dependency.edge.sourceHandle
        : dependency.binding.portId;
      if (!getPorts(dependency.producer).outputPorts.some(({ id }) => id === sourcePortId)) {
        return invalid(`Dependency references undeclared output port "${dependency.producer}.${sourcePortId}".`);
      }
      if (dependency.kind === "edge" &&
          !getPorts(dependency.consumer).inputPorts.some(({ id }) => id === dependency.edge.targetHandle)) {
        return invalid(`Edge "${dependency.edge.id}" references undeclared input port "${dependency.consumer}.${dependency.edge.targetHandle}".`);
      }
    }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Test scope port validation failed.");
  }
  return null;
}

function internalAdjacency(
  included: ReadonlySet<string>,
  dependencies: readonly Dependency[],
): Map<string, Set<string>> {
  const adjacency = new Map(sorted(included).map((id) => [id, new Set<string>()]));
  for (const { producer, consumer } of dependencies) {
    if (included.has(producer) && included.has(consumer)) adjacency.get(producer)!.add(consumer);
  }
  return adjacency;
}

function cycleNodes(adjacency: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const visited = new Set<string>();
  const finish: string[] = [];
  for (const seed of sorted(adjacency.keys())) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    const stack: Array<{ readonly id: string; readonly neighbors: readonly string[]; index: number }> = [
      { id: seed, neighbors: sorted(adjacency.get(seed) ?? []), index: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.neighbors[frame.index++];
      if (next !== undefined) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ id: next, neighbors: sorted(adjacency.get(next) ?? []), index: 0 });
        }
      } else {
        finish.push(frame.id);
        stack.pop();
      }
    }
  }
  const reverse = new Map(sorted(adjacency.keys()).map((id) => [id, new Set<string>()]));
  for (const [source, targets] of adjacency) for (const target of targets) reverse.get(target)!.add(source);
  const assigned = new Set<string>();
  const cyclic = new Set<string>();
  for (const seed of [...finish].reverse()) {
    if (assigned.has(seed)) continue;
    const component: string[] = [];
    const stack = [seed];
    assigned.add(seed);
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      for (const prior of sorted(reverse.get(id) ?? []).reverse()) {
        if (!assigned.has(prior)) {
          assigned.add(prior);
          stack.push(prior);
        }
      }
    }
    if (component.length > 1 || (adjacency.get(component[0]!)?.has(component[0]!) ?? false)) {
      for (const id of component) cyclic.add(id);
    }
  }
  return sorted(cyclic);
}

function topologicalOrder(adjacency: ReadonlyMap<string, ReadonlySet<string>>): string[] | null {
  const indegree = new Map(sorted(adjacency.keys()).map((id) => [id, 0]));
  for (const targets of adjacency.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const ready = sorted([...indegree].filter(([, degree]) => degree === 0).map(([id]) => id));
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const target of sorted(adjacency.get(id) ?? [])) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort(compare);
      }
    }
  }
  return order.length === adjacency.size ? order : null;
}

function boundaryPin(dependency: Dependency): FlowTestBoundaryPin {
  if (dependency.kind === "edge") {
    const tuple = [
      "edge-input", dependency.edge.id, dependency.producer, dependency.edge.sourceHandle,
      dependency.consumer, dependency.edge.targetHandle,
    ] as const;
    return {
      kind: "edge-input", key: JSON.stringify(tuple), edgeId: dependency.edge.id,
      sourceNodeId: dependency.producer, sourcePortId: dependency.edge.sourceHandle,
      targetNodeId: dependency.consumer, targetPortId: dependency.edge.targetHandle,
    };
  }
  if (dependency.kind === "binding") {
    const tuple = [
      "node-binding", dependency.consumer, dependency.bindingKey, dependency.producer,
      dependency.binding.portId, dependency.binding.path ?? null,
    ] as const;
    return {
      kind: "node-binding", key: JSON.stringify(tuple), sourceNodeId: dependency.producer,
      sourcePortId: dependency.binding.portId, targetNodeId: dependency.consumer,
      bindingKey: dependency.bindingKey,
      ...(dependency.binding.path === undefined ? {} : { path: dependency.binding.path }),
    };
  }
  const tuple = [
    "edge-condition", dependency.edge.id, dependency.consumer, dependency.producer,
    dependency.binding.portId, dependency.binding.path ?? null,
  ] as const;
  return {
    kind: "edge-condition", key: JSON.stringify(tuple), edgeId: dependency.edge.id,
    sourceNodeId: dependency.producer, sourcePortId: dependency.binding.portId,
    targetNodeId: dependency.consumer,
    ...(dependency.binding.path === undefined ? {} : { path: dependency.binding.path }),
    expected: "boolean",
  };
}

const PIN_RANK: Readonly<Record<FlowTestBoundaryPin["kind"], number>> = {
  "edge-input": 0,
  "edge-condition": 1,
  "node-binding": 2,
};

function comparePins(left: FlowTestBoundaryPin, right: FlowTestBoundaryPin): number {
  return PIN_RANK[left.kind] - PIN_RANK[right.kind] || compare(left.key, right.key);
}

function compareEdges(left: FlowEdgeV2, right: FlowEdgeV2): number {
  for (const [a, b] of [
    [left.source, right.source], [left.target, right.target],
    [left.sourceHandle, right.sourceHandle], [left.targetHandle, right.targetHandle],
    [left.id, right.id],
  ] as const) {
    const result = compare(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

export function planFlowTestScope(
  graph: FlowGraphV2,
  scope: FlowTestScope,
  resolveGraphPorts?: ValidatedNodePortResolver,
): FlowTestScopeResult {
  const nodes = new Map<string, FlowNodeV2>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) return invalid(`Duplicate node ID "${node.id}".`);
    nodes.set(node.id, node);
  }
  if (!nodes.has(scope.nodeId)) {
    return { status: "disabled", code: "MISSING_NODE", message: `Test node "${scope.nodeId}" does not exist.` };
  }
  const dependencies = collectDependencies(graph);
  if (!Array.isArray(dependencies)) return dependencies;
  const included = directionalClosure(scope.nodeId, scope.kind, dependencies);
  const invalidPorts = validateRelevantPorts(graph, nodes, dependencies, included, resolveGraphPorts);
  if (invalidPorts) return invalidPorts;
  const adjacency = internalAdjacency(included, dependencies);
  const executionOrder = topologicalOrder(adjacency);
  if (executionOrder === null) {
    return {
      status: "disabled",
      code: "CYCLE",
      message: "The selected test scope contains a dependency cycle.",
      cycleNodeIds: cycleNodes(adjacency),
    };
  }
  const boundaryPins = dependencies
    .filter(({ producer, consumer }) => included.has(consumer) && !included.has(producer))
    .map(boundaryPin)
    .sort(comparePins);
  const boundaryNodeIds = sorted(new Set(boundaryPins.map(({ sourceNodeId }) => sourceNodeId)));
  const boundary = new Set(boundaryNodeIds);
  const outside = sorted([...nodes.keys()].filter((id) => !included.has(id)));
  const unreachableNodeIds = outside.filter((id) => !boundary.has(id));
  const internalEdges = graph.edges
    .filter(({ source, target }) => included.has(source) && included.has(target))
    .sort(compareEdges);
  return {
    status: "planned",
    scope: { ...scope },
    executionOrder,
    nodeIds: [...executionOrder],
    edgeIds: internalEdges.map(({ id }) => id),
    boundaryPins,
    boundaryNodeIds,
    unreachableNodeIds,
    disabledNodeIds: outside,
  };
}
