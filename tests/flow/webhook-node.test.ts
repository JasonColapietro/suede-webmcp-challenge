import { describe, it, expect } from "vitest";
import { webhookNode, webhookParamsSchema } from "@/lib/flow/nodes/webhook";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { NODE_META, getNodeMeta } from "@/lib/flow/node-meta";
import { FREE_NODE_TYPES } from "@/lib/flow/executor";
import { makeCtx } from "../_helpers";

describe("webhook node registration", () => {
  it("is registered in the server executor list and client-safe meta", () => {
    expect(NODE_DEFS.some((d) => d.type === "webhook")).toBe(true);
    expect(NODE_META.some((m) => m.type === "webhook")).toBe(true);
    expect(getNodeMeta("webhook")?.group).toBe("Triggers");
    expect(getNodeMeta("webhook")?.priceUsdc).toBeUndefined();
  });

  it("declares no inputs (a trigger node) and one output", () => {
    expect(webhookNode.inputs).toEqual([]);
    expect(webhookNode.outputs).toEqual(["result"]);
  });

  it("is on the free-node allowlist (never gated by dry-run, never bills)", () => {
    expect(FREE_NODE_TYPES).toContain("webhook");
  });

  it("every declared field has a label and a hint", () => {
    const meta = getNodeMeta("webhook");
    expect(meta).toBeDefined();
    for (const field of meta?.fields ?? []) {
      expect(field.label, `field "${field.key}" missing a label`).toBeTruthy();
      expect(field.hint, `field "${field.key}" missing a hint`).toBeTruthy();
    }
  });
});

describe("webhook node executor", () => {
  it("forwards its trigger inputs through to the result output", async () => {
    const res = await webhookNode.executor(makeCtx(), {}, { event: "push", ref: "main" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toEqual({ event: "push", ref: "main" });
      expect(res.costUsdc).toBe(0);
    }
  });

  it("accepts an optional note param purely for documentation", () => {
    expect(() => webhookParamsSchema.parse({ note: "GitHub push events" })).not.toThrow();
    expect(() => webhookParamsSchema.parse({})).not.toThrow();
  });
});
