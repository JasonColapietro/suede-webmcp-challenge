import { describe, it, expect } from "vitest";
import { SEED_TEMPLATES } from "@/lib/templates";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { codegen } from "@/lib/manifest/codegen";
import type { AgentManifest } from "@/lib/manifest/schema";

const MINIMAL_MANIFEST: AgentManifest = {
  manifestVersion: 1,
  name: "price-watcher",
  description: "Watches a product page.",
  triggers: [{ kind: "schedule", cron: "0 13 * * *" }, { kind: "paidCall", priceUsdc: 0.25 }],
  steps: [
    { id: "s1", type: "input", config: {}, after: [] },
    { id: "s2", type: "llm", config: { prompt: "Extract the price." }, after: ["s1"] },
    { id: "s3", type: "output", config: {}, after: ["s2"] },
  ],
  meta: {},
};

// ── Law 4a: Determinism ───────────────────────────────────────────────────────
describe("Law 4a — codegen determinism", () => {
  it("produces byte-identical output for the same manifest called twice", () => {
    const out1 = codegen(MINIMAL_MANIFEST);
    const out2 = codegen(MINIMAL_MANIFEST);
    expect(out1).toBe(out2);
  });

  it("produces byte-identical output across seed templates", () => {
    for (const tpl of SEED_TEMPLATES) {
      const manifest = flowToManifest(tpl.graph);
      expect(codegen(manifest)).toBe(codegen(manifest));
    }
  });
});

// ── Law 4b: Frozen API names ──────────────────────────────────────────────────
describe("Law 4b — frozen @suedeai/agents API in emitted source", () => {
  it("imports only from @suedeai/agents", () => {
    const src = codegen(MINIMAL_MANIFEST);
    expect(src).toContain('from "@suedeai/agents"');
    // No other import statements
    const importLines = src.split("\n").filter((l) => l.startsWith("import "));
    expect(importLines.length).toBe(1);
  });

  it("uses defineAgent as the default export wrapper", () => {
    const src = codegen(MINIMAL_MANIFEST);
    expect(src).toContain("export default defineAgent(");
  });

  it("uses schedule() helper for schedule triggers", () => {
    const manifest = flowToManifest(
      SEED_TEMPLATES.find((t) => t.slug === "support-pulse-digest")!.graph,
    );
    const src = codegen(manifest);
    expect(src).toContain('schedule("');
  });

  it("uses paidCall() helper for paidCall triggers", () => {
    const manifest = flowToManifest(
      SEED_TEMPLATES.find((t) => t.slug === "lead-qualifier")!.graph,
    );
    const src = codegen(manifest);
    expect(src).toContain("paidCall(");
  });
});

// ── Law 4c: Contains agent name ───────────────────────────────────────────────
describe("Law 4c — emitted source contains agent metadata", () => {
  it("emits the agent name as a string field", () => {
    const src = codegen(MINIMAL_MANIFEST);
    expect(src).toContain('"price-watcher"');
  });

  it("includes step ids in the run body", () => {
    const src = codegen(MINIMAL_MANIFEST);
    for (const step of MINIMAL_MANIFEST.steps) {
      expect(src).toContain(step.id);
    }
  });

  it("includes step type names in the run body", () => {
    const src = codegen(MINIMAL_MANIFEST);
    for (const step of MINIMAL_MANIFEST.steps) {
      expect(src).toContain(step.type);
    }
  });
});

// ── Snapshot test ─────────────────────────────────────────────────────────────
describe("codegen snapshot", () => {
  it("emits expected source for the minimal manifest (snapshot)", () => {
    const src = codegen(MINIMAL_MANIFEST);
    expect(src).toMatchSnapshot();
  });
});

// ── Branch routing ────────────────────────────────────────────────────────────
const BRANCH_MANIFEST: AgentManifest = {
  manifestVersion: 1,
  name: "branch-agent",
  description: "Routes on a branch.",
  triggers: [{ kind: "manual" }],
  steps: [
    { id: "n1", type: "input", config: {}, after: [] },
    { id: "n2", type: "branch", config: { field: "ok", truthy: true }, after: ["n1"] },
    { id: "n3", type: "llm", config: { prompt: "true path" }, after: [{ node: "n2", handle: "true" }] },
    { id: "n4", type: "llm", config: { prompt: "false path" }, after: [{ node: "n2", handle: "false" }] },
  ],
  meta: {},
};

describe("codegen — branch routing reflects the handle a step is wired to", () => {
  it("captures the branch step's result and routes on its handle", () => {
    const src = codegen(BRANCH_MANIFEST);
    expect(src).toContain("const n2Result = await suede.run(\"branch\"");
    expect(src).toContain("const n2Handle = ");
    expect(src).toContain('if (n2Handle === "true")');
    expect(src).toContain('} else if (n2Handle === "false")');
  });

  it("nests the true-branch step inside the true arm, not flat", () => {
    const src = codegen(BRANCH_MANIFEST);
    const trueArmStart = src.indexOf('if (n2Handle === "true")');
    const falseArmStart = src.indexOf('} else if (n2Handle === "false")');
    const n3Index = src.indexOf("// step: n3 (llm)");
    const n4Index = src.indexOf("// step: n4 (llm)");
    expect(trueArmStart).toBeGreaterThan(-1);
    expect(n3Index).toBeGreaterThan(trueArmStart);
    expect(n3Index).toBeLessThan(falseArmStart);
    expect(n4Index).toBeGreaterThan(falseArmStart);
  });

  it("does not emit n3 or n4 as flat, unconditional steps outside the guard", () => {
    const src = codegen(BRANCH_MANIFEST);
    // Each of the guarded steps' step-comment line should appear exactly once
    // (inside its arm), not once flat plus once nested.
    const n3Occurrences = src.split("// step: n3 (llm)").length - 1;
    const n4Occurrences = src.split("// step: n4 (llm)").length - 1;
    expect(n3Occurrences).toBe(1);
    expect(n4Occurrences).toBe(1);
  });

  it("leaves an ordinary branch step (no handle-tagged children) unconditional, as before", () => {
    const manifest = flowToManifest(
      SEED_TEMPLATES.find((t) => t.slug === "site-monitor")!.graph,
    );
    const src = codegen(manifest);
    expect(src).not.toContain("Handle = ");
    for (const step of manifest.steps) {
      expect(src).toContain(`// step: ${step.id} (${step.type})`);
    }
  });
});
