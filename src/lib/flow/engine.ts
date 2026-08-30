/** Topological flow execution engine. */
import type { FlowEdge, FlowEdgeV2, FlowGraphV2, JsonValue, RunEvent, SupportedFlowGraph, ValueBinding } from "./types";
import type { NodeContext, NodeDef, NodeRegistry, NodeResult } from "./executor";
import { validateAndCompileTestRunRequest, type CompiledTestRunRequest } from "./test-run-contract";
import {
  createValidatedNodeRuntimeDefinitionResolver,
  createNodeExecutionProvenance,
  executeSelectedNode,
  isCostBearingNode,
  selectNodeDispatch,
  type ValidatedNodeRuntimeDefinitionResolver,
} from "./executor";
import { isFlowGraphV2 } from "./graph-schema";
import { nodeAllowsSecretBinding } from "./node-definitions";
import { planFlowTestScope, type PlannedFlowTestScope } from "./test-scope";
import { cloneRuntimeValue, resolveNodeBindings, resolveValueBinding, type ValueBindingContext } from "./value-bindings";
import { refuseApiOperationLive } from "../connectors/operation-closure";

/** Finite corruption/backstop guard; row-ID ancestry catches recursion before this. */
export const MAX_SUBFLOW_DEPTH = 16;

/** Fallback per-run cost ceiling when RUN_COST_CEILING_USDC is unset or invalid. */
const DEFAULT_RUN_COST_CEILING_USDC = 5;

/**
 * Absolute per-run cost ceiling, independent of the per-agent daily cap in
 * run-service.ts. The daily cap only ever looks at spend *before* a run
 * starts, so — before this ceiling existed — a single run containing a loop
 * node could spend up to LOOP_ITERATION_CEILING x (subflow cost) in one
 * shot, blowing past the daily cap by an unbounded multiple before the
 * *next* run's check would ever notice. This ceiling is enforced live,
 * inside the run, before every cost-bearing node — see the check in
 * `runFlow` below.
 */
export function runCostCeilingUsdc(): number {
  const raw = process.env.RUN_COST_CEILING_USDC;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_COST_CEILING_USDC;
}

export class FlowCycleError extends Error {
  /** Ids of the nodes involved in the cycle (unordered). */
  readonly cycleNodeIds: string[];

  constructor(cycleNodeIds: string[] = []) {
    const detail = cycleNodeIds.length > 0 ? `: ${cycleNodeIds.join(", ")}` : "";
    super(`Flow contains a cycle and cannot be ordered${detail}`);
    this.name = "FlowCycleError";
    this.cycleNodeIds = cycleNodeIds;
  }
}

export class SubflowDepthError extends Error {
  constructor(depth: number) {
    super(`Subflow nesting depth ${depth} exceeds max ${MAX_SUBFLOW_DEPTH}`);
    this.name = "SubflowDepthError";
  }
}

export class FlowExecutionValidationError extends Error {
  constructor(message: string) {
    super(`Flow v2 execution validation failed: ${message}`);
    this.name = "FlowExecutionValidationError";
  }
}

function classifyExecutionGraph(graph: SupportedFlowGraph): FlowGraphV2 | null {
  const schemaVersion = Reflect.get(graph, "schemaVersion");
  if (schemaVersion === 2) {
    if (!isFlowGraphV2(graph)) {
      throw new FlowExecutionValidationError("invalid schemaVersion 2 graph contract");
    }
    return graph;
  }
  if (typeof schemaVersion === "number") {
    throw new FlowExecutionValidationError(`unsupported schemaVersion ${schemaVersion}`);
  }
  if (schemaVersion !== undefined) {
    throw new FlowExecutionValidationError("invalid graph schemaVersion");
  }
  return null;
}

function validateBindingReference(
  binding: ValueBinding,
  graph: FlowGraphV2,
  nodeById: ReadonlyMap<string, FlowGraphV2["nodes"][number]>,
  runtimeByNodeId: ReadonlyMap<string, NodeDef>,
  location: string,
): void {
  if (binding.kind === "port") {
    const sourceNode = nodeById.get(binding.nodeId);
    const sourceDef = runtimeByNodeId.get(binding.nodeId);
    if (!sourceNode || !sourceDef) {
      throw new FlowExecutionValidationError(
        `${location} references missing port source node "${binding.nodeId}"`,
      );
    }
    if (!sourceDef.outputs.includes(binding.portId)) {
      throw new FlowExecutionValidationError(
        `${location} references undeclared port "${binding.nodeId}.${binding.portId}"`,
      );
    }
  }
  if (
    binding.kind === "variable" &&
    !graph.variables.some((variable) => variable.id === binding.variableId)
  ) {
    throw new FlowExecutionValidationError(
      `${location} references missing variable "${binding.variableId}"`,
    );
  }
}

