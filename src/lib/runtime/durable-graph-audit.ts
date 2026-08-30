export const DURABLE_GRAPH_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxJsonDepth: 32,
  maxEntries: 20_000,
  maxStringBytes: 64 * 1024,
  maxStrings: 20_000,
  maxGraphs: 256,
  maxClosureDepth: 16,
  maxNodes: 1_000,
  maxEdges: 2_000,
  maxBindings: 2_000,
  maxVariables: 1_000,
  maxMetadataValues: 5_000,
  maxLiteralValues: 5_000,
});

export interface DurableGraphAuditTotals {
  bytes: number;
  entries: number;
  strings: number;
  graphs: number;
  nodes: number;
  edges: number;
  bindings: number;
  variables: number;
  metadataValues: number;
  literalValues: number;
}

export class DurableGraphAuditError extends Error {
  constructor(readonly kind: "invalid-json" | "closure-limit") {
    super("Durable graph audit failed");
    this.name = "DurableGraphAuditError";
  }
}

const TEXT_ENCODER = new TextEncoder();
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function createDurableGraphAuditTotals(): DurableGraphAuditTotals {
  return {
    bytes: 0,
    entries: 0,
    strings: 0,
    graphs: 0,
    nodes: 0,
    edges: 0,
    bindings: 0,
    variables: 0,
    metadataValues: 0,
    literalValues: 0,
  };
}

function invalid(): never {
  throw new DurableGraphAuditError("invalid-json");
}

function limited(): never {
  throw new DurableGraphAuditError("closure-limit");
}

function add(total: number, amount: number, maximum: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || total > maximum - amount) return limited();
  return total + amount;
}

function encodedStringBytes(value: string): number {
  const bytes = TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
  if (bytes > DURABLE_GRAPH_LIMITS.maxStringBytes + 2) return limited();
  return bytes;
}

function ownData(value: object): readonly [string, unknown][] {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype) return invalid();
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    if (typeof key !== "string" || UNSAFE_KEYS.has(key)) return invalid();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid();
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function arrayData(value: readonly unknown[]): readonly unknown[] {
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return invalid();
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return invalid();
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return invalid();
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    result.push(descriptor.value);
  }
  return result;
}

function scan(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  totals: DurableGraphAuditTotals,
): number {
  if (depth > DURABLE_GRAPH_LIMITS.maxJsonDepth) return limited();
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid();
    return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
  }
  if (typeof value === "string") {
    totals.strings = add(totals.strings, 1, DURABLE_GRAPH_LIMITS.maxStrings);
    return encodedStringBytes(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = arrayData(value);
      totals.entries = add(totals.entries, values.length, DURABLE_GRAPH_LIMITS.maxEntries);
      let bytes = 2 + Math.max(0, values.length - 1);
      for (const child of values) bytes += scan(child, depth + 1, ancestors, totals);
      return bytes;
    }
    const entries = ownData(value);
    totals.entries = add(totals.entries, entries.length, DURABLE_GRAPH_LIMITS.maxEntries);
    let bytes = 2 + Math.max(0, entries.length - 1);
    for (const [key, child] of entries) {
      totals.strings = add(totals.strings, 1, DURABLE_GRAPH_LIMITS.maxStrings);
      bytes += encodedStringBytes(key) + 1 + scan(child, depth + 1, ancestors, totals);
    }
    return bytes;
  } finally {
    ancestors.delete(value);
  }
}

function countValues(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  if (Array.isArray(value)) {
    return 1 + value.reduce((total, child) => total + countValues(child), 0);
  }
  return 1 + Object.values(value as Record<string, unknown>)
    .reduce<number>((total, child) => total + countValues(child), 0);
}

