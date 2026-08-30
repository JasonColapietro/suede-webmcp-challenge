// tests/templates.test.ts
import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SEED_TEMPLATES } from "@/lib/templates";
import { FEATURED_TEMPLATE_PAGES } from "@/lib/featured-templates";
import { NODE_TYPE_SET } from "@/lib/flow/node-meta";
import { deriveInputSchema } from "@/lib/flow/input-contract";
import { flowToManifest } from "@/lib/manifest/from-flow";

/**
 * Templates that take no arguments at all, and say so with `fields: {}`.
 *
 * Each has a forwarding trigger (input / schedule / webhook) whose payload
 * dies at the very next node, because that node reads its own params instead
 * of its inputs: suede.generateSong resolves `params.prompt` before it reads
 * `inputs.in`; suede.promo and suede.promoClaims ignore inputs entirely; and
 * web.fetchUrl takes its `url` from params in the two templates that pin it to
 * a fixed page. Adding a slug here is a claim that the flow genuinely reads
 * nothing from its caller — verify the node after the trigger before you do.
 */
const NO_READABLE_INPUT = new Set([
  "song-register-royalty",
  "campaign-launcher",
  "competitor-tracker",
  "site-monitor",
  "campaign-watch",
]);

/** Trigger node types whose executor forwards the run payload downstream. */
const FORWARDING_TRIGGERS = new Set(["input", "schedule", "webhook"]);

