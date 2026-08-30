import { auditGraphCommandBatchLimits, parseGraphCommand } from "./graph-command-schema";
import { GraphCommandError, type CommandResult, type GraphCommand, type JsonValue, type Point } from "./graph-command-types";
import {
  assertAuthoredEdgeHasNoTargetHandleCollision,
  assertCollisionMultisetNotWorsened,
  assertGraphInvariants,
} from "./graph-invariants";
import { applyJsonPatchWithInverse } from "./json-patch";
import { alignSelection, distributeSelection } from "./graph-geometry";
import {
  createAuthoringNodePortResolver,
  type ValidatedNodePortResolver,
} from "./node-ports";
import {
  isFlowGraphV1,
  isFlowGraphV2,
  isFlowVariable,
  parseSupportedFlowGraph,
} from "./graph-schema";
import { upgradeFlowGraph } from "./graph-v2-codec";
import type {
  FlowEdge,
  FlowEdgeV2,
  FlowGraphV2,
  FlowNode,
  FlowNodeV2,
  FlowVariable,
  SupportedFlowGraph,
  ValueBinding,
} from "./types";
import { validateCallableInterfaceForGraph } from "./callable-interface-validation";

const clone = <T>(value: T): T => structuredClone(value);
const inverseId = (command: GraphCommand): string => `${command.id}:inverse`;
const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

function resultWithParseableInverse(
  graph: SupportedFlowGraph,
  inverse: GraphCommand,
  affectedIds: Iterable<string>,
): CommandResult {
  try {
    auditGraphCommandBatchLimits(inverse);
  } catch (error) {
    throw new GraphCommandError("Generated inverse violates the graph command parser limits", { cause: error });
  }
  return { graph, inverse, affectedIds: sorted(affectedIds) };
}

function graphReplaceInverse(graph: SupportedFlowGraph, command: GraphCommand): GraphCommand {
  return { v: 1, id: inverseId(command), kind: "graph.replace", graph: clone(graph) };
}

function nodeAt(graph: SupportedFlowGraph, id: string): { node: FlowNode | FlowNodeV2; index: number } {
  const index = graph.nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new GraphCommandError(`Node "${id}" is missing`);
  const node = graph.nodes[index];
  if (node === undefined) throw new GraphCommandError(`Node "${id}" is missing`);
  return { node, index };
}

function edgeAt(graph: SupportedFlowGraph, id: string): { edge: FlowEdge | FlowEdgeV2; index: number } {
  const index = graph.edges.findIndex((edge) => edge.id === id);
  if (index < 0) throw new GraphCommandError(`Edge "${id}" is missing`);
  const edge = graph.edges[index];
  if (edge === undefined) throw new GraphCommandError(`Edge "${id}" is missing`);
  return { edge, index };
}

function insertAt<T>(values: readonly T[], value: T, index: number | undefined, label: string): T[] {
  const target = index ?? values.length;
  if (target > values.length) throw new GraphCommandError(`${label} insertion index ${target} is out of bounds`);
  const next = [...values];
  next.splice(target, 0, value);
  return next;
}

function positionsInverse(command: GraphCommand, positions: Readonly<Record<string, Point>>): GraphCommand {
  return { v: 1, id: inverseId(command), kind: "selection.move", positions };
}

function isV2OnlyCommand(command: GraphCommand): boolean {
  return command.kind === "callable-interface.set" ||
    command.kind === "callable-interface.remove" ||
    command.kind === "subflow-reference.set" ||
    command.kind === "variable.add" ||
    command.kind === "variable.patch" ||
    command.kind === "variable.remove" ||
    command.kind === "binding.set" ||
    command.kind === "binding.remove";
}

function commandRequiresV2Graph(command: GraphCommand): boolean {
  return isV2OnlyCommand(command) ||
    (command.kind === "node.add" && Object.hasOwn(command.node, "bindings")) ||
    (command.kind === "edge.add" && Object.hasOwn(command.edge, "condition"));
}

