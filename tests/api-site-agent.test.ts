import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteCrawlError } from "@/lib/site/crawl";

const { checkBotIdMock, crawlSiteMock, checkRateLimitMock } = vi.hoisted(() => ({
  checkBotIdMock: vi.fn(),
  crawlSiteMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("botid/server", () => ({ checkBotId: checkBotIdMock }));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? "test-owner-site-agent" : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/site/crawl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/site/crawl")>()),
  crawlSite: crawlSiteMock,
}));

// Pin the profile to its deterministic half. The refinement layer on top is a
// live model call and is not what this route contributes; everything asserted
// below comes from the crawl itself, with or without a model key in the env.
vi.mock("@/lib/site/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/site/profile")>();
  return {
    ...actual,
    buildSiteProfile: async (crawl: import("@/lib/site/crawl").SiteCrawl) =>
      actual.deriveSiteProfile(crawl),
  };
});

const { POST } = await import("@/app/api/site-agent/route");

const HOME = "https://acme.example/";
const BODY_TEXT = "Acme Movers quotes every local move at a flat rate agreed up front.";

function fakeCrawl(): import("@/lib/site/crawl").SiteCrawl {
  return {
    homeUrl: HOME,
    origin: "https://acme.example",
    host: "acme.example",
    pages: [
      {
        url: HOME,
        title: "Fast, fair moving quotes | Acme Movers",
        description: "Local moves, flat rates, no hourly surprises.",
        siteName: "Acme Movers",
        ogTitle: "Moving without the runaround",
        ogDescription: null,
        canonical: HOME,
        text: BODY_TEXT,
        headings: ["Moving without the runaround", "Local moves"],
      },
    ],
    skippedByRobots: [],
    truncated: false,
  };
}

