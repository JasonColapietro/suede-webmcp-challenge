import { describe, expect, it } from "vitest";
import { codegen } from "@/lib/manifest/codegen";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import { manifestToFlow } from "@/lib/manifest/to-flow";

const MANIFEST_FIXTURES: ReadonlyArray<{ name: string; manifest: unknown }> = [
  {
    name: "manual trigger",
    manifest: {
      manifestVersion: 1,
      name: "Manual Research Brief",
      description: "Turns a prompt into a concise research brief.",
      triggers: [{ kind: "manual" }],
      steps: [
        { id: "request", type: "input", config: {}, after: [] },
        {
          id: "research",
          type: "llm",
          config: { system: "Be concise.", prompt: "Research {{in}}" },
          after: ["request"],
        },
        { id: "brief", type: "output", config: { label: "brief" }, after: ["research"] },
      ],
      meta: {},
    },
  },
  {
    name: "schedule plus paid-call triggers",
    manifest: {
      manifestVersion: 1,
      name: "Scheduled Paid Monitor",
      description: "Runs each morning and accepts paid on-demand calls.",
      triggers: [
        { kind: "schedule", cron: "15 9 * * 1-5" },
        { kind: "paidCall", priceUsdc: 0.125 },
      ],
      steps: [
        { id: "fetch", type: "http", config: { url: "https://example.com/feed" }, after: [] },
        { id: "summarize", type: "llm", config: { prompt: "Summarize {{in}}" }, after: ["fetch"] },
      ],
      meta: {},
    },
  },
  {
    name: "manual plus webhook triggers",
    manifest: {
      manifestVersion: 1,
      name: "Webhook Classifier",
      description: "Classifies manually supplied or webhook-delivered payloads.",
      triggers: [{ kind: "manual" }, { kind: "webhook" }],
      steps: [
        { id: "payload", type: "input", config: {}, after: [] },
        { id: "classify", type: "llm", config: { prompt: "Classify {{in}}" }, after: ["payload"] },
      ],
      meta: {},
    },
  },
  {
    name: "payout address and supported metadata",
    manifest: {
      manifestVersion: 1,
      name: "Creator Rights Desk",
      description: "Preserves payout and supported authoring metadata.",
      triggers: [{ kind: "paidCall", priceUsdc: 0.5 }],
      steps: [
        { id: "asset", type: "input", config: {}, after: [] },
        { id: "lookup", type: "suede.rightsLookup", config: { network: "base" }, after: ["asset"] },
        { id: "result", type: "output", config: { label: "rights" }, after: ["lookup"] },
      ],
      payoutAddress: "0x1111111111111111111111111111111111111111",
      meta: {
        template: "creator-rights-desk",
        createdBy: "code",
      },
    },
  },
  {
    name: "branching graph",
    manifest: {
      manifestVersion: 1,
      name: "Branching Review Gate",
      description: "Routes approved and rejected work to separate outputs.",
      triggers: [{ kind: "manual" }],
      steps: [
        { id: "submission", type: "input", config: {}, after: [] },
        {
          id: "gate",
          type: "branch",
          config: { expression: "input.score >= 80" },
          after: ["submission"],
        },
        { id: "approved", type: "output", config: { label: "approved" }, after: ["gate"] },
        { id: "rejected", type: "output", config: { label: "rejected" }, after: ["gate"] },
      ],
      meta: {},
    },
  },
  {
    name: "multi-root and multi-parent DAG",
    manifest: {
      manifestVersion: 1,
      name: "Multi-Source Synthesis",
      description: "Joins two independent roots before producing one answer.",
      triggers: [{ kind: "webhook" }],
      steps: [
        { id: "account", type: "input", config: { field: "account" }, after: [] },
        { id: "activity", type: "input", config: { field: "activity" }, after: [] },
        {
          id: "synthesis",
          type: "llm",
          config: { prompt: "Combine the account and activity inputs." },
          after: ["account", "activity"],
        },
        { id: "answer", type: "output", config: { label: "answer" }, after: ["synthesis"] },
      ],
      meta: {},
    },
  },
];

describe("Manifest v1 compatibility", () => {
  it("keeps v1 parse and compile bytes free of v2 keys", () => {
    const parsed = AgentManifestSchema.parse(MANIFEST_FIXTURES[0].manifest);
    const bytes = JSON.stringify(parsed);
    const compiled = flowToManifest(manifestToFlow(parsed));

    expect(JSON.stringify(compiled)).toBe(bytes);
    expect(compiled).not.toHaveProperty("graph");
    expect(compiled.schemaVersion).toBeUndefined();
  });

  for (const fixture of MANIFEST_FIXTURES) {
    it(`deep-round-trips ${fixture.name}`, () => {
      const parsed = AgentManifestSchema.parse(fixture.manifest);

      expect(flowToManifest(manifestToFlow(parsed))).toEqual(parsed);
    });

    it(`generates byte-identical source for ${fixture.name}`, () => {
      const parsed = AgentManifestSchema.parse(fixture.manifest);

      expect(codegen(parsed)).toBe(codegen(parsed));
    });
  }
});
