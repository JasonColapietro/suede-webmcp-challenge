import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "@/lib/catalog";
import type { TemplateSummary } from "@/components/landing/TemplateGallery";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));

import AgentFilter from "@/components/landing/AgentFilter";
import TemplateGallery from "@/components/landing/TemplateGallery";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

beforeAll(() => vi.stubGlobal("React", React));

function agent(index: number): CatalogEntry {
  return {
    id: `agent-${index}`,
    slug: `agent-${index}`,
    name: `Agent ${index}`,
    summary: `Summary ${index}`,
    description: null,
    priceUsdc: 0,
    calls: index,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: index,
    settlementLive: false,
    acceptsPayment: false,
    paymentState: "preview",
    previewAvailable: true,
    publishedLive: true,
    payTo: "0x0000000000000000000000000000000000000000",
    schedule: index % 2 === 0 ? "daily" : null,
    inputSchema: { type: "object" },
    urls: {
      public: `/a/agent-${index}`,
      run: `/api/a/agent-${index}/run`,
      x402: `/api/a/agent-${index}/x402`,
      agentCard: `/api/a/agent-${index}/card`,
      a2a: `/api/a/agent-${index}/a2a`,
    },
  };
}

function template(index: number): TemplateSummary {
  return {
    slug: `template-${index}`,
    name: `Template ${index}`,
    blurb: `Blurb ${index}`,
    whoPays: "A customer",
    price: 0,
    monthly: null,
    coreNodes: true,
    cadence: null,
    dots: ["var(--primary)"],
    category: index % 2 === 0 ? "business" : "creator",
    department: null,
    featuredRoute: null,
  };
}

describe("catalog search and progressive disclosure", () => {
  it("server-renders every public agent as a crawlable directory link", () => {
    const entries = Array.from({ length: 29 }, (_, index) => agent(index));
    const markup = renderToStaticMarkup(createElement(AgentFilter, {
      entries,
    }));

    expect(markup.match(/class="lp-dir-card"/g)).toHaveLength(entries.length);
    for (const entry of entries) {
      expect(markup).toContain(`href="${entry.urls.public}"`);
    }
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('role="radio"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("Filter agents by schedule");
    expect(markup).toContain("Showing 29 of 29 agents.");
    expect(markup).not.toContain("Show 5 more");
  });

  it("renders the first template page and an honest empty-catalog state", () => {
    const markup = renderToStaticMarkup(createElement(TemplateGallery, {
      templates: Array.from({ length: 14 }, (_, index) => template(index)),
    }));
    const empty = renderToStaticMarkup(createElement(TemplateGallery, { templates: [] }));

    expect(markup.match(/class="lp-tpl-cell"/g)).toHaveLength(12);
    expect(markup).toContain("Filter templates by category");
    expect(markup).toContain("Showing 12 of 14 templates.");
    expect(markup).toContain("Show 2 more");
    expect(empty).toContain("No templates are available yet.");
    expect(empty).not.toContain("Clear search and filters");
  });

  it("resets pagination in the initiating events instead of an after-paint effect", () => {
    for (const path of [
      "src/components/landing/AgentFilter.tsx",
      "src/components/landing/TemplateGallery.tsx",
    ]) {
      const component = source(path);
      expect(component).not.toContain("useEffect");
      expect(component.match(/setVisibleCount\(PAGE_SIZE\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(component).toContain("Clear search and filters");
    }
  });
});
