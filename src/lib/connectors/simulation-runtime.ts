import { evaluateExpression } from "@/lib/flow/expr";
import type { PlannedFlowTestScope } from "@/lib/flow/test-scope";
import type { FlowGraphV2, FlowNodeV2, JsonValue, ValueBinding } from "@/lib/flow/types";
import { generateSchemaSentinel } from "./sentinel";
import {
  SIMULATION_CANCELLED,
  SIMULATION_REFUSED,
  SIMULATION_TIMEOUT,
  validateConnectorValue,
} from "./simulation-contract";
import {
  readSimulationRuntimeLease,
  type SimulationLease,
  type SimulationRuntimeFacts,
} from "./simulation-authority";
import type { ConnectorSchemaV1 } from "./types";

export type ApiOperationSimulationRuntimeResult =
  | Readonly<{
      ok: true;
      plannedNodeCount: number;
      completedNodeCount: number;
      egressCount: 0;
      costUsdc: 0;
    }>
  | Readonly<{ ok: false; code: typeof SIMULATION_CANCELLED | typeof SIMULATION_REFUSED | typeof SIMULATION_TIMEOUT }>;

type RuntimeFacts = SimulationRuntimeFacts;

const UNSAFE_POINTER = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_TYPES = new Set(["api.operation", "transform", "branch", "output"]);

function runtimeFacts(value: unknown): RuntimeFacts | null {
  if (value === null || typeof value !== "object") return null;
  const facts = value as Partial<RuntimeFacts>;
  return facts.graph?.schemaVersion === 2 && facts.plan?.status === "planned" &&
    facts.pinnedInputs !== null && typeof facts.pinnedInputs === "object" &&
    facts.requestSchema !== undefined && facts.resultSchema !== undefined &&
    typeof facts.nodeId === "string" && facts.signal instanceof AbortSignal
    && Number.isFinite(facts.deadlineAtMs)
    ? facts as RuntimeFacts
    : null;
}

function clone(value: unknown): unknown {
  try { return structuredClone(value); } catch { throw new TypeError(SIMULATION_REFUSED); }
}

function pointer(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === "") return value;
  if (!path.startsWith("/")) throw new TypeError(SIMULATION_REFUSED);
  let current = value;
  for (const raw of path.slice(1).split("/")) {
    if (/~(?![01])/u.test(raw)) throw new TypeError(SIMULATION_REFUSED);
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (UNSAFE_POINTER.has(key)) throw new TypeError(SIMULATION_REFUSED);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length) throw new TypeError(SIMULATION_REFUSED);
      current = current[Number(key)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      throw new TypeError(SIMULATION_REFUSED);
    }
  }
  return current;
}

function resolveBinding(
  binding: ValueBinding,
  graph: FlowGraphV2,
  outputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): unknown {
  if (binding.kind === "secret") throw new TypeError(SIMULATION_REFUSED);
  if (binding.kind === "literal") return clone(binding.value);
  if (binding.kind === "variable") {
    const variable = graph.variables.find(({ id }) => id === binding.variableId);
    if (!variable || variable.sensitive === true || !Object.hasOwn(variable, "default")) throw new TypeError(SIMULATION_REFUSED);
    return clone(pointer(variable.default, binding.path));
  }
  const source = outputs.get(binding.nodeId);
  if (!source || !Object.hasOwn(source, binding.portId)) throw new TypeError(SIMULATION_REFUSED);
  return clone(pointer(source[binding.portId], binding.path));
}

function boundaryValue(
  plan: PlannedFlowTestScope,
  pins: Readonly<Record<string, JsonValue>>,
  predicate: (pin: PlannedFlowTestScope["boundaryPins"][number]) => boolean,
): unknown {
  const matches = plan.boundaryPins.filter(predicate);
  if (matches.length !== 1 || !Object.hasOwn(pins, matches[0]!.key)) throw new TypeError(SIMULATION_REFUSED);
  return clone(pins[matches[0]!.key]);
}

