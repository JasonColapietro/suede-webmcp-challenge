/**
 * Structured field extraction. The `llm` node returns a string, so pulling an
 * email and a budget out of an enquiry meant prompting for JSON and hoping,
 * then parsing it yourself in a Transform. This node declares the fields,
 * parses the reply, and guarantees the shape: every declared field is present,
 * and anything the text does not mention comes back null instead of missing.
 *
 * Paid provider call, so the executor is dry-run guarded like `llm`.
 */
import { z } from "zod";
import type { NodeDef } from "../../executor";
import { defineExecutableNode, withDryRunGuard } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";

/** Either ["email","budget"] or {"budget":"digits only"} for per-field hints. */
export const extractParamsSchema = z.object({
  fields: z.union([
    z.array(z.string().trim().min(1)).min(1).max(50),
    z.record(z.string().trim().min(1), z.string()),
  ]),
  instruction: z.string().optional(),
  model: z.string().optional(),
});

function fieldSpec(fields: z.infer<typeof extractParamsSchema>["fields"]): {
  names: string[];
  described: string;
} {
  if (Array.isArray(fields)) {
    return { names: [...fields], described: fields.join(", ") };
  }
  const names = Object.keys(fields);
  return {
    names,
    described: names.map((name) => `${name} (${fields[name]})`).join(", "),
  };
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null, null, 2);
}

function upstream(inputs: Record<string, unknown>): unknown {
  if ("in" in inputs) return inputs.in;
  const keys = Object.keys(inputs);
  return keys.length > 0 ? inputs[keys[0]] : undefined;
}

/** Models like to wrap JSON in prose or a ```json fence; take the object. */
export function parseObjectReply(reply: string): Record<string, unknown> | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidates = [fenced?.[1], reply].filter((c): c is string => typeof c === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Declared fields only, in declared order, with absent ones explicitly null. */
export function shapeResult(
  parsed: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const value = parsed[name];
    result[name] = value === undefined ? null : value;
  }
  return result;
}

const realExecutor: NodeDef["executor"] = async (ctx, rawParams, inputs) => {
  const params = extractParamsSchema.parse(rawParams);
  const { names, described } = fieldSpec(params.fields);
  const system = [
    "You extract structured data.",
    `Reply with one JSON object containing exactly these keys: ${described}.`,
    "Use null for anything the text does not state. Do not guess. Reply with JSON only.",
    params.instruction ? `Guidance: ${params.instruction}` : "",
  ].filter(Boolean).join(" ");

  try {
    const reply = await ctx.llm.generate(asText(upstream(inputs)), {
      system,
      model: params.model,
    });
    const parsed = parseObjectReply(reply);
    if (parsed === null) {
      return {
        ok: false,
        error: `Model did not return a JSON object. Reply began: ${JSON.stringify(reply.trim().slice(0, 120))}`,
        costUsdc: 0,
      };
    }
    return { ok: true, outputs: { result: shapeResult(parsed, names) }, costUsdc: 0 };
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
};

const dryRunStub: NodeDef["executor"] = async (_ctx, rawParams) => {
  const params = extractParamsSchema.parse(rawParams);
  const { names } = fieldSpec(params.fields);
  // Correct shape, no invented values, no provider call.
  return { ok: true, outputs: { result: shapeResult({}, names) }, costUsdc: 0 };
};

export const extractNode = withDryRunGuard(
  defineExecutableNode(getNodeDefinition("ai.extract"), {
    paramsSchema: extractParamsSchema,
    executor: realExecutor,
    dryRunStub,
  }),
  dryRunStub,
);
