export const TEST_ROUTE_ADMISSION_LIMITS = Object.freeze({
  ownerCapacity: 6,
  ownerRefillPerSec: 0.1,
  ipCapacity: 20,
  ipRefillPerSec: 0.5,
  ownerConcurrency: 2,
  globalConcurrency: 8,
  ownerKeyLimit: 256,
  ipKeyLimit: 256,
  keyTtlMs: 5 * 60 * 1_000,
  keyMaxBytes: 128,
} as const);

export type TestRouteHeaderResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 | 415 };

export type TestRouteAdmissionResult =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly retryAfterSec: number };

export interface TestRouteAdmissionSizes {
  readonly ownerKeys: number;
  readonly ipKeys: number;
  readonly activeOwners: number;
  readonly activeTotal: number;
}

export interface TestRouteAdmission {
  tryAcquire(input: {
    readonly ownerId: unknown;
    readonly ip: unknown;
  }): TestRouteAdmissionResult;
  sizes(): TestRouteAdmissionSizes;
}

export interface TestRouteAdmissionOptions {
  readonly now?: () => number;
}

interface Bucket {
  readonly tokens: number;
  readonly lastRefillMs: number;
  readonly lastSeenMs: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const TEXT_ENCODER = new TextEncoder();
const HEADER_FORBIDDEN = Object.freeze({ ok: false, status: 403 } as const);
const MEDIA_FORBIDDEN = Object.freeze({ ok: false, status: 415 } as const);
const HEADER_ALLOWED = Object.freeze({ ok: true } as const);
const GENERIC_RETRY = Object.freeze({ ok: false, retryAfterSec: 1 } as const);

/** Validate the browser-private request envelope without returning header values. */
export function validateTestRouteHeaders(request: Request): TestRouteHeaderResult {
  try {
    if (request.headers.has("authorization")) return HEADER_FORBIDDEN;
    const requestUrl = new URL(request.url);
    if ((requestUrl.protocol !== "https:" && requestUrl.protocol !== "http:") ||
        requestUrl.origin === "null" || request.headers.get("origin") !== requestUrl.origin) {
      return HEADER_FORBIDDEN;
    }
    if (request.headers.has("content-encoding")) return MEDIA_FORBIDDEN;
    const contentType = request.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    return contentType === "application/json" ? HEADER_ALLOWED : MEDIA_FORBIDDEN;
  } catch {
    return HEADER_FORBIDDEN;
  }
}

function boundedKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value ||
      CONTROL.test(value) || TEXT_ENCODER.encode(value).byteLength > TEST_ROUTE_ADMISSION_LIMITS.keyMaxBytes) {
    return null;
  }
  return value;
}

function validNow(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function purgeExpired(buckets: Map<string, Bucket>, nowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.lastSeenMs > TEST_ROUTE_ADMISSION_LIMITS.keyTtlMs) buckets.delete(key);
  }
}

function refill(
  current: Bucket | undefined,
  capacity: number,
  refillPerSec: number,
  nowMs: number,
): Bucket {
  if (!current) return { tokens: capacity, lastRefillMs: nowMs, lastSeenMs: nowMs };
  const elapsedSec = Math.max(0, (nowMs - current.lastRefillMs) / 1_000);
  return {
    tokens: Math.min(capacity, current.tokens + elapsedSec * refillPerSec),
    lastRefillMs: nowMs,
    lastSeenMs: nowMs,
  };
}

function storeLru(
  buckets: Map<string, Bucket>,
  key: string,
  bucket: Bucket,
  limit: number,
): void {
  if (buckets.has(key)) buckets.delete(key);
  while (buckets.size >= limit) {
    const oldest = buckets.keys().next();
    if (oldest.done) break;
    buckets.delete(oldest.value);
  }
  buckets.set(key, bucket);
}

function retryAfter(tokens: number, refillPerSec: number): number {
  return Math.max(1, Math.ceil((1 - tokens) / refillPerSec));
}

/** Create one bounded, process-local admission domain. Calls never queue. */
export function createTestRouteAdmission(
  options: TestRouteAdmissionOptions = {},
): TestRouteAdmission {
  const now = options.now ?? Date.now;
  const ownerBuckets = new Map<string, Bucket>();
  const ipBuckets = new Map<string, Bucket>();
  const activeByOwner = new Map<string, number>();
  let activeTotal = 0;

  return Object.freeze({
    tryAcquire(input: { readonly ownerId: unknown; readonly ip: unknown }): TestRouteAdmissionResult {
      const ownerId = boundedKey(input.ownerId);
      const ip = boundedKey(input.ip);
      let nowMs: number;
      try { nowMs = now(); } catch { return GENERIC_RETRY; }
      if (!ownerId || !ip || !validNow(nowMs)) return GENERIC_RETRY;

      purgeExpired(ownerBuckets, nowMs);
      purgeExpired(ipBuckets, nowMs);
      if ((activeByOwner.get(ownerId) ?? 0) >= TEST_ROUTE_ADMISSION_LIMITS.ownerConcurrency ||
          activeTotal >= TEST_ROUTE_ADMISSION_LIMITS.globalConcurrency) {
        return GENERIC_RETRY;
      }

      const owner = refill(
        ownerBuckets.get(ownerId),
        TEST_ROUTE_ADMISSION_LIMITS.ownerCapacity,
        TEST_ROUTE_ADMISSION_LIMITS.ownerRefillPerSec,
        nowMs,
      );
      const address = refill(
        ipBuckets.get(ip),
        TEST_ROUTE_ADMISSION_LIMITS.ipCapacity,
        TEST_ROUTE_ADMISSION_LIMITS.ipRefillPerSec,
        nowMs,
      );
      if (owner.tokens < 1 || address.tokens < 1) {
        const retryAfterSec = Math.max(
          owner.tokens < 1 ? retryAfter(owner.tokens, TEST_ROUTE_ADMISSION_LIMITS.ownerRefillPerSec) : 1,
          address.tokens < 1 ? retryAfter(address.tokens, TEST_ROUTE_ADMISSION_LIMITS.ipRefillPerSec) : 1,
        );
        return Object.freeze({ ok: false, retryAfterSec });
      }

      storeLru(ownerBuckets, ownerId, { ...owner, tokens: owner.tokens - 1 },
        TEST_ROUTE_ADMISSION_LIMITS.ownerKeyLimit);
      storeLru(ipBuckets, ip, { ...address, tokens: address.tokens - 1 },
        TEST_ROUTE_ADMISSION_LIMITS.ipKeyLimit);
      activeByOwner.set(ownerId, (activeByOwner.get(ownerId) ?? 0) + 1);
      activeTotal += 1;
      let released = false;
      return Object.freeze({
        ok: true as const,
        release(): void {
          if (released) return;
          released = true;
          const active = activeByOwner.get(ownerId) ?? 0;
          if (active <= 1) activeByOwner.delete(ownerId);
          else activeByOwner.set(ownerId, active - 1);
          activeTotal = Math.max(0, activeTotal - 1);
        },
      });
    },
    sizes(): TestRouteAdmissionSizes {
      return Object.freeze({
        ownerKeys: ownerBuckets.size,
        ipKeys: ipBuckets.size,
        activeOwners: activeByOwner.size,
        activeTotal,
      });
    },
  });
}