function inputsFor(
  node: FlowNodeV2,
  facts: RuntimeFacts,
  outputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  completed: ReadonlySet<string>,
): Record<string, unknown> | null {
  const values: Record<string, unknown> = Object.create(null);
  for (const [key, binding] of Object.entries(node.bindings)) {
    if (binding.kind === "port" && !facts.plan.nodeIds.includes(binding.nodeId)) {
      values[key] = boundaryValue(facts.plan, facts.pinnedInputs, (pin) =>
        pin.kind === "node-binding" && pin.targetNodeId === node.id && pin.bindingKey === key);
    } else {
      values[key] = resolveBinding(binding, facts.graph, outputs);
    }
  }
  const incoming = facts.graph.edges.filter(({ target }) => target === node.id);
  let activeEdges = 0;
  for (const edge of incoming) {
    let sourceValue: unknown;
    if (facts.plan.nodeIds.includes(edge.source)) {
      if (!completed.has(edge.source)) continue;
      const source = outputs.get(edge.source);
      if (!source || !Object.hasOwn(source, edge.sourceHandle)) continue;
      sourceValue = source[edge.sourceHandle];
    } else {
      sourceValue = boundaryValue(facts.plan, facts.pinnedInputs, (pin) =>
        pin.kind === "edge-input" && pin.edgeId === edge.id && pin.targetNodeId === node.id);
    }
    if (edge.condition) {
      let condition: unknown;
      if (edge.condition.kind === "port" && !facts.plan.nodeIds.includes(edge.condition.nodeId)) {
        condition = boundaryValue(facts.plan, facts.pinnedInputs, (pin) =>
          pin.kind === "edge-condition" && pin.edgeId === edge.id && pin.targetNodeId === node.id);
      } else {
        condition = resolveBinding(edge.condition, facts.graph, outputs);
      }
      if (typeof condition !== "boolean") throw new TypeError(SIMULATION_REFUSED);
      if (!condition) continue;
    }
    activeEdges += 1;
    if (Object.hasOwn(values, edge.targetHandle)) throw new TypeError(SIMULATION_REFUSED);
    values[edge.targetHandle] = clone(sourceValue);
  }
  return incoming.length > 0 && activeEdges === 0 ? null : values;
}

/** Resolve only the selected operation's closed request input during server preflight. */
export function resolveApiOperationSimulationRequestValue(input: {
  readonly graph: FlowGraphV2;
  readonly plan: PlannedFlowTestScope;
  readonly pinnedInputs: Readonly<Record<string, JsonValue>>;
  readonly nodeId: string;
}): unknown {
  const node = input.graph.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node || node.type !== "api.operation") throw new TypeError(SIMULATION_REFUSED);
  const facts = {
    graph: input.graph,
    plan: input.plan,
    pinnedInputs: input.pinnedInputs,
    requestSchema: { type: "null" } as ConnectorSchemaV1,
    resultSchema: { type: "null" } as ConnectorSchemaV1,
    nodeId: input.nodeId,
    signal: new AbortController().signal,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  };
  const values = inputsFor(node, facts, new Map(), new Set());
  if (!values || !Object.hasOwn(values, "request")) throw new TypeError(SIMULATION_REFUSED);
  return values.request;
}

