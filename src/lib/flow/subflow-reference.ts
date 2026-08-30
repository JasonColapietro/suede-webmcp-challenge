import { z } from "zod";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  JsonSchema,
  JsonValue,
  SubflowReference,
  ValueBinding,
} from "./types";

const UNSAFE_TOKENS = new Set(["__proto__", "prototype", "constructor"]);
const STABLE_PORT_ID = /^[A-Za-z_][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const nonBlank = z.string().min(1).refine((value) => value.trim() === value, "ID must not have surrounding whitespace");

const JsonSchemaSchema: z.ZodType<JsonSchema, z.ZodTypeDef, unknown> = z.unknown().transform((value, context) => {
  try {
    const cloned = strictJsonClone(value);
    if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON Schema must be a JSON object" });
      return z.NEVER;
    }
    return cloned as JsonSchema;
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid JSON Schema",
    });
    return z.NEVER;
  }
});

function decodePointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) throw new Error("JSON Pointer contains an invalid escape");
  const decoded = token.replace(/~1/g, "/").replace(/~0/g, "~");
  if (decoded === "-" || UNSAFE_TOKENS.has(decoded)) {
    throw new Error(`JSON Pointer contains unsafe token "${decoded}"`);
  }
  return decoded;
}

export function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error("JSON Pointer must be empty or start with /");
  return pointer.slice(1).split("/").map(decodePointerToken);
}

const pointerSchema = z.string().superRefine((pointer, context) => {
  try {
    parseJsonPointer(pointer);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid JSON Pointer",
    });
  }
});

