/**
 * Multi-way router. `branch` only answers true/false, so a four-way decision
 * meant chaining three branch nodes and threading the same value through each
 * one. This reads a field, looks it up in a case map, and emits on exactly one
 * of a/b/c/d, or on fallback when nothing matches.
 *
 * Emitting a single handle is what makes the routing real: the engine treats
 * an edge whose source handle is absent from the outputs as inactive, which is
 * the same mechanism `branch` relies on.
 *
 * Local computation only, so it is free and runs natively in dry-run.
 */
import { z } from "zod";
import { defineExecutableNode } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";

const OUTPUTS = ["a", "b", "c", "d"] as const;
type SwitchOutput = (typeof OUTPUTS)[number];

export const switchParamsSchema = z.object({
  field: z.string().default("value"),
  cases: z.record(z.string(), z.enum(OUTPUTS)).default({}),
});

function firstValue(inputs: Record<string, unknown>): unknown {
  if ("in" in inputs) return inputs.in;
  const keys = Object.keys(inputs);
  return keys.length > 0 ? inputs[keys[0]] : undefined;
}

/** Case keys are JSON object keys, so match on the string form of the value. */
function caseKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return null;
}

export const switchNode = defineExecutableNode(getNodeDefinition("logic.switch"), {
  paramsSchema: switchParamsSchema,
  executor: async (_ctx, rawParams, inputs) => {
    const params = switchParamsSchema.parse(rawParams ?? {});
    const value = firstValue(inputs);
    const fieldValue =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[params.field]
        : value;
    const key = caseKey(fieldValue);
    const matched: SwitchOutput | undefined =
      key !== null ? params.cases[key] : undefined;
    return {
      ok: true,
      outputs: { [matched ?? "fallback"]: value },
      costUsdc: 0,
    };
  },
});
