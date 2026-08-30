/**
 * Guards for the cookie-authenticated spend route.
 *
 * This is the route that widens authority — a same-origin session replaces a
 * bearer secret — so every refusal path is pinned here rather than left to the
 * handler, which vitest does not import.
 */
import { describe, it, expect } from "vitest";
import {
  BUY_IP_LIMIT,
  buyRateLimitKeys,
  checkBuyRateLimits,
  guardBuyRequest,
  priceEchoMatches,
  round6,
  type BuyGuardInput,
} from "@/lib/webmcp/buy-guard";

const ORIGIN = "https://agents.suedeai.ai";
const URL_ = `${ORIGIN}/api/webmcp/buy`;

function request(headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
  });
}

function input(over: Partial<BuyGuardInput> = {}): BuyGuardInput {
  return {
    request: request(),
    listedPriceUsdc: 2,
    confirmedPriceUsdc: 2,
    buyable: true,
    ...over,
  };
}

describe("same-origin mutation headers", () => {
  it("accepts a well-formed same-origin JSON request", () => {
    expect(guardBuyRequest(input())).toEqual({ ok: true });
  });

  it("refuses a request carrying an Authorization header", () => {
    // A bearer secret belongs on /api/mcp, not on the cookie-session route.
    const verdict = guardBuyRequest(input({ request: request({ authorization: "Bearer x" }) }));
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a cross-origin request", () => {
    const verdict = guardBuyRequest(input({ request: request({ origin: "https://evil.example" }) }));
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses an ABSENT Origin rather than treating it as same-origin", () => {
    // This is the exact case isOriginAllowed() lets through for non-browser MCP
    // clients, and the reason that helper is not reused on this route.
    const bare = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(guardBuyRequest(input({ request: bare }))).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a non-JSON content type", () => {
    const verdict = guardBuyRequest(
      input({ request: request({ "content-type": "text/plain" }) }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 415 });
  });

  it("refuses an encoded body", () => {
    const verdict = guardBuyRequest(
      input({ request: request({ "content-encoding": "gzip" }) }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 415 });
  });
});

describe("rate limit keying", () => {
  /*
   * These are the tests that were missing. The original limiter keyed on the
   * resolved owner id, which middleware mints fresh (crypto.randomUUID) for any
   * caller without an agx_owner cookie — so every request drew a new bucket and
   * the limit was never reached. The keying decision lived in the route
   * handler, which vitest does not import, so nothing caught it.
   */
  it("keys on the request IP and the target slug, never on caller-supplied identity", () => {
    const [ipKey, slugKey] = buyRateLimitKeys("203.0.113.7", "contract-review");
    expect(ipKey).toBe("webmcp-buy:ip:203.0.113.7");
    expect(slugKey).toBe("webmcp-buy:slug:contract-review");
    expect(ipKey).not.toContain("owner");
  });

  it("does NOT reset when a caller rotates its identity", () => {
    // The exact exploit: a fresh owner id per request used to mean a fresh
    // bucket. Keying on IP means rotating identity changes nothing.
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const now = 9_000_000;
    let refused = 0;
    for (let i = 0; i < BUY_IP_LIMIT.capacity + 5; i += 1) {
      // A different slug each time also must not open a new per-IP bucket.
      if (checkBuyRateLimits(ip, `slug-${i}`, now) !== null) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("bounds one target across many source IPs", () => {
    const slug = `hot-${Math.random().toString(36).slice(2)}`;
    const now = 9_100_000;
    let refused = 0;
    for (let i = 0; i < 80; i += 1) {
      if (checkBuyRateLimits(`10.0.${Math.floor(i / 250)}.${i % 250}`, slug, now) !== null) {
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("names the wait when it refuses", () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const now = 9_200_000;
    for (let i = 0; i < BUY_IP_LIMIT.capacity; i += 1) checkBuyRateLimits(ip, "s", now);
    const verdict = checkBuyRateLimits(ip, "s", now);
    expect(verdict).toMatchObject({ ok: false, status: 429 });
    expect(verdict !== null && verdict.ok === false && verdict.retryAfterSec).toBeGreaterThan(0);
  });

  it("lets a first-time caller through", () => {
    expect(checkBuyRateLimits(`172.16.0.${Math.floor(Math.random() * 200) + 1}`, "fresh", 9_300_000))
      .toBeNull();
  });
});

describe("buyability", () => {
  it("refuses when the server's own projection says it is not payable", () => {
    const verdict = guardBuyRequest(input({ buyable: false }));
    expect(verdict).toMatchObject({ ok: false, status: 409 });
    // Half the live shelf is preview-only, so this path is common and must be
    // at least as actionable as a typo.
    expect(verdict.ok === false && verdict.error).toContain("preview_service");
  });
});

describe("price echo", () => {
  it("refuses a stale quote instead of charging the new price", () => {
    const verdict = guardBuyRequest(input({ listedPriceUsdc: 5, confirmedPriceUsdc: 2 }));
    expect(verdict).toMatchObject({ ok: false, status: 409 });
    expect(verdict.ok === false && verdict.error).toContain("5");
  });

  it("compares at USDC precision rather than by identity", () => {
    expect(priceEchoMatches(0.1 + 0.2, 0.3)).toBe(true);
    expect(round6(2.00000049)).toBe(2);
  });

  it("refuses a non-finite echo", () => {
    expect(priceEchoMatches(2, Number.NaN)).toBe(false);
    expect(priceEchoMatches(2, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("accepts a free service echoed as zero", () => {
    expect(
      guardBuyRequest(input({ listedPriceUsdc: 0, confirmedPriceUsdc: 0 })),
    ).toEqual({ ok: true });
  });
});
