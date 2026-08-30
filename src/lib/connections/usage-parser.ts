const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 1_000;
const MAX_EDGES = 5_000;
const MAX_STRINGS = 10_000;
const MAX_STRING_BYTES = 65_536;

export type ConnectionReferenceScanResult = "match" | "no-match" | "malformed" | "limited";

class ShapeError extends Error {}
class LimitError extends Error {}

interface ScanBudget {
  strings: number;
}

function descriptors(value: object): PropertyDescriptorMap {
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new ShapeError();
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new ShapeError();
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new ShapeError();
  return Object.getOwnPropertyDescriptors(value);
}

function countString(value: string, budget: ScanBudget): void {
  budget.strings += 1;
  if (budget.strings > MAX_STRINGS || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    throw new LimitError();
  }
}

function inspectValue(value: unknown, depth: number, budget: ScanBudget): void {
  if (depth > MAX_DEPTH) throw new LimitError();
  if (typeof value === "string") {
    countString(value, budget);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ShapeError();
    return;
  }
  if (typeof value !== "object") throw new ShapeError();
  const map = descriptors(value);
  if (Array.isArray(value)) {
    const allowed = new Set<string>(["length"]);
    for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
    if (Object.keys(map).some((key) => !allowed.has(key))) throw new ShapeError();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = map[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ShapeError();
      inspectValue(descriptor.value, depth + 1, budget);
    }
    return;
  }
  for (const [key, descriptor] of Object.entries(map)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new ShapeError();
    countString(key, budget);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new ShapeError();
    inspectValue(descriptor.value, depth + 1, budget);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ShapeError();
  const map = descriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(map)) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new ShapeError();
    result[key] = descriptor.value;
  }
  return result;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) {
    throw new ShapeError();
  }
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ShapeError();
  return value;
}

function bindingMatches(value: unknown, connectionId: string): boolean {
  const item = record(value);
  if (item.kind === "literal") {
    exactKeys(item, ["kind", "value"]);
    return false;
  }
  if (item.kind === "port") {
    exactKeys(item, ["kind", "nodeId", "portId"], ["path"]);
    if (typeof item.nodeId !== "string" || typeof item.portId !== "string" ||
        (item.path !== undefined && typeof item.path !== "string")) throw new ShapeError();
    return false;
  }
  if (item.kind === "variable") {
    exactKeys(item, ["kind", "variableId"], ["path"]);
    if (typeof item.variableId !== "string" || (item.path !== undefined && typeof item.path !== "string")) {
      throw new ShapeError();
    }
    return false;
  }
  if (item.kind === "secret") {
    exactKeys(item, ["kind", "connectionId", "field"]);
    if (typeof item.connectionId !== "string" || typeof item.field !== "string") throw new ShapeError();
    return item.connectionId === connectionId;
  }
  throw new ShapeError();
}

function scanV2(root: Record<string, unknown>, connectionId: string): boolean {
  exactKeys(
    root,
    ["schemaVersion", "id", "name", "nodes", "edges", "variables", "groups", "annotations"],
    ["callableInterface", "meta"],
  );
  if (root.schemaVersion !== 2 || typeof root.id !== "string" || typeof root.name !== "string") {
    throw new ShapeError();
  }
  const nodes = array(root.nodes);
  const edges = array(root.edges);
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) throw new LimitError();
  array(root.variables);
  array(root.groups);
  array(root.annotations);

  let matched = false;
  for (const rawNode of nodes) {
    const node = record(rawNode);
    exactKeys(node, ["id", "type", "params", "bindings", "position"], ["implementationVersion", "meta"]);
    if (typeof node.id !== "string" || typeof node.type !== "string") throw new ShapeError();
    record(node.params);
    const position = record(node.position);
    exactKeys(position, ["x", "y"]);
    if (typeof position.x !== "number" || !Number.isFinite(position.x) ||
        typeof position.y !== "number" || !Number.isFinite(position.y)) throw new ShapeError();
    const bindings = record(node.bindings);
    for (const value of Object.values(bindings)) matched = bindingMatches(value, connectionId) || matched;
  }
  for (const rawEdge of edges) {
    const edge = record(rawEdge);
    exactKeys(edge, ["id", "source", "sourceHandle", "target", "targetHandle"], ["condition"]);
    for (const key of ["id", "source", "sourceHandle", "target", "targetHandle"] as const) {
      if (typeof edge[key] !== "string") throw new ShapeError();
    }
    if (edge.condition !== undefined) matched = bindingMatches(edge.condition, connectionId) || matched;
  }
  return matched;
}

function scanV1(root: Record<string, unknown>): false {
  exactKeys(root, ["id", "name", "nodes", "edges"], ["meta"]);
  if (typeof root.id !== "string" || typeof root.name !== "string") throw new ShapeError();
  const nodes = array(root.nodes);
  const edges = array(root.edges);
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) throw new LimitError();
  for (const rawNode of nodes) {
    const node = record(rawNode);
    exactKeys(node, ["id", "type", "params", "position"]);
    if (typeof node.id !== "string" || typeof node.type !== "string") throw new ShapeError();
    record(node.params);
    const position = record(node.position);
    exactKeys(position, ["x", "y"]);
    if (typeof position.x !== "number" || !Number.isFinite(position.x) ||
        typeof position.y !== "number" || !Number.isFinite(position.y)) throw new ShapeError();
  }
  for (const rawEdge of edges) {
    const edge = record(rawEdge);
    exactKeys(edge, ["id", "source", "target"], ["sourceHandle", "targetHandle"]);
    for (const key of ["id", "source", "target"] as const) {
      if (typeof edge[key] !== "string") throw new ShapeError();
    }
    if (edge.sourceHandle !== undefined && typeof edge.sourceHandle !== "string") throw new ShapeError();
    if (edge.targetHandle !== undefined && typeof edge.targetHandle !== "string") throw new ShapeError();
  }
  return false;
}

export function scanConnectionReferences(
  graphText: string,
  connectionId: string,
): ConnectionReferenceScanResult {
  try {
    if (typeof graphText !== "string" || typeof connectionId !== "string") throw new ShapeError();
    if (Buffer.byteLength(graphText, "utf8") > MAX_ARTIFACT_BYTES) throw new LimitError();
    const parsed = JSON.parse(graphText) as unknown;
    inspectValue(parsed, 0, { strings: 0 });
    const root = record(parsed);
    const matched = root.schemaVersion === 2 ? scanV2(root, connectionId) : scanV1(root);
    return matched ? "match" : "no-match";
  } catch (error) {
    return error instanceof LimitError ? "limited" : "malformed";
  }
}
