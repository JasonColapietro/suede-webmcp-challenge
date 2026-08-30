/**
 * The WebMCP storefront tool projection.
 *
 * The budget assertions here are the real gate on the descriptors: Chrome
 * truncates an over-budget description silently, so an overrun would ship as a
 * price or a review-policy caveat quietly vanishing from what a spending agent
 * reads. Pure functions only — no DOM, no fetch.
 */
import { describe, it, expect } from "vitest";
import { withinBudgets, WEBMCP_BUDGETS } from "@/lib/webmcp/protocol";
import {
  describeShelfPrice,
  formatServiceDetail,
  formatServiceList,
  matchServices,
  storefrontToolSpecs,
  WEBMCP_TOOL_NAMES,
} from "@/lib/webmcp/storefront";
import { describeWhatItDoes } from "@/lib/webmcp/storefront";
import type { ShelfEntry } from "@/lib/webmcp/shelf-contract";
import { describePrice, toolNameForSlug } from "@/lib/mcp/tools";

function entry(over: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    id: "id-1",
    slug: "contract-review",
    name: "Contract Review",
    summary: "Reads a vendor contract and flags renewal risk.",
    description: null,
    priceUsdc: 2,
    inputSchema: { type: "object", properties: { contract: { type: "string" } } },
    tags: ["contract", "legal", "renewal"],
    readiness: {
      state: "live",
      publishedLive: true,
      acceptsPayment: true,
      previewAvailable: true,
      hasSettledCalls: true,
      settledCalls: 4,
      lastCallAt: 1,
    },
    urls: {
      public: "https://agents.suedeai.ai/a/contract-review",
      run: "https://agents.suedeai.ai/api/agents/contract-review/run",
      x402: "x",
      agentCard: "c",
      a2a: "a",
    },
    ...over,
  };
}

describe("storefront descriptors", () => {
  const specs = storefrontToolSpecs();

  it("registers exactly the four-tool funnel", () => {
    expect(specs.map((s) => s.name)).toEqual([
      WEBMCP_TOOL_NAMES.find,
      WEBMCP_TOOL_NAMES.get,
      WEBMCP_TOOL_NAMES.preview,
      WEBMCP_TOOL_NAMES.buy,
    ]);
  });

  it("keeps every descriptor inside Chrome's character budgets", () => {
    for (const spec of specs) {
      expect(withinBudgets(spec), `${spec.name} exceeds a budget`).toBe(true);
      expect(spec.name.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolName);
      expect(spec.description.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolDescription);
    }
  });

  it("marks every tool's output as untrusted, not just search", () => {
    // Creator-authored names and pitches reach all four outputs.
    for (const spec of specs) {
      expect(spec.annotations.untrustedContentHint, spec.name).toBe(true);
    }
  });

  it("advertises only the two non-spending tools as read-only", () => {
    const readOnly = Object.fromEntries(
      specs.map((s) => [s.name, s.annotations.readOnlyHint]),
    );
    expect(readOnly[WEBMCP_TOOL_NAMES.find]).toBe(true);
    expect(readOnly[WEBMCP_TOOL_NAMES.get]).toBe(true);
    // A dry-run burns no inference but writes a durable runs row.
    expect(readOnly[WEBMCP_TOOL_NAMES.preview]).toBe(false);
    expect(readOnly[WEBMCP_TOOL_NAMES.buy]).toBe(false);
  });

  it("requires the agreed price to be echoed back on the spending tool", () => {
    const buy = specs.find((s) => s.name === WEBMCP_TOOL_NAMES.buy);
    expect(buy?.inputSchema.required).toContain("confirmedPriceUsdc");
  });

  it("keeps the service contract out of get_service's description", () => {
    // The 500-char budget cannot hold pitch + price + buyerIntent + reviewPolicy,
    // so the contract belongs in the 1500-char output instead.
    const get = specs.find((s) => s.name === WEBMCP_TOOL_NAMES.get);
    expect(get?.description).not.toMatch(/inputSchema|reviewPolicy|dataHandling/);
  });
});

describe("price vocabulary", () => {
  it("matches the HTTP MCP wording exactly, so both surfaces quote one price", () => {
    for (const price of [0, 0.5, 1, 2, 12.5, 100]) {
      expect(describeShelfPrice(price)).toBe(describePrice(price));
    }
  });

  it("reads a zero price as free, never as 0 USDC", () => {
    expect(describeShelfPrice(0)).toBe("Free to call.");
    expect(describeShelfPrice(0)).not.toContain("0 USDC");
  });
});

describe("HTTP MCP tool names are left alone", () => {
  it("does not repoint toolNameForSlug, which existing clients cache", () => {
    expect(toolNameForSlug("contract-review")).toBe("run_contract-review");
  });
});