function variableAt(graph: FlowGraphV2, id: string): { variable: FlowVariable; index: number } {
  const index = graph.variables.findIndex((variable) => variable.id === id);
  if (index < 0) throw new GraphCommandError(`Variable "${id}" is missing`);
  const variable = graph.variables[index];
  if (variable === undefined) throw new GraphCommandError(`Variable "${id}" is missing`);
  return { variable, index };
}

function v2NodeAt(graph: FlowGraphV2, id: string): { node: FlowNodeV2; index: number } {
  const index = graph.nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new GraphCommandError(`Node "${id}" is missing`);
  const node = graph.nodes[index];
  if (node === undefined) throw new GraphCommandError(`Node "${id}" is missing`);
  return { node, index };
}

function referencesVariable(binding: ValueBinding | undefined, variableId: string): boolean {
  return binding?.kind === "variable" && binding.variableId === variableId;
}

function remapDuplicatedBinding(
  binding: ValueBinding,
  nodeIdMap: Readonly<Record<string, string>>,
): ValueBinding {
  if (binding.kind !== "port") return clone(binding);
  const mappedNodeId = Object.hasOwn(nodeIdMap, binding.nodeId)
    ? nodeIdMap[binding.nodeId]
    : undefined;
  return mappedNodeId === undefined ? clone(binding) : { ...clone(binding), nodeId: mappedNodeId };
}

function assertVariableUnreferenced(graph: FlowGraphV2, variableId: string): void {
  for (const node of graph.nodes) {
    for (const [key, binding] of Object.entries(node.bindings)) {
      if (referencesVariable(binding, variableId)) {
        throw new GraphCommandError(`Variable "${variableId}" is referenced by node "${node.id}" binding "${key}"`);
      }
    }
  }
  for (const edge of graph.edges) {
    if (referencesVariable(edge.condition, variableId)) {
      throw new GraphCommandError(`Variable "${variableId}" is referenced by edge "${edge.id}" condition`);
    }
  }
}

function assertVariableReferencesExist(graph: FlowGraphV2): void {
  const variableIds = new Set(graph.variables.map((variable) => variable.id));
  for (const node of graph.nodes) {
    for (const binding of Object.values(node.bindings)) {
      if (binding.kind === "variable" && !variableIds.has(binding.variableId)) {
        throw new GraphCommandError(`Variable "${binding.variableId}" referenced by node "${node.id}" is missing`);
      }
    }
  }
  for (const edge of graph.edges) {
    if (edge.condition?.kind === "variable" && !variableIds.has(edge.condition.variableId)) {
      throw new GraphCommandError(`Variable "${edge.condition.variableId}" referenced by edge "${edge.id}" is missing`);
    }
  }
}

function validateResult(graph: SupportedFlowGraph): void {
  parseSupportedFlowGraph(graph);
  assertGraphInvariants(graph);
  if (isFlowGraphV2(graph)) assertVariableReferencesExist(graph);
}

function supportedCandidate(value: unknown): SupportedFlowGraph {
  parseSupportedFlowGraph(value);
  if (isFlowGraphV1(value) || isFlowGraphV2(value)) return value;
  throw new GraphCommandError("Graph command produced an unsupported graph");
}

function inferredEdgeHandle(
  graph: FlowGraphV2,
  nodeId: string,
  direction: "input" | "output",
  edgeId: string,
  resolvePorts: ValidatedNodePortResolver,
): string {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new GraphCommandError(`Edge "${edgeId}" references missing node "${nodeId}"`);
  const ports = direction === "output"
    ? resolvePorts(node).outputPorts
    : resolvePorts(node).inputPorts;
  if (ports.length !== 1 || ports[0] === undefined) {
    throw new GraphCommandError(`Edge "${edgeId}" cannot infer a unique ${direction} handle for node "${nodeId}"`);
  }
  return ports[0].id;
}

