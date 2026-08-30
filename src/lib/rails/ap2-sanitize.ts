import type { Ap2SanitizedJson } from "@/lib/db/repo";

const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_COLLECTION_ITEMS = 256;
const DEFAULT_MAX_STRING_BYTES = 32 * 1024;
const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "password",
  "passphrase",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "paymentsignature",
  "xpayment",
  "checkoutjwt",
  "checkoutmandate",
  "paymentmandate",
  "disclosure",
  "disclosures",
  "riskdata",
]);

export class Ap2ProjectionError extends Error {
  constructor() {
    super("AP2 response projection exceeded its safe persistence contract");
    this.name = "Ap2ProjectionError";
  }
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function sensitiveString(value: string): boolean {
  return /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/u.test(value)
    || value.length > 256 && value.includes("~")
      && /(?:^|~)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:~|$)/u.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeAp2Json(
  value: unknown,
  limits: {
    readonly maxBytes?: number;
    readonly maxDepth?: number;
    readonly maxCollectionItems?: number;
    readonly maxStringBytes?: number;
  } = {},
): Ap2SanitizedJson {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCollectionItems = limits.maxCollectionItems ?? DEFAULT_MAX_COLLECTION_ITEMS;
  const maxStringBytes = limits.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number, key?: string): Ap2SanitizedJson => {
    if (depth > maxDepth) throw new Ap2ProjectionError();
    if (key && SENSITIVE_KEYS.has(normalizedKey(key))) return REDACTED;
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Ap2ProjectionError();
      return candidate;
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > maxStringBytes) throw new Ap2ProjectionError();
      return sensitiveString(candidate) ? REDACTED : candidate;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > maxCollectionItems || seen.has(candidate)) {
        throw new Ap2ProjectionError();
      }
      seen.add(candidate);
      const result = candidate.map((item) => visit(item, depth + 1));
      seen.delete(candidate);
      return result;
    }
    if (!plainObject(candidate) || seen.has(candidate)) throw new Ap2ProjectionError();
    const entries = Object.entries(candidate);
    if (entries.length > maxCollectionItems) throw new Ap2ProjectionError();
    seen.add(candidate);
    const result: { [key: string]: Ap2SanitizedJson } = {};
    for (const [childKey, child] of entries) {
      if (childKey === "__proto__" || childKey === "constructor" || childKey === "prototype") {
        throw new Ap2ProjectionError();
      }
      result[childKey] = visit(child, depth + 1, childKey);
    }
    seen.delete(candidate);
    return result;
  };

  const sanitized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > maxBytes) {
    throw new Ap2ProjectionError();
  }
  return sanitized;
}
