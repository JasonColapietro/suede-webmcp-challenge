import { describe, it, expect } from "vitest";
import { styleCoachNode } from "@/lib/flow/nodes/suede/styleCoach";
import { royaltySplitNode } from "@/lib/flow/nodes/suede/royaltySplit";
import { registerIpNode } from "@/lib/flow/nodes/suede/registerIp";
import { promoNode } from "@/lib/flow/nodes/suede/promo";
import { branchNode } from "@/lib/flow/nodes/branch";
import { getNodeMeta } from "@/lib/flow/node-meta";
import { makeCtx } from "../_helpers";

describe("suede nodes", () => {
  it("styleCoach returns a dry-run result with zero cost", async () => {
    const res = await styleCoachNode.executor(makeCtx(), { seed: "lo-fi" }, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.costUsdc).toBe(0);
      expect((res.outputs.result as Record<string, unknown>).dryRun).toBe(true);
    }
  });

  it("royaltySplit rejects splits over 100%", async () => {
    const res = await royaltySplitNode.executor(
      makeCtx(),
      { splits: [{ payee: "a", bps: 7000 }, { payee: "b", bps: 4000 }] },
      {},
    );
    expect(res.ok).toBe(false);
  });

  it("registerIp produces a deterministic asset hash", async () => {
    // The real executor now writes on-chain; determinism is a property of
    // the hash, exercised via the dry-run stub (what a dry run executes).
    const asset = { assetUrl: "ipfs://x" };
    const stub = registerIpNode.dryRunStub!;
    const a = await stub(makeCtx(), {}, { in: asset });
    const b = await stub(makeCtx(), {}, { in: asset });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect((a.outputs.result as Record<string, unknown>).assetHash).toEqual(
        (b.outputs.result as Record<string, unknown>).assetHash,
      );
    }
  });

  it("promo accepts a custom hashtags array end to end", async () => {
    const res = await promoNode.executor(
      makeCtx(),
      {
        name: "Summer Drop",
        brief: "Post a clip using the track",
        rewardUsdc: 5,
        hashtags: ["#summerdrop", "#suede"],
      },
      {},
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.costUsdc).toBe(0);
      expect((res.outputs.campaign as Record<string, unknown>).name).toBe(
        "Summer Drop",
      );
    }
  });

  it("promo rejects a raw string hashtags value", async () => {
    const res = await promoNode.executor(
      makeCtx(),
      {
        name: "Drop",
        brief: "Post a clip",
        rewardUsdc: 5,
        hashtags: "#summerdrop",
      },
      {},
    );

    expect(res.ok).toBe(false);
  });

  it("promo metadata edits hashtags as a JSON array field", () => {
    const field = getNodeMeta("suede.promo")?.fields.find(
      (candidate) => candidate.key === "hashtags",
    );
    expect(field?.kind).toBe("json");
  });

  it("branch routes to the true handle on a truthy field", async () => {
    const res = await branchNode.executor(
      makeCtx(),
      { field: "ok", truthy: true },
      { in: { ok: true } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect("true" in res.outputs).toBe(true);
      expect("false" in res.outputs).toBe(false);
    }
  });
});
