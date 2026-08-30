import { describe, expect, it, vi } from "vitest";
import { ARTICLES } from "@/lib/articles";
import { SITE_URL } from "@/lib/site";
import { listTemplateDetailPageSlugs } from "@/lib/template-summaries";

vi.mock("@/lib/catalog", () => ({
  buildCatalog: vi.fn(async () => [
    {
      createdAt: Date.UTC(2026, 7, 26),
      urls: { public: "/a/public-agent" },
    },
  ]),
}));

import sitemap from "@/app/sitemap";
import robots from "@/app/robots";

const PRIVATE_PREFIXES = [
  "/start",
  "/from-website",
  "/grade",
  "/enter",
  "/build",
  "/code",
  "/flows",
  "/founding",
  "/company",
  "/connections",
  "/resources",
  "/runs",
  "/portfolio",
];

const EXPECTED_STATIC_PUBLIC_PATHS = [
  "/",
  "/agents",
  "/launch",
  "/docs",
  "/docs/overview",
  "/docs/building-flows",
  "/docs/launching",
  "/docs/payments",
  "/docs/api",
  "/docs/nodes",
  "/docs/architecture",
  "/docs/mcp",
  "/docs/reliability",
  "/docs/examples",
  "/docs/faq",
  "/docs/troubleshooting",
  "/articles",
  "/founder",
  "/about",
  "/contact",
  "/privacy",
  "/security",
  "/status",
  "/account-deletion",
  "/pricing",
  "/templates",
  "/templates/grade-rebuilder",
  "/templates/lead-qualifier",
  "/templates/competitor-tracker",
  "/templates/review-responder",
  "/templates/invoice-chaser",
  "/templates/meeting-prep",
  "/compare/gumloop-alternative",
  "/rankings/best-ai-agent-builders",
  "/no-code-ai-agent-platform",
  "/firm",
  "/ai-agent-marketplace-payments",
  "/x402-agent-builder",
  "/fit",
];

describe("mystery landing discovery boundary", () => {
  it("keeps only public routes in the generated sitemap", async () => {
    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);

    expect(urls).toEqual(expect.arrayContaining(
      EXPECTED_STATIC_PUBLIC_PATHS.map((path) => `${SITE_URL}${path}`),
    ));
    expect(urls).toEqual(expect.arrayContaining(
      ARTICLES.map((article) => `${SITE_URL}/articles/${article.slug}`),
    ));
    expect(urls).toEqual(expect.arrayContaining(
      listTemplateDetailPageSlugs().map((slug) => `${SITE_URL}/templates/${slug}`),
    ));
    expect(urls).toContain(`${SITE_URL}/a/public-agent`);

    for (const privatePrefix of PRIVATE_PREFIXES) {
      expect(
        urls.some((url) => {
          const pathname = new URL(url).pathname;
          return pathname === privatePrefix || pathname.startsWith(`${privatePrefix}/`);
        }),
        `sitemap must not publish ${privatePrefix}`,
      ).toBe(false);
    }
  });

  it("keeps API discovery crawlable without blocking private HTML redirects", () => {
    const value = robots();
    const rules = Array.isArray(value.rules) ? value.rules : [value.rules];

    for (const rule of rules) {
      expect(rule.disallow).toEqual(["/api/"]);
      expect(rule.allow).toEqual(expect.arrayContaining([
        "/",
        "/api/agents/*/.well-known/",
        "/api/agents/*/a2a",
        "/api/catalog",
        "/api/services",
      ]));
      expect(rule.disallow).not.toEqual(expect.arrayContaining(["/build/", "/flows", "/runs/"]));
    }
  });
});
