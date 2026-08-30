import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const midiParamsSchema = z.object({ audioUrl: z.string().optional() });

export const midiNode = suedeNode(
  getNodeDefinition("suede.midi"),
  SUEDE_ENDPOINTS.midi,
  midiParamsSchema,
  (params, inputs) => ({ audioUrl: params.audioUrl ?? coerceUrl(inputs) }),
);

function coerceUrl(inputs: Record<string, unknown>): unknown {
  const v = inputs.in ?? inputs.result;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o.assetUrl ?? o.audioUrl ?? o.url ?? v;
  }
  return v;
}
