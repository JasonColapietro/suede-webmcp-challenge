/**
 * Public pages must never hardcode a catalog number. Four SEO pages once
 * asserted "42 node types" and "86 public templates" as literals; the catalog
 * moved and the pages silently started lying. Every count now renders from
 * NODE_META / buildTemplateCatalogStats / COMPANY_TEMPLATES, and this test
 * fails the moment a literal creeps back in.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_META } from "@/lib/flow/node-meta";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { buildTemplateCatalogStats } from "@/lib/template-summaries";

const ROOT = join(__dirname, "..");

/** Public marketing surfaces that quote catalog sizes in body copy. */
const PUBLIC_PAGES = [
  "src/app/page.tsx",
  "src/app/about/page.tsx",
  "src/app/fit/page.tsx",
  "src/app/templates/page.tsx",
  "src/app/x402-agent-builder/page.tsx",
  "src/app/no-code-ai-agent-platform/page.tsx",
  "src/app/ai-agent-marketplace-payments/page.tsx",
  "src/components/landing/Faq.tsx",
];

describe("public copy never hardcodes catalog counts", () => {
  it("quotes no literal that equals a current catalog size", () => {
    const counts = {
      "node types": NODE_META.length,
      "public templates": buildTemplateCatalogStats().total,
      "company templates": COMPANY_TEMPLATES.length,
    } as const;

    const offenders: string[] = [];
    for (const relative of PUBLIC_PAGES) {
      const source = readFileSync(join(ROOT, relative), "utf8");
      for (const [noun, count] of Object.entries(counts)) {
        // A literal number immediately followed by the noun it counts, e.g.
        // "42 node types". Interpolated forms read ${...} and never match.
        const literal = new RegExp(`\\b\\d+[- ]${noun.replace(" ", "[- ]")}`, "g");
        for (const hit of source.match(literal) ?? []) {
          offenders.push(`${relative}: "${hit}" (should render from the ${count}-item source)`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
