import { CONNECTOR_IMPORT_V1_LIMITS, type ConnectorImportV1Limits } from "../limits";

export type ParsedJson = null | boolean | number | string | readonly ParsedJson[] | ParsedJsonObject;
export interface ParsedJsonObject { readonly [key: string]: ParsedJson }

export type OpenApiCompilerLimitKey = Exclude<keyof ConnectorImportV1Limits,
  "profile" | "maxImportsPerOwnerPerMinute" | "maxTerminalReceiptBytes">;
export type OpenApiCompilerLimitOverrides = { readonly [Key in OpenApiCompilerLimitKey]?: number };
export type OpenApiFailureCode =
  | "INVALID_LIMIT_PROFILE" | "IMPORT_CANCELLED" | "COMPILER_DEADLINE"
  | "INPUT_BYTES_LIMIT" | "INVALID_JSON" | "DUPLICATE_JSON_KEY"
  | "JSON_DEPTH_LIMIT" | "JSON_ENTRY_LIMIT" | "INSPECTED_VALUE_LIMIT"
  | "OPERATION_LIMIT" | "PARAMETER_LIMIT" | "SCHEMA_DEPTH_LIMIT"
  | "LOCAL_REFERENCE_LIMIT" | "CANONICAL_PROJECTION_LIMIT"
  | "OPENAPI_VERSION_REFUSED" | "OPENAPI_STRUCTURE_REFUSED"
  | "UNSUPPORTED_OPENAPI_KEYWORD" | "UNSUPPORTED_FIXTURE_INPUT"
  | "SERVER_ORIGIN_REFUSED" | "REMOTE_REFERENCE_REFUSED"
  | "REFERENCE_POINTER_REFUSED" | "REFERENCE_CYCLE_REFUSED"
  | "MISSING_OPERATION_ID" | "DUPLICATE_OPERATION_ID"
  | "SECURITY_REFUSED" | "HEADER_OWNERSHIP_REFUSED"
  | "PARAMETER_REFUSED" | "PARAMETER_SERIALIZATION_REFUSED"
  | "SCHEMA_KEYWORD_REFUSED" | "SCHEMA_FORMAT_REFUSED" | "SCHEMA_UNSATISFIABLE"
  | "REQUEST_BODY_REFUSED" | "RESPONSE_SELECTION_REFUSED" | "RESPONSE_MEDIA_TYPE_REFUSED"
  | "CALLBACK_REFUSED" | "LINK_REFUSED";

export class OpenApiRefusal extends Error {
  readonly code: OpenApiFailureCode;
  constructor(code: OpenApiFailureCode) {
    super(code);
    this.name = "OpenApiRefusal";
    this.code = code;
  }
}

export function refuse(code: OpenApiFailureCode): never {
  throw new OpenApiRefusal(code);
}

export interface OpenApiCompileGuard {
  readonly limits: Readonly<ConnectorImportV1Limits>;
  readonly signal?: AbortSignal;
  readonly deadline: number;
  inspectedValues: number;
  containerEntries: number;
  localReferenceExpansions: number;
}

const LIMIT_KEYS = Object.freeze([
  "maxInputBytes", "maxJsonDepth", "maxContainerEntries", "maxOperations",
  "maxParametersPerOperation", "maxSchemaDepth", "maxLocalReferenceExpansions",
  "maxInspectedValues", "compilerDeadlineMs", "maxCanonicalProjectionBytes",
] as const satisfies readonly OpenApiCompilerLimitKey[]);

export function createCompileGuard(
  overrides: OpenApiCompilerLimitOverrides | undefined,
  signal?: AbortSignal,
): OpenApiCompileGuard {
  const limits: Record<string, string | number> = { ...CONNECTOR_IMPORT_V1_LIMITS };
  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides) ||
        Object.getPrototypeOf(overrides) !== Object.prototype || Object.getOwnPropertySymbols(overrides).length !== 0) {
      refuse("INVALID_LIMIT_PROFILE");
    }
    const descriptors = Object.getOwnPropertyDescriptors(overrides);
    for (const key of Object.keys(descriptors)) {
      if (!LIMIT_KEYS.includes(key as OpenApiCompilerLimitKey)) refuse("INVALID_LIMIT_PROFILE");
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
          !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 ||
          descriptor.value > CONNECTOR_IMPORT_V1_LIMITS[key as OpenApiCompilerLimitKey]) {
        refuse("INVALID_LIMIT_PROFILE");
      }
      limits[key] = descriptor.value as number;
    }
  }
  const guard: OpenApiCompileGuard = {
    limits: Object.freeze(limits) as unknown as ConnectorImportV1Limits,
    signal,
    deadline: performance.now() + Number(limits.compilerDeadlineMs),
    inspectedValues: 0,
    containerEntries: 0,
    localReferenceExpansions: 0,
  };
  checkpoint(guard);
  return guard;
}

export function checkpoint(guard: OpenApiCompileGuard, inspect = false): void {
  if (guard.signal?.aborted) refuse("IMPORT_CANCELLED");
  if (performance.now() >= guard.deadline) refuse("COMPILER_DEADLINE");
  if (inspect) {
    guard.inspectedValues += 1;
    if (guard.inspectedValues > guard.limits.maxInspectedValues) refuse("INSPECTED_VALUE_LIMIT");
  }
}

