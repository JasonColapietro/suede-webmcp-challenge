import { parseGraphCommand } from "./graph-command-schema";
import { applyGraphCommand } from "./graph-command-reducer";
import { ValueBindingSchema, isFlowGraphV2 } from "./graph-schema";
import type { GraphCommand, GraphSelection, Point } from "./graph-command-types";
import { NODE_TYPE_SET } from "./node-definitions";
import type {
  FlowEdge,
  FlowEdgeV2,
  FlowNode,
  FlowNodeV2,
  NodeType,
  SupportedFlowGraph,
  ValueBinding,
} from "./types";

const FRAGMENT_KIND = "suede.graph-fragment";
const MAX_TEXT_BYTES = 1_048_576;
const MAX_DEPTH = 50;
const MAX_NODES = 500;
const MAX_EDGES = 2_000;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DROP = Symbol("drop-sensitive-fragment-value");

export interface GraphFragmentV1 {
  readonly kind: typeof FRAGMENT_KIND;
  readonly version: 1;
  readonly redactionCount: number;
  readonly nodes: readonly (FlowNode | FlowNodeV2)[];
  readonly edges: readonly (FlowEdge | FlowEdgeV2)[];
}

export class GraphFragmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphFragmentError";
  }
}

export class GraphFragmentDisabledError extends GraphFragmentError {
  readonly code = "NO_NODES_SELECTED";
  readonly reason = "Select at least one node to copy.";

  constructor() {
    super("Select at least one node to copy.");
    this.name = "GraphFragmentDisabledError";
  }
}

interface SanitizeState {
  redactions: number;
  readonly seen: Set<object>;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(object: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor?.enumerable && "value" in descriptor ? descriptor : undefined;
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "authorization" ||
    normalized.endsWith("authorization") ||
    normalized.includes("cookie") ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized.includes("apikey") ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized.includes("privatekey") ||
    normalized.includes("servicerole") ||
    normalized.includes("signingkey");
}

function isCredentialString(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]+-----/i.test(value) ||
    /\bbearer\s+[^\s]+/i.test(value) ||
    /(?:service.?role|signing.?(?:secret|key))\s*[:=]\s*[^\s]{4,}/i.test(value);
}

function isSecretReference(value: unknown): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== 3 || !keys.every((key) => ["kind", "connectionId", "field"].includes(key))) return false;
  const kind = dataProperty(value, "kind")?.value;
  const connectionId = dataProperty(value, "connectionId")?.value;
  const field = dataProperty(value, "field")?.value;
  return kind === "secret" &&
    typeof connectionId === "string" && connectionId.trim().length > 0 && !isCredentialString(connectionId) &&
    typeof field === "string" && field.trim().length > 0 && !isCredentialString(field);
}

function declaresMalformedSecretReference(value: Record<string, unknown>): boolean {
  return dataProperty(value, "kind")?.value === "secret" && !isSecretReference(value);
}

