import { describe, it, expect } from "vitest";
import { SEED_TEMPLATES } from "@/lib/templates";
import { NODE_TYPE_SET } from "@/lib/flow/node-meta";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import { runFlow, collectRun } from "@/lib/flow/engine";
import { getRegistry } from "@/lib/flow/registry";
import { makeCtx } from "../_helpers";
import type { FlowGraph } from "@/lib/flow/types";

// ── Law 3: Every seed template converts with zero unknown node types ──────────
describe("Law 3 — seed templates: no unknown node types", () => {
  for (const tpl of SEED_TEMPLATES) {
    it(`${tpl.slug} converts cleanly`, () => {
      const manifest = flowToManifest(tpl.graph);
      for (const step of manifest.steps) {
        expect(NODE_TYPE_SET.has(step.type), `unknown type "${step.type}" in ${tpl.slug}`).toBe(true);
      }
      expect(manifest.steps.length).toBeGreaterThan(0);
      expect(manifest.triggers.length).toBeGreaterThan(0);
      expect(manifest.name).toBe(tpl.graph.name);
    });
  }
});

// ── Spot checks for specific trigger detection ────────────────────────────────
describe("flowToManifest — trigger detection", () => {
  it("extracts a schedule trigger from a schedule node", () => {
    const { graph } = SEED_TEMPLATES.find((t) => t.slug === "support-pulse-digest")!;
    const manifest = flowToManifest(graph);
    const sched = manifest.triggers.find((t) => t.kind === "schedule");
    expect(sched).toBeDefined();
    if (sched?.kind === "schedule") {
      expect(sched.cron).toBe("0 9 * * *");
    }
  });

  it("emits a paidCall trigger for a graph with no schedule node", () => {
    const { graph } = SEED_TEMPLATES.find((t) => t.slug === "lead-qualifier")!;
    const manifest = flowToManifest(graph);
    const paid = manifest.triggers.find((t) => t.kind === "paidCall");
    expect(paid).toBeDefined();
  });
});

// ── Step ordering is deterministic ───────────────────────────────────────────
describe("flowToManifest — step ordering", () => {
  it("produces the same step order for the same graph when called twice", () => {
    const { graph } = SEED_TEMPLATES[0];
    const m1 = flowToManifest(graph);
    const m2 = flowToManifest(graph);
    expect(m1.steps.map((s) => s.id)).toEqual(m2.steps.map((s) => s.id));
  });
});

// ── Law 1: flowToManifest(manifestToFlow(m)) deep-equals m ───────────────────
describe("Law 1 — manifest round-trip: flowToManifest(manifestToFlow(m)) ≡ m", () => {
  it("round-trips a manual-trigger manifest", () => {
    const original = {
      manifestVersion: 1 as const,
      name: "echo-agent",
      description: "",
      triggers: [{ kind: "manual" as const }],
      steps: [
        { id: "s1", type: "input" as const, config: {}, after: [] },
        { id: "s2", type: "llm" as const, config: { prompt: "repeat" }, after: ["s1"] },
        { id: "s3", type: "output" as const, config: {}, after: ["s2"] },
      ],
      meta: {},
    };
    const roundTripped = flowToManifest(manifestToFlow(original as Parameters<typeof manifestToFlow>[0]));
    expect(roundTripped.name).toBe(original.name);
    expect(roundTripped.triggers).toEqual(original.triggers);
    expect(roundTripped.steps.map((s) => s.id)).toEqual(original.steps.map((s) => s.id));
    expect(roundTripped.steps.map((s) => s.type)).toEqual(original.steps.map((s) => s.type));
    expect(roundTripped.steps.map((s) => s.config)).toEqual(original.steps.map((s) => s.config));
  });

  it("round-trips a schedule-trigger manifest", () => {
    const original = {
      manifestVersion: 1 as const,
      name: "daily-thing",
      description: "",
      triggers: [{ kind: "schedule" as const, cron: "0 9 * * *" }],
      steps: [
        { id: "n2", type: "suede.styleCoach" as const, config: { seed: "dream pop" }, after: [] },
        { id: "n3", type: "suede.lyrics" as const, config: {}, after: ["n2"] },
        { id: "n4", type: "output" as const, config: {}, after: ["n3"] },
      ],
      meta: {},
    };
    const roundTripped = flowToManifest(manifestToFlow(original as Parameters<typeof manifestToFlow>[0]));
    expect(roundTripped.triggers[0].kind).toBe("schedule");
    if (roundTripped.triggers[0].kind === "schedule") {
      expect(roundTripped.triggers[0].cron).toBe("0 9 * * *");
    }
    expect(roundTripped.steps.map((s) => s.id)).toEqual(original.steps.map((s) => s.id));
  });
});

