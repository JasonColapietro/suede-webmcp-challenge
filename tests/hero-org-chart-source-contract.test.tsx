/**
 * The landing hero keeps one server-rendered source of truth across its org
 * chart, per-seat flow strips, and CSS-only selection rules. These contracts
 * protect that zero-hydration interaction without allowing the salvage to
 * rewrite the current example company or introduce handlerless controls.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HERO_SEAT_SLUG,
  ORG_BRANCHES,
  SEAT_STEP_META,
  describeSeat,
  flattenOrg,
  seatSlug,
} from "@/components/landing/AgentOrgCard";
import HeroGraph from "@/components/landing/HeroGraph";
import { NODE_TYPE_SET } from "@/lib/flow/node-meta";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

beforeAll(() => vi.stubGlobal("React", React));

const SEATS = flattenOrg();
const SLUGS = SEATS.map(seatSlug);

const CURRENT_SEATS = [
  ["CEO", "Claude"],
  ["CMO", "Gemini"],
  ["Lead Scorer", "Claude"],
  ["Outreach Writer", "Pi"],
  ["CTO", "Codex"],
  ["Frontend Eng", "Cursor"],
  ["On-call SRE", "OpenCode"],
  ["CFO", "Pi"],
  ["Invoice Chaser", "Gemini"],
  ["Expense Audit", "Claude"],
  ["COO", "OpenClaw"],
  ["Support Triage", "Claude"],
  ["CRM Sync", "Gemini"],
] as const;

describe("hero org chart seat-flow data", () => {
  it("adds flows without rewriting the current main org hierarchy", () => {
    expect(SEATS.map(({ role, agent }) => [role, agent])).toEqual(CURRENT_SEATS);
    expect(
      ORG_BRANCHES.map(({ dept, node, children }) => ({
        dept,
        head: node.role,
        reports: (children ?? []).map(({ role }) => role),
      })),
    ).toEqual([
      { dept: "Growth", head: "CMO", reports: ["Lead Scorer", "Outreach Writer"] },
      { dept: "Engineering", head: "CTO", reports: ["Frontend Eng", "On-call SRE"] },
      { dept: "Finance", head: "CFO", reports: ["Invoice Chaser", "Expense Audit"] },
      { dept: "Support Ops", head: "COO", reports: ["Support Triage", "CRM Sync"] },
    ]);
  });

  it("gives every seat a stable unique four-step flow", () => {
    expect(SEATS).toHaveLength(13);
    expect(new Set(SLUGS).size).toBe(SEATS.length);
    expect(new Set(SEATS.map((seat) => seat.flow.slug)).size).toBe(SEATS.length);
    for (const seat of SEATS) {
      expect(seat.flow.slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(seat.flow.steps, seat.role).toHaveLength(4);
      for (const step of seat.flow.steps) {
        expect(step.label.length, `${seat.role} / ${step.label}`).toBeLessThanOrEqual(12);
      }
    }
  });

  it("maps every shorthand step to a real current catalog node", () => {
    for (const meta of Object.values(SEAT_STEP_META)) {
      expect(NODE_TYPE_SET.has(meta.node), `${meta.node} is not a catalog node`).toBe(true);
    }
  });

  it("marks one billing node on each paid-call seat and none on other seats", () => {
    for (const seat of SEATS) {
      const billingSteps = seat.flow.steps.filter((step) => step.bills);
      expect(billingSteps, seat.role).toHaveLength(seat.live && seat.price ? 1 : 0);
    }
  });

  it("puts the visible price, cadence, and flow chain in the control name", () => {
    const scorer = SEATS.find(({ role }) => role === "Lead Scorer");
    const audit = SEATS.find(({ role }) => role === "Expense Audit");
    expect(scorer).toBeDefined();
    expect(audit).toBeDefined();
    expect(describeSeat(scorer!, "Growth")).toContain("$0.004 USDC per call");
    expect(describeSeat(scorer!, "Growth")).toContain("LLM Score Lead");
    expect(describeSeat(audit!, "Finance")).toContain("cron weekly Mon");
  });
});

describe("hero org chart selection markup", () => {
  const html = renderToStaticMarkup(createElement(HeroGraph));

  it("uses one native radio choice and one pre-rendered strip per seat", () => {
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html.match(/type="radio"/g)).toHaveLength(SEATS.length);
    expect(html.match(/name="hero-seat-flow"/g)).toHaveLength(SEATS.length);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    for (const slug of SLUGS) {
      expect(html.match(new RegExp(`data-seat="${slug}"`, "g")), slug).toHaveLength(2);
    }
    expect(html).toContain(`data-default-seat="${DEFAULT_HERO_SEAT_SLUG}"`);
  });

  it("has no dead seat button and exposes the native selection purpose", () => {
    expect(html).not.toMatch(/<button[^>]*class="[^"]*lp-seat/);
    expect(html).toContain('class="hg-org" role="group"');
    expect(html).toContain("Choose a seat to view its flow");
    expect(html).toContain('class="hg-strips"');
    expect(html).toMatch(/class="hg-strips"[^>]*aria-hidden="true"/);
  });

  it("adds no client boundary or event handler to the LCP-critical hero", () => {
    for (const file of [
      "src/components/landing/HeroGraph.tsx",
      "src/components/landing/HeroOrgChart.tsx",
      "src/components/landing/AgentOrgCard.tsx",
    ]) {
      const component = source(file);
      expect(component, file).not.toContain("use client");
      expect(component, file).not.toMatch(/\bonClick\b|\bonChange\b|\buseState\b|\buseEffect\b/);
    }
  });
});

describe("hero org chart selection styles", () => {
  const css = source("src/app/chrome.css");

  it("routes checked, hovered, and keyboard-focused seats to their own strip", () => {
    for (const slug of SLUGS) {
      expect(css, `missing checked rule for ${slug}`).toContain(
        `.hg-frame:has(.lp-seat--choice[data-seat="${slug}"] input:checked) .hg-strips > .hg-strip[data-seat="${slug}"]`,
      );
      expect(css, `missing hover rule for ${slug}`).toContain(
        `.hg-frame:has(.lp-seat--choice[data-seat="${slug}"]:hover) .hg-strips > .hg-strip[data-seat="${slug}"]`,
      );
      expect(css, `missing focus rule for ${slug}`).toContain(
        `.hg-frame:not(:has(.lp-seat--choice:hover)):has(.lp-seat--choice[data-seat="${slug}"]:focus-within) .hg-strips > .hg-strip[data-seat="${slug}"]`,
      );
    }
  });

  it("keeps the radio focus visible and the strip stack layout-stable", () => {
    expect(css).toContain(".lp-seat--choice:has(input:focus-visible)");
    expect(css).toContain(".lp-seat--choice:has(input:checked)");
    expect(css).toContain(".hg-strips {\n  display: grid;\n}");
    expect(css).toContain("grid-area: 1 / 1;");
  });

  it("stands transitions down and lets phone-width node labels wrap", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".lp-seat--choice,\n  .hg-strips > .hg-strip");
    const phone = css.slice(css.indexOf("@media (max-width: 560px)"));
    expect(phone).toContain(".hg-chip {\n    min-width: 0;\n  }");
    expect(phone).toContain("overflow-wrap: anywhere;");
  });
});
