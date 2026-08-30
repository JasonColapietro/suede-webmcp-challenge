import { z } from "zod";
import { defineExecutableNode } from "../executor";
import { getNodeDefinition } from "../node-definitions";
import { runFlow, collectRun } from "../engine";
import { errMessage } from "./_util";
import { normalizeSubflowReference, SubflowReferenceSchema } from "../subflow-reference";
import { assertCallableOutputSourcesExist, buildCallableTrigger, collectCallableOutputs, createChildContext } from "../subflow-validation";

const legacySubflowParamsSchema = z.object({ flowId: z.string().min(1) })
  .passthrough()
  .superRefine((value, context) => {
    if (Object.hasOwn(value, "reference")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Subflow params cannot contain both flowId and reference" });
    }
  })
  .transform(({ flowId }) => ({ flowId }));
const typedSubflowParamsSchema = z.object({ reference: SubflowReferenceSchema }).strict();
export const subflowParamsSchema = z.union([
  legacySubflowParamsSchema,
  typedSubflowParamsSchema,
]);

export const subflowNode = defineExecutableNode(getNodeDefinition("subflow"), {
  paramsSchema: subflowParamsSchema,
  executor: async (ctx, rawParams, inputs) => {
    const normalized = normalizeSubflowReference(rawParams);
    if (normalized.kind === "typed") {
      try {
        typedSubflowParamsSchema.parse(rawParams);
        ctx.signal?.throwIfAborted();
        const resolved = ctx.signal
          ? await ctx.resolveSubflow(normalized.reference, ctx.signal)
          : await ctx.resolveSubflow(normalized.reference);
        ctx.signal?.throwIfAborted();
        assertCallableOutputSourcesExist(resolved.graph, resolved.callableInterface, ctx.registry);
        const childCtx = createChildContext(ctx, resolved.flowId);
        const trigger = buildCallableTrigger(resolved.callableInterface, inputs);
        const summary = await collectRun(runFlow(resolved.graph, childCtx, ctx.registry, trigger));
        if (summary.costCeilingExceeded) {
          return {
            ok: false,
            error: `Subflow ${resolved.flowId} aborted: the run's cost ceiling was reached partway through it.`,
            costUsdc: summary.totalCostUsdc,
            costCeilingExceeded: true,
          };
        }
        if (summary.status === "error") {
          return { ok: false, error: `Subflow ${resolved.flowId} failed`, costUsdc: summary.totalCostUsdc };
        }
        return {
          ok: true,
          outputs: collectCallableOutputs(resolved.callableInterface, summary.outputs),
          costUsdc: summary.totalCostUsdc,
        };
      } catch (e) {
        if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
        return { ok: false, error: errMessage(e), costUsdc: 0 };
      }
    }
    // Parsed to keep rejecting malformed legacy params here; the normalized
    // form below is what the run actually uses.
    legacySubflowParamsSchema.parse(rawParams);
    const flowId = normalized.flowId;
    try {
      ctx.signal?.throwIfAborted();
      const sub = ctx.signal
        ? await ctx.loadSubflow(flowId, ctx.signal)
        : await ctx.loadSubflow(flowId);
      ctx.signal?.throwIfAborted();
      const childCtx = createChildContext(ctx, flowId);
      const summary = await collectRun(runFlow(sub, childCtx, ctx.registry, inputs));
      const cost = summary.totalCostUsdc;
      // Propagate a run-cost-ceiling abort distinctly from an ordinary
      // subflow failure, so the parent run aborts too instead of treating
      // this like any other failed node (see engine.ts's handling of
      // result.costCeilingExceeded).
      if (summary.costCeilingExceeded) {
        return {
          ok: false,
          error: `Subflow ${flowId} aborted: the run's cost ceiling was reached partway through it.`,
          costUsdc: cost,
          costCeilingExceeded: true,
        };
      }
      if (summary.status === "error") {
        return { ok: false, error: `Subflow ${flowId} failed`, costUsdc: cost };
      }
      return { ok: true, outputs: { result: summary.outputs }, costUsdc: cost };
    } catch (e) {
      if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
  },
});
