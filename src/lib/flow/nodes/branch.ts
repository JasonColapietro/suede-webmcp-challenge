import { z } from "zod";
import { defineExecutableNode } from "../executor";
import { getNodeDefinition } from "../node-definitions";

export const branchParamsSchema = z.object({
  field: z.string().default("value"),
  equals: z.unknown().optional(),
  truthy: z.boolean().default(true),
});

function firstValue(inputs: Record<string, unknown>): unknown {
  if ("in" in inputs) return inputs.in;
  const keys = Object.keys(inputs);
  return keys.length > 0 ? inputs[keys[0]] : undefined;
}

export const branchNode = defineExecutableNode(getNodeDefinition("branch"), {
  paramsSchema: branchParamsSchema,
  executor: async (_ctx, rawParams, inputs) => {
    const params = branchParamsSchema.parse(rawParams ?? {});
    const value = firstValue(inputs);
    const fieldValue =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[params.field]
        : value;
    const pass =
      params.equals !== undefined
        ? fieldValue === params.equals
        : Boolean(fieldValue) === params.truthy;
    // Only the taken handle is emitted; the engine treats the other as inactive.
    return { ok: true, outputs: pass ? { true: value } : { false: value }, costUsdc: 0 };
  },
});
