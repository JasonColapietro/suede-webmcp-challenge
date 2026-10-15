import { afterEach, describe, expect, it, vi } from "vitest";

// The catalog normally reads deployment data. Its public URL is enough to
// prove that the sitemap policy covers agent pages as well as static pages.
vi.mock("@/lib/catalog", () => ({
  buildCatalog: async () => [{
    urls: { public: "/a/example-service" },
    createdAt: "2026-10-01T00:00:00Z",
  }],
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("WebMCP search exclusion", () => {
  it.each(["https://webmcp.suedeai.ai", "https://webmcp.suedeai.ai/"])(
    "does not advertise noindexed pages when built for %s",
    async (origin) => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
      const { default: sitemap } = await import("@/app/sitemap");
      const { default: robots } = await import("@/app/robots");

      // An empty <urlset> is not valid against the sitemap protocol's XSD.
      // Retire the excluded host's sitemap with a genuine 404 instead.
      await expect(sitemap()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(robots().sitemap).toBeUndefined();
      // Crawlers still need to reach the pages to observe the noindex header;
      // the machine-discovery allowlist and API restrictions stay intact.
      expect(robots().rules).toContainEqual({
        userAgent: "*",
        allow: ["/", "/api/agents/*/.well-known/", "/api/agents/*/a2a", "/api/catalog", "/api/services"],
        disallow: ["/api/"],
      });
    },
  );

  it("keeps the primary Studio sitemap and catalog pages discoverable", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://agents.suedeai.ai");
    const { default: sitemap } = await import("@/app/sitemap");
    const { default: robots } = await import("@/app/robots");
    const pages = await sitemap();

    expect(pages).toContainEqual(expect.objectContaining({ url: "https://agents.suedeai.ai/" }));
    expect(pages).toContainEqual(expect.objectContaining({ url: "https://agents.suedeai.ai/a/example-service" }));
    expect(robots().sitemap).toBe("https://agents.suedeai.ai/sitemap.xml");
  });
});
