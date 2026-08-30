import { z } from "zod";
import { defineExecutableNode } from "../executor";
import { getNodeDefinition } from "../node-definitions";

export const inputParamsSchema = z.object({
  fields: z.record(z.string(), z.unknown()).optional(),
});

export const inputNode = defineExecutableNode(getNodeDefinition("input"), {
  paramsSchema: inputParamsSchema,
  executor: async (_ctx, rawParams, inputs) => {
    const params = inputParamsSchema.parse(rawParams ?? {});
    // Configured default fields, overridden by live trigger inputs.
    return { ok: true, outputs: { result: { ...(params.fields ?? {}), ...inputs } }, costUsdc: 0 };
  },
});
