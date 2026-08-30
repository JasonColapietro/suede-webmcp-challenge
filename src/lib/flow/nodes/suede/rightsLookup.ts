import { z } from "zod";
import { defineExecutableNode } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { errMessage } from "../_util";
import { suedeEndpointPrice } from "./factory";

export const rightsLookupParamsSchema = z.object({
  assetHash: z.string().optional(),
});

/** Resolve the assetHash to look up from params or the upstream value. */
function resolveAssetHash(
  params: { assetHash?: string },
  inputs: Record<string, unknown>,
): string {
  const upstream = inputs.in ?? inputs.result;
  const hashFromInput =
    upstream && typeof upstream === "object"
      ? (upstream as Record<string, unknown>).assetHash
      : upstream;
  return (
    params.assetHash ?? (typeof hashFromInput === "string" ? hashFromInput : "")
  );
}

/** GET /v1/rights/{assetHash} — bespoke because the hash is in the path. */
const rightsLookupDefinition = getNodeDefinition("suede.rightsLookup");
const rightsLookupPrice = suedeEndpointPrice(
  rightsLookupDefinition,
  SUEDE_ENDPOINTS.rightsLookup,
);

export const rightsLookupNode = defineExecutableNode(rightsLookupDefinition, {
  paramsSchema: rightsLookupParamsSchema,
  executor: async (ctx, rawParams, inputs) => {
    let params;
    try {
      params = rightsLookupParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
    const assetHash = resolveAssetHash(params, inputs);
    if (!assetHash) {
      return {
        ok: false,
        error: "rightsLookup requires an assetHash",
        costUsdc: 0,
      };
    }
    try {
      const res = await ctx.x402.call(
        `${SUEDE_ENDPOINTS.rightsLookup.path}/${assetHash}`,
        undefined,
        { method: "GET", priceUsdc: rightsLookupPrice },
      );
      return {
        ok: true,
        outputs: { result: res.data, settled: res.settled, dryRun: res.dryRun },
        costUsdc: res.costUsdc,
      };
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
  },
  // Same shape as suedeDryRunStub in factory.ts (this node is bespoke —
  // the assetHash is path-interpolated, so it isn't built via suedeNode()
  // — but the engine's central dry-run gate needs a stub here exactly the
  // same way). Never calls ctx.x402.call().
  dryRunStub: async (_ctx, rawParams, inputs) => {
    let params;
    try {
      params = rightsLookupParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
    const assetHash = resolveAssetHash(params, inputs);
    if (!assetHash) {
      return {
        ok: false,
        error: "rightsLookup requires an assetHash",
        costUsdc: 0,
      };
    }
    return {
      ok: true,
      outputs: {
        result: {
          dryRun: true,
          path: `${SUEDE_ENDPOINTS.rightsLookup.path}/${assetHash}`,
          method: "GET",
          echo: null,
        },
        settled: false,
        dryRun: true,
      },
      costUsdc: 0,
    };
  },
});
