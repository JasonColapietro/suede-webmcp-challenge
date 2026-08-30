import { z } from "zod";
import { SUEDE_ENDPOINTS } from "../../../rails/suede-endpoints";
import { getNodeDefinition } from "../../node-definitions";
import { suedeNode } from "./factory";

export const chainChatParamsSchema = z.object({
  message: z.string().optional(),
});

export const chainChatNode = suedeNode(
  getNodeDefinition("suede.chainChat"),
  SUEDE_ENDPOINTS.chainChat,
  chainChatParamsSchema,
  (params, inputs) => ({
    message: params.message ?? inputs.in ?? inputs.result ?? "",
  }),
);
