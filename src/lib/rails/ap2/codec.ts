import { createHash } from "node:crypto";

import type { JWTPayload, ProtectedHeaderParameters } from "jose";

import { Ap2ProtocolError } from "./types";

const DEFAULT_MAX_PRESENTATION_BYTES = 65_536;
const DEFAULT_MAX_CHAIN_SEGMENTS = 2;
const DEFAULT_MAX_DISCLOSURES = 32;
const DEFAULT_MAX_DISCLOSURE_BYTES = 4_096;
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export interface ParsedSdJwtSegment {
  readonly issuerJwt: string;
  readonly disclosures: readonly string[];
  readonly canonicalSdJwt: string;
  readonly protectedHeader: ProtectedHeaderParameters;
  readonly jwtPayload: JWTPayload;
  readonly resolvedPayload: Readonly<Record<string, unknown>>;
  readonly effectivePayload: Readonly<Record<string, unknown>>;
}

export interface ParsedSdJwtPresentation {
  readonly segments: readonly ParsedSdJwtSegment[];
}

export interface SdJwtParseLimits {
  readonly maxPresentationBytes?: number;
  readonly maxChainSegments?: number;
  readonly maxDisclosures?: number;
  readonly maxDisclosureBytes?: number;
}

function fail(): never {
  throw new Ap2ProtocolError("invalid_credential");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        if (FORBIDDEN_PROPERTY_NAMES.has(key) || value[key] === undefined) {
          throw new TypeError("Unsupported JSON object property");
        }
        return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Value is not canonical JSON");
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Base64Url(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function buildAp2RequestDigest(input: {
  readonly method: "POST";
  readonly resource: string;
  readonly body: unknown;
}): string {
  return sha256Base64Url(canonicalizeJson({
    body: input.body,
    method: input.method,
    resource: input.resource,
  }));
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) fail();
  try {
    const decoded: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!isPlainRecord(decoded)) fail();
    return decoded;
  } catch {
    return fail();
  }
}

function digestForDisclosure(disclosure: string, algorithm: unknown): string {
  const nodeAlgorithm = algorithm === undefined || algorithm === "sha-256"
    ? "sha256"
    : algorithm === "sha-384"
      ? "sha384"
      : algorithm === "sha-512"
        ? "sha512"
        : null;
  if (!nodeAlgorithm) fail();
  return createHash(nodeAlgorithm).update(disclosure, "ascii").digest("base64url");
}

interface DecodedDisclosure {
  readonly encoded: string;
  readonly digest: string;
  readonly name?: string;
  readonly value: unknown;
}

function decodeDisclosure(
  encoded: string,
  algorithm: unknown,
  maxBytes: number,
): DecodedDisclosure {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || Buffer.byteLength(encoded, "utf8") > maxBytes) {
    fail();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return fail();
  }
  if (!Array.isArray(decoded) || (decoded.length !== 2 && decoded.length !== 3)) fail();
  const [salt] = decoded;
  if (typeof salt !== "string" || salt.length < 16 || salt.length > 256) fail();
  if (decoded.length === 3) {
    const name = decoded[1];
    if (typeof name !== "string" || !name || FORBIDDEN_PROPERTY_NAMES.has(name)) fail();
    return {
      encoded,
      digest: digestForDisclosure(encoded, algorithm),
      name,
      value: decoded[2],
    };
  }
  return {
    encoded,
    digest: digestForDisclosure(encoded, algorithm),
    value: decoded[1],
  };
}

function resolveSelectiveDisclosures(
  payload: Record<string, unknown>,
  disclosures: readonly DecodedDisclosure[],
): Record<string, unknown> {
  const byDigest = new Map<string, DecodedDisclosure>();
  for (const disclosure of disclosures) {
    if (byDigest.has(disclosure.digest)) fail();
    byDigest.set(disclosure.digest, disclosure);
  }
  const consumed = new Set<string>();

  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        if (typeof item === "string" && byDigest.has(item)) {
          const disclosure = byDigest.get(item);
          if (!disclosure) fail();
          consumed.add(item);
          result.push(resolve(disclosure.value));
          continue;
        }
        if (isPlainRecord(item) && Object.keys(item).length === 1 && "..." in item) {
          const digest = item["..."];
          if (typeof digest !== "string") fail();
          const disclosure = byDigest.get(digest);
          if (!disclosure) continue;
          if (disclosure.name !== undefined) fail();
          consumed.add(digest);
          result.push(resolve(disclosure.value));
          continue;
        }
        result.push(resolve(item));
      }
      return result;
    }
    if (!isPlainRecord(value)) return value;

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "_sd") continue;
      if (FORBIDDEN_PROPERTY_NAMES.has(key)) fail();
      result[key] = resolve(child);
    }
    const digests = value._sd;
    if (digests !== undefined) {
      if (!Array.isArray(digests) || !digests.every((digest) => typeof digest === "string")) {
        fail();
      }
      for (const digest of digests) {
        const disclosure = byDigest.get(digest);
        if (!disclosure) continue;
        if (disclosure.name === undefined || disclosure.name in result) fail();
        consumed.add(digest);
        result[disclosure.name] = resolve(disclosure.value);
      }
    }
    return result;
  };

  const resolved = resolve(payload);
  if (!isPlainRecord(resolved) || consumed.size !== disclosures.length) fail();
  return resolved;
}

