import type {
  NodeDefinitionV2,
  NodeEffect,
  PermissionSpec,
  PortSpec,
} from "./node-definition-types";
import { getNodeDefinition } from "./node-definitions";
import { isFlowGraphV2, parseSupportedFlowGraph } from "./graph-schema";
import { normalizeSubflowReference } from "./subflow-reference";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  FlowNode,
  FlowNodeV2,
  JsonSchema,
  JsonValue,
  NodeType,
  SupportedFlowGraph,
} from "./types";
import type { DynamicNodePortResolver } from "./operation-port-resolver";

export type StaticNodeDefinitionResolver = (type: NodeType) => NodeDefinitionV2;

export interface ResolvedNodePorts {
  readonly inputPorts: readonly PortSpec[];
  readonly outputPorts: readonly PortSpec[];
}

export type ValidatedNodePortResolver = (node: FlowNode | FlowNodeV2) => ResolvedNodePorts;

export interface ResolvedChildCapabilityReceipt {
  readonly nodeTypes: readonly NodeType[];
  readonly effects: readonly NodeEffect[];
  readonly permissions: readonly PermissionSpec[];
  readonly cost:
    | { readonly kind: "free" }
    | { readonly kind: "estimated"; readonly currency: "USDC"; readonly amount: number }
    | { readonly kind: "variable"; readonly currency: "USDC" };
}

function callablePort(port: FlowCallableInterface["inputs"][number]): PortSpec;
function callablePort(port: FlowCallableInterface["outputs"][number]): PortSpec;
function callablePort(
  port: FlowCallableInterface["inputs"][number] | FlowCallableInterface["outputs"][number],
): PortSpec {
  return {
    id: port.id,
    label: port.label,
    schema: port.schema,
    required: port.required,
    cardinality: port.cardinality,
  };
}

function typedLoopPorts(
  callableInterface: FlowCallableInterface,
  definition: NodeDefinitionV2,
): ResolvedNodePorts {
  if (callableInterface.outputs.some((port) => port.id === "errors")) {
    throw new Error('Typed loop child callable output id "errors" is reserved');
  }
  const properties: Record<string, JsonValue> = {};
  for (const port of callableInterface.inputs) properties[port.id] = port.schema;
  const required = callableInterface.inputs.filter((port) => port.required).map((port) => port.id);
  const itemSchema: JsonSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
  const errors = definition.outputPorts.find((port) => port.id === "errors");
  if (!errors) throw new Error("Typed loop requires the canonical reserved errors output");

  return {
    inputPorts: [{
      id: "items",
      label: "Items",
      schema: { type: "array", items: itemSchema },
      required: true,
      cardinality: "one",
    }],
    outputPorts: [
      ...callableInterface.outputs.map((port): PortSpec => ({
        id: port.id,
        label: port.label,
        schema: {
          type: "array",
          items: { anyOf: [port.schema, { type: "null" }] },
        },
        required: true,
        cardinality: "one",
      })),
      errors,
    ],
  };
}

/**
 * Resolve the handles a node has in this exact graph. This is the only
 * graph-aware port authority; callers may inject their own static catalog
 * so custom runtime registries retain their authored contracts.
 */
export function resolveNodePorts(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolveStatic: StaticNodeDefinitionResolver = getNodeDefinition,
  resolveDynamic?: DynamicNodePortResolver,
): ResolvedNodePorts {
  const definition = resolveStatic(node.type);
  const dynamic = resolveDynamic?.(node);
  if (dynamic) return dynamic;
  const declaredV2 = Reflect.get(graph, "schemaVersion") === 2;
  if (!declaredV2 || (node.type !== "subflow" && node.type !== "loop")) {
    return { inputPorts: definition.inputPorts, outputPorts: definition.outputPorts };
  }
  if (!Object.hasOwn(node.params, "flowId") && !Object.hasOwn(node.params, "reference")) {
    return { inputPorts: definition.inputPorts, outputPorts: definition.outputPorts };
  }
  const normalized = normalizeSubflowReference(node.params);
  if (
    node.type === "loop" &&
    normalized.kind === "typed" &&
    normalized.reference.interface.outputs.some((port) => port.id === "errors")
  ) {
    throw new Error('Typed loop child callable output id "errors" is reserved');
  }
  if (!isFlowGraphV2(graph)) throw new Error("Cannot resolve ports for an invalid schemaVersion 2 graph");
  if (normalized.kind === "legacy") {
    return { inputPorts: definition.inputPorts, outputPorts: definition.outputPorts };
  }
  if (node.type === "loop") return typedLoopPorts(normalized.reference.interface, definition);
  return {
    inputPorts: normalized.reference.interface.inputs.map(callablePort),
    outputPorts: normalized.reference.interface.outputs.map(callablePort),
  };
}

