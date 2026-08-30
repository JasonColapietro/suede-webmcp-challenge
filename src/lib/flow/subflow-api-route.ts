import { createHash } from "node:crypto";
import { UnauthenticatedOwnerError } from "@/lib/auth";
import { privateJson } from "@/lib/projects/api-response";
import { SubflowApiStoreUnavailableError } from "./subflow-api";

export class InvalidSubflowApiRequestError extends Error {}

function rawQueryComponentHasValidUtf8(component: string): boolean {
  const bytes: number[] = [];
  for (let index = 0; index < component.length; index += 1) {
    if (component[index] === "%") {
      const encoded = component.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(encoded)) return false;
      bytes.push(Number.parseInt(encoded, 16));
      index += 2;
    } else {
      const code = component.charCodeAt(index);
      if (code > 0x7f) return false;
      bytes.push(code);
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    return true;
  } catch {
    return false;
  }
}

type CursorEndpoint = "candidates" | "versions" | "dependents";

function bindingHash(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function boundedCursorString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= 512;
}

function boundedCursorName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 &&
    Buffer.byteLength(value, "utf8") <= 200;
}

export function encodeSubflowCursor(input: {
  readonly endpoint: CursorEndpoint;
  readonly binding: readonly string[];
  readonly last: readonly (string | number)[];
}): string {
  return Buffer.from(JSON.stringify({
    e: input.endpoint,
    b: bindingHash(input.binding),
    l: input.last,
  }), "utf8").toString("base64url");
}

export function decodeSubflowCursor(
  value: string | undefined,
  endpoint: CursorEndpoint,
  binding: readonly string[],
): readonly (string | number)[] | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("cursor");
  let decoded: unknown;
  let decodedText: string;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("cursor");
    decodedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded = JSON.parse(decodedText);
  } catch {
    throw new Error("cursor");
  }
  if (
    decoded === null || typeof decoded !== "object" || Array.isArray(decoded) ||
    Object.keys(decoded).sort().join(",") !== "b,e,l"
  ) throw new Error("cursor");
  const record = decoded as { e?: unknown; b?: unknown; l?: unknown };
  if (record.e !== endpoint || record.b !== bindingHash(binding) || !Array.isArray(record.l)) {
    throw new Error("cursor");
  }
  const tuple = record.l;
  const valid = endpoint === "candidates"
    ? tuple.length === 2 && boundedCursorName(tuple[0]) && boundedCursorString(tuple[1])
    : endpoint === "versions"
      ? tuple.length === 2 && Number.isSafeInteger(tuple[0]) && Number(tuple[0]) > 0 &&
        boundedCursorString(tuple[1])
      : tuple.length === 1 && boundedCursorString(tuple[0]);
  if (!valid) throw new Error("cursor");
  if (decodedText !== JSON.stringify({ e: endpoint, b: bindingHash(binding), l: tuple })) {
    throw new Error("cursor");
  }
  return tuple as readonly (string | number)[];
}

export function strictSearchParams(request: Request, allowed: readonly string[]): URLSearchParams {
  const query = new URL(request.url).search;
  if (/%(?![0-9A-Fa-f]{2})/.test(query)) throw new InvalidSubflowApiRequestError();
  for (const pair of query.slice(1).split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const components = equals === -1
      ? [pair]
      : [pair.slice(0, equals), pair.slice(equals + 1)];
    for (const component of components) {
      if (!rawQueryComponentHasValidUtf8(component)) throw new InvalidSubflowApiRequestError();
    }
  }
  const params = new URL(request.url).searchParams;
  const allowedSet = new Set(allowed);
  for (const key of params.keys()) {
    if (!allowedSet.has(key) || params.getAll(key).length !== 1) {
      throw new InvalidSubflowApiRequestError();
    }
  }
  return params;
}

export function shallowOpaqueQueryId(request: Request, key: string): string {
  const value = new URL(request.url).searchParams.get(key);
  if (value === null || value.length < 1 || value.length > 512 || Buffer.byteLength(value, "utf8") > 512) {
    throw new InvalidSubflowApiRequestError();
  }
  return value;
}

export function requiredOpaqueQueryId(params: URLSearchParams, key: string): string {
  const value = params.get(key);
  if (value === null || value.length < 1 || value.length > 512 || Buffer.byteLength(value, "utf8") > 512) {
    throw new InvalidSubflowApiRequestError();
  }
  return value;
}

export function optionalCanonicalLimit(
  params: URLSearchParams,
  maximum: number,
  fallback: number,
): number {
  const value = params.get("limit");
  if (value === null) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new InvalidSubflowApiRequestError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum || String(parsed) !== value) {
    throw new InvalidSubflowApiRequestError();
  }
  return parsed;
}

export function optionalCursor(params: URLSearchParams): string | undefined {
  const value = params.get("cursor");
  if (value === null) return undefined;
  if (value.length < 1 || value.length > 2048) throw new InvalidSubflowApiRequestError();
  return value;
}

export function methodNotAllowed(allow: "GET" | "POST"): Response {
  return privateJson({ error: "method not allowed" }, 405, { Allow: allow });
}

export function subflowApiErrorResponse(error: unknown): Response {
  if (error instanceof UnauthenticatedOwnerError) {
    return privateJson({ error: "Authentication required" }, 401);
  }
  if (error instanceof InvalidSubflowApiRequestError ||
      (error instanceof Error && error.message === "cursor")) {
    return privateJson({ error: "invalid request" }, 400);
  }
  if (error instanceof SubflowApiStoreUnavailableError) {
    return privateJson({ error: "subflow store unavailable" }, 503);
  }
  return privateJson({ error: "internal server error" }, 500);
}
