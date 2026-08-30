import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "@/lib/catalog";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));

import DirectoryExplorer, { type DirectoryAgent } from "@/app/agents/DirectoryExplorer";
import {
  deriveDirectoryStats,
  formatUsdc,
  pickLaunchableTemplates,
} from "@/app/agents/directory-data";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

beforeAll(() => vi.stubGlobal("React", React));

function entry(index: number, overrides: Partial<DirectoryAgent> = {}): DirectoryAgent {
  return {
    id: `agent-${index}`,
    slug: `agent-${index}`,
    name: `Agent ${index}`,
    summary: `Summary ${index}`,
    description: null,
    priceUsdc: index % 2 === 0 ? 0 : 0.008,
    calls: index,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: index,
    payTo: "0x1234567890abcdef1234567890abcdef12345678",
    schedule: index % 2 === 0 ? "daily" : null,
    publishedLive: true,
    acceptsPayment: true,
    paymentState: "payment-enabled",
    previewAvailable: true,
    urls: {
      public: `/a/agent-${index}`,
      run: `/api/agents/agent-${index}/run`,
      x402: `/api/agents/agent-${index}/.well-known/x402`,
    },
    ...overrides,
  };
}

function catalogEntry(index: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: `agent-${index}`,
    slug: `agent-${index}`,
    name: `Agent ${index}`,
    summary: `Summary ${index}`,
    description: null,
    priceUsdc: 0.008,
    calls: index,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: index,
    payTo: "0x1234567890abcdef1234567890abcdef12345678",
    schedule: null,
    settlementLive: true,
    acceptsPayment: true,
    paymentState: "payment-enabled",
    previewAvailable: true,
    publishedLive: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    urls: {
      public: `/a/agent-${index}`,
      run: `/api/agents/agent-${index}/run`,
      x402: `/api/agents/agent-${index}/.well-known/x402`,
      agentCard: `/api/agents/agent-${index}/.well-known/agent-card`,
      a2a: `/api/agents/agent-${index}/a2a`,
    },
    ...overrides,
  };
}

