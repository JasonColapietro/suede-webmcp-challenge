/**
 * Loop node — runs a referenced subflow once per element of an upstream
 * array and collects the per-element results in order. This is the
 * iteration primitive the engine was missing: without it, a flow author has
 * to pre-batch an entire array into one blob and ask a single LLM call to
 * handle all of it at once (see the batch-categorization and
 * review-batch-rollup templates). That forces an all-or-nothing retry on
 * any hiccup and hides the real per-call cost inside one opaque LLM node.
 *
 * A loop multiplies every cost-bearing node inside its body by N, so this
 * file is as much a safety valve as it is a feature:
 *  - LOOP_ITERATION_CEILING is an absolute, non-configurable hard cap on how
 *    many elements a single loop node will ever process. Inputs longer than
 *    the effective cap are rejected outright (never silently truncated) so
 *    a runaway array can't quietly bill for less work than the author
 *    thinks it did, or run away unbounded.
 *  - Concurrency is bounded (default LOOP_DEFAULT_CONCURRENCY, hard-capped
 *    at LOOP_CONCURRENCY_CEILING) via a small worker-pool instead of an
 *    unbounded Promise.all over a user-supplied array.
 *  - Per-element cost is summed from each nested run's own cost ledger and
 *    returned as this node's costUsdc, so it accumulates into the run's
 *    total exactly like every other node (see engine.ts: `totalCost +=
 *    result.costUsdc`) and is visible to the per-agent daily cost cap
 *    (run-service.ts's AgentDailyCapExceededError reads the persisted run
 *    total, not a per-node breakdown).
 *  - The nested subflow is loaded through ctx.loadSubflow, so it inherits
 *    the owner-scoped check in run-context.ts unmodified: a loop cannot be
 *    used to probe or execute another tenant's flow any more than a plain
 *    Subflow node can.
 *  - The nested run's ctx.depth is incremented exactly like subflow.ts, so
 *    the existing MAX_SUBFLOW_DEPTH guard in engine.ts bounds
 *    loop-inside-loop (or loop-inside-subflow) nesting without any new
 *    bookkeeping here.
 *  - ctx.dryRun is passed through unchanged to every nested run. This node
 *    never inspects or overrides it: the nested runFlow call below dispatches
 *    every inner node through the engine's central dry-run gate
 *    (engine.ts's executeNode) exactly as a top-level run does, so a
 *    dry-run loop never fires a real paid or side-effecting call. This node
 *    itself declares costBearing: false (below) precisely so that gate
 *    never stubs the loop wholesale — it must always run for real so the
 *    inner nodes get a chance to see ctx.dryRun themselves.
 *
 * Failure policy: collect-errors, not fail-fast. Every element is attempted
 * (bounded by the concurrency and iteration cap); a failed element does not
 * stop the others. The node itself still reports ok:true as long as the
 * loop could start (valid array, subflow loadable, within the iteration
 * cap) — per-element failures are surfaced in outputs.errors instead of
 * failing the whole node, so a downstream step can still consume the
 * results that did succeed. This is deliberate: the whole reason this node
 * exists is to stop one flaky item (a timeout, a malformed row) from
 * forcing an all-or-nothing retry of a 100-item batch. The cost trade-off
 * is explicit too: because every element still runs, the worst case cost of
 * a loop is always up to N x (subflow cost), whether or not some elements
 * fail — collect-errors does not save cost the way fail-fast would.
 *
 * The one exception to collect-errors: the run's in-run cost ceiling
 * (ctx.costCeiling, enforced in engine.ts). Because ctx is shared by
 * reference through childCtx, every nested runFlow call below sees the same
 * ceiling ledger the top-level run does, and each one checks it before its
 * own cost-bearing nodes. If an iteration's nested run gets aborted for
 * running out of budget, that is NOT treated as a per-element failure —
 * no further iterations are started, and this node itself reports ok:false
 * with costCeilingExceeded so the abort propagates to the parent run
 * instead of silently completing a loop that ran out of money partway
 * through. See the ceilingHit handling below.
 */
import { z } from "zod";
import { defineExecutableNode } from "../executor";
import { getNodeDefinition } from "../node-definitions";
import { runFlow, collectRun } from "../engine";
import type { RunEvent } from "../types";
import { errMessage } from "./_util";
import { normalizeSubflowReference, SubflowReferenceSchema } from "../subflow-reference";
import {
  buildCallableTrigger,
  collectCallableOutputs,
  createChildContext,
  assertCallableOutputSourcesExist,
  assertExactCallableInputKeys,
  assertSubflowCanEnter,
} from "../subflow-validation";
import type { ResolvedSubflow } from "../subflow-resolver";
import type { SubflowReference } from "../types";

