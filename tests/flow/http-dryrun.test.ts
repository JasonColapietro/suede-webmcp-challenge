/**
 * End-to-end (through the engine, not the raw executor) proof that the
 * structural dry-run gate actually stops the http node from firing a real
 * request — the exact hole described in engine.ts's executeNode: an
 * unauthenticated caller forcing ctx.dryRun: true must never cause an
 * outbound fetch, even through a loop.
 */
import { describe, it, expect, vi } from "vitest";
import { runFlow, collectRun } from "@/lib/flow/engine";
import { httpNode, createHttpExecutor } from "@/lib/flow/nodes/http";
import { llmNode } from "@/lib/flow/nodes/llm";
import { loopNode } from "@/lib/flow/nodes/loop";
import { inputNode } from "@/lib/flow/nodes/input";
import { makeCtx, node, edge, graph, registry } from "../_helpers";
import type { FlowNode } from "@/lib/flow/types";

function withParams(n: FlowNode, params: Record<string, unknown>): FlowNode {
  return { ...n, params };
}

const publicLookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

describe("http node — dry-run through the engine performs no outbound fetch", () => {
  it("never calls fetch and returns a stub result", async () => {
    const fetchFn = vi.fn();
    const guardedHttp = { ...httpNode, executor: createHttpExecutor({ fetchFn, lookupFn: publicLookup }) };
    const g = graph(
      [withParams(node("h", "http"), { method: "GET", url: "https://example.com/api" })],
      [],
    );
    const reg = registry([guardedHttp]);
    const ctx = makeCtx({ dryRun: true });

    const { status, outputs } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(status).toBe("done");
    const result = outputs.h.result as { status: number; body: unknown };
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain("dry");
  });

  it("never calls fetch even for a POST/PUT/DELETE method (the actual side-effect risk)", async () => {
    const fetchFn = vi.fn();
    const guardedHttp = { ...httpNode, executor: createHttpExecutor({ fetchFn, lookupFn: publicLookup }) };
    const g = graph(
      [withParams(node("h", "http"), { method: "POST", url: "https://hooks.example.com/slack", body: "{}" })],
      [],
    );
    const reg = registry([guardedHttp]);
    const ctx = makeCtx({ dryRun: true });

    const { status } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(status).toBe("done");
  });
});

describe("http node — live mode still performs a real fetch", () => {
  it("calls fetch when ctx.dryRun is false", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const guardedHttp = { ...httpNode, executor: createHttpExecutor({ fetchFn, lookupFn: publicLookup }) };
    const g = graph(
      [withParams(node("h", "http"), { method: "GET", url: "https://example.com/api" })],
      [],
    );
    const reg = registry([guardedHttp]);
    const ctx = makeCtx({ dryRun: false });

    const { status } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(status).toBe("done");
  });
});

describe("llm node — dry-run through the engine performs no provider call", () => {
  it("never calls ctx.llm.generate", async () => {
    const generate = vi.fn().mockResolvedValue("real-provider-response");
    const g = graph([withParams(node("l", "llm"), { prompt: "hello" })], []);
    const reg = registry([llmNode]);
    const ctx = makeCtx({ dryRun: true, llm: { generate } });

    const { status, outputs } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(generate).not.toHaveBeenCalled();
    expect(status).toBe("done");
    expect(String(outputs.l.result)).toContain("dry-run");
  });

  it("calls ctx.llm.generate for real when ctx.dryRun is false", async () => {
    const generate = vi.fn().mockResolvedValue("real-provider-response");
    const g = graph([withParams(node("l", "llm"), { prompt: "hello" })], []);
    const reg = registry([llmNode]);
    const ctx = makeCtx({ dryRun: false, llm: { generate } });

    const { status, outputs } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(status).toBe("done");
    expect(outputs.l.result).toBe("real-provider-response");
  });
});

