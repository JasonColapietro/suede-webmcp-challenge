/**
 * The two money surfaces: /portfolio (the owner's earnings ledger) and
 * /a/[slug] (the public storefront a buyer sees before paying).
 *
 * These lock the parts that are easy to regress by accident: the zero state
 * must never render a number that could read as earnings, an all-zero window
 * must say so instead of drawing a flat line on an invented axis, the phone
 * layout must carry every agent the wide ledger carries, and neither surface
 * may reintroduce em dashes or the banned category label into public copy.
 */
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PortfolioEmpty } from "@/components/portfolio/PortfolioEmpty";
import { PortfolioTrend } from "@/components/portfolio/PortfolioTrend";
import { StatTiles } from "@/components/portfolio/StatTiles";
import { AgentTable } from "@/components/portfolio/AgentTable";
import type { AgentWithStats, PortfolioSummary } from "@/lib/portfolio/types";

// Set at module scope, not in beforeAll: the markup below is rendered during
// collection, which runs before any hook fires.
(globalThis as unknown as { React: typeof React }).React = React;

const NOW_ISO = "2026-08-03T12:00:00.000Z";

function trend(values: readonly number[]): PortfolioSummary["trend"] {
  return values.map((v, i) => ({
    day: `2026-07-${String(i + 1).padStart(2, "0")}`,
    calls: v > 0 ? 1 : 0,
    revenueUsdc: v,
    errors: 0,
  }));
}

function summary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    ownerWallet: "0x1111111111111111111111111111111111111111",
    totalRevenueUsdc: 0,
    totalGrossUsdc: 0,
    totalCalls: 0,
    agentCount: 0,
    activeAgents: 0,
    revenue7d: 0,
    delta7d: 0,
    trend: trend([0, 0, 0, 0, 0, 0, 0]),
    ...overrides,
  };
}

function agent(over: Partial<AgentWithStats> & { id: string; name: string }): AgentWithStats {
  return {
    slug: over.id,
    ownerWallet: "0x1111111111111111111111111111111111111111",
    x402Url: "",
    priceUsdc: 0.05,
    category: "Analytics",
    launchedAt: "2026-06-01T12:00:00.000Z",
    status: "live",
    stats: { calls: 10, revenueUsdc: 0.5, errors: 0, lastActiveAt: NOW_ISO, spark: [0, 0, 0, 0, 0, 0, 0.5] },
    ...over,
  } as AgentWithStats;
}

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

/** JSX text and string literals, with comment lines stripped out. */
function prose(file: string): string {
  return file
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}

describe("/portfolio zero state", () => {
  const markup = renderToStaticMarkup(createElement(PortfolioEmpty, { onTrack: () => {} }));

  it("routes the visitor to both ways of getting a first agent", () => {
    expect(markup).toContain('href="/build/new"');
    expect(markup).toContain('href="/templates"');
  });

  it("explains what will appear here rather than showing an unexplained void", () => {
    expect(markup).toContain("What lands here");
    expect(markup).toMatch(/Total earned/);
  });

  it("never renders a figure that could be read as earnings", () => {
    // No currency amount anywhere, and every preview tile's value slot holds a
    // literal dash rather than a number. Anything else would be fabricated.
    expect(markup).not.toMatch(/\$\d/);
    const values = [...markup.matchAll(/class="pf-ghost-dash">([^<]*)</g)].map((m) => m[1]);
    expect(values).toHaveLength(4);
    for (const v of values) expect(v.trim()).toBe("—");
  });
});

