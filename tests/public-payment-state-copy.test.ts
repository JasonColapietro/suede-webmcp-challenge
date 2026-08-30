import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const SOURCES = [
  "src/app/page.tsx",
  "src/app/docs/page.tsx",
  "src/app/launch/page.tsx",
  "src/app/fit/page.tsx",
  "src/app/agents/page.tsx",
  "src/app/about/page.tsx",
  "src/app/founder/page.tsx",
  "src/app/docs/faq/page.tsx",
  "src/app/docs/overview/page.tsx",
  "src/app/docs/api/page.tsx",
  "src/app/docs/launching/page.tsx",
  "src/app/layout.tsx",
  "src/app/no-code-ai-agent-platform/page.tsx",
  "src/app/rankings/best-ai-agent-builders/page.tsx",
  "src/app/templates/page.tsx",
  "src/app/templates/[slug]/page.tsx",
  "src/components/landing/JourneyAltitudes.tsx",
  "src/components/landing/Faq.tsx",
  "src/app/agents/opengraph-image.tsx",
  "src/app/a/[slug]/page.tsx",
  "src/app/a/[slug]/opengraph-image.tsx",
  "src/app/compare/opengraph-image.tsx",
  "src/app/templates/opengraph-image.tsx",
  "src/app/compare/gumloop-alternative/page.tsx",
  "docs/copy/2026-07-17-enterprise-gumloop-positioning.md",
] as const;

function source(path: (typeof SOURCES)[number]): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("public payment-state copy", () => {
  it("does not equate publishing or Live deployment with x402 payment enablement", () => {
    const combined = SOURCES.map(source).join("\n");

    for (const staleClaim of [
      /Every listing is a live x402 endpoint/iu,
      /Every launched flow is a pay-per-call endpoint/iu,
      /every live call is paid/iu,
      /Launch publishes any flow as a pay-per-call endpoint/iu,
      /launch any agent as a pay-per-call endpoint/iu,
      /A live, pay-per-call endpoint goes up instantly/iu,
      /lists every live endpoint with payment terms/iu,
      /listed with its price, payment terms/iu,
      /after launch, an x402-gated public run endpoint/iu,
      /publish any agent as a callable preview/iu,
      /A launched agent starts as a callable preview/iu,
      /agents launch as callable previews/iu,
      /Publish flows as callable previews/iu,
      /after launch, a callable public preview per agent/iu,
      /Publication is immediately callable in dry-run preview/iu,
      /Any HTTP client can call a published agent in dry-run preview/iu,
      /The catalog lists published, callable previews/iu,
      /One click publishes the flow as a callable preview/iu,
      /Published previews respond in dry-run/iu,
      /The moment launch returns[\s\S]{0,160}callable preview/iu,
      /Publish previews first/iu,
      /with[\s\S]{0,80}a Try-it dry-run/iu,
      /visual builder for callable agents[\s\S]{0,100}publish its preview/iu,
      /Dry-run is the default settlement mode/iu,
      /Dry-run resolution\.<\/strong> A run executes free/iu,
      /published callable agents/iu,
      /Publish a flow as a callable endpoint/iu,
      /build and publish callable agents/iu,
      /ready to preview free\. Make it yours, then launch/iu,
    ]) {
      expect(combined).not.toMatch(staleClaim);
    }
  });

  it("states that ordinary services may preview while unavailable services do not", () => {
    const launch = source("src/app/launch/page.tsx");
    const launching = source("src/app/docs/launching/page.tsx");
    const api = source("src/app/docs/api/page.tsx");
    const founder = source("src/app/founder/page.tsx");

    for (const copy of [launch, launching, api, founder]) {
      expect(copy).toMatch(/ordinary|standalone/iu);
      expect(copy).toMatch(/unavailable/iu);
      expect(copy).toMatch(/payment-enabled/iu);
    }
  });

  it("scopes creator earnings to calls that actually settled", () => {
    const fit = source("src/app/fit/page.tsx");
    const ranking = source("src/app/rankings/best-ai-agent-builders/page.tsx");
    const layout = source("src/app/layout.tsx");

    expect(fit).toMatch(/Every settled call routes/iu);
    expect(ranking).toMatch(/settled calls route/iu);
    expect(layout).toMatch(/Settled calls route/iu);
  });

  it("keeps homepage, share-card, and comparison claims aligned to the three public states", () => {
    const home = source("src/app/page.tsx");
    const agentDetail = source("src/app/a/[slug]/page.tsx");
    const agentOg = source("src/app/a/[slug]/opengraph-image.tsx");
    const combined = SOURCES.map(source).join("\n");

    expect(home).toMatch(/entry\.acceptsPayment\s*&&\s*entry\.settledCalls\s*>\s*0/u);
    expect(home).not.toMatch(/catalog\.slice\(0,\s*6\)/u);
    expect(agentDetail).toMatch(/readiness\.previewAvailable/u);
    expect(agentOg).toMatch(/agent\?\.status\s*!==\s*"live"\)\s*notFound\(\)/u);
    expect(agentOg).toMatch(/if\s*\(!publishedGraph\)\s*notFound\(\)/u);
    expect(agentOg).toMatch(/readiness\.state\s*===\s*"payment-enabled"/u);
    expect(agentOg).toMatch(/readiness\.state\s*===\s*"preview"/u);

    for (const staleClaim of [
      /Earning now/iu,
      /Every published agent is callable/iu,
      /every launched seat is a callable endpoint/iu,
      /launch it as a paid endpoint/iu,
      /flows launch as paid endpoints/iu,
      /Try any (?:of them )?free in dry-run/iu,
      /ACP and A2A rails travel/iu,
      /ACP, A2A, on-chain identity/iu,
    ]) {
      expect(combined).not.toMatch(staleClaim);
    }
  });
});