function edgeForV2Graph(graph: FlowGraphV2, edge: FlowEdge | FlowEdgeV2): unknown {
  const resolvePorts = createAuthoringNodePortResolver(graph);
  return {
    ...clone(edge),
    sourceHandle: edge.sourceHandle ?? inferredEdgeHandle(graph, edge.source, "output", edge.id, resolvePorts),
    targetHandle: edge.targetHandle ?? inferredEdgeHandle(graph, edge.target, "input", edge.id, resolvePorts),
  };
}

function applyPrimitive(graph: SupportedFlowGraph, command: Exclude<GraphCommand, { kind: "graph.batch" }>): CommandResult {
  if (!isFlowGraphV2(graph) && commandRequiresV2Graph(command)) {
    const upgraded = upgradeFlowGraph(graph);
    const result = applyPrimitive(upgraded, command);
    return resultWithParseableInverse(result.graph, graphReplaceInverse(graph, command), result.affectedIds);
  }

  let next: SupportedFlowGraph;
  let inverse: GraphCommand;
  let affected: string[];

  switch (command.kind) {
    case "node.add": {
      if (graph.nodes.some((node) => node.id === command.node.id)) throw new GraphCommandError(`Duplicate node ID "${command.node.id}"`);
      const node = isFlowGraphV2(graph) && !Object.hasOwn(command.node, "bindings")
        ? { ...clone(command.node), bindings: {} }
        : clone(command.node);
      try {
        next = supportedCandidate({ ...graph, nodes: insertAt(graph.nodes, node, command.index, "Node") });
      } catch (error) {
        throw new GraphCommandError(`Node "${command.node.id}" is not compatible with this graph version`, { cause: error });
      }
      inverse = { v: 1, id: inverseId(command), kind: "node.remove", nodeId: command.node.id };
      affected = [command.node.id];
      break;
    }
    case "node.remove": {
      const { index } = nodeAt(graph, command.nodeId);
      const incident = graph.edges.filter((edge) => edge.source === command.nodeId || edge.target === command.nodeId);
      next = supportedCandidate({
        ...graph,
        nodes: graph.nodes.filter((_, nodeIndex) => nodeIndex !== index),
        edges: graph.edges.filter((edge) => edge.source !== command.nodeId && edge.target !== command.nodeId),
      });
      inverse = graphReplaceInverse(graph, command);
      affected = [command.nodeId, ...incident.map((edge) => edge.id)];
      break;
    }
    case "node.patch": {
      const { node, index } = nodeAt(graph, command.nodeId);
      const patched = applyJsonPatchWithInverse(node.params as never, command.patch);
      const nodes: Array<FlowNode | FlowNodeV2> = [...graph.nodes];
      nodes[index] = { ...node, params: patched.value as Record<string, never> };
      next = supportedCandidate({ ...graph, nodes });
      inverse = isFlowGraphV2(graph)
        ? graphReplaceInverse(graph, command)
        : { v: 1, id: inverseId(command), kind: "node.patch", nodeId: command.nodeId, patch: patched.inverse };
      affected = [command.nodeId];
      break;
    }
    case "edge.add": {
      if (graph.edges.some((edge) => edge.id === command.edge.id)) throw new GraphCommandError(`Duplicate edge ID "${command.edge.id}"`);
      const edge = isFlowGraphV2(graph) ? edgeForV2Graph(graph, command.edge) : clone(command.edge);
      assertAuthoredEdgeHasNoTargetHandleCollision(graph.edges, command.edge);
      try {
        next = supportedCandidate({ ...graph, edges: insertAt(graph.edges, edge, command.index, "Edge") });
      } catch (error) {
        throw new GraphCommandError(`Edge "${command.edge.id}" is not compatible with this graph version`, { cause: error });
      }
      inverse = { v: 1, id: inverseId(command), kind: "edge.remove", edgeId: command.edge.id };
      affected = [command.edge.id];
      break;
    }
    case "edge.remove": {
      const { index } = edgeAt(graph, command.edgeId);
      next = supportedCandidate({ ...graph, edges: graph.edges.filter((_, edgeIndex) => edgeIndex !== index) });
      inverse = graphReplaceInverse(graph, command);
      affected = [command.edgeId];
      break;
    }
    case "selection.move":
    case "layout.apply": {
      const oldPositions: Record<string, Point> = {};
      const positions = command.positions;
      const nodes = graph.nodes.map((node) => {
        const position = positions[node.id];
        if (!position) return node;
        oldPositions[node.id] = clone(node.position);
        return { ...node, position: clone(position) };
      });
      for (const id of Object.keys(positions)) nodeAt(graph, id);
      next = supportedCandidate({ ...graph, nodes });
      inverse = positionsInverse(command, oldPositions);
      affected = Object.keys(positions);
      break;
    }
    case "selection.duplicate": {
      const selected = new Set(command.nodeIds);
      const sourceNodes = command.nodeIds.map((id) => nodeAt(graph, id).node);
      const internalEdges = graph.edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target));
      const expectedEdgeIds = internalEdges.map((edge) => edge.id).sort();
      const mappedEdgeIds = Object.keys(command.edgeIdMap).sort();
      if (JSON.stringify(expectedEdgeIds) !== JSON.stringify(mappedEdgeIds)) {
        throw new GraphCommandError("edgeIdMap must exactly cover the selected internal edges");
      }
      const existingIds = new Set([
        ...graph.nodes.map((node) => node.id),
        ...graph.edges.map((edge) => edge.id),
      ]);
      const mappedIds = [
        ...Object.values(command.nodeIdMap),
        ...Object.values(command.edgeIdMap),
      ];
      if (new Set(mappedIds).size !== mappedIds.length) {
        throw new GraphCommandError("Duplicated node and edge IDs must be unique across maps");
      }
      for (const id of mappedIds) {
        if (existingIds.has(id)) throw new GraphCommandError(`Duplicated ID "${id}" collides with the graph`);
      }
      const newNodes = sourceNodes.map((node) => {
        const duplicated = {
          ...clone(node), id: command.nodeIdMap[node.id] as string,
          position: { x: node.position.x + command.offset.x, y: node.position.y + command.offset.y },
        };
        if (!isFlowGraphV2(graph) || !("bindings" in node)) return duplicated;
        return {
          ...duplicated,
          bindings: Object.fromEntries(
            Object.entries(node.bindings).map(([key, binding]) => [
              key,
              remapDuplicatedBinding(binding, command.nodeIdMap),
            ]),
          ),
        };
      });
      const newEdges = internalEdges.map((edge) => {
        const condition = isFlowGraphV2(graph) && "condition" in edge
          ? edge.condition
          : undefined;
        return {
          ...clone(edge), id: command.edgeIdMap[edge.id] as string,
          source: command.nodeIdMap[edge.source] as string, target: command.nodeIdMap[edge.target] as string,
          ...(condition === undefined
            ? {}
            : { condition: remapDuplicatedBinding(condition, command.nodeIdMap) }),
        };
      });
      next = supportedCandidate({ ...graph, nodes: [...graph.nodes, ...newNodes], edges: [...graph.edges, ...newEdges] });
      inverse = {
        v: 1,
        id: inverseId(command),
        kind: "graph.batch",
        commands: [
          ...[...newEdges].reverse().map((edge, index) => ({
            v: 1 as const,
            id: `${inverseId(command)}:edge:${index}`,
            kind: "edge.remove" as const,
            edgeId: edge.id,
          })),
          ...[...newNodes].reverse().map((node, index) => ({
            v: 1 as const,
            id: `${inverseId(command)}:node:${index}`,
            kind: "node.remove" as const,
            nodeId: node.id,
          })),
        ],
      };
      affected = [...newNodes.map((node) => node.id), ...newEdges.map((edge) => edge.id)];
      break;
    }
    case "graph.rename":
      next = { ...graph, name: command.name };
      inverse = { v: 1, id: inverseId(command), kind: "graph.rename", name: graph.name };
      affected = [graph.id];
      break;
    case "callable-interface.set": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Callable interface commands require a v2 graph");
      const previous = graph.callableInterface;
      const callableInterface = validateCallableInterfaceForGraph(graph, command.interface);
      next = { ...graph, callableInterface: clone(callableInterface) };
      inverse = previous === undefined
        ? { v: 1, id: inverseId(command), kind: "callable-interface.remove" }
        : {
            v: 1,
            id: inverseId(command),
            kind: "callable-interface.set",
            interface: clone(previous),
          };
      affected = [graph.id];
      break;
    }
    case "callable-interface.remove": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Callable interface commands require a v2 graph");
      if (graph.callableInterface === undefined) {
        throw new GraphCommandError("Callable interface is missing");
      }
      const { callableInterface, ...withoutInterface } = graph;
      next = withoutInterface;
      inverse = {
        v: 1,
        id: inverseId(command),
        kind: "callable-interface.set",
        interface: clone(callableInterface),
      };
      affected = [graph.id];
      break;
    }
    case "subflow-reference.set": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Reusable-flow reference commands require a v2 graph");
      const { node, index } = v2NodeAt(graph, command.nodeId);
      if (node.type !== "subflow" && node.type !== "loop") {
        throw new GraphCommandError(`Node "${node.id}" is not a subflow or loop`);
      }
      const params = { ...node.params };
      delete params.flowId;
      delete params.reference;
      params.reference = clone(command.reference) as never;
      const nodes = [...graph.nodes];
      nodes[index] = { ...node, params };
      next = supportedCandidate({ ...graph, nodes });
      inverse = graphReplaceInverse(graph, command);
      affected = [node.id];
      break;
    }
    case "variable.add": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Variable commands require a v2 graph");
      if (graph.variables.some((variable) => variable.id === command.variable.id)) {
        throw new GraphCommandError(`Duplicate variable ID "${command.variable.id}"`);
      }
      const normalizedName = command.variable.name.toLowerCase();
      if (graph.variables.some((variable) => variable.name.toLowerCase() === normalizedName)) {
        throw new GraphCommandError(`Variable name "${command.variable.name}" must be unique`);
      }
      next = { ...graph, variables: insertAt(graph.variables, clone(command.variable), command.index, "Variable") };
      inverse = { v: 1, id: inverseId(command), kind: "variable.remove", variableId: command.variable.id };
      affected = [command.variable.id];
      break;
    }
    case "variable.patch": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Variable commands require a v2 graph");
      const { variable, index } = variableAt(graph, command.variableId);
      const variableJson: JsonValue = { ...variable };
      const patched = applyJsonPatchWithInverse(variableJson, command.patch, { forbiddenRootKeys: ["id"] });
      const variables = [...graph.variables];
      if (!isFlowVariable(patched.value)) throw new GraphCommandError(`Variable "${command.variableId}" patch is invalid`);
      variables[index] = patched.value;
      next = { ...graph, variables };
      inverse = graphReplaceInverse(graph, command);
      affected = [command.variableId];
      break;
    }
    case "variable.remove": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Variable commands require a v2 graph");
      const { variable, index } = variableAt(graph, command.variableId);
      assertVariableUnreferenced(graph, command.variableId);
      next = { ...graph, variables: graph.variables.filter((_, variableIndex) => variableIndex !== index) };
      inverse = { v: 1, id: inverseId(command), kind: "variable.add", variable: clone(variable), index };
      affected = [command.variableId];
      break;
    }
    case "binding.set": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Binding commands require a v2 graph");
      if (command.binding.kind === "variable") {
        const variableId = command.binding.variableId;
        if (!graph.variables.some((variable) => variable.id === variableId)) {
          throw new GraphCommandError(`Variable "${variableId}" is missing`);
        }
      }
      const { node, index } = v2NodeAt(graph, command.nodeId);
      const previous = node.bindings[command.key];
      const nodes = [...graph.nodes];
      nodes[index] = { ...node, bindings: { ...node.bindings, [command.key]: clone(command.binding) } };
      next = supportedCandidate({ ...graph, nodes });
      inverse = previous === undefined
        ? { v: 1, id: inverseId(command), kind: "binding.remove", nodeId: command.nodeId, key: command.key }
        : { v: 1, id: inverseId(command), kind: "binding.set", nodeId: command.nodeId, key: command.key, binding: clone(previous) };
      affected = [command.nodeId];
      break;
    }
    case "binding.remove": {
      if (!isFlowGraphV2(graph)) throw new GraphCommandError("Binding commands require a v2 graph");
      const { node, index } = v2NodeAt(graph, command.nodeId);
      const previous = node.bindings[command.key];
      if (previous === undefined) throw new GraphCommandError(`Binding "${command.key}" is missing from node "${command.nodeId}"`);
      const bindings = { ...node.bindings };
      delete bindings[command.key];
      const nodes = [...graph.nodes];
      nodes[index] = { ...node, bindings };
      next = supportedCandidate({ ...graph, nodes });
      inverse = graphReplaceInverse(graph, command);
      affected = [command.nodeId];
      break;
    }
    case "graph.replace":
      next = clone(command.graph);
      inverse = graphReplaceInverse(graph, command);
      affected = sorted([graph.id, command.graph.id, ...graph.nodes.map((node) => node.id), ...graph.edges.map((edge) => edge.id), ...command.graph.nodes.map((node) => node.id), ...command.graph.edges.map((edge) => edge.id)]);
      validateResult(next);
      return resultWithParseableInverse(next, inverse, affected);
    case "selection.align":
    case "selection.distribute": {
      const positions = command.kind === "selection.align"
        ? alignSelection(command.bounds, command.nodeIds, command.axis, command.mode)
        : distributeSelection(command.bounds, command.nodeIds, command.axis);
      const oldPositions = Object.fromEntries(command.nodeIds.map((id) => [id, clone(nodeAt(graph, id).node.position)]));
      const nodes = graph.nodes.map((node) => positions[node.id] ? { ...node, position: clone(positions[node.id] as Point) } : node);
      next = supportedCandidate({ ...graph, nodes });
      inverse = positionsInverse(command, oldPositions);
      affected = [...command.nodeIds];
      break;
    }
  }

  validateResult(next);
  assertCollisionMultisetNotWorsened(graph.edges, next.edges);
  return resultWithParseableInverse(next, inverse, affected);
}

export function applyGraphCommand(graph: SupportedFlowGraph, input: GraphCommand): CommandResult {
  const command = parseGraphCommand(input);
  assertGraphInvariants(graph);
  if (command.kind !== "graph.batch") return applyPrimitive(graph, command);

  let working = graph;
  const inverses: GraphCommand[] = [];
  const affected = new Set<string>();
  for (const child of command.commands) {
    const result = applyGraphCommand(working, child);
    working = result.graph;
    inverses.unshift(result.inverse);
    for (const id of result.affectedIds) affected.add(id);
  }
  assertGraphInvariants(working);
  return resultWithParseableInverse(
    working,
    { v: 1, id: inverseId(command), kind: "graph.batch", commands: inverses },
    affected,
  );
}

export function canApplyGraphCommand(graph: SupportedFlowGraph, command: GraphCommand): boolean {
  try {
    applyGraphCommand(graph, command);
    return true;
  } catch {
    return false;
  }
}