function sanitizeBindings(value: unknown, state: SanitizeState, depth: number): Record<string, unknown> {
  if (depth > MAX_DEPTH) throw new GraphFragmentError(`Clipboard fragment exceeds depth ${MAX_DEPTH}`);
  if (!plainRecord(value)) throw new GraphFragmentError("Clipboard fragment node bindings must be an object");
  if (state.seen.has(value)) throw new GraphFragmentError("Clipboard fragment must not contain circular data");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new GraphFragmentError("Clipboard fragment must contain JSON data properties only");
  }
  state.seen.add(value);
  const result: Record<string, unknown> = {};
  try {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (UNSAFE_KEYS.has(key)) throw new GraphFragmentError("Clipboard fragment contains an unsafe prototype key");
      const descriptor = dataProperty(value, key);
      if (!descriptor) throw new GraphFragmentError("Clipboard fragment bindings must contain enumerable data properties only");
      if (isSecretReference(descriptor.value) || (plainRecord(descriptor.value) && declaresMalformedSecretReference(descriptor.value))) {
        state.redactions += 1;
        continue;
      }
      const binding = sanitize(descriptor.value, state, depth + 1);
      if (binding !== DROP) result[key] = binding;
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

function isEdgeRecord(value: Record<string, unknown>): boolean {
  return typeof dataProperty(value, "source")?.value === "string" &&
    typeof dataProperty(value, "target")?.value === "string";
}

function sanitize(value: unknown, state: SanitizeState, depth = 0): unknown | typeof DROP {
  if (depth > MAX_DEPTH) throw new GraphFragmentError(`Clipboard fragment exceeds depth ${MAX_DEPTH}`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (isCredentialString(value)) {
      state.redactions += 1;
      return DROP;
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GraphFragmentError("Clipboard fragment numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw new GraphFragmentError("Clipboard fragment must contain JSON data properties only");
  if (state.seen.has(value)) throw new GraphFragmentError("Clipboard fragment must not contain circular data");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new GraphFragmentError("Clipboard fragment must contain JSON data properties only");
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (!Number.isSafeInteger(length) || length < 0) throw new GraphFragmentError("Clipboard fragment array is invalid");
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = dataProperty(value, String(index));
        if (!descriptor) throw new GraphFragmentError("Clipboard fragment arrays must not be sparse or use accessors");
        const item = sanitize(descriptor.value, state, depth + 1);
        if (item !== DROP) result.push(item);
      }
      if (Object.getOwnPropertyNames(value).filter((key) => key !== "length").length !== length) {
        throw new GraphFragmentError("Clipboard fragment arrays must not have extra properties");
      }
      return result;
    }
    if (!plainRecord(value)) throw new GraphFragmentError("Clipboard fragment objects must be plain JSON objects");
    if (declaresMalformedSecretReference(value)) {
      state.redactions += 1;
      return DROP;
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (UNSAFE_KEYS.has(key)) throw new GraphFragmentError("Clipboard fragment contains an unsafe prototype key");
      const descriptor = dataProperty(value, key);
      if (!descriptor) throw new GraphFragmentError("Clipboard fragment must contain enumerable data properties only");
      if (key === "condition" && isEdgeRecord(value)) {
        if (isSecretReference(descriptor.value)) {
          state.redactions += 1;
          continue;
        }
        if (!ValueBindingSchema.safeParse(descriptor.value).success) {
          throw new GraphFragmentError("Clipboard fragment contains an invalid edge condition binding");
        }
        const condition = sanitize(descriptor.value, state, depth + 1);
        if (condition !== DROP) result[key] = condition;
        continue;
      }
      if (isCredentialKey(key) && !isSecretReference(descriptor.value)) {
        state.redactions += 1;
        continue;
      }
      const isNodeBindings = key === "bindings" &&
        typeof dataProperty(value, "type")?.value === "string" &&
        plainRecord(dataProperty(value, "params")?.value) &&
        plainRecord(dataProperty(value, "position")?.value);
      if (isNodeBindings) {
        result[key] = sanitizeBindings(descriptor.value, state, depth + 1);
        continue;
      }
      const child = sanitize(descriptor.value, state, depth + 1);
      if (child !== DROP) result[key] = child;
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new GraphFragmentError("Clipboard fragment has unsupported top-level fields");
  }
}

function validateNode(value: unknown): FlowNode | FlowNodeV2 {
  if (!plainRecord(value) || !nonBlank(value.id) || typeof value.type !== "string" || !NODE_TYPE_SET.has(value.type as NodeType)) {
    throw new GraphFragmentError("Clipboard fragment contains an invalid node");
  }
  if (!plainRecord(value.params) || !plainRecord(value.position)) {
    throw new GraphFragmentError("Clipboard fragment node params and position must be objects");
  }
  if (!Number.isFinite(value.position.x) || !Number.isFinite(value.position.y)) {
    throw new GraphFragmentError("Clipboard fragment node position must be finite");
  }
  if (Object.hasOwn(value, "bindings")) {
    if (!plainRecord(value.bindings)) throw new GraphFragmentError("Clipboard fragment node bindings must be an object");
    for (const binding of Object.values(value.bindings)) {
      if (!ValueBindingSchema.safeParse(binding).success) {
        throw new GraphFragmentError("Clipboard fragment contains an invalid node binding");
      }
    }
    return value as unknown as FlowNodeV2;
  }
  return value as unknown as FlowNode;
}

function validateEdge(value: unknown): FlowEdge | FlowEdgeV2 {
  if (!plainRecord(value) || !nonBlank(value.id) || !nonBlank(value.source) || !nonBlank(value.target)) {
    throw new GraphFragmentError("Clipboard fragment contains an invalid edge");
  }
  if (value.sourceHandle !== undefined && !nonBlank(value.sourceHandle)) {
    throw new GraphFragmentError("Clipboard fragment contains an invalid edge handle");
  }
  if (value.targetHandle !== undefined && !nonBlank(value.targetHandle)) {
    throw new GraphFragmentError("Clipboard fragment contains an invalid edge handle");
  }
  if (value.condition !== undefined && !ValueBindingSchema.safeParse(value.condition).success) {
    throw new GraphFragmentError("Clipboard fragment contains an invalid edge condition binding");
  }
  return value as unknown as FlowEdge;
}

function canonicalize(
  value: unknown,
  addedRedactions: number,
): GraphFragmentV1 {
  if (!plainRecord(value)) throw new GraphFragmentError("Clipboard fragment must be an object");
  assertOnlyKeys(value, ["kind", "version", "redactionCount", "nodes", "edges"]);
  if (value.kind !== FRAGMENT_KIND) throw new GraphFragmentError("Clipboard fragment kind is not supported");
  if (value.version !== 1) throw new GraphFragmentError("Clipboard fragment version is not supported");
  if (!Number.isSafeInteger(value.redactionCount) || (value.redactionCount as number) < 0) {
    throw new GraphFragmentError("Clipboard fragment redaction count is invalid");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    throw new GraphFragmentError("Clipboard fragment must contain at least one node");
  }
  if (value.nodes.length > MAX_NODES) throw new GraphFragmentError(`Clipboard fragment exceeds ${MAX_NODES} nodes`);
  if (!Array.isArray(value.edges)) throw new GraphFragmentError("Clipboard fragment edges must be an array");
  if (value.edges.length > MAX_EDGES) throw new GraphFragmentError(`Clipboard fragment exceeds ${MAX_EDGES} edges`);

  const nodes = value.nodes.map(validateNode).sort(compareIds);
  const edges = value.edges.map(validateEdge).sort(compareIds);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new GraphFragmentError("Clipboard fragment node IDs must be unique; duplicate found");
  }
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
    throw new GraphFragmentError("Clipboard fragment edge IDs must be unique; duplicate found");
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    throw new GraphFragmentError("Clipboard fragment edge endpoints must be internal");
  }
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const redactionCount = (value.redactionCount as number) + addedRedactions;
  if (!Number.isSafeInteger(redactionCount)) {
    throw new GraphFragmentError("Clipboard fragment redaction count is invalid");
  }
  const normalized = nodes.map((node) => ({
    ...node,
    position: { ...node.position, x: node.position.x - minX, y: node.position.y - minY },
  }));
  return {
    kind: FRAGMENT_KIND,
    version: 1,
    redactionCount,
    nodes: normalized,
    edges,
  };
}

