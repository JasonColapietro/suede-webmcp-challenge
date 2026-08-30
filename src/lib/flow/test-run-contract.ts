import { z } from "zod";
import { FlowGraphV2Schema, JsonValueSchema } from "./graph-schema";
import {
  planFlowTestScope,
  type FlowTestScope,
  type PlannedFlowTestScope,
} from "./test-scope";
import { inspectTestInput, type TestInputPath } from "./test-input-safety";
import type { FlowGraphV2, JsonValue } from "./types";
import { graphContainsApiOperation } from "./api-operation-contract";

const TEXT_ENCODER = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/u;

export const TEST_RUN_REQUEST_LIMITS = Object.freeze({
  requestBytes: 2 * 1024 * 1024,
  requestDepth: 64,
  requestValues: 100_000,
  graphNodes: 500,
  graphEdges: 2_000,
  graphVariables: 256,
  graphGroups: 256,
  graphAnnotations: 500,
  pinnedInputs: 512,
  pinnedInputBytes: 256 * 1024,
  pinnedValueBytes: 64 * 1024,
  pinnedValueDepth: 16,
  pinnedValueValues: 10_000,
  graphIdentityBytes: 128,
  scopeIdBytes: 128,
  environmentIdBytes: 512,
} as const);

export type TestBoundaryPinTuple =
  | readonly [
      "edge-input",
      edgeId: string,
      sourceNodeId: string,
      sourcePortId: string,
      targetNodeId: string,
      targetPortId: string,
    ]
  | readonly [
      "node-binding",
      targetNodeId: string,
      bindingKey: string,
      sourceNodeId: string,
      sourcePortId: string,
      path: string | null,
    ]
  | readonly [
      "edge-condition",
      edgeId: string,
      targetNodeId: string,
      sourceNodeId: string,
      sourcePortId: string,
      path: string | null,
    ];

export interface TestRunRequest {
  readonly graph: FlowGraphV2;
  readonly scope: FlowTestScope;
  readonly pinnedInputs: Readonly<Record<string, JsonValue>>;
  readonly mode: "test";
  readonly environmentId: string;
}

export interface CompiledTestRunRequest extends TestRunRequest {
  readonly dryRun: true;
  readonly plan: PlannedFlowTestScope;
}

export type TestRunRequestParseResult =
  | { readonly ok: true; readonly request: TestRunRequest }
  | {
      readonly ok: false;
      readonly code: "invalid-request";
      readonly message: "Test run request is invalid.";
    };

export type TestRunRequestCompileResult =
  | { readonly ok: true; readonly value: CompiledTestRunRequest }
  | Exclude<TestRunRequestParseResult, { readonly ok: true }>;

const INVALID_REQUEST = Object.freeze({
  ok: false,
  code: "invalid-request",
  message: "Test run request is invalid.",
} as const);

function bytes(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function boundedIdentity(value: string, maxBytes: number): boolean {
  return value.length > 0 && value.trim() === value && bytes(value) <= maxBytes && !CONTROL.test(value);
}

const ScopeIdSchema = z.string().refine(
  (value) => boundedIdentity(value, TEST_RUN_REQUEST_LIMITS.scopeIdBytes),
);
const EnvironmentIdSchema = z.string().refine(
  (value) => boundedIdentity(value, TEST_RUN_REQUEST_LIMITS.environmentIdBytes),
);

export const TestScopeSchema: z.ZodType<FlowTestScope> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), nodeId: ScopeIdSchema }).strict(),
  z.object({ kind: z.literal("to-node"), nodeId: ScopeIdSchema }).strict(),
  z.object({ kind: z.literal("from-node"), nodeId: ScopeIdSchema }).strict(),
]);

function tupleString(value: unknown): value is string {
  return typeof value === "string" && boundedIdentity(value, TEST_RUN_REQUEST_LIMITS.graphIdentityBytes);
}

function tuplePath(value: unknown): value is string {
  return typeof value === "string" && bytes(value) <= 512 && !CONTROL.test(value);
}

/** Parse only the exact canonical key tuples emitted by planFlowTestScope. */
export function parseTestBoundaryPinKey(key: string): TestBoundaryPinTuple | null {
  if (bytes(key) > 4_096) return null;
  let value: unknown;
  try { value = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 6 || JSON.stringify(value) !== key ||
      Object.keys(value).length !== value.length) return null;
  if (value[0] === "edge-input" && value.slice(1).every(tupleString)) {
    return value as unknown as TestBoundaryPinTuple;
  }
  if (value[0] === "node-binding" && value.slice(1, 5).every(tupleString) &&
      (value[5] === null || tuplePath(value[5]))) {
    return value as unknown as TestBoundaryPinTuple;
  }
  if (value[0] === "edge-condition" && value.slice(1, 5).every(tupleString) &&
      (value[5] === null || tuplePath(value[5]))) {
    return value as unknown as TestBoundaryPinTuple;
  }
  return null;
}

const PinnedInputsSchema = z.record(
  z.string().refine((key) => parseTestBoundaryPinKey(key) !== null),
  JsonValueSchema,
);

