import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const stemsParamsSchema = z.object({ audioUrl: z.string().optional() });

export const stemsNode = suedeNode(
  getNodeDefinition("suede.stems"),
  SUEDE_ENDPOINTS.stems,
  stemsParamsSchema,
  (params, inputs) => ({ audioUrl: params.audioUrl ?? extractUrl(inputs) }),
);

function extractUrl(inputs: Record<string, unknown>): unknown {
  const v = inputs.in ?? inputs.result;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o.assetUrl ?? o.audioUrl ?? o.url ?? v;
  }
  return v;
}