function sanitizeAndCanonicalize(value: unknown): GraphFragmentV1 {
  const state: SanitizeState = { redactions: 0, seen: new Set<object>() };
  const sanitized = sanitize(value, state);
  if (sanitized === DROP) throw new GraphFragmentError("Clipboard fragment was removed by credential safety checks");
  return canonicalize(sanitized, state.redactions);
}

export function serializeGraphFragment(
  graph: SupportedFlowGraph,
  selection: GraphSelection,
): GraphFragmentV1 {
  if (selection.nodeIds.length === 0) throw new GraphFragmentDisabledError();
  if (new Set(selection.nodeIds).size !== selection.nodeIds.length) {
    throw new GraphFragmentError("Selected node IDs must be unique; duplicate found");
  }
  const graphNodes = new Map<string, FlowNode | FlowNodeV2>();
  for (const node of graph.nodes) {
    if (graphNodes.has(node.id)) throw new GraphFragmentError("Source graph node IDs must be unique; duplicate found");
    graphNodes.set(node.id, node);
  }
  const nodes = [...selection.nodeIds].sort().map((id) => {
    const node = graphNodes.get(id);
    if (!node) throw new GraphFragmentError("A selected node is missing from the source graph");
    return node;
  });
  if (nodes.length > MAX_NODES) throw new GraphFragmentError(`Clipboard fragment exceeds ${MAX_NODES} nodes`);
  const selected = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => selected.has(edge.source) && selected.has(edge.target))
    .sort(compareIds);
  if (edges.length > MAX_EDGES) throw new GraphFragmentError(`Clipboard fragment exceeds ${MAX_EDGES} edges`);
  return sanitizeAndCanonicalize({
    kind: FRAGMENT_KIND,
    version: 1,
    redactionCount: 0,
    nodes,
    edges,
  });
}