function resolvePortsFromValidatedSnapshot(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolveStatic: StaticNodeDefinitionResolver,
  resolveDynamic?: DynamicNodePortResolver,
): ResolvedNodePorts {
  const definition = resolveStatic(node.type);
  const dynamic = resolveDynamic?.(node);
  if (dynamic) return dynamic;
  if (Reflect.get(graph, "schemaVersion") !== 2 || (node.type !== "subflow" && node.type !== "loop")) {
    return { inputPorts: definition.inputPorts, outputPorts: definition.outputPorts };
  }
  if (!Object.hasOwn(node.params, "flowId") && !Object.hasOwn(node.params, "reference")) {
    return { inputPorts: definition.inputPorts, outputPorts: definition.outputPorts };
  }
  const normalized = normalizeSubflowReference(node.params);
  if (normalized.kind === "legacy") {
    return { inputPorts: definition.inputPorts, outputPorts: definition.outputPorts };
  }
  if (node.type === "loop") return typedLoopPorts(normalized.reference.interface, definition);
  return {
    inputPorts: normalized.reference.interface.inputs.map(callablePort),
    outputPorts: normalized.reference.interface.outputs.map(callablePort),
  };
}

/** Validate and snapshot once, then resolve every node without re-parsing the graph. */
export function createValidatedNodePortResolver(
  graph: SupportedFlowGraph,
  resolveStatic: StaticNodeDefinitionResolver = getNodeDefinition,
  resolveDynamic?: DynamicNodePortResolver,
): ValidatedNodePortResolver {
  if (Reflect.get(graph, "schemaVersion") !== 2) {
    return (node) => resolvePortsFromValidatedSnapshot(graph, node, resolveStatic, resolveDynamic);
  }
  const validated = parseSupportedFlowGraph(graph);
  if (Reflect.get(validated, "schemaVersion") !== 2) {
    throw new Error("Cannot resolve ports for an invalid schemaVersion 2 graph");
  }
  const nodes = new Map(validated.nodes.map((node) => [node.id, node]));
  return (node) => {
    const snapshot = nodes.get(node.id);
    if (!snapshot || snapshot.type !== node.type) {
      throw new Error(`Cannot resolve ports for node "${node.id}" outside the validated graph snapshot`);
    }
    return resolvePortsFromValidatedSnapshot(validated, snapshot, resolveStatic, resolveDynamic);
  };
}

/**
 * Snapshot resolver for an already-owned authoring graph. It deliberately
 * permits unresolved wrapper placeholders while avoiding whole-graph work.
 * Persistence/runtime/manifest boundaries must use the validated factory.
 */
export function createAuthoringNodePortResolver(
  graph: SupportedFlowGraph,
  resolveStatic: StaticNodeDefinitionResolver = getNodeDefinition,
  resolveDynamic?: DynamicNodePortResolver,
): ValidatedNodePortResolver {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return (node) => {
    const snapshot = nodes.get(node.id);
    if (!snapshot || snapshot.type !== node.type) {
      throw new Error(`Cannot resolve ports for node "${node.id}" outside the authoring graph snapshot`);
    }
    return resolvePortsFromValidatedSnapshot(graph, snapshot, resolveStatic, resolveDynamic);
  };
}

/** Fail closed on every graph reference that names a node port. */
export function assertGraphPortReferences(
  graph: SupportedFlowGraph,
  resolveStatic: StaticNodeDefinitionResolver = getNodeDefinition,
  resolveGraphPorts?: ValidatedNodePortResolver,
): void {
  if (Reflect.get(graph, "schemaVersion") !== 2) return;
  const resolvePorts = resolveGraphPorts ?? createValidatedNodePortResolver(graph, resolveStatic);
  const v2Graph = graph as FlowGraphV2;
  const nodes = new Map(v2Graph.nodes.map((node) => [node.id, node]));
  const ports = new Map(v2Graph.nodes.map((node) => [node.id, resolvePorts(node)]));
  const incoming = new Map<string, number>();
  const assertOutput = (nodeId: string, portId: string, location: string): void => {
    const node = nodes.get(nodeId);
    const contract = ports.get(nodeId);
    if (!node || !contract) throw new Error(`${location} references missing source node "${nodeId}"`);
    if (!contract.outputPorts.some((port) => port.id === portId)) {
      throw new Error(`${location} references undeclared source port "${nodeId}.${portId}"`);
    }
  };
  for (const edge of v2Graph.edges) {
    assertOutput(edge.source, edge.sourceHandle, `Edge "${edge.id}"`);
    const target = nodes.get(edge.target);
    const contract = ports.get(edge.target);
    if (!target || !contract) throw new Error(`Edge "${edge.id}" references missing target node "${edge.target}"`);
    const targetPort = contract.inputPorts.find((port) => port.id === edge.targetHandle);
    if (!targetPort) throw new Error(`Edge "${edge.id}" references undeclared target port "${edge.target}.${edge.targetHandle}"`);
    const key = `${edge.target}\u0000${edge.targetHandle}`;
    const count = (incoming.get(key) ?? 0) + 1;
    incoming.set(key, count);
    if (targetPort.cardinality === "one" && count > 1) {
      throw new Error(`Input "${edge.target}.${edge.targetHandle}" accepts only one edge`);
    }
    if (edge.condition?.kind === "port") {
      assertOutput(edge.condition.nodeId, edge.condition.portId, `Edge "${edge.id}" condition`);
    }
  }
  for (const node of v2Graph.nodes) {
    for (const [key, binding] of Object.entries(node.bindings)) {
      if (binding.kind === "port") assertOutput(binding.nodeId, binding.portId, `Node "${node.id}" binding "${key}"`);
    }
  }
}