function call(
  body: unknown,
  headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "https://agents.suedeai.ai",
    "sec-fetch-site": "same-origin",
  },
): Promise<Response> {
  return POST(
    new Request("https://agents.suedeai.ai/api/site-agent", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/site-agent", () => {
  beforeEach(() => {
    checkBotIdMock.mockReset().mockResolvedValue({ isBot: false });
    checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, retryAfterSec: 0 });
    crawlSiteMock.mockReset().mockResolvedValue(fakeCrawl());
  });

  it.each([
    [{ "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, 403],
    [{ "content-type": "text/plain", origin: "https://agents.suedeai.ai", "sec-fetch-site": "same-origin" }, 415],
    [{ "content-type": "application/json", origin: "https://agents.suedeai.ai" }, 403],
  ] as const)("rejects invalid session mutation headers before BotID", async (headers, status) => {
    const response = await call({ url: "acme.example" }, headers);

    expect(response.status).toBe(status);
    expect(checkBotIdMock).not.toHaveBeenCalled();
    expect(crawlSiteMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed Authorization header", async () => {
    const response = await call({ url: "acme.example" }, {
      "content-type": "application/json",
      authorization: "Basic nope",
    });

    expect(response.status).toBe(401);
  });

  it("blocks automated callers before crawling", async () => {
    checkBotIdMock.mockResolvedValueOnce({ isBot: true });

    const response = await call({ url: "acme.example" });

    expect(response.status).toBe(403);
    expect(crawlSiteMock).not.toHaveBeenCalled();
  });

  it("returns 429 with a retry hint when the owner is over budget", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, retryAfterSec: 42 });

    const response = await call({ url: "acme.example" });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    await expect(response.json()).resolves.toMatchObject({ retryAfterSec: 42 });
    expect(crawlSiteMock).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "url missing"],
    [{ url: "" }, "url empty"],
    [{ url: "acme.example", blueprint: "nope" }, "unknown blueprint"],
    [{ url: "acme.example", priceUsdc: -1 }, "negative price"],
    [{ url: "acme.example", extra: true }, "unknown field"],
  ])("returns 400 for %j (%s)", async (body, _label) => {
    expect((await call(body)).status).toBe(400);
  });

  it("returns the profile, blueprint and a launchable manifest", async () => {
    const response = await call({ url: "acme.example" });

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      profile: Record<string, unknown>;
      blueprint: { id: string };
      manifest: { name: string; steps: Array<{ type: string; config: Record<string, unknown> }> };
    };

    expect(crawlSiteMock).toHaveBeenCalledWith("acme.example");
    expect(json.profile.siteName).toBe("Acme Movers");
    expect(json.profile.host).toBe("acme.example");
    expect(json.blueprint.id).toBe("concierge");
    expect(json.manifest.name).toBe("Acme Movers Concierge");
    expect(json.manifest.steps.map((step) => step.type)).toEqual(["input", "llm", "output"]);
    expect(String(json.manifest.steps[1]!.config.system)).toContain(BODY_TEXT);
  });

  it("reports the page count without echoing the whole crawl back", async () => {
    const json = (await (await call({ url: "acme.example" })).json()) as {
      profile: { knowledge?: unknown; knowledgeChars: number; sources: unknown[] };
    };

    expect(json.profile.knowledge).toBeUndefined();
    expect(json.profile.knowledgeChars).toBeGreaterThan(0);
    expect(json.profile.sources).toHaveLength(1);
  });

  it("keeps the existing launch-draft response contract free of Foundry mutations", async () => {
    const response = await call({ url: "acme.example" });
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["profile", "blueprint", "pricing", "manifest"]);
    expect(payload).not.toHaveProperty("resourceId");
    expect(payload).not.toHaveProperty("redirectTo");
    expect(crawlSiteMock).toHaveBeenCalledTimes(1);
  });

  it("honours the requested blueprint and price", async () => {
    const json = (await (
      await call({ url: "acme.example", blueprint: "lead-qualifier", priceUsdc: 0.25 })
    ).json()) as {
      blueprint: { id: string };
      manifest: { name: string; triggers: Array<{ kind: string; priceUsdc?: number }> };
    };

    expect(json.blueprint.id).toBe("lead-qualifier");
    expect(json.manifest.name).toBe("Acme Movers Lead Qualifier");
    expect(json.manifest.triggers).toEqual([{ kind: "paidCall", priceUsdc: 0.25 }]);
  });

  it("returns the pricing decision and clamps below-cost asks to the floor", async () => {
    const defaulted = (await (await call({ url: "acme.example" })).json()) as {
      pricing: {
        estimatedTokens: number;
        estimatedCostUsdc: number;
        floorUsdc: number;
        suggestedUsdc: number;
        priceUsdc: number;
      };
      manifest: { triggers: Array<{ priceUsdc?: number }> };
    };

    expect(defaulted.pricing.estimatedTokens).toBeGreaterThan(0);
    expect(defaulted.pricing.floorUsdc).toBeGreaterThan(0);
    expect(defaulted.pricing.priceUsdc).toBe(defaulted.pricing.suggestedUsdc);
    expect(defaulted.manifest.triggers[0]!.priceUsdc).toBe(defaulted.pricing.suggestedUsdc);

    // priceUsdc: 0 no longer publishes a free agent — every call spends real
    // model time, so the price clamps to the cost floor instead.
    const clamped = (await (await call({ url: "acme.example", priceUsdc: 0 })).json()) as {
      pricing: { floorUsdc: number; priceUsdc: number };
      manifest: { triggers: Array<{ priceUsdc?: number }> };
    };
    expect(clamped.pricing.priceUsdc).toBe(clamped.pricing.floorUsdc);
    expect(clamped.manifest.triggers[0]!.priceUsdc).toBe(clamped.pricing.floorUsdc);
  });

  it("maps an unusable address to 400 and a site-side failure to 422", async () => {
    crawlSiteMock.mockRejectedValueOnce(new SiteCrawlError("invalid-url", "not a website"));
    const bad = await call({ url: "nope" });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toEqual({ error: "not a website", code: "invalid-url" });

    crawlSiteMock.mockRejectedValueOnce(new SiteCrawlError("robots-blocked", "robots says no"));
    const blocked = await call({ url: "acme.example" });
    expect(blocked.status).toBe(422);
    await expect(blocked.json()).resolves.toMatchObject({ code: "robots-blocked" });
  });

  it("returns 500 without leaking internals when the crawl throws something else", async () => {
    crawlSiteMock.mockRejectedValueOnce(new Error("socket exploded"));

    const response = await call({ url: "acme.example" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal error" });
  });

  it("flags a partial read so the owner sees the agent's limits before launching", async () => {
    crawlSiteMock.mockResolvedValueOnce({ ...fakeCrawl(), truncated: true });

    const json = (await (await call({ url: "acme.example" })).json()) as {
      profile: { truncated: boolean };
      manifest: { steps: Array<{ config: Record<string, unknown> }> };
    };

    expect(json.profile.truncated).toBe(true);
    expect(String(json.manifest.steps[1]!.config.system)).toContain("Only part of the site was read");
  });
});
