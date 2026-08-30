import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const masteringParamsSchema = z.object({
  audioUrl: z.string().optional(),
});

export const masteringNode = suedeNode(
  getNodeDefinition("suede.mastering"),
  SUEDE_ENDPOINTS.mastering,
  masteringParamsSchema,
  (params, inputs) => ({ audioUrl: params.audioUrl ?? resolveUrl(inputs) }),
);

function resolveUrl(inputs: Record<string, unknown>): unknown {
  const v = inputs.in ?? inputs.result;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o.assetUrl ?? o.audioUrl ?? o.url ?? v;
  }
  return v;
}
