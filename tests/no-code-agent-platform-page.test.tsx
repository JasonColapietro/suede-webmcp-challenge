import React, { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OG_IMAGE, SITE_URL } from "@/lib/site";

vi.mock("@/lib/catalog", () => ({
  buildCatalog: vi.fn().mockResolvedValue([]),
}));

const ROUTE = "/no-code-ai-agent-platform";
const PAGE_URL = `${SITE_URL}${ROUTE}`;

beforeAll(() => vi.stubGlobal("React", React));

interface PageMetadata {
  readonly title?: { readonly absolute?: string };
  readonly description?: string;
  readonly alternates?: { readonly canonical?: string | URL };
  readonly openGraph?: {
    readonly url?: string | URL;
    readonly images?: readonly ({ readonly url?: string | URL } | string)[];
  };
  readonly twitter?: {
    readonly images?: readonly (string | URL)[];
  };
}

interface PageModule {
  readonly metadata: PageMetadata;
  readonly default: () => ReactElement;
}

async function optionalImport<T>(specifier: string): Promise<T | null> {
  try {
    return await import(specifier) as T;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.includes("Cannot find module") ||
        error.message.includes("Failed to load url"))
    ) {
      return null;
    }
    throw error;
  }
}

function jsonLdGraphs(markup: string): Record<string, unknown>[] {
  return [...markup.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
}

describe("no-code AI agent platform public route", () => {
  it("publishes absolute self-canonical, Open Graph, and Twitter metadata", async () => {
    const page = await optionalImport<PageModule>("@/app/no-code-ai-agent-platform/page");
    expect(page).not.toBeNull();
    if (!page) return;

    expect(page.metadata).toMatchObject({
      title: { absolute: "No-Code AI Agent Platform | Suede Agent Studio" },
      alternates: { canonical: PAGE_URL },
      openGraph: {
        url: PAGE_URL,
        images: [{ url: OG_IMAGE }],
      },
      twitter: { images: [OG_IMAGE] },
    });
  });

  it("renders one clear H1, the verified limitations, and every required next step", async () => {
    const page = await optionalImport<PageModule>("@/app/no-code-ai-agent-platform/page");
    expect(page).not.toBeNull();
    if (!page) return;

    const markup = renderToStaticMarkup(createElement(page.default));
    expect(markup.match(/<h1(?:\s[^>]*)?>/g)).toHaveLength(1);
    expect(markup).toMatch(/<h1[^>]*>[^<]*no-code AI agent/i);
    expect(markup).toContain("Dry run is not a live integration test");
    expect(markup).toContain("Publishing does not create demand");
    expect(markup).toContain("x402 is the caller-payment rail today");

    for (const href of [
      "/rankings/best-ai-agent-builders",
      "/compare/gumloop-alternative",
      "/docs/building-flows",
      "/docs/launching",
      "/docs/payments",
      "/pricing",
      "/start",
    ]) {
      expect(markup).toContain(`href="${href}"`);
    }
  });

  it("renders source-bounded WebPage, breadcrumb, and FAQ schema", async () => {
    const page = await optionalImport<PageModule>("@/app/no-code-ai-agent-platform/page");
    expect(page).not.toBeNull();
    if (!page) return;

    const markup = renderToStaticMarkup(createElement(page.default));
    const graph = jsonLdGraphs(markup)
      .flatMap((node) => Array.isArray(node["@graph"]) ? node["@graph"] as Record<string, unknown>[] : [node]);
    const webPage = graph.find((node) => node["@type"] === "WebPage");
    const breadcrumbs = graph.find((node) => node["@type"] === "BreadcrumbList");
    const faq = graph.find((node) => node["@type"] === "FAQPage");

    expect(webPage).toMatchObject({
      url: PAGE_URL,
      dateModified: "2026-07-31",
      about: { "@id": `${SITE_URL}/#app` },
    });
    expect(breadcrumbs).toMatchObject({
      itemListElement: [
        { position: 1, name: "Suede Agent Studio", item: SITE_URL },
        { position: 2, name: "No-Code AI Agent Platform", item: PAGE_URL },
      ],
    });
    expect(faq).toMatchObject({ "@id": `${PAGE_URL}#faq` });
    expect(faq?.mainEntity).toBeInstanceOf(Array);
    expect(faq?.mainEntity as unknown[]).toHaveLength(5);
  });

  it("adds the route to the generated sitemap with the requested date", async () => {
    const sitemapModule = await import("@/app/sitemap");
    const entries = await sitemapModule.default();
    expect(entries).toContainEqual({
      url: PAGE_URL,
      lastModified: "2026-07-31",
      changeFrequency: "monthly",
      priority: 0.8,
    });
  });

  it("links into the guide from the public learning footer and x402 guide", async () => {
    const [{ default: SiteFooter }, { default: X402AgentBuilderPage }] = await Promise.all([
      import("@/components/site/SiteFooter"),
      import("@/app/x402-agent-builder/page"),
    ]);
    const footerMarkup = renderToStaticMarkup(createElement(SiteFooter));
    const x402Markup = renderToStaticMarkup(createElement(X402AgentBuilderPage));

    expect(footerMarkup).toContain(`href="${ROUTE}"`);
    expect(x402Markup).toContain(`href="${ROUTE}"`);
  });
});