/** Absolute, non-configurable ceiling. No config field can raise this. */
export const LOOP_ITERATION_CEILING = 200;
/** Default iteration cap when the author leaves maxIterations blank. */
export const LOOP_DEFAULT_MAX_ITERATIONS = 50;
/** Absolute ceiling on concurrent in-flight elements. */
export const LOOP_CONCURRENCY_CEILING = 4;
/** Default concurrency when the author leaves concurrency blank. */
export const LOOP_DEFAULT_CONCURRENCY = 2;

const loopOptionsShape = {
  itemsPath: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
} as const;
const legacyLoopParamsSchema = z.object({
  flowId: z.string().min(1, "flowId is required"),
  ...loopOptionsShape,
}).passthrough().superRefine((value, context) => {
  if (Object.hasOwn(value, "reference")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Loop params cannot contain both flowId and reference" });
  }
}).transform(({ flowId, itemsPath, concurrency, maxIterations }) => ({
  flowId,
  ...(itemsPath === undefined ? {} : { itemsPath }),
  ...(concurrency === undefined ? {} : { concurrency }),
  ...(maxIterations === undefined ? {} : { maxIterations }),
}));
const typedLoopParamsSchema = z.object({
  reference: SubflowReferenceSchema,
  concurrency: z.number().int().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
}).strict();
export const loopParamsSchema = z.union([legacyLoopParamsSchema, typedLoopParamsSchema]);

export type LoopParams = z.infer<typeof legacyLoopParamsSchema>;

export interface LoopElementError {
  index: number;
  error: string;
}

function firstValue(inputs: Record<string, unknown>): unknown {
  if ("in" in inputs) return inputs.in;
  const keys = Object.keys(inputs);
  return keys.length > 0 ? inputs[keys[0]] : undefined;
}