describe("matchServices", () => {
  it("ranks a stated need above an unrelated entry", () => {
    const hit = entry();
    const miss = entry({ slug: "z-photo", name: "Photo Resizer", summary: "Resizes images.", tags: [] });
    const ranked = matchServices([miss, hit], "review a vendor contract for renewal risk");
    expect(ranked[0]?.slug).toBe("contract-review");
  });

  it("caps results at ten however large the requested limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => entry({ slug: `s-${i}`, id: `i-${i}` }));
    expect(matchServices(many, "contract", 999)).toHaveLength(10);
  });

  it("breaks ties on slug so ordering is stable", () => {
    const a = entry({ slug: "aaa", id: "a", tags: ["contract"] });
    const b = entry({ slug: "bbb", id: "b", tags: ["contract"] });
    expect(matchServices([b, a], "contract").map((e) => e.slug)).toEqual(["aaa", "bbb"]);
  });

  it("returns NOTHING when nothing matches, rather than shelf order", () => {
    // Returning zero-hit entries sorted by slug presents shelf order as
    // relevance. An agent cannot tell that from a real result set.
    const a = entry({ slug: "aaa", id: "a", tags: [] });
    const b = entry({ slug: "bbb", id: "b", tags: [] });
    for (const need of ["book me a flight to Tokyo", "xyzzy quux frobnicate"]) {
      expect(matchServices([b, a], need), need).toEqual([]);
    }
  });
});

describe("what a listing says it does", () => {
  it("prefers the creator pitch over the derived node chain", () => {
    // Production `summary` is "Input › LLM (Claude) › Output" on most of the
    // shelf, so rendering it makes every listing read identically.
    const topology = entry({
      summary: "Input › LLM (Claude) › Output",
      description: "Flags renewal risk in a vendor contract.",
    });
    expect(describeWhatItDoes(topology)).toBe("Flags renewal risk in a vendor contract.");
    expect(formatServiceList([topology], 1)).toContain("Flags renewal risk");
    expect(formatServiceList([topology], 1)).not.toContain("Input ›");
  });

  it("falls back to the summary when there is no pitch", () => {
    expect(describeWhatItDoes(entry({ description: null, summary: "Does a thing." })))
      .toBe("Does a thing.");
  });
});

describe("formatServiceList", () => {
  it("stays inside the output budget and reports what it dropped", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      entry({ slug: `service-${i}`, id: `i-${i}`, summary: "S".repeat(200) }),
    );
    const out = formatServiceList(many, 40);
    expect(out.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolOutput);
    expect(out).toMatch(/not shown/);
  });

  it("says so plainly when nothing matches", () => {
    expect(formatServiceList([], 0)).toMatch(/no services right now/i);
    // A miss against a stocked shelf must read differently from an empty shelf.
    expect(formatServiceList([], 6)).toMatch(/shelf has 6/);
  });

  it("reports availability read back from the server projection", () => {
    const notBuyable = entry({
      readiness: { ...entry().readiness, acceptsPayment: false, previewAvailable: true },
    });
    expect(formatServiceList([notBuyable], 1)).toContain("preview only, not buyable");
  });
});

describe("formatServiceDetail", () => {
  it("stays inside the output budget", () => {
    const huge = entry({
      description: "D".repeat(4000),
      exampleInput: { blob: "x".repeat(4000) },
    });
    expect(formatServiceDetail(huge).length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolOutput);
  });

  it("keeps every included JSON part parseable rather than clipping one", () => {
    // A blob cut mid-string fails JSON.parse AND eats the budget a smaller
    // part could have used intact.
    const detail = formatServiceDetail(
      entry({
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
        outputSchema: { type: "object", properties: { huge: { description: "z".repeat(3000) } } },
        exampleInput: { contract: "a short example" },
      }),
    );
    expect(detail.length).toBeLessThanOrEqual(WEBMCP_BUDGETS.toolOutput);
    for (const [, json] of detail.matchAll(/^(?:Input contract|Example input|Returns): (.+)$/gmu)) {
      expect(() => JSON.parse(json) as unknown, json.slice(0, 60)).not.toThrow();
    }
    expect(detail).toContain("Omitted, too large to inline: return shape.");
  });

  it("keeps the worked example over the return schema when space is short", () => {
    // A dry-run stubs every fetch and model node, so exampleOutput is the only
    // thing that can show a buyer what it is paying for.
    const detail = formatServiceDetail(
      entry({
        outputSchema: { type: "object", properties: { big: { description: "y".repeat(2500) } } },
        exampleInput: { contract: "text" },
      }),
    );
    expect(detail).toContain("Example input");
    expect(detail).not.toContain("Returns:");
  });

  it("puts price and review policy ahead of the example payload", () => {
    const detail = formatServiceDetail(
      entry({
        curation: {
          key: "k",
          collection: "business-operations",
          operator: "Suede Labs AI",
          buyerIntent: "For buyers who need X.",
          reviewPolicy: "A human reviews every result.",
          dataHandling: "Inputs are retained for 30 days.",
        },
        exampleInput: { contract: "text" },
      }),
    );
    expect(detail.indexOf("Costs 2 USDC")).toBeLessThan(detail.indexOf("A human reviews"));
    expect(detail.indexOf("A human reviews")).toBeLessThan(detail.indexOf("Example input"));
  });

  it("does not claim Suede review for an ordinary customer listing", () => {
    expect(formatServiceDetail(entry({ curation: undefined }))).toContain("not reviewed by Suede");
  });
});
