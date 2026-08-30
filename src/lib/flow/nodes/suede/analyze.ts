import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const analyzeParamsSchema = z.object({
  audioUrl: z.string().optional(),
});

export const analyzeNode = suedeNode(
  getNodeDefinition("suede.analyze"),
  SUEDE_ENDPOINTS.analyze,
  analyzeParamsSchema,
  (params, inputs) => ({ audioUrl: params.audioUrl ?? pickUrl(inputs) }),
);

function pickUrl(inputs: Record<string, unknown>): unknown {
  const v = inputs.in ?? inputs.result;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o.assetUrl ?? o.audioUrl ?? o.url ?? v;
  }
  return v;
}