function effectivePayload(resolved: Record<string, unknown>): Record<string, unknown> {
  const delegated = resolved.delegate_payload;
  if (delegated === undefined) return resolved;
  if (!Array.isArray(delegated) || delegated.length !== 1 || !isPlainRecord(delegated[0])) {
    fail();
  }
  return delegated[0];
}

function parseSegment(
  rawSegment: string,
  index: number,
  segmentCount: number,
  limits: Required<SdJwtParseLimits>,
): ParsedSdJwtSegment {
  let segment = rawSegment;
  // The dSD-JWT chain delimiter consumes the root SD-JWT's trailing `~`.
  // Restore it even when that root already contains selective disclosures.
  if (index < segmentCount - 1 && !segment.endsWith("~")) segment = `${segment}~`;
  if (!segment.endsWith("~") || segment.startsWith("~")) fail();
  const parts = segment.split("~");
  const issuerJwt = parts[0];
  const disclosures = parts.slice(1, -1);
  if (!issuerJwt || disclosures.length > limits.maxDisclosures) fail();
  const jwtParts = issuerJwt.split(".");
  if (jwtParts.length !== 3 || jwtParts.some((part) => !part)) fail();
  const protectedHeader = decodeJsonSegment(jwtParts[0]);
  const jwtPayload = decodeJsonSegment(jwtParts[1]);
  const decodedDisclosures = disclosures.map((disclosure) =>
    decodeDisclosure(disclosure, jwtPayload._sd_alg, limits.maxDisclosureBytes));
  const resolvedPayload = resolveSelectiveDisclosures(jwtPayload, decodedDisclosures);
  const canonicalSdJwt = `${issuerJwt}~${disclosures.length ? `${disclosures.join("~")}~` : ""}`;
  return {
    issuerJwt,
    disclosures,
    canonicalSdJwt,
    protectedHeader,
    jwtPayload,
    resolvedPayload,
    effectivePayload: effectivePayload(resolvedPayload),
  };
}

export function parseSdJwtPresentation(
  presentation: string,
  customLimits: SdJwtParseLimits = {},
): ParsedSdJwtPresentation {
  const limits: Required<SdJwtParseLimits> = {
    maxPresentationBytes: customLimits.maxPresentationBytes ?? DEFAULT_MAX_PRESENTATION_BYTES,
    maxChainSegments: customLimits.maxChainSegments ?? DEFAULT_MAX_CHAIN_SEGMENTS,
    maxDisclosures: customLimits.maxDisclosures ?? DEFAULT_MAX_DISCLOSURES,
    maxDisclosureBytes: customLimits.maxDisclosureBytes ?? DEFAULT_MAX_DISCLOSURE_BYTES,
  };
  if (
    !presentation
    || Buffer.byteLength(presentation, "utf8") > limits.maxPresentationBytes
    || presentation.includes("\0")
  ) fail();
  const rawSegments = presentation.split("~~");
  if (
    rawSegments.length < 1
    || rawSegments.length > limits.maxChainSegments
    || rawSegments.some((segment) => !segment)
  ) fail();
  return {
    segments: rawSegments.map((segment, index) =>
      parseSegment(segment, index, rawSegments.length, limits)),
  };
}

export function finalMandateReference(presentation: string): string {
  const parsed = parseSdJwtPresentation(presentation);
  const final = parsed.segments.at(-1);
  if (!final) fail();
  return digestForDisclosure(final.canonicalSdJwt, final.jwtPayload._sd_alg);
}

/** Stable replay identity; unlike a Receipt reference, disclosures do not alter it. */
export function finalMandateReplayIdentity(presentation: string): string {
  const parsed = parseSdJwtPresentation(presentation);
  const final = parsed.segments.at(-1);
  if (!final) fail();
  return sha256Base64Url(final.issuerJwt);
}

export function rootSdJwtReference(
  presentation: string,
  algorithmOverride?: unknown,
): string {
  const parsed = parseSdJwtPresentation(presentation);
  const root = parsed.segments[0];
  if (!root) fail();
  const algorithm = arguments.length >= 2 ? algorithmOverride : root.jwtPayload._sd_alg;
  return digestForDisclosure(root.canonicalSdJwt, algorithm);
}