function preflightV2ExecutionWithResolver(
  graph: FlowGraphV2,
  resolveRuntime: ValidatedNodeRuntimeDefinitionResolver,
): void {
  const nodeById = new Map<string, FlowGraphV2["nodes"][number]>();
  const runtimeByNodeId = new Map<string, NodeDef>();
  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      throw new FlowExecutionValidationError(`duplicate node id "${node.id}"`);
    }
    const runtime = resolveRuntime(node);
    if (!runtime) {
      throw new FlowExecutionValidationError(
        `node "${node.id}" has no runtime definition for type "${node.type}"`,
      );
    }
    nodeById.set(node.id, node);
    runtimeByNodeId.set(node.id, runtime);
  }

  const incomingCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) {
      throw new FlowExecutionValidationError(
        `edge "${edge.id}" references a missing ${!sourceNode ? "source" : "target"} node`,
      );
    }
    const sourceDef = runtimeByNodeId.get(sourceNode.id);
    const targetDef = runtimeByNodeId.get(targetNode.id);
    if (!sourceDef || !targetDef) {
      throw new FlowExecutionValidationError(`edge "${edge.id}" has no runtime definition`);
    }
    if (!sourceDef.outputs.includes(edge.sourceHandle)) {
      throw new FlowExecutionValidationError(
        `edge "${edge.id}" names undeclared source port "${edge.source}.${edge.sourceHandle}"`,
      );
    }
    if (!targetDef.inputs.includes(edge.targetHandle)) {
      throw new FlowExecutionValidationError(
        `edge "${edge.id}" names undeclared target port "${edge.target}.${edge.targetHandle}"`,
      );
    }
    const cardinalityKey = `${edge.target}\u0000${edge.targetHandle}`;
    const count = (incomingCounts.get(cardinalityKey) ?? 0) + 1;
    incomingCounts.set(cardinalityKey, count);
    if ((targetDef.inputCardinality?.[edge.targetHandle] ?? "one") === "one" && count > 1) {
      throw new FlowExecutionValidationError(
        `input "${edge.target}.${edge.targetHandle}" accepts only one edge`,
      );
    }
    if (edge.condition) {
      if (edge.condition.kind === "secret") {
        throw new FlowExecutionValidationError(
          `edge "${edge.id}" condition cannot use a secret binding`,
        );
      }
      validateBindingReference(edge.condition, graph, nodeById, runtimeByNodeId, `edge "${edge.id}" condition`);
    }
  }

  for (const node of graph.nodes) {
    for (const [key, binding] of Object.entries(node.bindings)) {
      if (binding.kind === "secret" && !nodeAllowsSecretBinding(node.type, key, binding.field)) {
        throw new FlowExecutionValidationError(
          `node "${node.id}" has an unsupported secret binding`,
        );
      }
      validateBindingReference(binding, graph, nodeById, runtimeByNodeId, `node "${node.id}" binding "${key}"`);
    }
  }
}

/** Validate every structural v2 execution reference before run:start or dispatch. */
export function preflightV2Execution(graph: FlowGraphV2, registry: NodeRegistry): void {
  preflightV2ExecutionWithResolver(
    graph,
    createValidatedNodeRuntimeDefinitionResolver(graph, registry),
  );
}

/** Kahn's algorithm. Throws FlowCycleError if the graph is not a DAG. */
export function topoSort(graph: SupportedFlowGraph): string[] {
  const indegree = new Map<string, number>();
  for (const n of graph.nodes) indegree.set(n.id, 0);
  for (const e of graph.edges) {
    if (indegree.has(e.target)) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const e of graph.edges) {
      if (e.source !== id) continue;
      const next = (indegree.get(e.target) ?? 0) - 1;
      indegree.set(e.target, next);
      if (next === 0) queue.push(e.target);
    }
  }
  if (order.length !== graph.nodes.length) {
    const orderedIds = new Set(order);
    const cycleNodeIds = graph.nodes.filter((n) => !orderedIds.has(n.id)).map((n) => n.id);
    throw new FlowCycleError(cycleNodeIds);
  }
  return order;
}