// ── Law 2: manifestToFlow(flowToManifest(g)) runs identically ────────────────
describe("Law 2 — flow re-run: manifestToFlow(flowToManifest(g)) runs identically", () => {
  for (const tpl of SEED_TEMPLATES) {
    it(`${tpl.slug}: same node count and config`, () => {
      const original = tpl.graph;
      const manifest = flowToManifest(original);
      const rebuilt = manifestToFlow(manifest);

      // Node count: non-schedule nodes in original + optional re-added schedule node
      const origNonScheduleCount = original.nodes.filter((n) => n.type !== "schedule").length;
      const scheduleTrigger = manifest.triggers.find((t) => t.kind === "schedule");
      const expectedNodeCount = scheduleTrigger ? origNonScheduleCount + 1 : origNonScheduleCount;
      expect(rebuilt.nodes.length, `${tpl.slug} node count`).toBe(expectedNodeCount);

      // Every step's config round-trips
      for (const step of manifest.steps) {
        const rebuildNode = rebuilt.nodes.find((n) => n.id === step.id);
        expect(rebuildNode, `step ${step.id} missing in rebuilt graph`).toBeDefined();
        expect(rebuildNode!.params).toEqual(step.config);
      }
    });

    it(`${tpl.slug}: rebuilt graph runs to status "done" in dry-run`, async () => {
      const manifest = flowToManifest(tpl.graph);
      const rebuilt = manifestToFlow(manifest);
      const { status } = await collectRun(
        runFlow(rebuilt, makeCtx(), getRegistry(), {}),
      );
      expect(status, `${tpl.slug} rebuilt run status`).toBe("done");
    });
  }
});