describe("engine-level guard is independent of any per-module wrapping", () => {
  it("stubs a cost-bearing node that has NOT been wrapped with withDryRunGuard at all", async () => {
    // Unlike llmNode (wrapped with withDryRunGuard in its own module as a
    // second, redundant layer — see llm.ts), this NodeDef relies entirely
    // on the engine's central gate: costBearing: true + a dryRunStub, with
    // its `executor` left completely bare.
    const realExecutor = vi.fn(async () => ({
      ok: true as const,
      outputs: { result: "charged-the-platform-card" },
      costUsdc: 3,
    }));
    const stubExecutor = vi.fn(async () => ({
      ok: true as const,
      outputs: { result: "dry-run-stub" },
      costUsdc: 0,
    }));
    const unwrappedPaidNode = {
      type: "some.unwrapped.paid.node" as never,
      label: "Unwrapped paid node",
      group: "Rails" as const,
      costBearing: true,
      paramsSchema: { parse: (v: unknown) => v } as never,
      inputs: ["in"],
      outputs: ["result"],
      executor: realExecutor,
      dryRunStub: stubExecutor,
    };
    const g = graph([node("p", "some.unwrapped.paid.node" as never)], []);
    const reg = registry([unwrappedPaidNode]);
    const ctx = makeCtx({ dryRun: true });

    const { status, outputs } = await collectRun(runFlow(g, ctx, reg, {}));

    expect(realExecutor).not.toHaveBeenCalled();
    expect(stubExecutor).toHaveBeenCalledTimes(1);
    expect(status).toBe("done");
    expect(outputs.p.result).toBe("dry-run-stub");
  });
});

describe("loop node — dry-run through a subflow containing an http node", () => {
  it("still executes the loop, but the inner http node performs no outbound fetch", async () => {
    const fetchFn = vi.fn();
    const guardedHttp = { ...httpNode, executor: createHttpExecutor({ fetchFn, lookupFn: publicLookup }) };
    const sub = graph(
      [withParams(node("h", "http"), { method: "POST", url: "https://hooks.example.com/notify" })],
      [],
    );
    const outerGraph = graph(
      [withParams(node("b", "loop"), { flowId: "sub-1" }), node("c", "output")],
      [edge("b", "c")],
    );
    // Two distinct registries: the outer run's registry needs loopNode +
    // an output stub; the loop's own child registry (ctx.registry, used by
    // its nested runFlow call for the subflow body) needs the guarded http
    // node.
    const passthroughOutput = {
      type: "output" as const,
      label: "Output",
      group: "I/O" as const,
      paramsSchema: { parse: (v: unknown) => v } as never,
      inputs: ["in"],
      outputs: ["result"],
      executor: async (_ctx: unknown, _params: unknown, inputs: Record<string, unknown>) => ({
        ok: true as const,
        outputs: { result: inputs },
        costUsdc: 0,
      }),
    };
    const ctx = makeCtx({
      dryRun: true,
      registry: registry([guardedHttp]),
      loadSubflow: async () => sub,
    });

    const { status, outputs } = await collectRun(
      runFlow(outerGraph, ctx, registry([loopNode, passthroughOutput]), { in: [1] }),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(status).toBe("done");
    const loopResult = outputs.b.result as Array<Record<string, Record<string, unknown>>>;
    expect(loopResult).toHaveLength(1);
    const innerHttpResult = loopResult[0].h.result as { status: number };
    expect(innerHttpResult.status).toBe(200);
  });
});

describe("free/pure nodes still execute for real in dry-run (input node, through the engine)", () => {
  it("input runs its real executor and forwards trigger input", async () => {
    const g = graph([node("i", "input")], []);
    const reg = registry([inputNode]);
    const ctx = makeCtx({ dryRun: true });

    const { status, outputs } = await collectRun(runFlow(g, ctx, reg, { seed: "hello" }));

    expect(status).toBe("done");
    expect(outputs.i.result).toEqual({ seed: "hello" });
  });
});