/**
 * Compatibility entry point for direct callers. Dispatch policy remains in
 * executor.ts: this delegates to selectNodeDispatch/executeSelectedNode.
 * runFlow selects even earlier so guarded dry runs can avoid resolving real
 * parameters and secret bindings altogether.
 *
 * Deny-by-default: a node that `requiresDryRunStub` (cost-bearing and/or
 * `sideEffecting`, see executor.ts) but declares no `dryRunStub` is refused
 * outright rather than allowed to run for real — this should never happen
 * for anything in NODE_DEFS (the enumeration test in
 * tests/flow/dryrun-enumeration.test.ts fails first, at test time), but a
 * dynamically-constructed NodeDef that skips that test still fails safe
 * here instead of risking a real charge or a real external call.
 */
export async function executeNode(
  def: NodeDef,
  ctx: NodeContext,
  params: unknown,
  inputs: Record<string, unknown>,
): Promise<NodeResult> {
  return executeSelectedNode(
    selectNodeDispatch(def, ctx),
    ctx,
    { params, provenance: createNodeExecutionProvenance({}) },
    inputs,
  );
}

function isEdgeActive(
  edge: FlowEdge,
  status: Map<string, string>,
  outputs: Map<string, Record<string, unknown>>,
): boolean {
  if (status.get(edge.source) !== "done") return false;
  if (!edge.sourceHandle) return true;
  const srcOut = outputs.get(edge.source) ?? {};
  return edge.sourceHandle in srcOut;
}

interface ScopedIncomingV2 {
  readonly edge: FlowEdgeV2;
  readonly boundary: boolean;
  readonly boundaryValue?: JsonValue;
}

type MutableFlowEdgeV2 = { -readonly [Key in keyof FlowEdgeV2]: FlowEdgeV2[Key] };

interface ScopedExecution {
  readonly executionOrder: readonly string[];
  readonly incomingByTarget: ReadonlyMap<string, readonly ScopedIncomingV2[]>;
}

const SCOPED_EXECUTIONS = new WeakMap<FlowGraphV2, ScopedExecution>();
const INVALID_SCOPED_RESULT = "Scoped test node returned an invalid result.";

function invalidScopedExecution(): never {
  throw new FlowExecutionValidationError("scoped test execution is invalid");
}

