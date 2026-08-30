/**
 * Middleware enforcement of the Google Play access-only runtime.
 *
 * Every assertion here is paired: the same path must 403 on the Play host and
 * behave normally on agents.suedeai.ai. A gate that blocks everywhere is not a
 * fix, it is an outage — the web and iOS builds keep the card top-up.
 */

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const PLAY_HOST = "android-agents.suedeai.ai";
const CANONICAL_HOST = "agents.suedeai.ai";

function request(
  host: string,
  pathname: string,
  method = "GET",
  headers: Readonly<Record<string, string>> = {},
): NextRequest {
  return new NextRequest(`https://${host}${pathname}`, {
    method,
    headers: { host, ...headers },
  });
}

const OWNER_A = "1c1f7a1e-0000-4000-8000-000000000001";
const OWNER_B = "1c1f7a1e-0000-4000-8000-000000000002";

function forwardedOwner(response: Response): string | null {
  return response.headers.get("x-middleware-request-x-owner-id");
}

const PAYMENT_PATHS = [
  "/api/gateway/topup",
  "/api/gateway/topup/stripe",
  "/api/gateway/topup/stripe/webhook",
];

const COMMERCE_DISCOVERY_PATHS = [
  "/.well-known/x402",
  "/.well-known/x402.json",
  "/.well-known/agent-card.json",
  "/.well-known/ai-plugin.json",
  "/api/catalog",
  "/api/services",
  "/api/mcp",
  "/llms.txt",
  "/openapi.json",
  "/api/agents/lead-qualifier/.well-known/x402",
  "/api/agents/lead-qualifier/run",
  "/api/agents/lead-qualifier/settlement",
];

describe("Play host: payment routes", () => {
  it.each(PAYMENT_PATHS)("403s %s", async (pathname) => {
    const response = middleware(request(PLAY_HOST, pathname, "POST"));
    expect(response.status).toBe(403);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(response.json()).resolves.toEqual({
      error: "Purchases are unavailable in this Google Play build.",
    });
  });

  it.each(PAYMENT_PATHS)("does not block %s on the canonical host", (pathname) => {
    const response = middleware(request(CANONICAL_HOST, pathname, "POST"));
    expect(response.status).toBe(200);
  });
});

describe("Play host: commerce discovery", () => {
  it.each(COMMERCE_DISCOVERY_PATHS)("403s %s", async (pathname) => {
    const response = middleware(request(PLAY_HOST, pathname));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Commerce discovery is unavailable in this Google Play build.",
    });
  });

  it.each(COMMERCE_DISCOVERY_PATHS)(
    "does not block %s on the canonical host",
    (pathname) => {
      expect(middleware(request(CANONICAL_HOST, pathname)).status).toBe(200);
    },
  );
});

describe("Play host: page allowlist", () => {
  it.each(["/flows", "/build/flow-1", "/runs", "/privacy", "/account-deletion"])(
    "serves %s",
    (pathname) => {
      expect(middleware(request(PLAY_HOST, pathname)).status).toBe(200);
    },
  );

  it.each(["/", "/pricing", "/a/lead-qualifier", "/docs/payments", "/x402-agent-builder"])(
    "redirects %s to the app home instead of rendering a purchase surface",
    (pathname) => {
      const response = middleware(request(PLAY_HOST, pathname));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`https://${PLAY_HOST}/flows`);
    },
  );

  it("serves the purchase pages normally on the canonical host", () => {
    for (const pathname of ["/", "/pricing", "/a/lead-qualifier", "/docs/payments"]) {
      expect(middleware(request(CANONICAL_HOST, pathname)).status).toBe(200);
    }
  });
});

