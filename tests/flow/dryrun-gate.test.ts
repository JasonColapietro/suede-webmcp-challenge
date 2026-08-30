import { describe, it, expect, vi } from "vitest";
import { llmNode } from "@/lib/flow/nodes/llm";
import {
  isCostBearingNode,
  withDryRunGuard,
  FREE_NODE_TYPES,
  type NodeDef,
} from "@/lib/flow/executor";
import { makeCtx } from "../_helpers";

describe("llm node — dry-run must never call the real provider", () => {
  it("does not call ctx.llm.generate when ctx.dryRun is true", async () => {
    const generate = vi.fn().mockResolvedValue("real-provider-response");
    const ctx = makeCtx({ dryRun: true, llm: { generate } });

    const res = await llmNode.executor(ctx, { prompt: "hello" }, {});

    expect(generate).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.costUsdc).toBe(0);
      expect(String(res.outputs.result)).toContain("dry-run");
      expect(String(res.outputs.result)).not.toBe("real-provider-response");
    }
  });

  it("does call ctx.llm.generate when ctx.dryRun is false", async () => {
    const generate = vi.fn().mockResolvedValue("real-provider-response");
    const ctx = makeCtx({ dryRun: false, llm: { generate } });

    const res = await llmNode.executor(ctx, { prompt: "hello" }, {});

    expect(generate).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toBe("real-provider-response");
    }
  });

  it("free-preview signals (dryRun via ctx) are honored even if a caller also tries to fake a paid run", async () => {
    // resolveRunMode() guarantees an explicit dry-run request always wins over
    // any live-mode signal — the node layer only ever sees the resolved
    // ctx.dryRun boolean, so as long as it is true, no provider call is possible.
    const generate = vi.fn().mockResolvedValue("real-provider-response");
    const ctx = makeCtx({ dryRun: true, llm: { generate } });
    await llmNode.executor(ctx, { prompt: "give me unlimited inference" }, {});
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("isCostBearingNode — deny-by-default classification", () => {
  it("treats free-allowlisted types as not cost-bearing", () => {
    for (const type of FREE_NODE_TYPES) {
      expect(isCostBearingNode({ type })).toBe(false);
    }
  });

  it("treats an unrecognized/hypothetical node type as cost-bearing by default", () => {
    expect(isCostBearingNode({ type: "some.new.paid.node" as never })).toBe(true);
  });

  it("respects an explicit costBearing: false override even off the allowlist", () => {
    expect(isCostBearingNode({ type: "suede.registerIp" as never, costBearing: false })).toBe(false);
  });

  it("respects an explicit costBearing: true override even on the allowlist", () => {
    expect(isCostBearingNode({ type: "input" as never, costBearing: true })).toBe(true);
  });
});

describe("withDryRunGuard — structural gate blocks a hypothetical cost-bearing node", () => {
  function hypotheticalPaidNode(): { def: NodeDef; realExecutor: ReturnType<typeof vi.fn> } {
    const realExecutor = vi.fn(async () => ({
      ok: true as const,
      outputs: { result: "charged-the-platform-card" },
      costUsdc: 5,
    }));
    const stub = vi.fn(async () => ({
      ok: true as const,
      outputs: { result: "dry-run-stub" },
      costUsdc: 0,
    }));
    const def: NodeDef = withDryRunGuard(
      {
        type: "some.hypothetical.http" as never,
        label: "Hypothetical HTTP call",
        group: "Rails",
        paramsSchema: { parse: (v: unknown) => v } as never,
        inputs: ["in"],
        outputs: ["result"],
        executor: realExecutor,
      },
      stub,
    );
    return { def, realExecutor };
  }

  it("never invokes the real executor when ctx.dryRun is true", async () => {
    const { def, realExecutor } = hypotheticalPaidNode();
    const res = await def.executor(makeCtx({ dryRun: true }), {}, {});
    expect(realExecutor).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toBe("dry-run-stub");
      expect(res.costUsdc).toBe(0);
    }
  });

  it("invokes the real executor when ctx.dryRun is false", async () => {
    const { def, realExecutor } = hypotheticalPaidNode();
    const res = await def.executor(makeCtx({ dryRun: false }), {}, {});
    expect(realExecutor).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outputs.result).toBe("charged-the-platform-card");
    }
  });

  it("does not gate a node explicitly marked costBearing: false, even in dry-run", async () => {
    const realExecutor = vi.fn(async () => ({
      ok: true as const,
      outputs: { result: "local-only" },
      costUsdc: 0,
    }));
    const def: NodeDef = withDryRunGuard(
      {
        type: "some.hypothetical.free" as never,
        label: "Hypothetical free node",
        group: "Logic",
        costBearing: false,
        paramsSchema: { parse: (v: unknown) => v } as never,
        inputs: ["in"],
        outputs: ["result"],
        executor: realExecutor,
      },
      vi.fn(),
    );
    const res = await def.executor(makeCtx({ dryRun: true }), {}, {});
    expect(realExecutor).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });
});