function sameOptionalPath(
  binding: Extract<ValueBinding, { readonly kind: "port" }>,
  pin: { readonly path?: string },
): boolean {
  return Object.hasOwn(binding, "path") === Object.hasOwn(pin, "path") && binding.path === pin.path;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBoundaryPin(
  left: PlannedFlowTestScope["boundaryPins"][number],
  right: PlannedFlowTestScope["boundaryPins"][number],
): boolean {
  if (left.kind !== right.kind || left.key !== right.key || left.sourceNodeId !== right.sourceNodeId ||
      left.sourcePortId !== right.sourcePortId || left.targetNodeId !== right.targetNodeId) return false;
  if (left.kind === "edge-input" && right.kind === "edge-input") {
    return left.edgeId === right.edgeId && left.targetPortId === right.targetPortId;
  }
  if (left.kind === "node-binding" && right.kind === "node-binding") {
    return left.bindingKey === right.bindingKey && left.path === right.path &&
      Object.hasOwn(left, "path") === Object.hasOwn(right, "path");
  }
  return left.kind === "edge-condition" && right.kind === "edge-condition" &&
    left.edgeId === right.edgeId && left.expected === right.expected && left.path === right.path &&
    Object.hasOwn(left, "path") === Object.hasOwn(right, "path");
}

function samePlannedScope(left: PlannedFlowTestScope, right: PlannedFlowTestScope): boolean {
  return left.scope.kind === right.scope.kind && left.scope.nodeId === right.scope.nodeId &&
    sameStrings(left.executionOrder, right.executionOrder) && sameStrings(left.nodeIds, right.nodeIds) &&
    sameStrings(left.edgeIds, right.edgeIds) && left.boundaryPins.length === right.boundaryPins.length &&
    left.boundaryPins.every((pin, index) => sameBoundaryPin(pin, right.boundaryPins[index]!)) &&
    sameStrings(left.boundaryNodeIds, right.boundaryNodeIds) &&
    sameStrings(left.unreachableNodeIds, right.unreachableNodeIds) &&
    sameStrings(left.disabledNodeIds, right.disabledNodeIds);
}

function prepareCompiledTestExecution(compiled: CompiledTestRunRequest): {
  readonly graph: FlowGraphV2;
  readonly execution: ScopedExecution;
} {
  let detached: CompiledTestRunRequest;
  try { detached = structuredClone(compiled); } catch { return invalidScopedExecution(); }
  if (detached.mode !== "test" || detached.dryRun !== true || detached.plan.status !== "planned") {
    return invalidScopedExecution();
  }
  const recompiled = validateAndCompileTestRunRequest({
    graph: detached.graph,
    scope: detached.scope,
    pinnedInputs: detached.pinnedInputs,
    mode: detached.mode,
    environmentId: detached.environmentId,
  });
  if (!recompiled.ok || !samePlannedScope(recompiled.value.plan, detached.plan)) {
    return invalidScopedExecution();
  }
  detached = recompiled.value;
  const { graph, plan } = detached;
  const replanned = planFlowTestScope(graph, plan.scope);
  if (replanned.status !== "planned" || !samePlannedScope(replanned, plan)) return invalidScopedExecution();
  const order = [...plan.executionOrder];
  if (order.length !== plan.nodeIds.length || new Set(order).size !== order.length ||
      order.some((id, index) => id !== plan.nodeIds[index])) return invalidScopedExecution();

  const originalNodes = new Map<string, FlowGraphV2["nodes"][number]>();
  for (const candidate of graph.nodes) {
    if (originalNodes.has(candidate.id)) return invalidScopedExecution();
    originalNodes.set(candidate.id, candidate);
  }
  const selected = new Set(order);
  const projectedNodes = order.map((id) => {
    const candidate = originalNodes.get(id);
    if (!candidate) return invalidScopedExecution();
    return { ...candidate, params: { ...candidate.params }, bindings: { ...candidate.bindings } };
  });
  const projectedNodeById = new Map(projectedNodes.map((candidate) => [candidate.id, candidate]));

  const originalEdges = new Map<string, FlowEdgeV2>();
  for (const candidate of graph.edges) {
    if (originalEdges.has(candidate.id)) return invalidScopedExecution();
    originalEdges.set(candidate.id, candidate);
  }
  const plannedEdgeIds = new Set(plan.edgeIds);
  if (plannedEdgeIds.size !== plan.edgeIds.length) return invalidScopedExecution();
  const actualInternal = graph.edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target));
  if (actualInternal.length !== plannedEdgeIds.size ||
      actualInternal.some((edge) => !plannedEdgeIds.has(edge.id))) return invalidScopedExecution();

  const incomingEntries: Array<{ edge: MutableFlowEdgeV2; boundary: boolean; boundaryValue?: JsonValue }> = [];
  const entryByEdgeId = new Map<string, (typeof incomingEntries)[number]>();
  for (const edge of graph.edges) {
    if (!selected.has(edge.target)) continue;
    const entry = { edge: { ...edge }, boundary: !selected.has(edge.source) };
    incomingEntries.push(entry);
    entryByEdgeId.set(edge.id, entry);
  }
  const projectedEdges = incomingEntries
    .filter(({ boundary }) => !boundary)
    .map(({ edge }) => edge);

  const pinKeys = Object.keys(detached.pinnedInputs);
  if (pinKeys.length !== plan.boundaryPins.length ||
      pinKeys.some((key) => !plan.boundaryPins.some((pin) => pin.key === key))) return invalidScopedExecution();
  const consumed = new Set<string>();
  for (const pin of plan.boundaryPins) {
    if (consumed.has(pin.key) || !Object.hasOwn(detached.pinnedInputs, pin.key)) return invalidScopedExecution();
    const pinnedValue = detached.pinnedInputs[pin.key]!;
    if (pin.kind === "edge-input") {
      const entry = entryByEdgeId.get(pin.edgeId);
      if (!entry || !entry.boundary || entry.edge.source !== pin.sourceNodeId ||
          entry.edge.sourceHandle !== pin.sourcePortId || entry.edge.target !== pin.targetNodeId ||
          entry.edge.targetHandle !== pin.targetPortId) return invalidScopedExecution();
      entry.boundaryValue = pinnedValue;
    } else if (pin.kind === "node-binding") {
      const target = projectedNodeById.get(pin.targetNodeId);
      const binding = target?.bindings[pin.bindingKey];
      if (!target || !binding || binding.kind !== "port" || selected.has(binding.nodeId) ||
          binding.nodeId !== pin.sourceNodeId || binding.portId !== pin.sourcePortId ||
          !sameOptionalPath(binding, pin)) return invalidScopedExecution();
      target.bindings = { ...target.bindings, [pin.bindingKey]: { kind: "literal", value: pinnedValue } };
    } else {
      const entry = entryByEdgeId.get(pin.edgeId);
      const condition = entry?.edge.condition;
      if (!entry || entry.edge.target !== pin.targetNodeId || !condition || condition.kind !== "port" ||
          selected.has(condition.nodeId) || condition.nodeId !== pin.sourceNodeId ||
          condition.portId !== pin.sourcePortId || !sameOptionalPath(condition, pin) ||
          pin.expected !== "boolean" || typeof pinnedValue !== "boolean") return invalidScopedExecution();
      entry.edge.condition = { kind: "literal", value: pinnedValue };
    }
    consumed.add(pin.key);
  }
  if (consumed.size !== plan.boundaryPins.length) return invalidScopedExecution();

  for (const candidate of projectedNodes) {
    for (const binding of Object.values(candidate.bindings)) {
      if (binding.kind === "secret" || (binding.kind === "port" && !selected.has(binding.nodeId))) {
        return invalidScopedExecution();
      }
    }
  }
  for (const entry of incomingEntries) {
    if (entry.boundary && !Object.hasOwn(entry, "boundaryValue")) return invalidScopedExecution();
    const condition = entry.edge.condition;
    if (condition?.kind === "secret" ||
        (condition?.kind === "port" && !selected.has(condition.nodeId))) return invalidScopedExecution();
  }

  const incomingByTarget = new Map<string, ScopedIncomingV2[]>();
  for (const entry of incomingEntries) {
    const list = incomingByTarget.get(entry.edge.target) ?? [];
    list.push(entry);
    incomingByTarget.set(entry.edge.target, list);
  }
  const projection: FlowGraphV2 = {
    schemaVersion: 2,
    id: graph.id,
    name: graph.name,
    nodes: projectedNodes,
    edges: projectedEdges,
    variables: graph.variables,
    groups: [],
    annotations: [],
    ...(graph.meta ? { meta: graph.meta } : {}),
  };
  return {
    graph: projection,
    execution: {
      executionOrder: Object.freeze(order),
      incomingByTarget,
    },
  };
}

