import type { NodeContext } from "./executor";
import {
  materializeCallableInputs,
  projectCallableOutputs,
} from "./subflow-reference";
import type { FlowCallableInterface, JsonValue } from "./types";
import type { NodeRegistry } from "./executor";
import type { SupportedFlowGraph } from "./types";
import { isFlowGraphV2 } from "./graph-schema";
import { createValidatedNodeRuntimeDefinitionResolver } from "./executor";

export function assertSubflowCanEnter(ctx: NodeContext, flowId: string): void {
  if (ctx.flowAncestry.includes(flowId)) {
    throw new Error(`Recursive subflow reference refused for flow row "${flowId}"`);
  }
}

export function createChildContext(ctx: NodeContext, flowId: string): NodeContext {
  assertSubflowCanEnter(ctx, flowId);
  const ancestry = Object.freeze([...ctx.flowAncestry, flowId]);
  return { ...ctx, depth: ctx.depth + 1, flowAncestry: ancestry };
}

export function buildCallableTrigger(
  callableInterface: FlowCallableInterface,
  inputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const value = materializeCallableInputs(callableInterface, inputs);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Callable trigger root must be an object");
  }
  return value as Record<string, JsonValue>;
}

export function collectCallableOutputs(
  callableInterface: FlowCallableInterface,
  outputs: Readonly<Record<string, unknown>>,
): Record<string, JsonValue> {
  return projectCallableOutputs(callableInterface, outputs);
}

export function assertExactCallableInputKeys(
  callableInterface: FlowCallableInterface,
  inputs: Readonly<Record<string, unknown>>,
): void {
  const allowed = new Set(callableInterface.inputs.map((port) => port.id));
  for (const key of Object.keys(inputs)) {
    if (!allowed.has(key)) throw new Error(`Callable input contains undeclared key "${key}"`);
  }
}

export function assertCallableOutputSourcesExist(
  graph: SupportedFlowGraph,
  callableInterface: FlowCallableInterface,
  registry: NodeRegistry,
): void {
  if (!isFlowGraphV2(graph)) throw new Error("Typed subflow must resolve to a v2 graph");
  const resolveRuntime = createValidatedNodeRuntimeDefinitionResolver(graph, registry);
  for (const output of callableInterface.outputs) {
    const node = graph.nodes.find((candidate) => candidate.id === output.source.nodeId);
    if (!node) {
      throw new Error(`Callable output "${output.id}" source node "${output.source.nodeId}" is missing`);
    }
    const runtime = resolveRuntime(node);
    if (!runtime || !runtime.outputs.includes(output.source.portId)) {
      throw new Error(
        `Callable output "${output.id}" source port "${output.source.nodeId}.${output.source.portId}" is missing`,
      );
    }
  }
}
