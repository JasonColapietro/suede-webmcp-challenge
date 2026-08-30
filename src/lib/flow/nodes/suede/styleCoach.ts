import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const styleCoachParamsSchema = z.object({
  seed: z.string().optional(),
});

export const styleCoachNode = suedeNode(
  getNodeDefinition("suede.styleCoach"),
  SUEDE_ENDPOINTS.styleCoach,
  styleCoachParamsSchema,
  (params, inputs) => ({
    seed: params.seed ?? inputs.in ?? inputs.result ?? "",
  }),
);