function enforceScopedResult(result: NodeResult): NodeResult {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(result);
    const cost = descriptors.costUsdc;
    const ok = descriptors.ok;
    if (!cost || !("value" in cost) || cost.value !== 0 || !ok || !("value" in ok)) {
      return { ok: false, error: INVALID_SCOPED_RESULT, costUsdc: 0 };
    }
    if (ok.value === true) {
      const outputs = descriptors.outputs;
      if (!outputs || !("value" in outputs) || outputs.value === null || typeof outputs.value !== "object") {
        return { ok: false, error: INVALID_SCOPED_RESULT, costUsdc: 0 };
      }
      return { ok: true, outputs: outputs.value, costUsdc: 0 };
    }
    const error = descriptors.error;
    if (ok.value !== false || !error || !("value" in error) || typeof error.value !== "string") {
      return { ok: false, error: INVALID_SCOPED_RESULT, costUsdc: 0 };
    }
    return { ok: false, error: error.value, costUsdc: 0 };
  } catch {
    return { ok: false, error: INVALID_SCOPED_RESULT, costUsdc: 0 };
  }
}

/**
 * Run a flow, yielding RunEvents in order and recording the cost ledger on
 * ctx.logger. Errors halt the failed node's downstream branch; independent
 * branches still complete — EXCEPT a run-cost-ceiling abort (see below),
 * which stops the whole run immediately, independent branches included.
 */
