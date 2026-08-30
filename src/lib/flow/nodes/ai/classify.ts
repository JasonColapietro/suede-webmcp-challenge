/**
 * Constrained classification. The `llm` node can be prompted to categorise
 * something, but it answers in free text: nothing stops it replying "Urgent!"
 * or "I'd say this is urgent" when a downstream Branch or Switch is matching
 * on the exact string "urgent". This node declares the allowed answers up
 * front, normalizes the model's reply against them, and fails loudly rather
 * than emitting a label the flow author never defined.
 *
 * It emits { label, value }: the label to route on, and the original upstream
 * value riding along so a Switch on "label" does not lose the payload.
 *
 * Paid provider call, so the executor is dry-run guarded like `llm`.
 */
import { z } from "zod";
import type { NodeDef } from "../../executor";
import { defineExecutableNode, withDryRunGuard } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";

export const classifyParamsSchema = z.object({
  labels: z.array(z.string().trim().min(1)).min(2).max(50),
  instruction: z.string().optional(),
  model: z.string().optional(),
});

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null, null, 2);
}

function upstream(inputs: Record<string, unknown>): unknown {
  if ("in" in inputs) return inputs.in;
  const keys = Object.keys(inputs);
  return keys.length > 0 ? inputs[keys[0]] : undefined;
}

/** Accept a tidy answer ("Urgent.", "urgent") but never invent a label. */
export function matchLabel(reply: string, labels: readonly string[]): string | null {
  const cleaned = reply.trim().replace(/^["'`]+|["'`.!]+$/g, "").trim();
  const exact = labels.find((label) => label === cleaned);
  if (exact !== undefined) return exact;
  const folded = cleaned.toLowerCase();
  return labels.find((label) => label.toLowerCase() === folded) ?? null;
}

const realExecutor: NodeDef["executor"] = async (ctx, rawParams, inputs) => {
  const params = classifyParamsSchema.parse(rawParams);
  const value = upstream(inputs);
  const system = [
    "You are a classifier.",
    `Reply with exactly one of these labels and nothing else: ${params.labels.join(", ")}.`,
    "Do not explain. Do not add punctuation.",
    params.instruction ? `Guidance: ${params.instruction}` : "",
  ].filter(Boolean).join(" ");

  try {
    const reply = await ctx.llm.generate(asText(value), { system, model: params.model });
    const label = matchLabel(reply, params.labels);
    if (label === null) {
      return {
        ok: false,
        error: `Model replied ${JSON.stringify(reply.trim().slice(0, 120))}, which is not one of the declared labels (${params.labels.join(", ")}).`,
        costUsdc: 0,
      };
    }
    return { ok: true, outputs: { result: { label, value } }, costUsdc: 0 };
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
};

const dryRunStub: NodeDef["executor"] = async (_ctx, rawParams, inputs) => {
  const params = classifyParamsSchema.parse(rawParams);
  // Shape-accurate and label-legal, so a dry run exercises downstream routing
  // without a provider call. Always the first label: deterministic, not a guess.
  return {
    ok: true,
    outputs: { result: { label: params.labels[0], value: upstream(inputs) } },
    costUsdc: 0,
  };
};

export const classifyNode = withDryRunGuard(
  defineExecutableNode(getNodeDefinition("ai.classify"), {
    paramsSchema: classifyParamsSchema,
    executor: realExecutor,
    dryRunStub,
  }),
  dryRunStub,
);
