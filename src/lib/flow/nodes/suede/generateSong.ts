import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const generateSongParamsSchema = z.object({
  prompt: z.string().optional(),
  durationSeconds: z.number().int().positive().optional(),
});

export const generateSongNode = suedeNode(
  getNodeDefinition("suede.generateSong"),
  SUEDE_ENDPOINTS.generateSong,
  generateSongParamsSchema,
  (params, inputs) => ({
    prompt: params.prompt ?? inputs.in ?? inputs.result ?? "",
    durationSeconds: params.durationSeconds,
  }),
);
