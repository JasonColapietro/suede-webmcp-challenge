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
 *  2. A per-caller rate limit. Non-optional: callAgentTool treats a zero price
 *     as non-billable, and middleware mints an anonymous owner for every
 *     browser, so without a limiter this route would be an unmetered real
 *     inference endpoint for every free published agent.
 *  3. The price echo, compared against a freshly read server-side price. This
 *     is a UX guard against a stale quote, NOT the authoritative price check —
 *     the server-side read is.
 *  4. Buyability, read back from the server's own projection and never
 *     recomputed here.
 */
import { validateMutationHeaders } from "@/lib/runtime/api-contract";

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

export interface BuyGuardInput {
  readonly request: Request;
  /** Freshly read server-side price. Never the client's cached copy. */
  readonly listedPriceUsdc: number;
  /** The price the calling agent echoed back. */
  readonly confirmedPriceUsdc: number;
  /** The server's own buyability verdict for this entry. */
  readonly buyable: boolean;
  readonly rateLimitAllowed: boolean;
  readonly retryAfterSec: number;
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

  if (!input.rateLimitAllowed) {
    return {
      ok: false,
      status: 429,
      error: "too many requests",
      retryAfterSec: input.retryAfterSec,
    };
  }

  if (!input.buyable) {
    return { ok: false, status: 409, error: "this service is not accepting paid calls" };
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