describe("directory explorer storefront", () => {
  it("server-renders every public agent as a crawlable marketplace card", () => {
    const entries = Array.from({ length: 29 }, (_, index) => entry(index));
    const markup = renderToStaticMarkup(createElement(DirectoryExplorer, { entries }));

    expect(markup.match(/class="agdir-card"/g)).toHaveLength(entries.length);
    expect(markup.match(/class="agdir-live"/g)).toHaveLength(entries.length);
    for (const e of entries) {
      expect(markup).toContain(`href="${e.urls.public}"`);
      expect(markup).toContain(`POST ${e.urls.run}`);
    }
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain("Filter agents by schedule");
    // Both price bands exist in this inventory, so the price filter appears.
    expect(markup).toContain("Filter agents by price");
    expect(markup).toContain("Showing 29 of 29 agents.");
    expect(markup).toContain("Call this agent");
    // Free and paid render honestly, and the payout wallet shows shortened.
    expect(markup).toContain("Free");
    expect(markup).toContain("$0.008 / call");
    expect(markup).toContain("pays 0x1234…5678");
    // Zero calls never fakes activity.
    expect(markup).toContain("newly listed");
    expect(markup).not.toContain("Show 5 more");
  });

  it("hides the price filter when the inventory has a single price band", () => {
    const entries = [entry(1), entry(3), entry(5)]; // all priced 0.008
    const markup = renderToStaticMarkup(createElement(DirectoryExplorer, { entries }));
    expect(markup).not.toContain("Filter agents by price");
    expect(markup).toContain("Filter agents by schedule");
  });

  it("renders an honest empty state with a build CTA", () => {
    const markup = renderToStaticMarkup(createElement(DirectoryExplorer, { entries: [] }));
    expect(markup).toContain("No agents are live yet.");
    expect(markup).toContain('href="/start"');
    expect(markup).not.toContain("agdir-card");
  });

  it("resets pagination in the initiating events instead of an after-paint effect", () => {
    const component = source("src/app/agents/DirectoryExplorer.tsx");
    expect(component).not.toContain("useEffect");
    expect(component.match(/setVisibleCount\(PAGE_SIZE\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(component).toContain("Clear search and filters");
  });

  it("separates calls made from calls settled instead of claiming every call settled", () => {
    const markup = renderToStaticMarkup(
      createElement(DirectoryExplorer, {
        entries: [entry(1, { calls: 12, settledCalls: 3 })],
      }),
    );
    expect(markup).toContain("12 calls · 3 settled");
    // The old label claimed every external call settled; it must be gone.
    expect(markup).not.toContain("12 calls settled");
  });

  it("badges non-deployed entries as dry-run only and demotes them below published ones", () => {
    const markup = renderToStaticMarkup(
      createElement(DirectoryExplorer, {
        entries: [
          // Most-called sort would put the stale agent first; publication
          // truth must outrank popularity.
          entry(1, {
            name: "Stale Agent",
            calls: 99,
            publishedLive: false,
            acceptsPayment: false,
            paymentState: "preview",
          }),
          entry(2, { name: "Published Agent", calls: 1, publishedLive: true }),
        ],
      }),
    );
    expect(markup).toContain("dry-run only");
    expect(markup.match(/class="agdir-live"/g)).toHaveLength(1);
    expect(markup.indexOf("Published Agent")).toBeLessThan(markup.indexOf("Stale Agent"));
  });

  it("shows recency for called agents and stays silent for never-called ones", () => {
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    const markup = renderToStaticMarkup(
      createElement(DirectoryExplorer, {
        entries: [
          entry(1, { lastCallAt: twoHoursAgo }),
          entry(2, { lastCallAt: null }),
        ],
      }),
    );
    expect(markup).toContain("last called 2h ago");
    expect(markup.match(/last called/g)).toHaveLength(1);
  });

  it("lets a real creator description replace the derived node-chain line", () => {
    const markup = renderToStaticMarkup(
      createElement(DirectoryExplorer, {
        entries: [
          entry(1, { description: "Chases invoices politely.", summary: "Input › LLM › Output" }),
          entry(2, { description: null, summary: "Input › Branch › Output" }),
        ],
      }),
    );
    expect(markup).toContain("Chases invoices politely.");
    expect(markup).not.toContain("Input › LLM › Output");
    expect(markup).toContain("Input › Branch › Output");
  });

  it("marks priced agents that cannot settle yet as not charging", () => {
    const markup = renderToStaticMarkup(
      createElement(DirectoryExplorer, {
        entries: [
          entry(1, {
            priceUsdc: 0.05,
            acceptsPayment: false,
            paymentState: "preview",
          }),
          entry(3, { priceUsdc: 0.05, acceptsPayment: true }),
        ],
      }),
    );
    expect(markup.match(/not charging yet/g)).toHaveLength(1);
    expect(markup.match(/Machine-payable per call/g)).toHaveLength(1);
    expect(markup.match(/pays 0x1234…5678/g)).toHaveLength(1);
  });

  it("labels unavailable company services without offering a preview or payment", () => {
    const markup = renderToStaticMarkup(
      createElement(DirectoryExplorer, {
        entries: [entry(1, {
          paymentState: "unavailable",
          acceptsPayment: false,
          previewAvailable: false,
        })],
      }),
    );
    expect(markup).toContain("unavailable");
    expect(markup).not.toContain("not charging yet");
    expect(markup).not.toContain("Machine-payable per call");
    expect(markup).not.toContain("Call this agent");
  });

  it("describes an empty first listing without promising a paid endpoint", () => {
    const markup = renderToStaticMarkup(createElement(DirectoryExplorer, { entries: [] }));
    expect(markup).toContain("current call readiness appears here");
    expect(markup).not.toContain("paid x402 endpoint");
  });
});

describe("directory stats derivation", () => {
  // Deliberate pin update: stats now carry totalSettled so the page can say
  // "N calls · M settled" instead of claiming every external call settled.
  it("derives every headline number from the catalog", () => {
    const stats = deriveDirectoryStats([
      catalogEntry(1, { priceUsdc: 0.002, calls: 10, settledCalls: 4, schedule: "daily" }),
      catalogEntry(2, { priceUsdc: 0.012, calls: 5, settledCalls: 1 }),
      catalogEntry(3, { priceUsdc: 0, calls: 0 }),
    ]);
    expect(stats).toEqual({
      liveCount: 3,
      totalCalls: 15,
      totalSettled: 5,
      scheduledCount: 1,
      freeCount: 1,
      minPriceUsdc: 0.002,
      maxPriceUsdc: 0.012,
    });
  });

  it("reports an empty catalog as zeros and nulls, never invented numbers", () => {
    expect(deriveDirectoryStats([])).toEqual({
      liveCount: 0,
      totalCalls: 0,
      totalSettled: 0,
      scheduledCount: 0,
      freeCount: 0,
      minPriceUsdc: null,
      maxPriceUsdc: null,
    });
  });

  it("formats USDC prices without trailing noise", () => {
    expect(formatUsdc(0.008)).toBe("$0.008");
    expect(formatUsdc(0.01)).toBe("$0.01");
    expect(formatUsdc(0.1)).toBe("$0.1");
    expect(formatUsdc(2)).toBe("$2");
  });

  it("backfills a sparse shelf only with templates that have no live launch", () => {
    const picks = pickLaunchableTemplates([], 6);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.length).toBeLessThanOrEqual(6);
    // A live launch of the first pick's template removes it from the shelf.
    const first = picks[0]!;
    const withLive = pickLaunchableTemplates(
      [catalogEntry(9, { slug: `${first.slug}-abc12` })],
      6,
    );
    expect(withLive.some((t) => t.slug === first.slug)).toBe(false);
  });
});