function utf8StringBytes(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) refuse("INVALID_JSON");
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      refuse("INVALID_JSON");
    } else {
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (bytes > maximum) refuse("INPUT_BYTES_LIMIT");
  }
  return bytes;
}

function decodedSource(source: string | Uint8Array, guard: OpenApiCompileGuard): string {
  let bytes: Uint8Array;
  if (typeof source === "string") {
    utf8StringBytes(source, guard.limits.maxInputBytes);
    bytes = new TextEncoder().encode(source);
  }
  else if (source instanceof Uint8Array) bytes = source;
  else return refuse("INVALID_JSON");
  if (bytes.byteLength > guard.limits.maxInputBytes) refuse("INPUT_BYTES_LIMIT");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("INVALID_JSON");
  }
}

class JsonParser {
  readonly #source: string;
  readonly #guard: OpenApiCompileGuard;
  #index = 0;

  constructor(source: string, guard: OpenApiCompileGuard) {
    this.#source = source;
    this.#guard = guard;
  }

  parse(): ParsedJson {
    this.#space();
    const result = this.#value(0);
    this.#space();
    if (this.#index !== this.#source.length) refuse("INVALID_JSON");
    return result;
  }

  #space(): void {
    while (this.#index < this.#source.length && /[\t\n\r ]/u.test(this.#source[this.#index]!)) this.#index += 1;
  }

  #value(depth: number): ParsedJson {
    checkpoint(this.#guard, true);
    if (depth > this.#guard.limits.maxJsonDepth) refuse("JSON_DEPTH_LIMIT");
    const char = this.#source[this.#index];
    if (char === "{") return this.#object(depth);
    if (char === "[") return this.#array(depth);
    if (char === '"') return this.#string();
    if (char === "t" && this.#take("true")) return true;
    if (char === "f" && this.#take("false")) return false;
    if (char === "n" && this.#take("null")) return null;
    return this.#number();
  }

  #take(token: string): boolean {
    if (!this.#source.startsWith(token, this.#index)) return false;
    this.#index += token.length;
    return true;
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const code = this.#source.charCodeAt(this.#index);
      if (code === 0x22) {
        this.#index += 1;
        try {
          const value = JSON.parse(this.#source.slice(start, this.#index)) as string;
          if (/\p{Cs}/u.test(value)) refuse("INVALID_JSON");
          return value;
        } catch (error) {
          if (error instanceof OpenApiRefusal) throw error;
          return refuse("INVALID_JSON");
        }
      }
      if (code < 0x20) refuse("INVALID_JSON");
      if (code === 0x5c) {
        this.#index += 1;
        const escaped = this.#source[this.#index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.#source.slice(this.#index + 1, this.#index + 5))) refuse("INVALID_JSON");
          this.#index += 5;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) refuse("INVALID_JSON");
      }
      this.#index += 1;
    }
    return refuse("INVALID_JSON");
  }

  #number(): number {
    const rest = this.#source.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest);
    if (!match) return refuse("INVALID_JSON");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) refuse("INVALID_JSON");
    return Object.is(value, -0) ? 0 : value;
  }

  #entry(): void {
    this.#guard.containerEntries += 1;
    if (this.#guard.containerEntries > this.#guard.limits.maxContainerEntries) refuse("JSON_ENTRY_LIMIT");
  }

  #array(depth: number): readonly ParsedJson[] {
    this.#index += 1;
    this.#space();
    const result: ParsedJson[] = [];
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return Object.freeze(result);
    }
    while (true) {
      this.#entry();
      result.push(this.#value(depth + 1));
      this.#space();
      const char = this.#source[this.#index++];
      if (char === "]") return Object.freeze(result);
      if (char !== ",") refuse("INVALID_JSON");
      this.#space();
    }
  }

  #object(depth: number): ParsedJsonObject {
    this.#index += 1;
    this.#space();
    const result = Object.create(null) as Record<string, ParsedJson>;
    const keys = new Set<string>();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return Object.freeze(result);
    }
    while (true) {
      if (this.#source[this.#index] !== '"') refuse("INVALID_JSON");
      const key = this.#string().normalize("NFC");
      if (keys.has(key)) refuse("DUPLICATE_JSON_KEY");
      keys.add(key);
      this.#space();
      if (this.#source[this.#index++] !== ":") refuse("INVALID_JSON");
      this.#space();
      this.#entry();
      Object.defineProperty(result, key, {
        value: this.#value(depth + 1), enumerable: true, writable: false, configurable: false,
      });
      this.#space();
      const char = this.#source[this.#index++];
      if (char === "}") return Object.freeze(result);
      if (char !== ",") refuse("INVALID_JSON");
      this.#space();
    }
  }
}

export function parseBoundedJson(source: string | Uint8Array, guard: OpenApiCompileGuard): ParsedJson {
  return new JsonParser(decodedSource(source, guard), guard).parse();
}

export function jsonObject(value: ParsedJson, code: OpenApiFailureCode = "OPENAPI_STRUCTURE_REFUSED"): ParsedJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value as ParsedJsonObject;
}

export function jsonArray(value: ParsedJson | undefined, code: OpenApiFailureCode = "OPENAPI_STRUCTURE_REFUSED"): readonly ParsedJson[] {
  if (!Array.isArray(value)) refuse(code);
  return value;
}

export function boundedText(value: ParsedJson | undefined, code: OpenApiFailureCode, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value) ||
      new TextEncoder().encode(value).byteLength > maximum) refuse(code);
  return value.normalize("NFC");
}