describe("template validation — all 88 templates", () => {
  it("has 88 templates total", () => {
    expect(SEED_TEMPLATES).toHaveLength(88);
  });

  it("every template has a category field", () => {
    for (const t of SEED_TEMPLATES) {
      expect(
        ["business", "personal", "creator"],
        `${t.slug} missing or invalid category`,
      ).toContain(t.category);
    }
  });

  it("every template has a non-empty slug, name, pitch, price >= 0", () => {
    for (const t of SEED_TEMPLATES) {
      expect(t.slug, "slug empty").toBeTruthy();
      expect(t.name, "name empty").toBeTruthy();
      expect(t.pitch, "pitch empty").toBeTruthy();
      expect(t.suggestedPriceUsdc, `${t.slug} price < 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it("every template slug is unique", () => {
    const slugs = SEED_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("featured template SEO routes map to real templates", () => {
    const templateSlugs = new Set(SEED_TEMPLATES.map((t) => t.slug));
    for (const { route, templateSlug } of FEATURED_TEMPLATE_PAGES) {
      expect(templateSlugs.has(templateSlug), `${route} maps to missing template ${templateSlug}`).toBe(true);
      expect(existsSync(`src/app/templates/${route}/page.tsx`), `${route} page missing`).toBe(true);
    }
  });

  it("every template graph uses only known node types", () => {
    for (const t of SEED_TEMPLATES) {
      for (const node of t.graph.nodes) {
        expect(
          NODE_TYPE_SET.has(node.type),
          `${t.slug}: unknown node type "${node.type}"`,
        ).toBe(true);
      }
    }
  });

  it("flowToManifest compiles every template graph without throwing", () => {
    for (const t of SEED_TEMPLATES) {
      expect(() => flowToManifest(t.graph), `${t.slug} failed flowToManifest`).not.toThrow();
    }
  });

  it("every template with a schedule node has a valid 5-field cron", () => {
    for (const t of SEED_TEMPLATES) {
      const scheduleNode = t.graph.nodes.find((n) => n.type === "schedule");
      if (scheduleNode) {
        const cron = scheduleNode.params.cron;
        expect(typeof cron, `${t.slug} cron not a string`).toBe("string");
        const parts = (cron as string).trim().split(/\s+/);
        expect(parts, `${t.slug} cron not 5 fields: "${cron}"`).toHaveLength(5);
      }
    }
  });

  it("every template with a price > 0 compiles a paidCall or schedule trigger", () => {
    for (const t of SEED_TEMPLATES) {
      if (t.suggestedPriceUsdc > 0) {
        const manifest = flowToManifest(t.graph);
        const hasTrigger = manifest.triggers.some(
          (tr) => tr.kind === "paidCall" || tr.kind === "schedule",
        );
        expect(hasTrigger, `${t.slug} has price but no paid/schedule trigger`).toBe(true);
      }
    }
  });

  // A template's trigger node is its published MCP contract: deriveInputSchema
  // turns `params.fields` keys into the JSON Schema a calling model reads. With
  // no fields it derives a bare `{ type: "object" }`, which names nothing — and
  // because the MCP billing path debits the caller before the run, every wrong
  // guess costs a spend-then-refund round trip. This covers schedule and
  // webhook as well as input: a cron is not the only way a scheduled agent
  // runs, and as an MCP tool it takes arguments like any other.
  it("every template with a forwarding trigger publishes a named input schema", () => {
    for (const t of SEED_TEMPLATES) {
      if (!t.graph.nodes.some((n) => FORWARDING_TRIGGERS.has(n.type))) continue;
      if (NO_READABLE_INPUT.has(t.slug)) continue;
      const properties = deriveInputSchema(t.graph).properties;
      expect(
        properties && Object.keys(properties).length > 0,
        `${t.slug}: its trigger node authors no fields, so its MCP tool advertises a bare {"type":"object"} that tells a calling model nothing`,
      ).toBe(true);
    }
  });

  // The allowlist above is an assertion, not an escape hatch. A no-argument
  // template must SAY so with `fields: {}` — that publishes
  // `additionalProperties: false`. Omitting `fields` would publish a bare
  // `{ type: "object" }` that invites a paying caller to send data the graph
  // drops, which is the failure the allowlist exists to prevent, not permit.
  it("every no-argument template closes its schema instead of leaving it bare", () => {
    for (const slug of NO_READABLE_INPUT) {
      const template = SEED_TEMPLATES.find((t) => t.slug === slug);
      expect(template, `${slug} is allowlisted but no longer exists`).toBeDefined();
      expect(
        deriveInputSchema(template!.graph),
        `${slug}: allowlisted as taking no arguments, so its trigger must author an explicit empty fields: {}`,
      ).toEqual({ type: "object", additionalProperties: false });
    }
  });

  // No seed template should reach the bare fallback: it means we could not say
  // whether the agent takes arguments, which is the exact ambiguity that made
  // 24 of 26 production MCP tools uncallable.
  it("no template publishes a bare, uninformative input schema", () => {
    const bare = SEED_TEMPLATES.filter((t) => {
      const schema = deriveInputSchema(t.graph);
      return !schema.properties && schema.additionalProperties !== false;
    }).map((t) => t.slug);
    expect(bare, `these publish a bare {"type":"object"}: ${bare.join(", ")}`).toEqual([]);
  });

  // Declaring a field the flow never reads is worse than declaring none: it
  // invites a paying caller to send data that is silently discarded. Most node
  // types consume their inputs structurally (generateInvoicePdf merges the
  // upstream record, parseSpreadsheet reads fileBase64), which no static check
  // can see — but `llm` is the exception worth pinning: interpolating
  // `params.prompt` is its ONLY channel for inputs, so an llm whose prompt
  // omits {{in}} provably drops everything upstream of it.
  //
  // The gate is the inbound EDGE, not the presence of an input node. A schedule
  // trigger forwards the run's payload the same way an input node does, and a
  // paid upstream (suede.analyze) bills real USDC before handing its result
  // over — an llm that drops either is the same defect, and the input-node
  // framing missed all four. `llm` declares exactly one input port ("in"), so
  // any inbound edge lands on `inputs.in` and `{{in}}` is the only token that
  // can read it. An llm with no inbound edge is fully param-configured and
  // exempt.
  it("every llm node with an inbound edge interpolates the payload", () => {
    for (const t of SEED_TEMPLATES) {
      const fed = new Set(t.graph.edges.map((e) => e.target));
      for (const node of t.graph.nodes) {
        if (node.type !== "llm" || !fed.has(node.id)) continue;
        expect(
          JSON.stringify(node.params ?? {}).includes("{{in"),
          `${t.slug}: llm node "${node.id}" never interpolates {{in}}, so its upstream output never reaches the model`,
        ).toBe(true);
      }
    }
  });

  it("general category templates cover all three: business, personal, creator", () => {
    const categories = new Set(SEED_TEMPLATES.map((t) => t.category));
    expect(categories.has("business")).toBe(true);
    expect(categories.has("personal")).toBe(true);
    expect(categories.has("creator")).toBe(true);
  });
});