export function parseGraphFragment(text: string): GraphFragmentV1 {
  if (typeof text !== "string") throw new GraphFragmentError("Clipboard fragment text is required");
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
    throw new GraphFragmentError("Clipboard fragment exceeds the 1 MiB size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GraphFragmentError("Clipboard fragment is not valid JSON");
  }
  return sanitizeAndCanonicalize(value);
}

export function commandForPaste(
  fragmentInput: GraphFragmentV1,
  commandId: string,
  targetOrigin: Point,
  targetGraph: SupportedFlowGraph,
): Extract<GraphCommand, { kind: "graph.batch" }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(commandId)) {
    throw new GraphFragmentError("Paste command ID must use letters, numbers, underscores, or hyphens");
  }
  if (!Number.isFinite(targetOrigin.x) || !Number.isFinite(targetOrigin.y)) {
    throw new GraphFragmentError("Paste target origin must be finite");
  }
  const fragment = sanitizeAndCanonicalize(fragmentInput);
  const nodeIds = new Map(fragment.nodes.map((node, index) => [node.id, `node_${commandId}_${index}`]));
  const edgeIds = new Map(fragment.edges.map((edge, index) => [edge.id, `edge_${commandId}_${index}`]));

  const remapBinding = (binding: ValueBinding): ValueBinding => {
    if (binding.kind === "port") {
      const mappedNodeId = nodeIds.get(binding.nodeId);
      if (mappedNodeId === undefined) {
        throw new GraphFragmentError(`Port binding references external or missing node "${binding.nodeId}"`);
      }
      return { ...binding, nodeId: mappedNodeId };
    }
    if (binding.kind === "variable") {
      if (!isFlowGraphV2(targetGraph) || !targetGraph.variables.some((variable) => variable.id === binding.variableId)) {
        throw new GraphFragmentError(`Variable binding references missing target variable "${binding.variableId}"`);
      }
    }
    return structuredClone(binding);
  };

  const remapNode = (node: FlowNode | FlowNodeV2): FlowNode | FlowNodeV2 => {
    const mappedNodeId = nodeIds.get(node.id);
    if (mappedNodeId === undefined) throw new GraphFragmentError(`Node "${node.id}" is missing from the paste ID map`);
    const base = {
      ...node,
      id: mappedNodeId,
      position: { x: targetOrigin.x + node.position.x, y: targetOrigin.y + node.position.y },
    };
    if (!("bindings" in node)) return base;
    const bindings = Object.fromEntries(
      Object.entries(node.bindings).map(([key, binding]) => [key, remapBinding(binding)]),
    );
    return { ...base, bindings };
  };

  const remapEdge = (edge: FlowEdge | FlowEdgeV2): FlowEdge | FlowEdgeV2 => {
    const mappedEdgeId = edgeIds.get(edge.id);
    const mappedSource = nodeIds.get(edge.source);
    const mappedTarget = nodeIds.get(edge.target);
    if (mappedEdgeId === undefined || mappedSource === undefined || mappedTarget === undefined) {
      throw new GraphFragmentError(`Edge "${edge.id}" is missing from the paste ID map`);
    }
    const condition = "condition" in edge ? edge.condition : undefined;
    return {
      ...edge,
      id: mappedEdgeId,
      source: mappedSource,
      target: mappedTarget,
      ...(condition === undefined ? {} : { condition: remapBinding(condition) }),
    };
  };
  const commands: GraphCommand[] = [
    ...fragment.nodes.map((node, index): GraphCommand => ({
      v: 1,
      id: `${commandId}:node:${index}`,
      kind: "node.add",
      node: remapNode(node),
    })),
    ...fragment.edges.map((edge, index): GraphCommand => ({
      v: 1,
      id: `${commandId}:edge:${index}`,
      kind: "edge.add",
      edge: remapEdge(edge),
    })),
  ];
  const parsed = parseGraphCommand({ v: 1, id: commandId, kind: "graph.batch", commands });
  if (parsed.kind !== "graph.batch") throw new GraphFragmentError("Paste command did not compile to a batch");
  try {
    applyGraphCommand(targetGraph, parsed);
  } catch (error) {
    throw new GraphFragmentError(`Paste fragment is not compatible with the target graph: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return parsed;
}