// ── sourceHandle round-trip: branch and loop routing survives compile+decompile ──
describe("sourceHandle round-trip through the manifest", () => {
  const branchGraph: FlowGraph = {
    id: "g-branch",
    name: "branch-flow",
    nodes: [
      { id: "n1", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "n2", type: "branch", params: { field: "ok", truthy: true }, position: { x: 240, y: 0 } },
      { id: "n3", type: "llm", params: { prompt: "true path" }, position: { x: 480, y: 0 } },
      { id: "n4", type: "llm", params: { prompt: "false path" }, position: { x: 480, y: 120 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
      { id: "e2", source: "n2", target: "n3", sourceHandle: "true", targetHandle: "in" },
      { id: "e3", source: "n2", target: "n4", sourceHandle: "false", targetHandle: "in" },
    ],
  };

  const loopGraph: FlowGraph = {
    id: "g-loop",
    name: "loop-flow",
    nodes: [
      { id: "n1", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "n2", type: "loop", params: { flowId: "sub-1" }, position: { x: 240, y: 0 } },
      { id: "n3", type: "output", params: { label: "items" }, position: { x: 480, y: 0 } },
      { id: "n4", type: "output", params: { label: "errors" }, position: { x: 480, y: 120 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
      // Default handle -- no sourceHandle set, same as any ordinary single-output edge.
      { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
      { id: "e3", source: "n2", target: "n4", sourceHandle: "errors", targetHandle: "in" },
    ],
  };

  it("a branch flow's true/false sourceHandles survive flowToManifest", () => {
    const manifest = flowToManifest(branchGraph);
    const n3 = manifest.steps.find((s) => s.id === "n3")!;
    const n4 = manifest.steps.find((s) => s.id === "n4")!;
    expect(n3.after).toEqual([{ node: "n2", handle: "true" }]);
    expect(n4.after).toEqual([{ node: "n2", handle: "false" }]);
  });

  it("a branch flow round-trips with both sourceHandles preserved", () => {
    const manifest = flowToManifest(branchGraph);
    const rebuilt = manifestToFlow(manifest);

    const trueEdge = rebuilt.edges.find((e) => e.source === "n2" && e.target === "n3");
    const falseEdge = rebuilt.edges.find((e) => e.source === "n2" && e.target === "n4");
    expect(trueEdge?.sourceHandle).toBe("true");
    expect(falseEdge?.sourceHandle).toBe("false");

    // Full round-trip: flowToManifest(manifestToFlow(m)) reproduces m's after entries.
    const reManifest = flowToManifest(rebuilt);
    expect(reManifest.steps.find((s) => s.id === "n3")!.after).toEqual(
      manifest.steps.find((s) => s.id === "n3")!.after,
    );
    expect(reManifest.steps.find((s) => s.id === "n4")!.after).toEqual(
      manifest.steps.find((s) => s.id === "n4")!.after,
    );
  });

  it("a loop flow's default and errors sourceHandles survive flowToManifest", () => {
    const manifest = flowToManifest(loopGraph);
    const n3 = manifest.steps.find((s) => s.id === "n3")!;
    const n4 = manifest.steps.find((s) => s.id === "n4")!;
    expect(n3.after).toEqual(["n2"]); // default handle -- plain string, no handle object
    expect(n4.after).toEqual([{ node: "n2", handle: "errors" }]);
  });

  it("a loop flow with a downstream edge on the errors handle round-trips preserved", () => {
    const manifest = flowToManifest(loopGraph);
    const rebuilt = manifestToFlow(manifest);

    const resultEdge = rebuilt.edges.find((e) => e.source === "n2" && e.target === "n3");
    const errorsEdge = rebuilt.edges.find((e) => e.source === "n2" && e.target === "n4");
    expect(resultEdge?.sourceHandle).toBeUndefined();
    expect(errorsEdge?.sourceHandle).toBe("errors");

    const reManifest = flowToManifest(rebuilt);
    expect(reManifest.steps.find((s) => s.id === "n4")!.after).toEqual([
      { node: "n2", handle: "errors" },
    ]);
  });

  it("a simple linear flow's manifest is unchanged by the sourceHandle change (no spurious handle fields)", () => {
    const linearGraph: FlowGraph = {
      id: "g-linear",
      name: "linear-flow",
      nodes: [
        { id: "n1", type: "input", params: {}, position: { x: 0, y: 0 } },
        { id: "n2", type: "llm", params: { prompt: "hi" }, position: { x: 240, y: 0 } },
        { id: "n3", type: "output", params: {}, position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", targetHandle: "in" },
        { id: "e2", source: "n2", target: "n3", targetHandle: "in" },
      ],
    };
    const manifest = flowToManifest(linearGraph);
    expect(manifest.steps.map((s) => ({ id: s.id, after: s.after }))).toEqual([
      { id: "n1", after: [] },
      { id: "n2", after: ["n1"] },
      { id: "n3", after: ["n2"] },
    ]);
    // Every after entry is a bare string -- no `{ node, handle }` object leaks in.
    for (const step of manifest.steps) {
      for (const entry of step.after) {
        expect(typeof entry).toBe("string");
      }
    }
  });

  it("a legacy manifest with plain-string after (no handle info) still parses and produces a valid flow", () => {
    const legacy = {
      manifestVersion: 1 as const,
      name: "legacy-branch",
      description: "",
      triggers: [{ kind: "manual" as const }],
      steps: [
        { id: "n1", type: "input", config: {}, after: [] },
        { id: "n2", type: "branch", config: { truthy: true }, after: ["n1"] },
        // Pre-handle-support manifests only ever had plain-string after entries,
        // even for a branch's targets -- routing info simply didn't exist yet.
        { id: "n3", type: "output", config: {}, after: ["n2"] },
      ],
      meta: {},
    };
    const parsed = AgentManifestSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const flow = manifestToFlow(parsed.data);
    expect(flow.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    const edge = flow.edges.find((e) => e.source === "n2" && e.target === "n3");
    expect(edge).toBeDefined();
    expect(edge?.sourceHandle).toBeUndefined(); // no handle recorded -- falls back to default
  });
});
