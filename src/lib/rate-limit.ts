/**
 * In-memory per-key token-bucket rate limiter.
 *
 * NOTE: This implementation uses a module-level Map for state, which means:
 * - State is shared across all requests within a single Node.js process instance.
 * - State resets on cold start (new serverless instance spin-up). This is acceptable
 *   for abuse mitigation — it means limits are per-instance, not globally coordinated.
 *   For a globally coordinated rate limiter, use Redis or an edge KV store instead.
 *
 * Token bucket algorithm:
 * - Each key starts with `capacity` tokens.
 * - Tokens refill at `refillPerSec` per second (continuous refill, computed lazily on
 *   each check from elapsed wall time).
 * - Each request consumes 1 token. If the bucket is empty the request is rejected.
 */

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

export interface RateLimitOptions {
  capacity?: number;
  refillPerSec?: number;
}

/** Defaults: 10-request burst, refills 1 token every 2 seconds (0.5 req/s). */
const DEFAULT_CAPACITY = 10;
const DEFAULT_REFILL_PER_SEC = 0.5;

/** Per-map cap and idle expiry keep attacker-controlled keys memory-bounded. */
export const RATE_LIMIT_STATE_MAX_ENTRIES = 4_096;
export const RATE_LIMIT_STATE_TTL_MS = 6 * 60 * 60 * 1_000;

const buckets = new Map<string, BucketState>();

function bucketFromBoundedState(
  state: Map<string, BucketState>,
  key: string,
  capacity: number,
  nowMs: number,
): BucketState {
  let bucket = state.get(key);
  if (bucket && nowMs - bucket.lastSeenMs > RATE_LIMIT_STATE_TTL_MS) {
    state.delete(key);
    bucket = undefined;
  }

  if (!bucket) {
    while (state.size > 0) {
      const oldest = state.entries().next().value as [string, BucketState] | undefined;
      if (!oldest) break;
      const [oldestKey, oldestBucket] = oldest;
      const expired = nowMs - oldestBucket.lastSeenMs > RATE_LIMIT_STATE_TTL_MS;
      if (!expired && state.size < RATE_LIMIT_STATE_MAX_ENTRIES) break;
      state.delete(oldestKey);
    }
    bucket = { tokens: capacity, lastRefillMs: nowMs, lastSeenMs: nowMs };
  } else {
    state.delete(key);
    bucket.lastSeenMs = nowMs;
  }
  state.set(key, bucket);
  return bucket;
}

/**
 * Check whether `key` is within its rate limit.
 * Consumes one token if allowed.
 *
 * @param key                - Opaque rate-limit key (e.g. "run:<ip>").
 * @param opts.capacity      - Maximum burst size (default 10).
 * @param opts.refillPerSec  - Token refill rate per second (default 0.5).
 * @param nowMs              - Overridable clock in ms-since-epoch (defaults to Date.now()).
 *                             Exposed so tests can inject a deterministic clock without sleeping.
 */
export function checkRateLimit(
  key: string,
  opts: RateLimitOptions = {},
  nowMs: number = Date.now(),
): RateLimitResult {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const refillPerSec = opts.refillPerSec ?? DEFAULT_REFILL_PER_SEC;

  const bucket = bucketFromBoundedState(buckets, key, capacity, nowMs);

  // Refill tokens based on elapsed time.
  const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
  bucket.lastRefillMs = nowMs;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  // How many seconds until the next token is available.
  const tokensNeeded = 1 - bucket.tokens;
  const retryAfterSec = Math.ceil(tokensNeeded / refillPerSec);
  return { allowed: false, retryAfterSec };
}

/**
 * Extract the client IP from a Request.
 *
 * Prefers `x-real-ip` (Vercel sets this to the real connecting IP and overwrites
 * any client-supplied value — harder to spoof than `x-forwarded-for`, whose
 * first hop a client can prepend), then falls back to the first hop of
 * `x-forwarded-for`, then "unknown".
 *
 * NOTE: IP attribution is best-effort. It is a meaningful abuse speed-bump on
 * Vercel but not a hard identity — callers that depend on it (per-IP limits)
 * must remain best-effort mitigations, not the sole security boundary.
 */
export function ipFromRequest(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Variable-cost token budget
// ---------------------------------------------------------------------------

/**
 * A continuously-refilling token *budget* keyed by an opaque string.
 *
 * Unlike checkRateLimit (which consumes exactly 1 token per call for
 * request-rate limiting), this supports variable-cost charges — used for per-IP
 * daily token budgets where each call's cost (LLM tokens consumed) is only known
 * after the call completes. The usage pattern is peek-then-charge:
 *   1. peekTokenBudget(...) before the call — reject when nothing is left.
 *   2. chargeTokenBudget(..., actualTokens) after the call.
 *
 * Same module-level / per-instance caveats as checkRateLimit apply (see top of
 * file): state is per Node.js process and resets on cold start.
 */

export interface TokenBudgetOptions {
  /** Total tokens available across a full window (e.g. one day). */
  capacity: number;
  /** Refill rate in tokens/sec. Defaults to a full `capacity` per 24h. */
  refillPerSec?: number;
}

const SECONDS_PER_DAY = 86_400;
const tokenBudgets = new Map<string, BucketState>();

function refillBudget(key: string, opts: TokenBudgetOptions, nowMs: number): BucketState {
  const { capacity } = opts;
  const refillPerSec = opts.refillPerSec ?? capacity / SECONDS_PER_DAY;

  const bucket = bucketFromBoundedState(tokenBudgets, key, capacity, nowMs);

  const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
  bucket.lastRefillMs = nowMs;
  return bucket;
}

/** Remaining budget for `key` after a lazy refill. Does not consume. */
export function peekTokenBudget(
  key: string,
  opts: TokenBudgetOptions,
  nowMs: number = Date.now(),
): { remaining: number } {
  const bucket = refillBudget(key, opts, nowMs);
  return { remaining: bucket.tokens };
}

/**
 * Charge `amount` tokens against `key`'s budget (lazily refilled first).
 *
 * The bucket floors at `-capacity` so a single over-budget charge can lock the
 * key out for at most ~one full window, never indefinitely. Negative or NaN
 * amounts are clamped to 0 (no-op).
 */
export function chargeTokenBudget(
  key: string,
  amount: number,
  opts: TokenBudgetOptions,
  nowMs: number = Date.now(),
): void {
  const bucket = refillBudget(key, opts, nowMs);
  const charge = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  bucket.tokens = Math.max(-opts.capacity, bucket.tokens - charge);
}
