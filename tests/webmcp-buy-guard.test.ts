/**
 * Guards for the cookie-authenticated spend route.
 *
 * This is the route that widens authority — a same-origin session replaces a
 * bearer secret — so every refusal path is pinned here rather than left to the
 * handler, which vitest does not import.
 */
import { describe, it, expect } from "vitest";
import {
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
    rateLimitAllowed: true,
    retryAfterSec: 0,
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

describe("rate limiting", () => {
  it("refuses once the caller's bucket is empty, and says when to retry", () => {
    // Non-optional: a zero-price agent is non-billable, so without this the
    // route is unmetered inference for any browser.
    const verdict = guardBuyRequest(input({ rateLimitAllowed: false, retryAfterSec: 7 }));
    expect(verdict).toMatchObject({ ok: false, status: 429, retryAfterSec: 7 });
  });

  it("is checked before the price echo, so a hot loop cannot probe prices", () => {
    const verdict = guardBuyRequest(
      input({ rateLimitAllowed: false, retryAfterSec: 3, confirmedPriceUsdc: 999 }),
    );
    expect(verdict).toMatchObject({ status: 429 });
  });
});

describe("buyability", () => {
  it("refuses when the server's own projection says it is not payable", () => {
    expect(guardBuyRequest(input({ buyable: false }))).toMatchObject({ ok: false, status: 409 });
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
