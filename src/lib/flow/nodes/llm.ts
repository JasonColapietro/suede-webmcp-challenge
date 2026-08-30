import { z } from "zod";
import { gatewayCostUsdc } from "@/lib/billing";
import type { NodeDef } from "../executor";
import { defineExecutableNode, withDryRunGuard } from "../executor";
import { getNodeDefinition } from "../node-definitions";
import { errMessage, interpolate } from "./_util";

export const llmParamsSchema = z.object({
  prompt: z.string(),
  system: z.string().optional(),
  model: z.string().optional(),
});

/**
 * Hits the real provider (Anthropic/OpenRouter) on the platform's API key —
 * this is a paid, cost-bearing call. `withDryRunGuard` below ensures this
 * executor never runs when ctx.dryRun is true; the dry-run stub runs instead.
 * Free-preview callers (e.g. `?dryRun=1`) must never reach real inference.
 */
const realExecutor: NodeDef["executor"] = async (ctx, rawParams, inputs) => {
  const params = llmParamsSchema.parse(rawParams);
  const prompt = interpolate(params.prompt, inputs);
  const generateOpts = { system: params.system, model: params.model };
  try {
    // Prefer the usage-reporting variant so the tokens this call actually
    // consumed surface as this node's costUsdc — that is what the run
    // ledger, the in-run cost ceiling, and the per-agent daily cap count.
    // A client without generateWithUsage (minimal test doubles) keeps the
    // historical zero-cost behavior.
    if (ctx.llm.generateWithUsage) {
      const generation = await ctx.llm.generateWithUsage(prompt, generateOpts);
      return {
        ok: true,
        outputs: { result: generation.text },
        costUsdc: gatewayCostUsdc(generation.usage.totalTokens),
      };
    }
    const text = await ctx.llm.generate(prompt, generateOpts);
    return { ok: true, outputs: { result: text }, costUsdc: 0 };
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
};

/** Synthetic dry-run result. Mirrors suede/promo.ts's dry-run pattern: no provider call, no cost. */
const dryRunStub: NodeDef["executor"] = async (_ctx, rawParams, inputs) => {
  const params = llmParamsSchema.parse(rawParams);
  const prompt = interpolate(params.prompt, inputs);
  return {
    ok: true,
    outputs: {
      result: `[dry-run] LLM call skipped, no provider request was made. Prompt preview: ${prompt.slice(0, 200)}`,
    },
    costUsdc: 0,
  };
};

export const llmNode = withDryRunGuard(
  defineExecutableNode(getNodeDefinition("llm"), {
    paramsSchema: llmParamsSchema,
    executor: realExecutor,
    // Exposed as a NodeDef field so the engine's central dry-run gate
    // (engine.ts's executeNode) can use it directly too — that is now the
    // primary enforcement point. withDryRunGuard below still wraps
    // `executor` as a second, redundant layer: existing tests call
    // `llmNode.executor` directly, bypassing the engine entirely, and
    // expect it to self-gate.
    dryRunStub,
  }),
  dryRunStub,
);