function executeLocal(
  node: FlowNodeV2,
  inputs: Record<string, unknown>,
  facts: RuntimeFacts,
): Readonly<Record<string, unknown>> {
  if (node.type === "api.operation") {
    if (node.id !== facts.nodeId || !Object.hasOwn(inputs, "request") ||
        !validateConnectorValue(facts.requestSchema, inputs.request)) throw new TypeError(SIMULATION_REFUSED);
    return Object.freeze({ result: generateSchemaSentinel(facts.resultSchema) });
  }
  if (node.type === "transform") {
    const expression = node.params.expression;
    if (typeof expression !== "string") throw new TypeError(SIMULATION_REFUSED);
    const result = evaluateExpression(expression, inputs);
    if (!result.ok) throw new TypeError(SIMULATION_REFUSED);
    return Object.freeze({ result: clone(result.value) });
  }
  if (node.type === "branch") {
    const value = Object.hasOwn(inputs, "in") ? inputs.in : inputs[Object.keys(inputs)[0] ?? ""];
    const field = typeof node.params.field === "string" ? node.params.field : "value";
    const fieldValue = value !== null && typeof value === "object" && Object.hasOwn(value, field)
      ? (value as Record<string, unknown>)[field]
      : value;
    const pass = Object.hasOwn(node.params, "equals")
      ? fieldValue === node.params.equals
      : Boolean(fieldValue) === (typeof node.params.truthy === "boolean" ? node.params.truthy : true);
    return Object.freeze(pass ? { true: clone(value) } : { false: clone(value) });
  }
  if (node.type === "output") return Object.freeze({ result: clone(inputs) });
  throw new TypeError(SIMULATION_REFUSED);
}

export async function runLocalApiOperationSimulation(lease: SimulationLease): Promise<ApiOperationSimulationRuntimeResult> {
  let facts: RuntimeFacts | null;
  try { facts = runtimeFacts(readSimulationRuntimeLease(lease)); } catch { return Object.freeze({ ok: false, code: SIMULATION_REFUSED }); }
  if (!facts) return Object.freeze({ ok: false, code: SIMULATION_REFUSED });
  if (facts.signal.aborted) return Object.freeze({ ok: false, code: SIMULATION_CANCELLED });
  if (performance.now() >= facts.deadlineAtMs) return Object.freeze({ ok: false, code: SIMULATION_TIMEOUT });
  const included = facts.plan.nodeIds;
  const apiNodes = facts.graph.nodes.filter((node) => included.includes(node.id) && node.type === "api.operation");
  if (apiNodes.length !== 1 || apiNodes[0]!.id !== facts.nodeId ||
      included.some((id) => !ALLOWED_TYPES.has(facts.graph.nodes.find((node) => node.id === id)?.type ?? ""))) {
    return Object.freeze({ ok: false, code: SIMULATION_REFUSED });
  }
  const expectedPins = facts.plan.boundaryPins.map(({ key }) => key).sort();
  const actualPins = Object.keys(facts.pinnedInputs).sort();
  if (expectedPins.length !== actualPins.length || expectedPins.some((key, index) => key !== actualPins[index])) {
    return Object.freeze({ ok: false, code: SIMULATION_REFUSED });
  }
  const outputs = new Map<string, Readonly<Record<string, unknown>>>();
  const completed = new Set<string>();
  try {
    for (const id of facts.plan.executionOrder) {
      if (facts.signal.aborted) return Object.freeze({ ok: false, code: SIMULATION_CANCELLED });
      if (performance.now() >= facts.deadlineAtMs) return Object.freeze({ ok: false, code: SIMULATION_TIMEOUT });
      const node = facts.graph.nodes.find((candidate) => candidate.id === id);
      if (!node) throw new TypeError(SIMULATION_REFUSED);
      const inputs = inputsFor(node, facts, outputs, completed);
      if (!inputs) continue;
      outputs.set(id, executeLocal(node, inputs, facts));
      completed.add(id);
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      if (facts.signal.aborted) return Object.freeze({ ok: false, code: SIMULATION_CANCELLED });
      if (performance.now() >= facts.deadlineAtMs) return Object.freeze({ ok: false, code: SIMULATION_TIMEOUT });
    }
  } catch {
    return Object.freeze({ ok: false, code: facts.signal.aborted ? SIMULATION_CANCELLED : SIMULATION_REFUSED });
  }
  return Object.freeze({
    ok: true,
    plannedNodeCount: included.length,
    completedNodeCount: completed.size,
    egressCount: 0,
    costUsdc: 0,
  });
}
