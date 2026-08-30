import { z } from "zod";
import { defineExecutableNode } from "../executor";
import { getNodeDefinition } from "../node-definitions";

export const outputParamsSchema = z.object({ label: z.string().optional() });

export const outputNode = defineExecutableNode(getNodeDefinition("output"), {
  paramsSchema: outputParamsSchema,
  executor: async (_ctx, _rawParams, inputs) => {
    return { ok: true, outputs: { result: inputs }, costUsdc: 0 };
  },
});
