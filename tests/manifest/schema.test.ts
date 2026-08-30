import { describe, it, expect } from "vitest";
import { AgentManifestSchema } from "@/lib/manifest/schema";

describe("AgentManifestSchema", () => {
  it("accepts a minimal valid manifest (manual trigger, one step)", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "test-agent",
      triggers: [{ kind: "manual" }],
      steps: [{ id: "s1", type: "llm", config: {}, after: [] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a schedule trigger with a valid cron", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "sched",
      triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
      steps: [{ id: "s1", type: "llm" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a schedule trigger with an invalid cron", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "bad-sched",
      triggers: [{ kind: "schedule", cron: "not-a-cron" }],
      steps: [{ id: "s1", type: "llm" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a paidCall trigger with a non-negative price", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "paid",
      triggers: [{ kind: "paidCall", priceUsdc: 0.25 }],
      steps: [{ id: "s1", type: "input" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a paidCall trigger with a negative price", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "paid-bad",
      triggers: [{ kind: "paidCall", priceUsdc: -1 }],
      steps: [{ id: "s1", type: "input" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a manifest with no triggers", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "x",
      triggers: [],
      steps: [{ id: "s1", type: "llm" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a manifest with no steps", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "x",
      triggers: [{ kind: "manual" }],
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  it("defaults description to empty string when omitted", () => {
    const result = AgentManifestSchema.parse({
      manifestVersion: 1,
      name: "x",
      triggers: [{ kind: "manual" }],
      steps: [{ id: "s1", type: "llm" }],
    });
    expect(result.description).toBe("");
  });

  it("defaults step.config to {} and step.after to [] when omitted", () => {
    const result = AgentManifestSchema.parse({
      manifestVersion: 1,
      name: "x",
      triggers: [{ kind: "manual" }],
      steps: [{ id: "s1", type: "llm" }],
    });
    expect(result.steps[0].config).toEqual({});
    expect(result.steps[0].after).toEqual([]);
  });

  it("accepts a webhook trigger", () => {
    const result = AgentManifestSchema.safeParse({
      manifestVersion: 1,
      name: "wh",
      triggers: [{ kind: "webhook" }],
      steps: [{ id: "s1", type: "input" }],
    });
    expect(result.success).toBe(true);
  });

  // ── step.after: string | { node, handle? } ─────────────────────────────────
  describe("step.after accepts both the legacy plain-string shape and the handle-tagged object shape", () => {
    it("accepts plain-string after entries (pre-handle-support manifests)", () => {
      const result = AgentManifestSchema.safeParse({
        manifestVersion: 1,
        name: "legacy",
        triggers: [{ kind: "manual" }],
        steps: [
          { id: "s1", type: "input", config: {}, after: [] },
          { id: "s2", type: "output", config: {}, after: ["s1"] },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.steps[1]!.after).toEqual(["s1"]);
      }
    });

    it("accepts a handle-tagged object after entry", () => {
      const result = AgentManifestSchema.safeParse({
        manifestVersion: 1,
        name: "branchy",
        triggers: [{ kind: "manual" }],
        steps: [
          { id: "s1", type: "branch", config: {}, after: [] },
          { id: "s2", type: "output", config: {}, after: [{ node: "s1", handle: "true" }] },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.steps[1]!.after).toEqual([{ node: "s1", handle: "true" }]);
      }
    });

    it("accepts a handle-tagged object entry with no handle (equivalent to the default)", () => {
      const result = AgentManifestSchema.safeParse({
        manifestVersion: 1,
        name: "no-handle-object",
        triggers: [{ kind: "manual" }],
        steps: [
          { id: "s1", type: "loop", config: {}, after: [] },
          { id: "s2", type: "output", config: {}, after: [{ node: "s1" }] },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects an after entry that is neither a string nor a { node } object", () => {
      const result = AgentManifestSchema.safeParse({
        manifestVersion: 1,
        name: "bad-after",
        triggers: [{ kind: "manual" }],
        steps: [{ id: "s1", type: "input", config: {}, after: [{ handle: "true" }] }],
      });
      expect(result.success).toBe(false);
    });
  });
});
