import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const lyricsParamsSchema = z.object({ prompt: z.string().optional() });

export const lyricsNode = suedeNode(
  getNodeDefinition("suede.lyrics"),
  SUEDE_ENDPOINTS.lyrics,
  lyricsParamsSchema,
  (params, inputs) => ({
    prompt: params.prompt ?? inputs.in ?? inputs.result ?? "",
  }),
);
