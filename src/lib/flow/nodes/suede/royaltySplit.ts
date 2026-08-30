import { z } from "zod";
import { defineExecutableNode } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";

export const royaltySplitParamsSchema = z.object({
  splits: z
    .array(
      z.object({
        payee: z.string().min(1),
        bps: z.number().int().min(0).max(10000),
      }),
    )
    .min(1, "at least one split required"),
});

/**
 * Local node: builds a basis-point royalty split table for the upstream
 * asset. costBearing: false is explicit: this executor never touches the
 * network or ctx.x402 at all — it is pure local arithmetic over its own
 * params and inputs, so it is always safe to run for real, dry-run or not.
 */
export const royaltySplitNode = defineExecutableNode(
  getNodeDefinition("suede.royaltySplit"),
  {
    paramsSchema: royaltySplitParamsSchema,
    executor: async (_ctx, rawParams, inputs) => {
      let params;
      try {
        params = royaltySplitParamsSchema.parse(rawParams);
      } catch (e) {
        return { ok: false, error: errMessage(e), costUsdc: 0 };
      }
      const total = params.splits.reduce((sum, s) => sum + s.bps, 0);
      if (total > 10000) {
        return {
          ok: false,
          error: `Royalty splits exceed 100% (${total} bps)`,
          costUsdc: 0,
        };
      }
      return {
        ok: true,
        outputs: {
          result: {
            asset: inputs.in ?? inputs.result ?? null,
            totalBps: total,
            splits: params.splits,
          },
        },
        costUsdc: 0,
      };
    },
  },
);
