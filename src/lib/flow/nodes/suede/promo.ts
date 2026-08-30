import { z } from "zod";
import { defineExecutableNode, type NodeDef } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";

export const promoParamsSchema = z.object({
  name: z.string().min(1).describe("Campaign name"),
  brief: z.string().min(1).describe("What creators need to do"),
  rewardUsdc: z.number().positive().describe("Reward per slot in USDC"),
  slotCap: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(25)
    .describe("Max campaign slots"),
  hashtags: z
    .array(z.string())
    .default(["#suede"])
    .describe("Required hashtags"),
});

/**
 * Synthetic dry-run stub. Promo has its own external billing, so this node
 * is $0 to Suede (canonical free cost) — but a live call creates a real
 * campaign at promo.suedeai.ai, an external side effect. Never calls fetch.
 */
const dryRunStub: NodeDef["executor"] = async (_ctx, rawParams, _inputs) => {
  let params;
  try {
    params = promoParamsSchema.parse(rawParams);
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
  return {
    ok: true,
    outputs: {
      campaign: {
        campaignId: "dry-run",
        campaignUrl: "https://promo.suedeai.ai/c/dry-run",
        name: params.name,
      },
    },
    costUsdc: 0,
  };
};

/** Launches a Promo campaign via the Promo API. Free node — Promo handles its own billing. */
export const promoNode = defineExecutableNode(
  getNodeDefinition("suede.promo"),
  {
    paramsSchema: promoParamsSchema,
    dryRunStub,
    executor: async (ctx, rawParams, _inputs) => {
      let params;
      try {
        params = promoParamsSchema.parse(rawParams);
      } catch (e) {
        return { ok: false, error: errMessage(e), costUsdc: 0 };
      }

      // Belt-and-suspenders: the engine's central dry-run gate (executeNode)
      // never lets this real executor run while ctx.dryRun is true — it
      // substitutes `dryRunStub` above instead. This inline check is kept as
      // a second, redundant layer in case this executor is ever invoked some
      // other way that isn't gated centrally.
      if (ctx.dryRun) {
        return dryRunStub(ctx, rawParams, _inputs);
      }

      // Fail before the network call when this deployment has no Promo
      // credential. Without this the request goes out as `Bearer ` (empty),
      // Promo answers 401, and the operator sees a bare "Promo API error: 401"
      // that reads like a Promo outage rather than missing local config — and
      // they see it *after* the caller has already paid for the run.
      const promoKey = process.env.PROMO_AGENT_KEY;
      if (!promoKey) {
        return {
          ok: false,
          error:
            "Promo is not configured: PROMO_AGENT_KEY is not set on this deployment.",
          costUsdc: 0,
        };
      }

      const agentId =
        (ctx as unknown as Record<string, unknown>).agentId ?? null;

      let response: Response;
      try {
        response = await fetch(
          "https://promo.suedeai.ai/api/agent/create-campaign",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${promoKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: params.name,
              brief: params.brief,
              rewardUsdc6: Math.round(params.rewardUsdc * 1_000_000),
              slotCap: params.slotCap,
              hashtags: params.hashtags,
              sourceAgentId: agentId,
              sourceFlowId: ctx.runId,
            }),
          },
        );
      } catch (e) {
        return {
          ok: false,
          error: `Promo API fetch error: ${errMessage(e)}`,
          costUsdc: 0,
        };
      }

      if (response.status !== 201) {
        return {
          ok: false,
          error: `Promo API error: ${response.status}`,
          costUsdc: 0,
        };
      }

      let data: { campaignId: string; campaignUrl: string };
      try {
        data = (await response.json()) as typeof data;
      } catch (e) {
        return {
          ok: false,
          error: `Promo API parse error: ${errMessage(e)}`,
          costUsdc: 0,
        };
      }

      return {
        ok: true,
        outputs: {
          campaign: {
            campaignId: data.campaignId,
            campaignUrl: data.campaignUrl,
            name: params.name,
          },
        },
        costUsdc: 0,
      };
    },
  },
);