export async function* runFlow(
  graph: SupportedFlowGraph,
  ctx: NodeContext,
  registry: NodeRegistry,
  triggerInput: Record<string, unknown> = {},
): AsyncGenerator<RunEvent> {
  ctx.signal?.throwIfAborted();
  if (ctx.depth > MAX_SUBFLOW_DEPTH) throw new SubflowDepthError(ctx.depth);
  if (!ctx.dryRun) refuseApiOperationLive(graph);

  const v2Graph = classifyExecutionGraph(graph);
  const scopedExecution = v2Graph ? SCOPED_EXECUTIONS.get(v2Graph) : undefined;
  let resolveV2Runtime: ValidatedNodeRuntimeDefinitionResolver | null = null;
  let v2TriggerTemplate: unknown = null;
  if (v2Graph) {
    resolveV2Runtime = createValidatedNodeRuntimeDefinitionResolver(v2Graph, registry);
    preflightV2ExecutionWithResolver(v2Graph, resolveV2Runtime);
    const clonedTrigger = cloneRuntimeValue(triggerInput, "V2 trigger input");
    if (!clonedTrigger.ok) throw new FlowExecutionValidationError(clonedTrigger.error);
    v2TriggerTemplate = clonedTrigger.value;
  }
  const order = scopedExecution ? [...scopedExecution.executionOrder] : topoSort(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const status = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const runVariables = ctx.runVariables ?? {};
  const resolveSecretReference = ctx.resolveSecretReference ?? (async () => {
    throw new Error("Secret reference resolution is unavailable in this run");
  });
  let totalCost = 0;
  let runStatus: "done" | "error" = "done";
  let ceilingAborted = false;

  ctx.signal?.throwIfAborted();
  yield { kind: "run:start", runId: ctx.runId, at: Date.now() };

  for (const id of order) {
    const node = nodeById.get(id);
    if (!node) continue;
    const resolvedDef = resolveV2Runtime
      ? resolveV2Runtime(node)
      : registry[node.type];

    let inputs: Record<string, unknown> = v2Graph ? Object.create(null) : {};
    let inputError: string | null = null;
    const incomingV2: readonly ScopedIncomingV2[] = v2Graph
      ? scopedExecution?.incomingByTarget.get(id) ??
        v2Graph.edges.filter((edge) => edge.target === id).map((edge) => ({ edge, boundary: false }))
      : [];
    if (v2Graph && incomingV2.length > 0) {
      const bindingContext: ValueBindingContext = {
        graph: v2Graph,
        outputs,
        runVariables,
        resolveSecretReference,
      };
      for (const incoming of incomingV2) {
        const edge = incoming.edge;
        if (!resolvedDef?.inputs.includes(edge.targetHandle)) {
          inputError = `Edge "${edge.id}" references undeclared input port "${edge.target}.${edge.targetHandle}".`;
          break;
        }
        let sourceValue: unknown;
        if (incoming.boundary) {
          sourceValue = incoming.boundaryValue;
        } else {
          if (status.get(edge.source) !== "done") continue;
          const sourceOutputs = outputs.get(edge.source);
          if (!sourceOutputs || !Object.hasOwn(sourceOutputs, edge.sourceHandle)) continue;
          sourceValue = sourceOutputs[edge.sourceHandle];
        }
        if (edge.condition) {
          const condition = await resolveValueBinding(edge.condition, bindingContext);
          if (!condition.ok) {
            inputError = `Edge "${edge.id}" condition failed: ${condition.error}`;
            break;
          }
          if (typeof condition.value !== "boolean") {
            inputError = `Edge "${edge.id}" condition must resolve to a boolean`;
            break;
          }
          if (!condition.value) continue;
        }
        const clonedValue = cloneRuntimeValue(
          sourceValue,
          `Edge "${edge.id}" value`,
        );
        if (!clonedValue.ok) {
          inputError = clonedValue.error;
          break;
        }
        const value = clonedValue.value;
        const cardinality = resolvedDef?.inputCardinality?.[edge.targetHandle] ?? "one";
        if (Object.hasOwn(inputs, edge.targetHandle)) {
          if (cardinality === "many") {
            const previous = inputs[edge.targetHandle];
            inputs[edge.targetHandle] = Array.isArray(previous)
              ? [...previous, value]
              : [previous, value];
          } else {
            inputError = `Multiple edges target single-value input "${edge.targetHandle}"`;
            break;
          }
        } else {
          inputs[edge.targetHandle] = cardinality === "many" ? [value] : value;
        }
      }
      if (!inputError && Object.keys(inputs).length === 0) {
        status.set(id, "skipped");
        continue;
      }
    } else if (!v2Graph) {
      const incoming: readonly FlowEdge[] = graph.edges.filter((edge) => edge.target === id);
      if (incoming.length === 0) {
        inputs = { ...triggerInput };
      } else {
        const active = incoming.filter((e) => isEdgeActive(e, status, outputs));
        if (active.length === 0) {
          status.set(id, "skipped");
          continue;
        }
        // Two active edges into the same input key overwrite each other in
        // array order. Old saved graphs can still have this shape (the canvas
        // now blocks creating it), so keep last-write-wins for compatibility
        // but surface it in the run log — a silent clobber here is silent
        // data loss, not a benign fan-in.
        const seenKeys = new Set<string>();
        for (const e of active) {
          const key = e.targetHandle ?? e.source;
          if (seenKeys.has(key)) {
            ctx.signal?.throwIfAborted();
            yield {
              kind: "node:log",
              runId: ctx.runId,
              nodeId: id,
              level: "error",
              msg: `Multiple incoming edges target the same input "${key}". Only the last one is used; the others are dropped.`,
            };
          }
          seenKeys.add(key);
          const srcOut = outputs.get(e.source) ?? {};
          const value = e.sourceHandle ? srcOut[e.sourceHandle] : (srcOut.result ?? srcOut);
          inputs[key] = value;
        }
      }
    } else {
      const clonedTrigger = cloneRuntimeValue(v2TriggerTemplate, "V2 trigger input");
      if (!clonedTrigger.ok) {
        inputError = clonedTrigger.error;
      } else {
        inputs = Object.assign(Object.create(null), clonedTrigger.value);
      }
    }

    if (inputError) {
      status.set(id, "error");
      runStatus = "error";
      ctx.logger.record({ nodeId: id, nodeType: node.type, status: "error", costUsdc: 0, settled: false });
      ctx.signal?.throwIfAborted();
      yield {
        kind: "node:error",
        runId: ctx.runId,
        nodeId: id,
        nodeType: node.type,
        error: inputError,
      };
      continue;
    }

    const def = resolvedDef;
    if (!def) {
      status.set(id, "error");
      runStatus = "error";
      ctx.logger.record({ nodeId: id, nodeType: node.type, status: "error", costUsdc: 0, settled: false });
      ctx.signal?.throwIfAborted();
      yield {
        kind: "node:error",
        runId: ctx.runId,
        nodeId: id,
        nodeType: node.type,
        error: `No executor registered for node type "${node.type}"`,
      };
      continue;
    }
    const selection = selectNodeDispatch(def, ctx);

    // In-run cost ceiling, checked BEFORE the node executes, using its
    // declared list price (priceUsdc) as a projection of what it will cost.
    // This is only ever an estimate: a node's true cost is knowable only
    // after it runs (a metered LLM call, a variable-price API), so this
    // reservations only cover declared projections. Concurrent and nested
    // leaves can all underestimate their actual provider cost, so overshoot
    // can scale with every underestimated leaf already in flight; there is
    // no one-leaf bound. Skipped entirely in dry-run: cost-bearing/side-effecting nodes
    // are stubbed to $0 by the selected central dry-run dispatch below, so a
    // dry run can never actually spend anything
    // and must never be aborted for a ceiling it cannot reach.
    const costBearing = isCostBearingNode(def);
    let projectedReservationUsdc = 0;
    if (costBearing && !ctx.dryRun) {
      const projectedUsdc = def.priceUsdc ?? 0;
      const reservedUsdc = ctx.costCeiling.reservedUsdc ?? 0;
      if (ctx.costCeiling.spentUsdc + reservedUsdc + projectedUsdc > ctx.costCeiling.limitUsdc) {
        const message =
          `Run cost ceiling of $${ctx.costCeiling.limitUsdc.toFixed(2)} reached before node "${id}" ` +
          `(${node.type}) could run: $${ctx.costCeiling.spentUsdc.toFixed(2)} already spent this run, ` +
          `$${reservedUsdc.toFixed(2)} reserved by in-flight nodes, and this node's list price is ` +
          `$${projectedUsdc.toFixed(2)}. The node was not executed and was not charged.`;
        status.set(id, "error");
        runStatus = "error";
        ceilingAborted = true;
        ctx.logger.record({ nodeId: id, nodeType: node.type, status: "error", costUsdc: 0, settled: false });
        ctx.signal?.throwIfAborted();
        yield {
          kind: "node:error",
          runId: ctx.runId,
          nodeId: id,
          nodeType: node.type,
          error: message,
          costCeilingExceeded: true,
        };
        break;
      }
      // JavaScript runs this mutation synchronously before dispatch. Parallel loop
      // workers therefore observe each other's projected holds before any leaf awaits.
      projectedReservationUsdc = projectedUsdc;
      ctx.costCeiling.reservedUsdc = reservedUsdc + projectedUsdc;
    }

    let result: NodeResult;
    try {
      // Keep the reservation inside this finally boundary: a consumer can
      // cancel the async generator while it is paused at node:start.
      ctx.signal?.throwIfAborted();
      yield { kind: "node:start", runId: ctx.runId, nodeId: id, nodeType: node.type };
      ctx.signal?.throwIfAborted();
      try {
        let params: unknown = node.params;
        let provenance = createNodeExecutionProvenance({});
        if (v2Graph) {
          const v2Node = v2Graph.nodes.find((candidate) => candidate.id === id);
          if (!v2Node) throw new Error(`V2 node "${id}" is missing from the graph`);
          const clonedParams = cloneRuntimeValue(v2Node.params, `Node "${id}" params`);
          if (!clonedParams.ok) throw new Error(clonedParams.error);
          params = clonedParams.value;
          if (selection.kind === "real") {
            const resolved = await resolveNodeBindings(v2Node, {
              graph: v2Graph,
              outputs,
              runVariables,
              resolveSecretReference,
            });
            params = Object.assign(Object.create(null), params, resolved.values);
            provenance = createNodeExecutionProvenance(resolved.secretBindingValues);
          }
        }
        result = await executeSelectedNode(selection, ctx, { params, provenance }, inputs);
      } catch (err) {
        result = { ok: false as const, error: err instanceof Error ? err.message : String(err), costUsdc: 0 };
      }
    } finally {
      if (projectedReservationUsdc > 0) {
        ctx.costCeiling.reservedUsdc = Math.max(
          0,
          (ctx.costCeiling.reservedUsdc ?? 0) - projectedReservationUsdc,
        );
      }
    }

    if (scopedExecution) result = enforceScopedResult(result);

    if (result.ok) {
      status.set(id, "done");
      outputs.set(id, result.outputs);
      totalCost += result.costUsdc;
      // Only leaf cost-bearing nodes add to the shared ceiling ledger — a
      // loop/subflow node's bubbled-up costUsdc is a rollup of leaf costs
      // its own nested runFlow calls already added (they share this same
      // ctx.costCeiling object by reference), so adding it again here would
      // double-count real spend against the ceiling.
      if (costBearing) ctx.costCeiling.spentUsdc += result.costUsdc;
      ctx.logger.record({ nodeId: id, nodeType: node.type, status: "done", costUsdc: result.costUsdc, settled: result.costUsdc > 0 });
      ctx.signal?.throwIfAborted();
      yield {
        kind: "node:done",
        runId: ctx.runId,
        nodeId: id,
        nodeType: node.type,
        outputs: result.outputs,
        costUsdc: result.costUsdc,
      };
    } else {
      status.set(id, "error");
      runStatus = "error";
      totalCost += result.costUsdc;
      if (costBearing) ctx.costCeiling.spentUsdc += result.costUsdc;
      ctx.logger.record({ nodeId: id, nodeType: node.type, status: "error", costUsdc: result.costUsdc, settled: false });
      ctx.signal?.throwIfAborted();
      yield {
        kind: "node:error",
        runId: ctx.runId,
        nodeId: id,
        nodeType: node.type,
        error: result.error,
        ...(result.costCeilingExceeded ? { costCeilingExceeded: true as const } : {}),
      };
      // A loop/subflow node reports costCeilingExceeded on its own result
      // when a nested run it kicked off was aborted for the same reason.
      // Propagate the abort up: stop the whole run here too, rather than
      // just halting this node's downstream branch.
      if (result.costCeilingExceeded) {
        ceilingAborted = true;
        break;
      }
    }
  }

  ctx.signal?.throwIfAborted();
  yield {
    kind: "run:done",
    runId: ctx.runId,
    totalCostUsdc: totalCost,
    status: runStatus,
    ...(ceilingAborted ? { abortedReason: "cost-ceiling" as const } : {}),
  };
}

/** Execute one already-compiled scoped test through the normal engine without enabling live capabilities. */
export async function* runCompiledTestFlow(
  compiled: CompiledTestRunRequest,
  options: { readonly runId?: string } = {},
): AsyncGenerator<RunEvent> {
  const prepared = prepareCompiledTestExecution(compiled);
  const { createSafeScopedTestRuntime } = await import("./test-runtime");
  const runtime = createSafeScopedTestRuntime(options.runId);
  if (!runtime) return invalidScopedExecution();
  SCOPED_EXECUTIONS.set(prepared.graph, prepared.execution);
  try {
    yield* runFlow(prepared.graph, runtime.ctx, runtime.registry, {});
  } finally {
    SCOPED_EXECUTIONS.delete(prepared.graph);
  }
  if (runtime.invariantViolated()) return invalidScopedExecution();
}

/** Drain a runFlow generator into a summary (used by tests and machine runs). */
export async function collectRun(gen: AsyncGenerator<RunEvent>): Promise<{
  events: RunEvent[];
  totalCostUsdc: number;
  status: "done" | "error";
  outputs: Record<string, Record<string, unknown>>;
  /** True when this run (or a nested run inside it) was aborted by the in-run cost ceiling. */
  costCeilingExceeded: boolean;
}> {
  const events: RunEvent[] = [];
  const outputs: Record<string, Record<string, unknown>> = {};
  let totalCostUsdc = 0;
  let status: "done" | "error" = "done";
  let costCeilingExceeded = false;
  for await (const e of gen) {
    events.push(e);
    if (e.kind === "node:done") outputs[e.nodeId] = e.outputs;
    if (e.kind === "node:error" && e.costCeilingExceeded) costCeilingExceeded = true;
    if (e.kind === "run:done") {
      totalCostUsdc = e.totalCostUsdc;
      status = e.status;
    }
  }
  return { events, totalCostUsdc, status, outputs, costCeilingExceeded };
}