function countGraphCategories(value: unknown, totals: DurableGraphAuditTotals): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const graph = value as Record<string, unknown>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return invalid();
  totals.nodes = add(totals.nodes, graph.nodes.length, DURABLE_GRAPH_LIMITS.maxNodes);
  totals.edges = add(totals.edges, graph.edges.length, DURABLE_GRAPH_LIMITS.maxEdges);
  const variables = Array.isArray(graph.variables) ? graph.variables : [];
  totals.variables = add(totals.variables, variables.length, DURABLE_GRAPH_LIMITS.maxVariables);

  const metadata: unknown[] = [];
  if (Object.hasOwn(graph, "meta")) metadata.push(graph.meta);
  for (const rawNode of graph.nodes) {
    if (rawNode === null || typeof rawNode !== "object" || Array.isArray(rawNode)) return invalid();
    const node = rawNode as Record<string, unknown>;
    if (Object.hasOwn(node, "meta")) metadata.push(node.meta);
    if (!Object.hasOwn(node, "bindings")) continue;
    if (node.bindings === null || typeof node.bindings !== "object" || Array.isArray(node.bindings)) return invalid();
    const bindings = node.bindings as Record<string, unknown>;
    totals.bindings = add(totals.bindings, Object.keys(bindings).length, DURABLE_GRAPH_LIMITS.maxBindings);
    for (const binding of Object.values(bindings)) {
      if (binding === null || typeof binding !== "object" || Array.isArray(binding)) continue;
      const record = binding as Record<string, unknown>;
      if (record.kind === "literal" && Object.hasOwn(record, "value")) {
        totals.literalValues = add(
          totals.literalValues,
          countValues(record.value),
          DURABLE_GRAPH_LIMITS.maxLiteralValues,
        );
      }
    }
  }
  for (const rawEdge of graph.edges) {
    if (rawEdge === null || typeof rawEdge !== "object" || Array.isArray(rawEdge)) return invalid();
    const edge = rawEdge as Record<string, unknown>;
    if (!Object.hasOwn(edge, "condition")) continue;
    totals.bindings = add(totals.bindings, 1, DURABLE_GRAPH_LIMITS.maxBindings);
    const condition = edge.condition;
    if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
      const record = condition as Record<string, unknown>;
      if (record.kind === "literal" && Object.hasOwn(record, "value")) {
        totals.literalValues = add(
          totals.literalValues,
          countValues(record.value),
          DURABLE_GRAPH_LIMITS.maxLiteralValues,
        );
      }
    }
  }
  for (const rawVariable of variables) {
    if (rawVariable === null || typeof rawVariable !== "object" || Array.isArray(rawVariable)) return invalid();
    const variable = rawVariable as Record<string, unknown>;
    if (Object.hasOwn(variable, "default")) {
      totals.literalValues = add(
        totals.literalValues,
        countValues(variable.default),
        DURABLE_GRAPH_LIMITS.maxLiteralValues,
      );
    }
  }
  for (const item of metadata) {
    totals.metadataValues = add(
      totals.metadataValues,
      countValues(item),
      DURABLE_GRAPH_LIMITS.maxMetadataValues,
    );
  }
}

function canonicalClone(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid();
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return arrayData(value).map((child) => canonicalClone(child, ancestors));
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of [...ownData(value)].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      result[key] = canonicalClone(child, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Return deterministic sorted-key JSON without touching or normalizing the input object. */
export function canonicalDurableGraphJson(value: unknown): string {
  try {
    return JSON.stringify(canonicalClone(value, new Set()));
  } catch (error) {
    if (error instanceof DurableGraphAuditError) throw error;
    throw new DurableGraphAuditError("invalid-json");
  }
}

/** Audit one exact frozen graph without cloning, normalizing, or invoking accessors. */
export function auditDurableGraph(value: unknown, totals: DurableGraphAuditTotals): void {
  try {
    const bytes = scan(value, 0, new Set(), totals);
    totals.bytes = add(totals.bytes, bytes, DURABLE_GRAPH_LIMITS.maxBytes);
    totals.graphs = add(totals.graphs, 1, DURABLE_GRAPH_LIMITS.maxGraphs);
    countGraphCategories(value, totals);
  } catch (error) {
    if (error instanceof DurableGraphAuditError) throw error;
    throw new DurableGraphAuditError("invalid-json");
  }
}