function getPath(value: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur = value;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function firstErrorMessage(events: RunEvent[], index: number): string {
  const errEvent = events.find(
    (e): e is Extract<RunEvent, { kind: "node:error" }> => e.kind === "node:error",
  );
  return errEvent ? `${errEvent.nodeId}: ${errEvent.error}` : `Loop element ${index} failed`;
}

export const loopNode = defineExecutableNode(getNodeDefinition("loop"), {
  paramsSchema: loopParamsSchema,
  executor: async (ctx, rawParams, inputs) => {
    let params: LoopParams;
    let typedReference: SubflowReference | null = null;
    try {
      const normalized = normalizeSubflowReference(rawParams);
      if (normalized.kind === "typed") {
        typedReference = normalized.reference;
        const typed = typedLoopParamsSchema.parse(rawParams);
        params = legacyLoopParamsSchema.parse({
          flowId: normalized.reference.flowId,
          concurrency: typed.concurrency,
          maxIterations: typed.maxIterations,
        });
      } else {
        params = legacyLoopParamsSchema.parse(rawParams);
      }
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
    const flowId = params.flowId;

    const rawSource = typedReference
      ? inputs.items
      : params.itemsPath
      ? getPath(firstValue(inputs), params.itemsPath)
      : firstValue(inputs);

    if (!Array.isArray(rawSource)) {
      const where = params.itemsPath ? ` at path "${params.itemsPath}"` : "";
      return {
        ok: false,
        error: `Loop input is not an array${where}. Got ${rawSource === undefined ? "undefined" : typeof rawSource}.`,
        costUsdc: 0,
      };
    }
    // Re-bind to a stably-typed local: TS narrowing from Array.isArray does
    // not survive into the hoisted `worker` function declaration below.
    const items: unknown[] = rawSource;

    const configuredMax = params.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS;
    const effectiveCap = Math.min(configuredMax, LOOP_ITERATION_CEILING);
    if (items.length > effectiveCap) {
      const capKind = configuredMax > LOOP_ITERATION_CEILING ? "absolute" : "configured";
      return {
        ok: false,
        error:
          `Loop input has ${items.length} items, over the ${capKind} cap of ${effectiveCap}. ` +
          `Reduce the input size, or raise Max iterations up to the hard ceiling of ${LOOP_ITERATION_CEILING}.`,
        costUsdc: 0,
      };
    }

    if (items.length === 0 && !typedReference) {
      return { ok: true, outputs: { result: [], errors: [] }, costUsdc: 0 };
    }

    let resolved: ResolvedSubflow | null = null;
    let sub;
    try {
      if (typedReference) {
        ctx.signal?.throwIfAborted();
        resolved = ctx.signal
          ? await ctx.resolveSubflow(typedReference, ctx.signal)
          : await ctx.resolveSubflow(typedReference);
        assertCallableOutputSourcesExist(resolved.graph, resolved.callableInterface, ctx.registry);
        sub = resolved.graph;
      } else {
        ctx.signal?.throwIfAborted();
        sub = ctx.signal
          ? await ctx.loadSubflow(flowId, ctx.signal)
          : await ctx.loadSubflow(flowId);
      }
      assertSubflowCanEnter(ctx, flowId);
    } catch (e) {
      if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    if (typedReference && resolved && items.length === 0) {
      const outputs = Object.create(null) as Record<string, unknown>;
      for (const port of resolved.callableInterface.outputs) outputs[port.id] = [];
      outputs.errors = [];
      return { ok: true, outputs, costUsdc: 0 };
    }

    const concurrency = Math.max(
      1,
      Math.min(params.concurrency ?? LOOP_DEFAULT_CONCURRENCY, LOOP_CONCURRENCY_CEILING, items.length),
    );

    const results: Array<Record<string, Record<string, unknown>> | null> = new Array(
      items.length,
    ).fill(null);
    const typedOutputs = Object.create(null) as Record<string, Array<unknown | null>>;
    if (resolved) {
      for (const port of resolved.callableInterface.outputs) {
        typedOutputs[port.id] = new Array(items.length).fill(null);
      }
    }
    const errors: LoopElementError[] = [];
    let totalCost = 0;
    let successfulIterations = 0;
    // Set when any iteration's nested run was aborted by the in-run cost
    // ceiling. This is NOT a per-element failure (that's what `errors` is
    // for) — it means the run as a whole is out of budget, so once it's
    // set, no further iterations are started, and the loop node itself
    // reports ok:false with costCeilingExceeded so the abort propagates to
    // the parent run instead of being swallowed by collect-errors.
    let ceilingHit = false;

    let cursor = 0;
    const runOne = async (index: number): Promise<void> => {
      ctx.signal?.throwIfAborted();
      const item = items[index];
      try {
        if (resolved && (item === null || typeof item !== "object" || Array.isArray(item))) {
          throw new Error(`Typed loop item ${index} must be a record keyed by callable input port IDs`);
        }
        if (resolved) {
          assertExactCallableInputKeys(
            resolved.callableInterface,
            item as Record<string, unknown>,
          );
        }
        const childCtx = createChildContext(ctx, flowId);
        const trigger = resolved
          ? buildCallableTrigger(resolved.callableInterface, item as Record<string, unknown>)
          : { in: item, index };
        const summary = await collectRun(
          runFlow(sub, childCtx, ctx.registry, trigger),
        );
        totalCost += summary.totalCostUsdc;
        if (summary.costCeilingExceeded) {
          ceilingHit = true;
          return;
        }
        if (summary.status === "error") {
          errors.push({ index, error: firstErrorMessage(summary.events, index) });
        } else {
          // The child run itself completed. Count it before typed projection:
          // projection can still fail locally after provider cost was incurred.
          successfulIterations += 1;
          if (resolved) {
            const projected = collectCallableOutputs(resolved.callableInterface, summary.outputs);
            for (const port of resolved.callableInterface.outputs) {
              typedOutputs[port.id]![index] = Object.hasOwn(projected, port.id)
                ? projected[port.id]
                : null;
            }
          } else {
            results[index] = summary.outputs;
          }
        }
      } catch (e) {
        if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
        errors.push({ index, error: errMessage(e) });
      }
    };

    async function worker(): Promise<void> {
      for (;;) {
        // Concurrent workers can each have an iteration in flight when the
        // ceiling is hit, so this check bounds how many NEW iterations start
        // after that — not how many were already running. Worst-case
        // overshoot from this loop is therefore up to `concurrency` extra
        // in-flight iterations. Actual estimate under-runs can compound
        // further inside nested concurrent leaves, so this is not a strict
        // bound on provider-actual overshoot.
        if (ceilingHit) return;
        ctx.signal?.throwIfAborted();
        const index = cursor++;
        if (index >= items.length) return;
        await runOne(index);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (ceilingHit) {
      return {
        ok: false,
        error:
          `Run cost ceiling exceeded during this loop: ${successfulIterations} of ${items.length} ` +
          `iterations completed before the run was aborted. The remaining iterations were not started.`,
        costUsdc: totalCost,
        costCeilingExceeded: true,
      };
    }

    if (resolved) {
      return {
        ok: true,
        outputs: { ...typedOutputs, errors: errors.sort((a, b) => a.index - b.index) },
        costUsdc: totalCost,
      };
    }
    return {
      ok: true,
      outputs: { result: results, errors },
      costUsdc: totalCost,
    };
  },
});
