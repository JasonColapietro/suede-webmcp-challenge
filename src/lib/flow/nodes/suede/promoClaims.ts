import { z } from "zod";
import { defineExecutableNode, type NodeDef } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";

export const PROMO_CLAIM_STATUSES = [
  "claimed",
  "submitted",
  "verifying",
  "approved",
  "rejected",
  "inconclusive",
  "forfeited",
  "disputed",
  "expired",
  "settlement_pending",
  "payout_failed",
  "paid",
  "verification_source_unavailable",
] as const;

export const promoClaimsParamsSchema = z.object({
  statuses: z
    .array(z.enum(PROMO_CLAIM_STATUSES))
    .min(1)
    .default(["inconclusive", "disputed"])
    .describe("Claim statuses to fetch"),
  campaignId: z.string().uuid().optional().describe("Limit to one campaign"),
  limit: z.number().int().min(1).max(500).default(200),
});

/**
 * Read-only mirror over Promo's claim ledger. Promo stays the system of
 * record: this node fetches, never mutates, and dry-run never touches the
 * network.
 */
const dryRunStub: NodeDef["executor"] = async (_ctx, rawParams, _inputs) => {
  try {
    promoClaimsParamsSchema.parse(rawParams);
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
  return {
    ok: true,
    outputs: { claims: { claims: [], total: 0, dryRun: true } },
    costUsdc: 0,
  };
};

export const promoClaimsNode = defineExecutableNode(
  getNodeDefinition("suede.promoClaims"),
  {
    paramsSchema: promoClaimsParamsSchema,
    dryRunStub,
    executor: async (ctx, rawParams, _inputs) => {
      let params;
      try {
        params = promoClaimsParamsSchema.parse(rawParams);
      } catch (e) {
        return { ok: false, error: errMessage(e), costUsdc: 0 };
      }

      // The engine's central dry-run gate substitutes `dryRunStub` before
      // this executor can run; the inline check is a redundant second layer.
      if (ctx.dryRun) {
        return dryRunStub(ctx, rawParams, _inputs);
      }

      // Fail before the network call when this deployment has no Promo
      // credential, so the operator sees missing config rather than a bare
      // upstream 401 that reads like a Promo outage.
      const promoKey = process.env.PROMO_AGENT_KEY;
      if (!promoKey) {
        return {
          ok: false,
          error:
            "Promo is not configured: PROMO_AGENT_KEY is not set on this deployment.",
          costUsdc: 0,
        };
      }

      const query = new URLSearchParams({
        status: params.statuses.join(","),
        limit: String(params.limit),
      });
      if (params.campaignId) query.set("campaignId", params.campaignId);

      let response: Response;
      try {
        response = await fetch(
          `https://promo.suedeai.ai/api/agent/claims?${query.toString()}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${promoKey}`,
            },
          },
        );
      } catch (e) {
        return {
          ok: false,
          error: `Promo API fetch error: ${errMessage(e)}`,
          costUsdc: 0,
        };
      }

      if (response.status !== 200) {
        return {
          ok: false,
          error: `Promo API error: ${response.status}`,
          costUsdc: 0,
        };
      }

      let data: { claims: unknown[]; total: number };
      try {
        data = (await response.json()) as typeof data;
      } catch (e) {
        return {
          ok: false,
          error: `Promo API parse error: ${errMessage(e)}`,
          costUsdc: 0,
        };
      }

      return { ok: true, outputs: { claims: data }, costUsdc: 0 };
    },
  },
);