const EFFECT_ORDER: readonly NodeEffect[] = ["read", "write", "delete", "send", "spend", "publish", "settle"];

/**
 * Conservative disclosure for an already-resolved child graph. Unknown or
 * inherited cost is variable; estimated costs are summed, never averaged.
 */
export function resolveChildCapabilityReceipt(
  childGraph: SupportedFlowGraph,
  resolveStatic: StaticNodeDefinitionResolver = getNodeDefinition,
): ResolvedChildCapabilityReceipt {
  const definitions = childGraph.nodes.map((node) => resolveStatic(node.type));
  const effects = new Set(definitions.flatMap((definition) => definition.effects));
  const permissions = new Map<string, PermissionSpec>();
  for (const definition of definitions) {
    for (const permission of definition.permissions) {
      const existing = permissions.get(permission.id);
      permissions.set(permission.id, existing?.required || permission.required
        ? { ...permission, required: true }
        : permission);
    }
  }

  const variable = definitions.some((definition) =>
    definition.cost.kind === "variable" || definition.capabilityMode === "inherits-graph",
  );
  const estimated = definitions.reduce((sum, definition) =>
    sum + (definition.cost.kind === "estimated" && typeof definition.cost.amount === "number"
      ? definition.cost.amount
      : 0), 0);
  const cost = variable
    ? { kind: "variable" as const, currency: "USDC" as const }
    : estimated > 0
      ? { kind: "estimated" as const, currency: "USDC" as const, amount: estimated }
      : { kind: "free" as const };

  return {
    nodeTypes: [...new Set(childGraph.nodes.map((node) => node.type))].sort(),
    effects: EFFECT_ORDER.filter((effect) => effects.has(effect)),
    permissions: [...permissions.values()].sort((left, right) => left.id.localeCompare(right.id)),
    cost,
  };
}

/**
 * Receipt for the node as authored, optionally enriched by a resolved child.
 * The child can only widen disclosure; an inherits-graph wrapper's existing
 * conservative effects, permissions, and variable cost are never reduced.
 */
export function resolveNodeCapabilityReceipt(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  resolvedChild?: SupportedFlowGraph,
  resolveStatic: StaticNodeDefinitionResolver = getNodeDefinition,
  resolvePorts?: ValidatedNodePortResolver,
): ResolvedChildCapabilityReceipt {
  (resolvePorts ?? ((candidate) => resolveNodePorts(graph, candidate, resolveStatic)))(node);
  const definition = resolveStatic(node.type);
  const child = resolvedChild ? resolveChildCapabilityReceipt(resolvedChild, resolveStatic) : null;
  const effects = new Set<NodeEffect>([...definition.effects, ...(child?.effects ?? [])]);
  const permissions = new Map<string, PermissionSpec>();
  for (const permission of [...definition.permissions, ...(child?.permissions ?? [])]) {
    const existing = permissions.get(permission.id);
    permissions.set(permission.id, existing?.required || permission.required
      ? { ...permission, required: true }
      : permission);
  }
  const definitionVariable = definition.cost.kind === "variable" || definition.capabilityMode === "inherits-graph";
  const childVariable = child?.cost.kind === "variable";
  const amount = (definition.cost.kind === "estimated" ? definition.cost.amount ?? 0 : 0) +
    (child?.cost.kind === "estimated" ? child.cost.amount : 0);
  const cost = definitionVariable || childVariable
    ? { kind: "variable" as const, currency: "USDC" as const }
    : amount > 0
      ? { kind: "estimated" as const, currency: "USDC" as const, amount }
      : { kind: "free" as const };
  return {
    nodeTypes: child?.nodeTypes ?? [node.type],
    effects: EFFECT_ORDER.filter((effect) => effects.has(effect)),
    permissions: [...permissions.values()].sort((left, right) => left.id.localeCompare(right.id)),
    cost,
  };
}