describe("Play host: API deny-by-default", () => {
  it("403s an API route that is not on the allowlist", async () => {
    const response = middleware(request(PLAY_HOST, "/api/cron/tick"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This endpoint is unavailable in this Google Play build.",
    });
  });

  it("serves the owner-scoped builder APIs", () => {
    for (const pathname of ["/api/me", "/api/flows", "/api/v2/projects", "/api/gateway/llm"]) {
      expect(middleware(request(PLAY_HOST, pathname)).status).toBe(200);
    }
  });

  it.each([
    ["POST", "/api/v2/resources"],
    ["PATCH", "/api/v2/resources/resource-1"],
    ["DELETE", "/api/v2/resources/resource-1/sources/source-1"],
  ])("403s Resource Foundry mutation %s %s before the broad v2 allowlist", async (method, pathname) => {
    const response = middleware(request(PLAY_HOST, pathname, method));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This endpoint is unavailable in this Google Play build.",
    });
  });

  it("still permits Resource Foundry reads and unrelated v2 mutations", () => {
    expect(middleware(request(PLAY_HOST, "/api/v2/resources")).status).toBe(200);
    expect(middleware(request(PLAY_HOST, "/api/v2/resources/resource-1")).status).toBe(200);
    expect(middleware(request(PLAY_HOST, "/api/v2/projects", "POST")).status).toBe(200);
  });
});

describe("Play host: activation cannot be faked or escaped", () => {
  it("does not activate from a query flag on the canonical host", () => {
    const response = middleware(
      request(CANONICAL_HOST, "/api/gateway/topup/stripe?play_mode=1", "POST"),
    );
    expect(response.status).toBe(200);
  });

  it("strips purchase intent from a Play-host URL", () => {
    const response = middleware(request(PLAY_HOST, "/flows?tier=250&checkout=1"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`https://${PLAY_HOST}/flows`);
  });

  it("keeps every Play-host response out of search indexes", () => {
    expect(middleware(request(PLAY_HOST, "/flows")).headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow",
    );
    expect(
      middleware(request(CANONICAL_HOST, "/flows")).headers.get("X-Robots-Tag"),
    ).toBeNull();
  });
});

describe("owner identity middleware still works on both hosts", () => {
  it.each([PLAY_HOST, CANONICAL_HOST])("mints an owner cookie on %s", (host) => {
    const response = middleware(request(host, "/flows"));
    expect(response.cookies.get("agx_owner")?.value).toBeTruthy();
  });

  it("still leaves /api/me/claim to own its Set-Cookie", () => {
    const response = middleware(request(PLAY_HOST, "/api/me/claim", "POST"));
    expect(response.status).toBe(200);
    expect(response.cookies.get("agx_owner")).toBeUndefined();
  });

  it("lets a canonical cookie win over a different canonical header", () => {
    const response = middleware(request(CANONICAL_HOST, "/flows", "GET", {
      cookie: `agx_owner=${OWNER_A}`,
      "x-owner-id": OWNER_B,
    }));

    expect(forwardedOwner(response)).toBe(OWNER_A);
    expect(response.cookies.get("agx_owner")).toBeUndefined();
  });

  it("replaces an invalid cookie with a canonical programmatic header", () => {
    const response = middleware(request(CANONICAL_HOST, "/flows", "GET", {
      cookie: "agx_owner=not-a-workspace-key",
      "x-owner-id": OWNER_B,
    }));

    expect(forwardedOwner(response)).toBe(OWNER_B);
    expect(response.cookies.get("agx_owner")?.value).toBe(OWNER_B);
  });

  it.each(["not-a-workspace-key", OWNER_A.toUpperCase(), "1c1f7a1e-0000-1000-8000-000000000001"])(
    "replaces a non-canonical owner header %j with a fresh canonical UUIDv4",
    (candidate) => {
      const response = middleware(request(CANONICAL_HOST, "/flows", "GET", {
        "x-owner-id": candidate,
      }));
      const owner = response.cookies.get("agx_owner")?.value;

      expect(owner).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(owner).not.toBe(candidate);
      expect(forwardedOwner(response)).toBe(owner);
    },
  );
});