const portIdSchema = z.string().superRefine((id, context) => {
  if (!STABLE_PORT_ID.test(id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Port id must be stable" });
  }
  if (UNSAFE_TOKENS.has(id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Port id is unsafe" });
  }
});

const portShape = {
  id: portIdSchema,
  label: z.string(),
  schema: JsonSchemaSchema,
  required: z.boolean(),
  cardinality: z.enum(["one", "many"]),
} as const;

const CallableInputPortSchema = z.object({
  ...portShape,
  target: z.object({ kind: z.literal("trigger"), path: pointerSchema }).strict(),
}).strict();

const CallableOutputPortSchema = z.object({
  ...portShape,
  source: z.object({
    nodeId: nonBlank,
    portId: portIdSchema,
    path: pointerSchema.optional(),
  }).strict(),
}).strict();

function requireUniquePortIds(
  ports: readonly { readonly id: string }[],
  direction: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  ports.forEach((port, index) => {
    if (seen.has(port.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${direction} port ids must be unique`,
        path: [direction, index, "id"],
      });
    }
    seen.add(port.id);
  });
}

export const FlowCallableInterfaceSchema: z.ZodType<FlowCallableInterface, z.ZodTypeDef, unknown> = z.object({
  inputs: z.array(CallableInputPortSchema),
  outputs: z.array(CallableOutputPortSchema),
}).strict().superRefine((value, context) => {
  requireUniquePortIds(value.inputs, "inputs", context);
  requireUniquePortIds(value.outputs, "outputs", context);
  try {
    assertNoTargetCollisions(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Callable input target collision",
      path: ["inputs"],
    });
  }
});

const hashSchema = z.string().regex(HASH, "Hash must be a lowercase SHA-256 digest");

export const SubflowReferenceSchema: z.ZodType<SubflowReference, z.ZodTypeDef, unknown> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft"),
    flowId: nonBlank,
    interface: FlowCallableInterfaceSchema,
    interfaceHash: hashSchema,
  }).strict(),
  z.object({
    kind: z.literal("pinned"),
    flowId: nonBlank,
    versionId: nonBlank,
    interface: FlowCallableInterfaceSchema,
    interfaceHash: hashSchema,
    contentHash: hashSchema,
  }).strict(),
]).superRefine((reference, context) => {
  if (reference.interfaceHash !== hashCallableInterface(reference.interface)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Subflow interface hash does not match the embedded callable interface",
      path: ["interfaceHash"],
    });
  }
});

export type NormalizedSubflowReference =
  | { readonly kind: "legacy"; readonly flowId: string }
  | { readonly kind: "typed"; readonly reference: SubflowReference };

function own(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeSubflowReference(params: unknown): NormalizedSubflowReference {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Subflow params must contain flowId or reference");
  }
  const value = params as Record<string, unknown>;
  const hasLegacy = own(value, "flowId");
  const hasTyped = own(value, "reference");
  if (hasLegacy && hasTyped) throw new Error("Subflow params cannot contain both flowId and reference");
  if (hasTyped) return { kind: "typed", reference: SubflowReferenceSchema.parse(value.reference) };
  if (hasLegacy && typeof value.flowId === "string" && value.flowId.length > 0) {
    return { kind: "legacy", flowId: value.flowId };
  }
  throw new Error("Subflow params must contain a non-empty flowId or reference");
}

export function subflowRecursionIdentity(reference: SubflowReference): string {
  return reference.flowId;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    const record = value as Readonly<Record<string, JsonValue>>;
    for (const key of Object.keys(record).sort()) result[key] = canonicalize(record[key] as JsonValue);
    return result;
  }
  return value;
}

function rightRotate(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Small synchronous SHA-256 implementation, safe in both browser and server bundles. */
export function sha256Utf8(text: string): string {
  const maxWord = 2 ** 32;
  const words: number[] = [];
  const hash: number[] = [];
  const constants: number[] = [];
  let primeCounter = 0;
  const composite: Record<number, boolean> = {};
  for (let candidate = 2; primeCounter < 64; candidate += 1) {
    if (composite[candidate]) continue;
    for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) composite[multiple] = true;
    if (primeCounter < 8) hash[primeCounter] = (Math.sqrt(candidate) * maxWord) | 0;
    constants[primeCounter] = (Math.cbrt(candidate) * maxWord) | 0;
    primeCounter += 1;
  }
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  const high = Math.floor(bitLength / maxWord);
  const low = bitLength >>> 0;
  for (const value of [high, low]) {
    padded.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
  }
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) {
        const base = offset + index * 4;
        words[index] = ((padded[base] as number) << 24) | ((padded[base + 1] as number) << 16) |
          ((padded[base + 2] as number) << 8) | (padded[base + 3] as number);
      } else {
        const before15 = words[index - 15] as number;
        const before2 = words[index - 2] as number;
        const gamma0 = rightRotate(before15, 7) ^ rightRotate(before15, 18) ^ (before15 >>> 3);
        const gamma1 = rightRotate(before2, 17) ^ rightRotate(before2, 19) ^ (before2 >>> 10);
        words[index] = (((words[index - 16] as number) + gamma0 + (words[index - 7] as number) + gamma1) | 0);
      }
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rightRotate(e as number, 6) ^ rightRotate(e as number, 11) ^ rightRotate(e as number, 25);
      const choice = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const temp1 = (((h as number) + sigma1 + choice + (constants[index] as number) + (words[index] as number)) | 0);
      const sigma0 = rightRotate(a as number, 2) ^ rightRotate(a as number, 13) ^ rightRotate(a as number, 22);
      const majority = ((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number));
      const temp2 = (sigma0 + majority) | 0;
      h = g; g = f; f = e; e = ((d as number) + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    const chunk = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) hash[index] = (((hash[index] as number) + (chunk[index] as number)) | 0);
  }
  return hash.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

export function hashCallableInterface(value: FlowCallableInterface): string {
  const parsed = FlowCallableInterfaceSchema.parse(value);
  return sha256Utf8(JSON.stringify(canonicalize(parsed as unknown as JsonValue)));
}

export function assertSubflowReferenceReceipt(
  reference: SubflowReference,
  resolved: { readonly interfaceHash: string; readonly contentHash?: string },
): void {
  if (reference.interfaceHash !== resolved.interfaceHash) throw new Error("Subflow interface hash mismatch");
  if (reference.kind === "pinned" && reference.contentHash !== resolved.contentHash) {
    throw new Error("Subflow content hash mismatch");
  }
}

function cloneJsonArray(value: readonly unknown[], ancestors: Set<object>, path: string): JsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${path} must be a plain JSON array`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must not contain symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new Error(`${path} must not contain sparse JSON arrays`);
    if (!("value" in descriptor)) throw new Error(`${path}[${index}] must not be an accessor`);
    if (!descriptor.enumerable) throw new Error(`${path}[${index}] must be enumerable JSON data`);
    result.push(strictJsonCloneInternal(descriptor.value, ancestors, `${path}[${index}]`));
  }
  const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new Error(`${path} must not contain non-JSON array properties`);
  }
  return result;
}

function cloneJsonObject(value: object, ancestors: Set<object>, path: string): Record<string, JsonValue> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain JSON object`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must not contain symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (UNSAFE_TOKENS.has(key)) throw new Error(`${path} contains unsafe prototype-like key "${key}"`);
    if (key === "toJSON") throw new Error(`${path} must not define toJSON`);
    if (!("value" in descriptor)) throw new Error(`${path}.${key} must not be an accessor`);
    if (!descriptor.enumerable) throw new Error(`${path}.${key} must be enumerable JSON data`);
    result[key] = strictJsonCloneInternal(descriptor.value, ancestors, `${path}.${key}`);
  }
  return result;
}

function strictJsonCloneInternal(value: unknown, ancestors: Set<object>, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite JSON numbers`);
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains unsupported JSON value ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a JSON cycle`);
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? cloneJsonArray(value, ancestors, path)
      : cloneJsonObject(value, ancestors, path);
  } finally {
    ancestors.delete(value);
  }
}

export function strictJsonClone(value: unknown): JsonValue {
  return strictJsonCloneInternal(value, new Set<object>(), "$json");
}

function ownDataValue(
  value: object,
  key: PropertyKey,
  path: string,
): { readonly found: false } | { readonly found: true; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { found: false };
  if (!("value" in descriptor)) throw new Error(`${path} must not be an accessor`);
  if (!descriptor.enumerable) throw new Error(`${path} must be enumerable JSON data`);
  return { found: true, value: descriptor.value };
}

export function readJsonPointer(value: unknown, pointer: string): JsonValue {
  let current: unknown = strictJsonClone(value);
  for (const token of parseJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`Array index "${token}" is not canonical`);
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length || !own(current, index)) {
        throw new Error(`JSON Pointer path is missing at "${token}"`);
      }
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !own(current, token)) {
      throw new Error(`JSON Pointer path is missing at "${token}"`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current as JsonValue;
}

function pointerCollision(left: readonly string[], right: readonly string[]): boolean {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function assertNoTargetCollisions(value: FlowCallableInterface): void {
  const paths = value.inputs.map((port) => ({ id: port.id, tokens: parseJsonPointer(port.target.path) }));
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (pointerCollision(paths[left]!.tokens, paths[right]!.tokens)) {
        throw new Error(`Callable input target collision between "${paths[left]!.id}" and "${paths[right]!.id}"`);
      }
    }
  }
}

function assertCardinality(id: string, cardinality: "one" | "many", value: JsonValue): void {
  if (cardinality === "many" && !Array.isArray(value)) {
    throw new Error(`Callable port "${id}" has many cardinality and requires an array`);
  }
}

function writePointer(root: JsonValue, pointer: string, value: JsonValue): JsonValue {
  const tokens = parseJsonPointer(pointer);
  if (tokens.length === 0) return strictJsonClone(value);
  if (root === null || typeof root !== "object" || Array.isArray(root)) throw new Error("Callable trigger root must be an object");
  let current = root as Record<string, JsonValue>;
  tokens.forEach((token, index) => {
    if (index === tokens.length - 1) {
      current[token] = strictJsonClone(value);
      return;
    }
    const existing = current[token];
    if (existing !== undefined) {
      if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error(`Callable input target collision at "${token}"`);
      }
      current = existing as Record<string, JsonValue>;
    } else {
      const next = Object.create(null) as Record<string, JsonValue>;
      current[token] = next;
      current = next;
    }
  });
  return root;
}

export function materializeCallableInputs(
  callableInterface: FlowCallableInterface,
  values: Readonly<Record<string, unknown>>,
): JsonValue {
  const parsed = FlowCallableInterfaceSchema.parse(callableInterface);
  assertNoTargetCollisions(parsed);
  let result: JsonValue = Object.create(null) as Record<string, JsonValue>;
  for (const port of parsed.inputs) {
    const input = ownDataValue(values, port.id, `Callable input "${port.id}"`);
    if (!input.found) {
      if (port.required) throw new Error(`Missing required callable input "${port.id}"`);
      continue;
    }
    const value = strictJsonClone(input.value);
    assertCardinality(port.id, port.cardinality, value);
    result = writePointer(result, port.target.path, value);
  }
  return result;
}

export function projectCallableOutputs(
  callableInterface: FlowCallableInterface,
  nodeOutputs: Readonly<Record<string, unknown>>,
): Record<string, JsonValue> {
  const parsed = FlowCallableInterfaceSchema.parse(callableInterface);
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const port of parsed.outputs) {
    const nodeOutput = ownDataValue(
      nodeOutputs,
      port.source.nodeId,
      `Callable output node "${port.source.nodeId}"`,
    );
    if (!nodeOutput.found) {
      if (port.required) throw new Error(`Missing required callable output "${port.id}"`);
      continue;
    }
    const outputs = strictJsonClone(nodeOutput.value);
    if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
      if (port.required) throw new Error(`Missing required callable output "${port.id}"`);
      continue;
    }
    const source = ownDataValue(outputs, port.source.portId, `Callable output port "${port.source.portId}"`);
    if (!source.found) {
      if (port.required) throw new Error(`Missing required callable output "${port.id}"`);
      continue;
    }
    const root = source.value;
    let value: JsonValue;
    try {
      value = port.source.path === undefined ? strictJsonClone(root) : readJsonPointer(root, port.source.path);
    } catch (error) {
      if (port.required) throw new Error(`Missing required callable output "${port.id}"`, { cause: error });
      continue;
    }
    assertCardinality(port.id, port.cardinality, value);
    result[port.id] = value;
  }
  return result;
}

function bindingLineage(
  binding: ValueBinding,
  graph: FlowGraphV2,
  visitNode: (nodeId: string) => void,
): void {
  if (binding.kind === "secret") throw new Error("Callable output lineage contains a secret binding");
  if (binding.kind === "variable") {
    const variable = graph.variables.find((candidate) => candidate.id === binding.variableId);
    if (variable?.sensitive) throw new Error("Callable output lineage contains a sensitive variable");
  }
  if (binding.kind === "port") visitNode(binding.nodeId);
}

export function assertCallableOutputLineageSafe(
  graph: FlowGraphV2,
  callableInterface: FlowCallableInterface,
): void {
  const parsed = FlowCallableInterfaceSchema.parse(callableInterface);
  for (const output of parsed.outputs) {
    const visited = new Set<string>();
    const visitNode = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error(`Callable output source node "${nodeId}" is missing`);
      for (const binding of Object.values(node.bindings)) bindingLineage(binding, graph, visitNode);
      for (const edge of graph.edges) {
        if (edge.target !== nodeId) continue;
        if (edge.condition) bindingLineage(edge.condition, graph, visitNode);
        visitNode(edge.source);
      }
    };
    visitNode(output.source.nodeId);
  }
}
