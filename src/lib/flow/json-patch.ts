import type { JsonPatchOp, JsonValue } from "./graph-command-types";

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_JSON_DEPTH = 100;

export interface JsonPatchOptions {
  readonly forbiddenRootKeys?: readonly string[];
}

export interface JsonPatchResult<T extends JsonValue> {
  readonly value: T;
  readonly inverse: readonly JsonPatchOp[];
}

export function assertJsonValue(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
  depth = 0,
): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`${path} exceeds the JSON depth limit of ${MAX_JSON_DEPTH}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must contain only JSON values`);
  if (seen.has(value)) throw new TypeError(`${path} must not contain a circular JSON value`);
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} must not contain symbol-keyed properties`);
    }
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
        throw new TypeError(`${path} has an invalid array length`);
      }
      const length = lengthDescriptor.value;
      for (let index = 0; index < length; index += 1) {
        if (!(index in value)) throw new TypeError(`${path}[${index}] is a sparse array hole, not a JSON value`);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${path}[${index}] must be an enumerable JSON data property`);
        }
        assertJsonValue(descriptor.value, `${path}[${index}]`, seen, depth + 1);
      }
      if (Object.getOwnPropertyNames(value).filter((key) => key !== "length").length !== length) {
        throw new TypeError(`${path} has non-index array properties that are not JSON values`);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (UNSAFE_KEYS.has(key)) throw new TypeError(`${path}.${key} is an unsafe prototype key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable JSON data property`);
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value) as T;
}

function decodePointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/.test(segment)) throw new Error(`Invalid JSON Pointer escape in "${segment}"`);
  const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
  if (UNSAFE_KEYS.has(decoded)) throw new Error(`Unsafe JSON Pointer segment "${decoded}"`);
  return decoded;
}

function encodePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function parsePointer(path: string, forbiddenRootKeys: ReadonlySet<string>): string[] {
  if (path === "") throw new Error("Root JSON Patch operations are not allowed");
  if (!path.startsWith("/")) throw new Error(`JSON Patch path must start with "/": ${path}`);
  const segments = path.slice(1).split("/").map(decodePointerSegment);
  if (forbiddenRootKeys.has(segments[0] ?? "")) {
    throw new Error(`JSON Patch root key "${segments[0]}" is forbidden`);
  }
  return segments;
}

export function assertSafeJsonPointer(
  path: string,
  forbiddenRootKeys: readonly string[] = [],
): void {
  parsePointer(path, new Set(forbiddenRootKeys));
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function arrayIndex(segment: string, length: number, allowAppend: boolean): number {
  if (allowAppend && segment === "-") return length;
  if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error(`Invalid array index "${segment}"`);
  const index = Number(segment);
  const maximum = allowAppend ? length : length - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new Error(`Array index ${segment} is out of bounds`);
  }
  return index;
}

function parentAt(root: JsonValue, segments: readonly string[]): JsonValue {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = current[arrayIndex(segment, current.length, false)] as JsonValue;
      continue;
    }
    if (!current || typeof current !== "object") throw new Error(`JSON Patch parent path does not exist at "${segment}"`);
    const object = current as Record<string, JsonValue>;
    if (!hasOwn(object, segment)) throw new Error(`JSON Patch parent path does not exist at "${segment}"`);
    current = object[segment];
  }
  return current;
}

export function applyJsonPatchWithInverse<T extends JsonValue>(
  source: T,
  patch: readonly JsonPatchOp[],
  options: JsonPatchOptions = {},
): JsonPatchResult<T> {
  assertJsonValue(source, "$source");
  assertJsonValue(patch, "$patch");
  const forbidden = new Set(options.forbiddenRootKeys ?? []);
  const value = cloneJson(source) as JsonValue;
  const inverse: JsonPatchOp[] = [];

  for (const operation of patch) {
    const segments = parsePointer(operation.path, forbidden);
    const key = segments.at(-1) as string;
    const parentSegments = segments.slice(0, -1);
    const parent = parentAt(value, parentSegments);

    if (Array.isArray(parent)) {
      if (operation.op === "add") {
        const index = arrayIndex(key, parent.length, true);
        const inserted = cloneJson(operation.value);
        parent.splice(index, 0, inserted);
        const actualPath = `/${[...parentSegments, String(index)].map(encodePointerSegment).join("/")}`;
        inverse.unshift({ op: "remove", path: actualPath });
      } else {
        const index = arrayIndex(key, parent.length, false);
        const previous = cloneJson(parent[index] as JsonValue);
        if (operation.op === "replace") {
          parent[index] = cloneJson(operation.value);
          inverse.unshift({ op: "replace", path: operation.path, value: previous });
        } else {
          parent.splice(index, 1);
          inverse.unshift({ op: "add", path: operation.path, value: previous });
        }
      }
      continue;
    }

    if (!parent || typeof parent !== "object") throw new Error("JSON Patch parent is not an object or array");
    const object = parent as Record<string, JsonValue>;
    const existed = hasOwn(object, key);
    if (operation.op === "add") {
      const previous = existed ? cloneJson(object[key]) : undefined;
      object[key] = cloneJson(operation.value);
      inverse.unshift(existed
        ? { op: "replace", path: operation.path, value: previous as JsonValue }
        : { op: "remove", path: operation.path });
      continue;
    }
    if (!existed) throw new Error(`JSON Patch path does not exist: ${operation.path}`);
    const previous = cloneJson(object[key]);
    if (operation.op === "replace") {
      object[key] = cloneJson(operation.value);
      inverse.unshift({ op: "replace", path: operation.path, value: previous });
    } else {
      delete object[key];
      inverse.unshift({ op: "add", path: operation.path, value: previous });
    }
  }

  assertJsonValue(value, "$result");
  return { value: value as T, inverse };
}
