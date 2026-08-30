import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

const DISTRIBUTION_SOURCES = [
  "docs/discovery-assets.md",
  "docs/distribution/x402-index-discovery.md",
  "docs/distribution/agentic-market.md",
  "docs/distribution/awesome-x402-x402index.md",
  "docs/distribution/awesome-x402-xpaysh.md",
  "docs/distribution/pay-sh.md",
  "docs/distribution/README.md",
  "docs/distribution/suede-agent-studio.yaml",
  "docs/distribution/satring.md",
] as const;

const PUBLIC_PAYMENT_PAGES = [
  "public/llms.txt",
  "src/app/page.tsx",
  "src/app/x402-agent-builder/page.tsx",
  "src/app/ai-agent-marketplace-payments/page.tsx",
] as const;

const CANONICAL_COPY_SOURCES = [
  "docs/copy/2026-06-11-platform-copy.md",
  "docs/copy/2026-07-17-launch-pack.md",
  "docs/copy/2026-07-17-autonomous-company-positioning.md",
  "docs/copy/2026-07-17-enterprise-gumloop-positioning.md",
] as const;

function sources(paths: readonly string[]): string {
  return paths.map((path) => readFileSync(join(ROOT, path), "utf8")).join("\n");
}

describe("public agent-payment source truth", () => {
  it("keeps distribution drafts on current Agent Studio and x402 v2 references", () => {
    const copy = sources(DISTRIBUTION_SOURCES);

    for (const stale of [
      /Agentix/iu,
      /app\.suedeai\.ai/iu,
      /agentix\.suedeai\.ai/iu,
      /daily-lyric-drop/iu,
      /the-ownership-loop/iu,
      /75f771ee-c18f-4335-a89a-b39859b6ccae/iu,
      /21877fd8-ec3c-450c-ad99-dd860488b998/iu,
      /base-mainnet/iu,
      /maxAmountRequired/iu,
      /x-payment-required/iu,
      /\bX-PAYMENT\b/u,
      /two live agents/iu,
      /live agents \(2\)/iu,
    ]) {
      expect(copy).not.toMatch(stale);
    }

    expect(copy).toContain("https://agents.suedeai.ai/api/catalog");
    expect(copy).toContain("https://agents.suedeai.ai/.well-known/x402");
    expect(copy).toContain("eip155:8453");
    expect(copy).toContain("PAYMENT-REQUIRED");
    expect(copy).toContain("PAYMENT-SIGNATURE");
  });

  it("describes x402 as the conditional caller-payment rail", () => {
    const copy = sources(PUBLIC_PAYMENT_PAGES);

    expect(copy).not.toMatch(/x402, Stripe, or A2A(?:[^\n]{0,40})settlement/iu);
    expect(copy).not.toMatch(/x402 settles every call today/iu);
    expect(copy).not.toMatch(/Every call settles in USDC on the protocols/iu);
    expect(copy).not.toMatch(/callers pay by wallet over x402 or by card through Stripe/iu);
    expect(copy).not.toMatch(/earn USDC on every call/iu);

    expect(copy).toMatch(/x402[^\n]{0,120}caller-payment/iu);
    expect(copy).toMatch(/A2A[^\n]{0,120}interface/iu);
    expect(copy).toMatch(/Stripe[^\n]{0,120}(?:builder|gateway) credit/iu);
    expect(copy).toMatch(/settlement[^\n]{0,120}(?:enabled|payment-enabled)/iu);
  });

  it("does not advertise runtime-gated AP2 surfaces in static llms.txt", () => {
    const copy = sources(["public/llms.txt"]);

    expect(copy).not.toMatch(/\bAP2\b/u);
    expect(copy).not.toMatch(/\.well-known\/ap2/iu);
    expect(copy).not.toMatch(/agentic-commerce\/ap2/iu);
  });

  it("describes MCP tools as eligibility-filtered rather than universally callable", () => {
    const copy = sources(["public/llms.txt"]);

    expect(copy).toMatch(/tools\/list[^\n]{0,100}authoritative/iu);
    expect(copy).toMatch(/Company employees, relay-backed services/iu);
    expect(copy).not.toMatch(/Every published agent is an MCP tool/iu);
  });

  it("keeps reusable copy sources aligned with three-state public readiness", () => {
    const copy = sources(CANONICAL_COPY_SOURCES);

    for (const stale of [
      /Every launched flow becomes a pay-per-call x402 endpoint/iu,
      /Every launched workflow is a billable endpoint/iu,
      /Every agent below is live: scheduled, priced, and paid/iu,
      /sells every call/iu,
    ]) {
      expect(copy).not.toMatch(stale);
    }
    expect(copy).toMatch(/preview, payment-enabled, or unavailable/iu);
    expect(copy).toMatch(/payment[^\n]{0,120}(?:separate|ready|readiness)/iu);
    expect(copy).not.toMatch(/\bACP\b/u);
  });
});
