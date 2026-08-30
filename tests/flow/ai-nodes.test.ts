/**
 * Cover for the AI nodes. The point of both is that they constrain the model
 * instead of trusting it, so most of this is about what happens when the
 * model answers badly, plus proof that a dry run never reaches a provider.
 */
import { describe, expect, it, vi } from "vitest";
import { classifyNode, matchLabel } from "@/lib/flow/nodes/ai/classify";
import { extractNode, parseObjectReply, shapeResult } from "@/lib/flow/nodes/ai/extract";
import type { NodeContext, NodeResult } from "@/lib/flow/executor";

function expectSuccess(result: NodeResult): asserts result is Extract<NodeResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
}

function expectFailure(result: NodeResult): asserts result is Extract<NodeResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected node failure");
}

function ctxWith(reply: string, dryRun = false) {
  const generate = vi.fn(async (_prompt: string, _options?: { system?: string }) => reply);
  return {
    ctx: { dryRun, llm: { generate } } as unknown as NodeContext,
    generate,
  };
}

describe("ai.classify", () => {
  it("routes on a clean label and carries the original value through", async () => {
    const { ctx } = ctxWith("urgent");
    const result = await classifyNode.executor(
      ctx,
      { labels: ["urgent", "normal"] },
      { in: { subject: "server down" } },
    );
    expectSuccess(result);
    expect(result.outputs?.result).toEqual({
      label: "urgent",
      value: { subject: "server down" },
    });
  });

  it("tolerates a tidy but non-exact reply", () => {
    expect(matchLabel("Urgent.", ["urgent", "normal"])).toBe("urgent");
    expect(matchLabel(' "normal" ', ["urgent", "normal"])).toBe("normal");
    expect(matchLabel("URGENT!", ["urgent"])).toBe("urgent");
  });

  it("fails loudly instead of inventing a label the flow never declared", async () => {
    const { ctx } = ctxWith("I would say this one is quite urgent, actually");
    const result = await classifyNode.executor(ctx, { labels: ["urgent", "normal"] }, { in: "x" });
    expectFailure(result);
    // The error has to name what the model actually said, or it is undebuggable.
    expect(result.error).toContain("not one of the declared labels");
    expect(result.error).toContain("urgent, normal");
  });

  it("never invents a label from a near-miss", () => {
    expect(matchLabel("urgently", ["urgent"])).toBeNull();
    expect(matchLabel("", ["urgent"])).toBeNull();
  });

  it("requires at least two labels, since one label is not a decision", () => {
    expect(() => classifyNode.paramsSchema.parse({ labels: ["only"] })).toThrow();
  });

  it("makes no provider call in dry-run and still returns a legal label", async () => {
    const { ctx, generate } = ctxWith("unused", true);
    const result = await classifyNode.executor(ctx, { labels: ["urgent", "normal"] }, { in: "x" });
    expect(generate).not.toHaveBeenCalled();
    expectSuccess(result);
    const label = (result.outputs?.result as { label: string }).label;
    expect(["urgent", "normal"]).toContain(label);
  });
});

describe("ai.extract", () => {
  it("returns exactly the declared fields", async () => {
    const { ctx } = ctxWith('{"email":"a@b.com","budget":5000}');
    const result = await extractNode.executor(
      ctx,
      { fields: ["email", "budget"] },
      { in: "mail me at a@b.com, we have 5000 to spend" },
    );
    expectSuccess(result);
    expect(result.outputs?.result).toEqual({ email: "a@b.com", budget: 5000 });
  });

  it("fills an unmentioned field with null rather than omitting it", () => {
    expect(shapeResult({ email: "a@b.com" }, ["email", "budget"]))
      .toEqual({ email: "a@b.com", budget: null });
  });

  it("drops keys the model volunteered that were never asked for", () => {
    expect(shapeResult({ email: "a@b.com", mood: "keen" }, ["email"]))
      .toEqual({ email: "a@b.com" });
  });

  it("digs the object out of a fenced or chatty reply", () => {
    expect(parseObjectReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseObjectReply('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
    expect(parseObjectReply('{"a":1}')).toEqual({ a: 1 });
  });

  it("refuses a reply that is not an object", () => {
    expect(parseObjectReply("[1,2,3]")).toBeNull();
    expect(parseObjectReply("no idea sorry")).toBeNull();
    expect(parseObjectReply("")).toBeNull();
  });

  it("reports the unusable reply instead of returning empty data", async () => {
    const { ctx } = ctxWith("I could not find anything.");
    const result = await extractNode.executor(ctx, { fields: ["email"] }, { in: "x" });
    expectFailure(result);
    expect(result.error).toContain("did not return a JSON object");
  });

  it("accepts per-field descriptions and sends them to the model", async () => {
    const { ctx, generate } = ctxWith('{"budget":10}');
    const result = await extractNode.executor(
      ctx,
      { fields: { budget: "Annual spend in USD, digits only" } },
      { in: "about ten dollars a year" },
    );
    expectSuccess(result);
    expect(result.outputs?.result).toEqual({ budget: 10 });
    const system = generate.mock.calls[0]?.[1]?.system as string;
    expect(system).toContain("budget (Annual spend in USD, digits only)");
  });

  it("makes no provider call in dry-run and still returns the declared shape", async () => {
    const { ctx, generate } = ctxWith("unused", true);
    const result = await extractNode.executor(ctx, { fields: ["email", "budget"] }, { in: "x" });
    expect(generate).not.toHaveBeenCalled();
    expectSuccess(result);
    expect(result.outputs?.result).toEqual({ email: null, budget: null });
  });
});