describe("/portfolio revenue trend", () => {
  it("states an empty window instead of drawing a flat line on an invented axis", () => {
    const markup = renderToStaticMarkup(createElement(PortfolioTrend, { summary: summary() }));
    expect(markup).toContain("Nothing settled in this window.");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("peak ");
  });

  it("draws the chart once anything has settled", () => {
    const markup = renderToStaticMarkup(
      createElement(PortfolioTrend, { summary: summary({ trend: trend([0, 1, 2, 3, 2, 4, 6]) }) }),
    );
    expect(markup).toContain("<svg");
    expect(markup).toContain("peak ");
    expect(markup).not.toContain("Nothing settled");
  });

  it("ships a phone variant whose axis labels are not scaled into illegibility", () => {
    const markup = renderToStaticMarkup(
      createElement(PortfolioTrend, { summary: summary({ trend: trend([0, 1, 2, 3, 2, 4, 6]) }) }),
    );
    expect(markup).toContain("pf-chart--wide");
    expect(markup).toContain("pf-chart--narrow");
    // The wide chart's 820-unit viewBox renders 11-unit text at ~4px inside a
    // phone column; the narrow variant keeps the same text near 9px.
    const viewBoxes = [...markup.matchAll(/viewBox="0 0 (\d+) /g)].map((m) => Number(m[1]));
    expect(viewBoxes).toEqual([820, 380]);
  });
});

describe("/portfolio stat tiles", () => {
  const markup = renderToStaticMarkup(
    createElement(StatTiles, {
      summary: summary({ totalRevenueUsdc: 12.5, totalCalls: 250, agentCount: 3, activeAgents: 2, revenue7d: 4 }),
    }),
  );

  it("gives the money answer the single earn accent", () => {
    expect(markup.match(/pf-tile--earn/g)).toHaveLength(1);
  });

  it("reads the roster in seat terms", () => {
    expect(markup).toContain("Seats earning");
    // "2" then the muted "/ 3" denominator.
    expect(markup).toMatch(/>2<span class="pf-figure-of"> \/ 3</);
  });
});

describe("/portfolio agent ledger", () => {
  const agents = [agent({ id: "a1", name: "Invoice Chaser" }), agent({ id: "a2", name: "Lead Scorer" })];
  const markup = renderToStaticMarkup(createElement(AgentTable, { agents, nowISO: NOW_ISO }));

  it("carries every agent in both the wide ledger and the phone card list", () => {
    for (const a of agents) {
      // Once as a table row, once as a seat card.
      expect(markup.match(new RegExp(a.name, "g"))).toHaveLength(2);
      expect(markup).toContain(`/portfolio/${a.id}`);
    }
    expect(markup).toContain("pf-seats");
    expect(markup).toContain("pf-table-wrap");
  });

  it("keeps revenue and status on the phone card rather than behind a scroll", () => {
    const seats = markup.slice(markup.indexOf("pf-seats"));
    expect(seats).toContain("pf-seat-rev");
    expect(seats).toContain("Live");
  });
});

describe("public copy discipline on both money surfaces", () => {
  const surfaces: readonly [string, string][] = [
    ["/portfolio", prose(source("src/app/portfolio/page.tsx"))],
    ["/portfolio empty state", prose(source("src/components/portfolio/PortfolioEmpty.tsx"))],
    ["/portfolio trend", prose(source("src/components/portfolio/PortfolioTrend.tsx"))],
    ["/portfolio tiles", prose(source("src/components/portfolio/StatTiles.tsx"))],
    ["/a/[slug]", prose(source("src/app/a/[slug]/page.tsx"))],
  ];

  it.each(surfaces)("%s uses no em dashes in copy", (_name, text) => {
    // The bare "—" placeholder for a missing table value is the one allowed
    // use; it is a glyph, not prose, and is written as an HTML entity.
    expect(text.replace(/&mdash;/g, "")).not.toContain("—");
  });

  it.each(surfaces)("%s avoids the banned category label", (_name, text) => {
    expect(text.toLowerCase()).not.toMatch(/\ba[n]? ai workforce\b|\bthe ai workforce\b/);
  });

  it.each(surfaces)("%s makes no take-rate or revenue-share claim", (_name, text) => {
    expect(text.toLowerCase()).not.toMatch(/take rate|take-rate|revenue share|revenue-share|% of (each|every|your)/);
  });
});

describe("/a/[slug] storefront contract", () => {
  const page = source("src/app/a/[slug]/page.tsx");

  it("puts price, the try-it path, and the call path above the safety block", () => {
    const price = page.indexOf("ag-price-figure");
    const tryIt = page.indexOf('id="try-it"');
    const callIt = page.indexOf('id="call-it"');
    const safety = page.indexOf("ag-safety");
    expect(price).toBeGreaterThan(-1);
    expect(price).toBeLessThan(tryIt);
    expect(tryIt).toBeLessThan(callIt);
    expect(callIt).toBeLessThan(safety);
  });

  it("renders preview, payment-enabled, and unavailable posture without hiding valid paths", () => {
    expect(page).toContain('readiness.state === "unavailable"');
    expect(page).toContain("Preview only.");
    expect(page).toContain("Preview or pay.");
    expect(page).toContain("Public calls unavailable.");
    expect(page).toContain("Try it free");
    expect(page).toContain('readiness.state !== "unavailable"');
  });

  it("never prints the zero address as a payout destination", () => {
    expect(page).toContain('payout.source === "unset"');
    expect(page).toContain("No valid payout address is connected.");
  });

  it("speaks the estate chip dialect for cadence and live status", () => {
    expect(page).toContain("lp-pill--sched");
    expect(page).toContain("lp-pill--live");
  });
});
