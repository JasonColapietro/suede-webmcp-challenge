import { describe, expect, it } from "vitest";
import type { CrawlPage, SiteCrawl } from "@/lib/site/crawl";
import {
  buildKnowledge,
  deriveOfferings,
  deriveSiteName,
  deriveSiteProfile,
  MAX_OFFERINGS,
  MAX_SUMMARY_CHARS,
} from "@/lib/site/profile";

function makePage(overrides: Partial<CrawlPage> & { url: string }): CrawlPage {
  return {
    title: null,
    description: null,
    siteName: null,
    ogTitle: null,
    ogDescription: null,
    canonical: null,
    text: "",
    headings: [],
    ...overrides,
  };
}

function makeCrawl(pages: CrawlPage[], truncated = false): SiteCrawl {
  return {
    homeUrl: pages[0]!.url,
    origin: "https://acme.example",
    host: "acme.example",
    pages,
    skippedByRobots: [],
    truncated,
  };
}

describe("deriveSiteName", () => {
  it("prefers og:site_name", () => {
    const page = makePage({ url: "https://acme.example/", siteName: "Acme Movers", title: "Home" });

    expect(deriveSiteName(page, "acme.example")).toBe("Acme Movers");
  });

  it("takes the short half of a separated title", () => {
    const page = makePage({
      url: "https://acme.example/",
      title: "Fast, fair moving quotes | Acme Movers",
    });

    expect(deriveSiteName(page, "acme.example")).toBe("Acme Movers");
  });

  it("falls back to the hostname without www", () => {
    expect(deriveSiteName(makePage({ url: "https://acme.example/" }), "www.acme.example")).toBe(
      "acme.example",
    );
  });
});

describe("deriveSiteProfile tagline", () => {
  function taglineFor(overrides: Partial<CrawlPage>): string {
    return deriveSiteProfile(
      makeCrawl([makePage({ url: "https://acme.example/", text: "x".repeat(200), ...overrides })]),
    ).tagline;
  }

  // Real titles from sites run through the crawler on 2026-07-26. Before the
  // segment filter, each of these returned the brand name as its own tagline.
  it.each([
    ["Linear – The system for product development", "Linear", "The system for product development"],
    ["Strumly — your 24/7 guitar coach", "Strumly", "your 24/7 guitar coach"],
    ["Acme Movers | Fast, fair moving quotes", "Acme Movers", "Fast, fair moving quotes"],
  ])("reads %j as a tagline, not as the brand", (title, siteName, expected) => {
    expect(taglineFor({ title, siteName })).toBe(expected);
  });

  it("keeps an unseparated tagline whole", () => {
    expect(taglineFor({ siteName: "Acme", ogTitle: "Moving without the runaround" })).toBe(
      "Moving without the runaround",
    );
  });

  it("falls through to the next candidate when every segment is the brand", () => {
    expect(
      taglineFor({ siteName: "Acme", ogTitle: "Acme | Acme", headings: ["Moving, solved"] }),
    ).toBe("Moving, solved");
  });

  it("returns empty rather than echoing the brand when nothing else is offered", () => {
    expect(taglineFor({ siteName: "Acme", title: "Acme", ogTitle: "Acme" })).toBe("");
  });
});

describe("deriveOfferings", () => {
  it("reads sub-page headings before home-page slogans and de-duplicates", () => {
    const crawl = makeCrawl([
      makePage({ url: "https://acme.example/", headings: ["Moving without the runaround", "Local moves"] }),
      makePage({ url: "https://acme.example/services", headings: ["Local moves", "Packing", "Storage"] }),
    ]);

    expect(deriveOfferings(crawl)).toEqual([
      "Local moves",
      "Packing",
      "Storage",
      "Moving without the runaround",
    ]);
  });

  it("drops navigation chrome and caps the list", () => {
    const crawl = makeCrawl([
      makePage({
        url: "https://acme.example/",
        headings: ["Menu", "Newsletter", ...Array.from({ length: 20 }, (_, i) => `Service ${i}`)],
      }),
    ]);
    const offerings = deriveOfferings(crawl);

    expect(offerings).toHaveLength(MAX_OFFERINGS);
    expect(offerings).not.toContain("Menu");
    expect(offerings).not.toContain("Newsletter");
  });
});

describe("buildKnowledge", () => {
  it("labels each section with its source page and respects the cap", () => {
    const crawl = makeCrawl([
      makePage({ url: "https://acme.example/", title: "Acme Movers", text: "Flat rate quotes." }),
      makePage({ url: "https://acme.example/about", title: "About", text: "Founded in 2011." }),
    ]);
    const knowledge = buildKnowledge(crawl, 10_000);

    expect(knowledge).toContain("--- Acme Movers (https://acme.example/) ---");
    expect(knowledge).toContain("Flat rate quotes.");
    expect(knowledge).toContain("--- About (https://acme.example/about) ---");
    expect(buildKnowledge(crawl, 60).length).toBeLessThanOrEqual(60);
  });

  it("skips pages with no text", () => {
    const crawl = makeCrawl([
      makePage({ url: "https://acme.example/", title: "Acme", text: "Real text." }),
      makePage({ url: "https://acme.example/empty", title: "Empty", text: "   " }),
    ]);

    expect(buildKnowledge(crawl, 10_000)).not.toContain("/empty");
  });
});

describe("deriveSiteProfile", () => {
  const crawl = makeCrawl(
    [
      makePage({
        url: "https://acme.example/",
        title: "Fast, fair moving quotes | Acme Movers",
        description: "Local moves, flat rates, no hourly surprises.",
        siteName: "Acme Movers",
        ogTitle: "Moving without the runaround",
        headings: ["Moving without the runaround", "Local moves"],
        text: "We quote flat. You pay that.",
      }),
      makePage({ url: "https://acme.example/pricing", title: "Pricing", headings: ["Flat rates"], text: "One price." }),
    ],
    true,
  );

  it("produces a complete, schema-valid profile with no model call", () => {
    const profile = deriveSiteProfile(crawl);

    expect(profile.siteName).toBe("Acme Movers");
    expect(profile.tagline).toBe("Moving without the runaround");
    expect(profile.summary).toBe("Local moves, flat rates, no hourly surprises.");
    expect(profile.offerings).toContain("Flat rates");
    expect(profile.sources).toHaveLength(2);
    expect(profile.knowledge).toContain("We quote flat.");
    expect(profile.truncated).toBe(true);
    // Model-only fields stay empty rather than being invented.
    expect(profile.audience).toBe("");
    expect(profile.tone).toBe("");
    expect(profile.faqs).toEqual([]);
  });

  it("summarises from body text when the site publishes no description", () => {
    const bare = makeCrawl([
      makePage({
        url: "https://acme.example/",
        title: "Acme Movers",
        text: `${"Acme Movers has moved families across the county since 2011. ".repeat(20)}`,
      }),
    ]);
    const profile = deriveSiteProfile(bare);

    expect(profile.summary.length).toBeGreaterThan(0);
    expect(profile.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(profile.summary).toContain("Acme Movers has moved families");
  });
});