const BoundedGraphSchema = FlowGraphV2Schema.superRefine((graph, context) => {
  for (const [key, value, limit] of [
    ["nodes", graph.nodes.length, TEST_RUN_REQUEST_LIMITS.graphNodes],
    ["edges", graph.edges.length, TEST_RUN_REQUEST_LIMITS.graphEdges],
    ["variables", graph.variables.length, TEST_RUN_REQUEST_LIMITS.graphVariables],
    ["groups", graph.groups.length, TEST_RUN_REQUEST_LIMITS.graphGroups],
    ["annotations", graph.annotations.length, TEST_RUN_REQUEST_LIMITS.graphAnnotations],
  ] as const) {
    if (value > limit) {
      context.addIssue({ code: z.ZodIssueCode.too_big, type: "array", maximum: limit, inclusive: true, path: [key], message: "Too many graph entries" });
    }
  }
});

const TestRunRequestSchema = z.object({
  graph: BoundedGraphSchema,
  scope: TestScopeSchema,
  pinnedInputs: PinnedInputsSchema,
  mode: z.literal("test"),
  environmentId: EnvironmentIdSchema,
}).strict();

function graphSecretReferencePath(path: TestInputPath): boolean {
  return (path.length === 5 && path[0] === "graph" && path[1] === "nodes" &&
      typeof path[2] === "number" && path[3] === "bindings" && typeof path[4] === "string") ||
    (path.length === 4 && path[0] === "graph" && path[1] === "edges" &&
      typeof path[2] === "number" && path[3] === "condition");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function callableIdentitiesWithinBounds(value: unknown): boolean {
  if (value === undefined) return true;
  const callable = record(value);
  if (!callable || !Array.isArray(callable.inputs) || !Array.isArray(callable.outputs)) return false;
  for (const portValue of [...callable.inputs, ...callable.outputs]) {
    const port = record(portValue);
    if (!port || typeof port.id !== "string" || !boundedIdentity(port.id, 128)) return false;
    const source = record(port.source);
    if (source && (!boundedIdentity(String(source.nodeId ?? ""), 128) ||
        !boundedIdentity(String(source.portId ?? ""), 128))) return false;
  }
  return true;
}

function bindingIdentitiesWithinBounds(value: unknown): boolean {
  const binding = record(value);
  if (!binding) return false;
  if (binding.kind === "port") {
    return boundedIdentity(String(binding.nodeId ?? ""), 128) &&
      boundedIdentity(String(binding.portId ?? ""), 128);
  }
  if (binding.kind === "variable") {
    return boundedIdentity(String(binding.variableId ?? ""), 128);
  }
  if (binding.kind === "secret") {
    return boundedIdentity(String(binding.connectionId ?? ""), TEST_RUN_REQUEST_LIMITS.graphIdentityBytes) &&
      boundedIdentity(String(binding.field ?? ""), 128);
  }
  return binding.kind === "literal";
}

/** Reject identity normalization and oversized graph references before Zod transforms them. */
function graphIdentitiesWithinBounds(value: unknown): boolean {
  const request = record(value);
  const graph = record(request?.graph);
  if (!graph || typeof graph.id !== "string" ||
      !boundedIdentity(graph.id, TEST_RUN_REQUEST_LIMITS.graphIdentityBytes) ||
      !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      !Array.isArray(graph.variables) || !Array.isArray(graph.groups) ||
      !Array.isArray(graph.annotations) || !callableIdentitiesWithinBounds(graph.callableInterface)) return false;
  for (const nodeValue of graph.nodes) {
    const node = record(nodeValue);
    const bindings = record(node?.bindings);
    if (!node || typeof node.id !== "string" || !boundedIdentity(node.id, 128) || !bindings) return false;
    for (const [key, bindingValue] of Object.entries(bindings)) {
      if (!boundedIdentity(key, 128) || !bindingIdentitiesWithinBounds(bindingValue)) return false;
    }
    const params = record(node.params);
    const reference = record(params?.reference);
    if (typeof params?.flowId === "string" &&
        !boundedIdentity(params.flowId, TEST_RUN_REQUEST_LIMITS.graphIdentityBytes)) return false;
    if (reference && (
      !boundedIdentity(String(reference.flowId ?? ""), TEST_RUN_REQUEST_LIMITS.graphIdentityBytes) ||
      (reference.kind === "pinned" &&
        !boundedIdentity(String(reference.versionId ?? ""), TEST_RUN_REQUEST_LIMITS.graphIdentityBytes)) ||
      !callableIdentitiesWithinBounds(reference.interface)
    )) return false;
  }
  for (const edgeValue of graph.edges) {
    const edge = record(edgeValue);
    if (!edge || ![edge.id, edge.source, edge.sourceHandle, edge.target, edge.targetHandle]
      .every((item) => typeof item === "string" && boundedIdentity(item, 128))) return false;
    if (edge.condition !== undefined && !bindingIdentitiesWithinBounds(edge.condition)) return false;
  }
  for (const variableValue of graph.variables) {
    const variable = record(variableValue);
    if (!variable || typeof variable.id !== "string" || !boundedIdentity(variable.id, 128)) return false;
  }
  for (const groupValue of graph.groups) {
    const group = record(groupValue);
    if (!group || typeof group.id !== "string" || !boundedIdentity(group.id, 128) || !Array.isArray(group.nodeIds) ||
        !group.nodeIds.every((id) => typeof id === "string" && boundedIdentity(id, 128))) return false;
  }
  for (const annotationValue of graph.annotations) {
    const annotation = record(annotationValue);
    if (!annotation || typeof annotation.id !== "string" || !boundedIdentity(annotation.id, 128)) return false;
  }
  return true;
}

function pinnedInputsWithinBudget(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let entries: [string, unknown][];
  try { entries = Object.entries(value); } catch { return false; }
  if (entries.length > TEST_RUN_REQUEST_LIMITS.pinnedInputs) return false;
  const aggregate = inspectTestInput(value, {
    limits: {
      maxBytes: TEST_RUN_REQUEST_LIMITS.pinnedInputBytes,
      maxDepth: TEST_RUN_REQUEST_LIMITS.pinnedValueDepth + 1,
      maxValues: TEST_RUN_REQUEST_LIMITS.pinnedValueValues + 1,
    },
  });
  if (!aggregate.ok) return false;
  return entries.every(([, item]) => inspectTestInput(item, {
    limits: {
      maxBytes: TEST_RUN_REQUEST_LIMITS.pinnedValueBytes,
      maxDepth: TEST_RUN_REQUEST_LIMITS.pinnedValueDepth,
      maxValues: TEST_RUN_REQUEST_LIMITS.pinnedValueValues,
    },
  }).ok);
}

/** Inspect first, then parse. Every refusal is generic and never echoes input. */
export function parseTestRunRequest(value: unknown): TestRunRequestParseResult {
  const inspected = inspectTestInput(value, {
    limits: {
      maxBytes: TEST_RUN_REQUEST_LIMITS.requestBytes,
      maxDepth: TEST_RUN_REQUEST_LIMITS.requestDepth,
      maxValues: TEST_RUN_REQUEST_LIMITS.requestValues,
    },
    allowGraphSecretReferenceAt: graphSecretReferencePath,
  });
  if (!inspected.ok) return INVALID_REQUEST;
  let snapshot: unknown;
  try { snapshot = structuredClone(value); } catch { return INVALID_REQUEST; }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      !graphIdentitiesWithinBounds(snapshot)) return INVALID_REQUEST;
  let rawPins: unknown;
  try { rawPins = Reflect.get(snapshot, "pinnedInputs"); } catch { return INVALID_REQUEST; }
  if (!pinnedInputsWithinBudget(rawPins)) return INVALID_REQUEST;
  const parsed = TestRunRequestSchema.safeParse(snapshot);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : INVALID_REQUEST;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function planRequiresSecretResolution(graph: FlowGraphV2, plan: PlannedFlowTestScope): boolean {
  const included = new Set(plan.nodeIds);
  if (graph.nodes.some((node) => included.has(node.id) &&
      Object.values(node.bindings).some((binding) => binding.kind === "secret"))) return true;
  return graph.edges.some((edge) => included.has(edge.target) && edge.condition?.kind === "secret");
}

function boundaryPinValuesMatchContract(
  plan: PlannedFlowTestScope,
  pinnedInputs: Readonly<Record<string, JsonValue>>,
): boolean {
  return plan.boundaryPins.every((pin) => {
    if (pin.kind === "edge-condition") return typeof pinnedInputs[pin.key] === "boolean";
    return pin.kind === "edge-input" || pin.kind === "node-binding";
  });
}

/** Validate, plan, require exact pins, detach, sort map keys, and hard-code safe execution mode. */
export function validateAndCompileTestRunRequest(value: unknown): TestRunRequestCompileResult {
  const parsed = parseTestRunRequest(value);
  if (!parsed.ok) return parsed;
  if (graphContainsApiOperation(parsed.request.graph)) return INVALID_REQUEST;
  let plan;
  try { plan = planFlowTestScope(parsed.request.graph, parsed.request.scope); } catch { return INVALID_REQUEST; }
  if (plan.status !== "planned") return INVALID_REQUEST;
  if (planRequiresSecretResolution(parsed.request.graph, plan)) return INVALID_REQUEST;
  const required = plan.boundaryPins.map(({ key }) => key).sort();
  const provided = Object.keys(parsed.request.pinnedInputs).sort();
  if (required.length !== provided.length || required.some((key, index) => key !== provided[index])) {
    return INVALID_REQUEST;
  }
  if (!boundaryPinValuesMatchContract(plan, parsed.request.pinnedInputs)) return INVALID_REQUEST;
  const pinnedInputs = Object.fromEntries(
    provided.map((key) => [key, parsed.request.pinnedInputs[key]]),
  ) as Record<string, JsonValue>;
  const detached = structuredClone({
    graph: parsed.request.graph,
    scope: parsed.request.scope,
    pinnedInputs,
    mode: "test" as const,
    environmentId: parsed.request.environmentId,
    dryRun: true as const,
    plan,
  });
  return { ok: true, value: deepFreeze(detached) };
}
