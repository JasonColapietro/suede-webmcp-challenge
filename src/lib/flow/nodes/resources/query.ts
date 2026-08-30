import { z } from "zod";
import { RESOURCE_FOUNDRY_ENABLED } from "@/lib/resources/flags";
import { executeResourceQuery } from "@/lib/resources/query";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";

const SHA256 = /^[a-f0-9]{64}$/u;

export const RESOURCE_QUERY_NODE_REFUSAL = "Resource query is unavailable.";

export const resourceQueryNodeParamsSchema = z.object({
  resourceProductId: z.string().trim().min(1).max(128),
  packVersionId: z.string().trim().min(1).max(128),
  resourcePackContentHash: z.string().regex(SHA256),
  filterFields: z.array(z.string().trim().min(1).max(128)).max(64),
  returnFields: z.array(z.string().trim().min(1).max(128)).max(64),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

function refusal() {
  return { ok: false, error: RESOURCE_QUERY_NODE_REFUSAL, costUsdc: 0 } as const;
}

export const createResourceQueryExecutor = (
  enabled = RESOURCE_FOUNDRY_ENABLED,
): NodeExecutor => async (ctx, rawParams, inputs) => {
  if (!enabled) return refusal();
  try {
    const params = resourceQueryNodeParamsSchema.parse(rawParams);
    if (inputs.filters === null || typeof inputs.filters !== "object" || Array.isArray(inputs.filters)) {
      return refusal();
    }
    const reference = {
      resourceProductId: params.resourceProductId,
      packVersionId: params.packVersionId,
      contentHash: params.resourcePackContentHash,
    };
    const resolved = await ctx.resolveResourcePack(reference);
    if (!resolved || (resolved.status !== "approved" && resolved.status !== "live")) return refusal();
    const { bundle } = resolved;
    if (
      bundle.resourceProductId !== reference.resourceProductId ||
      bundle.packVersionId !== reference.packVersionId ||
      bundle.semanticHash !== reference.contentHash ||
      bundle.freshness !== "fresh" ||
      resourcePackSemanticHash(bundle.content).semanticHash !== reference.contentHash
    ) return refusal();
    const output = await executeResourceQuery(
      { getExactPack: async () => bundle },
      {
        resourceProductId: reference.resourceProductId,
        packVersionId: reference.packVersionId,
        semanticHash: reference.contentHash,
        filters: inputs.filters as never,
        filterFields: params.filterFields,
        returnFields: params.returnFields,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      },
    );
    return {
      ok: true,
      outputs: { result: output.result, resourceReceipt: output.resourceReceipt },
      costUsdc: 0,
    };
  } catch {
    return refusal();
  }
};

export const resourceQueryNode = defineExecutableNode(getNodeDefinition("resource.query"), {
  paramsSchema: resourceQueryNodeParamsSchema,
  executor: createResourceQueryExecutor(),
});
