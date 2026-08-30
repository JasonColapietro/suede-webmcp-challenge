import { describe, expect, it } from "vitest";
import { collectRun, runFlow } from "@/lib/flow/engine";
import { getRegistry } from "@/lib/flow/registry";
import { codegen } from "@/lib/manifest/codegen";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import { SEED_TEMPLATES } from "@/lib/templates";
import { makeCtx } from "../_helpers";

// Deliberate re-pin (trigger contracts): the input node was never the only way
// a caller's arguments enter a graph — `schedule` and `webhook` forward the run
// payload through the identical `outputs: { result: <trigger input> }` shape.
// deriveInputSchema keyed off the input node alone, so all 12 scheduled
// templates published `additionalProperties: false`, telling a calling model to
// send nothing to prompts that interpolate {{in}}. Schedule and webhook nodes
// now carry the same `fields` config the input node has, and the nine scheduled
// templates that genuinely read their payload name it, which changes those
// nodes' `params` and the compiled manifest's `config` in the snapshot.
//
// The five templates that truly take no arguments now say so with an explicit
// `fields: {}` — song-register-royalty, campaign-launcher, competitor-tracker,
// site-monitor, campaign-watch — which keeps them at
// `additionalProperties: false` rather than letting them fall back to a bare
// `{ type: "object" }`. Every one of the 87 now publishes either named
// properties or a closed schema; none is left uninformative. Node counts,
// edges, wiring, prompts, and metadata are untouched here, and all 87 still
// dry-run to "done" at zero cost.
//
// Deliberate re-pin (llm payload, four prompts): ar-analyst,
// daily-research-digest, inbox-triage-brief, and invoice-chaser each fed an
// llm node from an upstream edge whose output the prompt never interpolated.
// `interpolate(params.prompt, inputs)` is that executor's only input channel,
// so the upstream was silently discarded every run — on ar-analyst that meant
// paying suede.analyze in USDC and throwing the analysis away. Each prompt now
// ends with a labeled `{{in}}` payload section, the same shape the input-node
// templates already used. Only `prompt` strings change: no node, edge, handle,
// param, or metadata is touched, and all 87 still dry-run to "done" at zero
// cost. These four have no input node, so no published MCP schema moves.
//
// Deliberate re-pin (input contracts): 57 templates authored no `fields` on
// their input node, so `deriveInputSchema` published a bare `{ type: "object" }`
// — an MCP tool a model cannot call without guessing, on a path that debits the
// caller before the run. Every input node whose payload a downstream node
// actually reads now names its real fields, which changes that node's `params`
// (and the compiled manifest's `config`) throughout the snapshot. Five prompts
// that described an input they never interpolated also gained the `{{in}}` token
// that makes the declared contract true: grade-rebuilder,
// brand-audit-to-contest-brief, creator-shortlist-for-brief, meeting-prep, and
// faq-concierge. song-register-royalty and campaign-launcher stay field-less on
// purpose — their downstream nodes read params only, so naming fields would
// advertise arguments the graph drops. Node counts, edges, wiring, and metadata
// are untouched, and all 87 still dry-run to "done" at zero cost.
// Deliberate re-pin (catalog addition): ai-visibility-prospector joins the
// Sales department — a standard input→llm→output llmAgent with a named input
// contract (prospect, clientBrand, category, engineTranscripts,
// senderCredentials). No existing template's graph, manifest, codegen, or
// dry-run moves; the snapshot gains exactly one entry and the count moves
// 87 → 88.
describe("template v0 compatibility", () => {
  it("freezes all 88 templates across FlowGraph v1, Manifest v1, codegen, and dry-run", async () => {
    const templates = [...SEED_TEMPLATES].sort((a, b) =>
      a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
    );
    const compatibilityPayload = [];

    for (const template of templates) {
      const manifest = flowToManifest(template.graph);
      const dryRun = await collectRun(
        runFlow(template.graph, makeCtx(), getRegistry(), {}),
      );

      compatibilityPayload.push({
        slug: template.slug,
        metadata: {
          name: template.name,
          pitch: template.pitch,
          description: template.description,
          whoPays: template.whoPays,
          suggestedPriceUsdc: template.suggestedPriceUsdc,
          category: template.category,
        },
        graph: template.graph,
        manifest,
        generatedSource: codegen(manifest),
        rebuiltGraph: manifestToFlow(manifest),
        dryRun: {
          status: dryRun.status,
          totalCostUsdc: dryRun.totalCostUsdc,
        },
      });
    }

    expect(compatibilityPayload).toHaveLength(88);
    expect(compatibilityPayload).toMatchSnapshot();
  });
});
