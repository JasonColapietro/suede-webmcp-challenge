/**
 * Guards for the cookie-authenticated spend route.
 *
 * These live here, pure and injectable, rather than inside the route handler
 * because this repo does not import route handlers into vitest — a guard that
 * existed only in the handler would ship untested. The route stays a thin
 * wiring layer over `guardBuyRequest`.
 *
 * Four guards, in the order a hostile request meets them:
 *
 *  1. Same-origin mutation headers, delegated to the shared
 *     validateMutationHeaders. NOT isOriginAllowed: that helper deliberately
 *     returns true for a null, empty, or literal "null" Origin because MCP
 *     clients are overwhelmingly non-browser and send none. Correct there, and
 *     a no-op against the browser CSRF class THIS route faces.
 *  2. A rate limit keyed on things the CALLER CANNOT MINT. The first version
 *     keyed on the resolved owner id, which made it a no-op: middleware falls
 *     back to `crypto.randomUUID()` when no agx_owner cookie is present, so a
 *     cookie-less caller drew a brand-new bucket on every request, and could
 *     also just supply its own id. Key on the request IP (Vercel overwrites
 *     x-real-ip) and on the target slug instead.
 *
 *     The reason it matters is NOT free inference — an earlier note here said
 *     that and was wrong. `acceptsPayment` requires priceUsdc > 0, so a free
 *     agent can never pass buyability on this route. The real exposure is
 *     database amplification: every request runs eligibleEntries(), which
 *     issues two uncached queries PER catalog entry, so one unthrottled caller
 *     multiplies into tens of queries per request.
 *  3. The price echo, compared against a freshly read server-side price. This
 *     is a UX guard against a stale quote, NOT the authoritative price check —
 *     the server-side read is.
 *  4. Buyability, read back from the server's own projection and never
 *     recomputed here.
 */
import { validateMutationHeaders } from "@/lib/runtime/api-contract";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Per-source ceiling. Tight, because a browser buying agent makes one purchase
 * at a time and anything faster is not a person shopping.
 */
export const BUY_IP_LIMIT = { capacity: 5, refillPerSec: 0.2 } as const;

/**
 * Per-target ceiling, bounding one agent across many sources. Looser than the
 * per-IP bucket: a genuinely popular service should not be throttled because
 * several buyers arrive at once.
 */
export const BUY_SLUG_LIMIT = { capacity: 60, refillPerSec: 1 } as const;

/**
 * Bucket keys for one buy attempt.
 *
 * Deliberately exported and unit-tested. The first version built these inline
 * in the route handler while this module took `rateLimitAllowed` as a plain
 * input — so the module's own argument for existing (guards in the handler
 * ship untested) did not cover the keying decision, and that is exactly the
 * gap the no-op limiter fell through.
 */
export function buyRateLimitKeys(ip: string, slug: string): readonly [string, string] {
  return [`webmcp-buy:ip:${ip}`, `webmcp-buy:slug:${slug}`];
}

export type BuyGuardVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 403 | 409 | 415 | 429;
      readonly error: string;
      readonly retryAfterSec?: number;
    };

/** USDC carries six decimals; compare at that precision, never with ===. */
export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** True when the echoed price is the listed price to USDC precision. */
export function priceEchoMatches(listed: number, confirmed: number): boolean {
  return (
    Number.isFinite(listed) &&
    Number.isFinite(confirmed) &&
    round6(listed) === round6(confirmed)
  );
}

/** The refusing half of a verdict, so callers can read `error` without narrowing. */
export type BuyRefusal = Extract<BuyGuardVerdict, { readonly ok: false }>;

/**
 * Both buckets for one attempt, checked before any expensive work.
 *
 * Returns a 429 refusal naming the wait, or null to proceed.
 */
export function checkBuyRateLimits(
  ip: string,
  slug: string,
  nowMs: number = Date.now(),
): BuyRefusal | null {
  const [ipKey, slugKey] = buyRateLimitKeys(ip, slug);
  const perIp = checkRateLimit(ipKey, BUY_IP_LIMIT, nowMs);
  const perSlug = perIp.allowed
    ? checkRateLimit(slugKey, BUY_SLUG_LIMIT, nowMs)
    : { allowed: true, retryAfterSec: 0 };
  if (perIp.allowed && perSlug.allowed) return null;
  return {
    ok: false,
    status: 429,
    error: "too many requests",
    retryAfterSec: Math.max(perIp.retryAfterSec, perSlug.retryAfterSec),
  };
}

export interface BuyGuardInput {
  readonly request: Request;
  /** Freshly read server-side price. Never the client's cached copy. */
  readonly listedPriceUsdc: number;
  /** The price the calling agent echoed back. */
  readonly confirmedPriceUsdc: number;
  /** The server's own buyability verdict for this entry. */
  readonly buyable: boolean;
}

export function guardBuyRequest(input: BuyGuardInput): BuyGuardVerdict {
  const headerFailure = validateMutationHeaders(input.request);
  if (headerFailure !== null) {
    return {
      ok: false,
      status: headerFailure,
      error: headerFailure === 403 ? "forbidden" : "unsupported media type",
    };
  }

  if (!input.buyable) {
    // Name the slug and the alternative: an agent that lands here has done
    // nothing wrong, and previously got less to work with than a typo does.
    return {
      ok: false,
      status: 409,
      error:
        "this service is not accepting paid calls right now; call preview_service " +
        "for a free dry-run, or find_services for one that is buyable",
    };
  }

  if (!priceEchoMatches(input.listedPriceUsdc, input.confirmedPriceUsdc)) {
    // Fail closed: a price that moved between discovery and purchase must
    // refuse rather than charge the agent an amount it never agreed to.
    return {
      ok: false,
      status: 409,
      error: `price has changed: listed ${round6(input.listedPriceUsdc)} USDC per call`,
    };
  }

  return { ok: true };
}
