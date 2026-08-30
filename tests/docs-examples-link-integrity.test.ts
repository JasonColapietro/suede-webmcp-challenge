import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "@/lib/catalog";
import {
  DOCS_EXAMPLES,
  resolveDocsExamples,
} from "@/lib/docs-examples";
import { SEED_TEMPLATES } from "@/lib/templates";

function catalogEntry(
  slug: string,
  name: string,
  overrides: Partial<CatalogEntry> = {},
): CatalogEntry {
  return Object.assign({
    id: `agent-${slug}`,
    slug,
    name,
    summary: "Input › LLM › Output",
    description: null,
    priceUsdc: 0.08,
    calls: 0,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: 1,
    settlementLive: false,
    acceptsPayment: false,
    paymentState: "preview" as const,
    previewAvailable: true,
    publishedLive: true,
    payTo: "0x0000000000000000000000000000000000000000",
    schedule: null,
    inputSchema: { type: "object" },
    urls: {
      public: `/a/${slug}`,
      run: `/api/agents/${slug}/run`,
      x402: `/api/agents/${slug}/.well-known/x402`,
      agentCard: `/api/agents/${slug}/.well-known/agent-card`,
      a2a: `/api/agents/${slug}/a2a`,
    },
  }, overrides);
}

describe("docs example link integrity", () => {
  it("keeps every example attached to a real buildable template", () => {
    const templateSlugs = new Set(SEED_TEMPLATES.map((template) => template.slug));
    expect(DOCS_EXAMPLES).toHaveLength(6);
    expect(new Set(DOCS_EXAMPLES.map((example) => example.templateSlug)).size)
      .toBe(DOCS_EXAMPLES.length);
    for (const example of DOCS_EXAMPLES) {
      expect(templateSlugs.has(example.templateSlug)).toBe(true);
    }
  });

  it("only emits listing links supplied by the same catalog used by the sitemap", () => {
    const catalog = [
      catalogEntry("contract-red-flag-scan-chm9v", "Contract Red-Flag Scan"),
      catalogEntry("unrelated-agent-abc12", "Unrelated Agent"),
    ];
    const resolved = resolveDocsExamples(catalog);
    const listingHrefs = resolved.flatMap((example) =>
      example.listing ? [example.listing.href] : [],
    );

    expect(listingHrefs).toEqual(["/a/contract-red-flag-scan-chm9v"]);
    expect(
      listingHrefs.every((href) =>
        catalog.some((entry) => entry.urls.public === href),
      ),
    ).toBe(true);
    expect(resolved.filter((example) => example.listing === null)).toHaveLength(5);
  });

  it("prefers the strongest current launch when multiple listings match", () => {
    const resolved = resolveDocsExamples([
      catalogEntry("lead-qualifier-old11", "Lead Qualifier", {
        calls: 2,
        createdAt: 20,
      }),
      catalogEntry("lead-qualifier-live22", "Lead Qualifier", {
        calls: 5,
        createdAt: 10,
      }),
    ]);
    const lead = resolved.find(
      (example) => example.templateSlug === "lead-qualifier",
    );

    expect(lead?.listing?.href).toBe("/a/lead-qualifier-live22");
  });

  it("does not retain any retired hardcoded listing suffix", async () => {
    const [examplesPage, launchingPage] = await Promise.all([
      readFile(
        new URL("../src/app/docs/examples/page.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/app/docs/launching/page.tsx", import.meta.url),
        "utf8",
      ),
    ]);
    const source = `${examplesPage}\n${launchingPage}`;

    for (const retired of [
      "invoice-chaser-49vii",
      "listing-quality-qa-gate-u32mc",
      "pr-diff-digest-0dd3t",
      "support-ticket-triage-6my5h",
      "lead-qualifier-6x8xw",
    ]) {
      expect(source).not.toContain(retired);
    }
  });
});
