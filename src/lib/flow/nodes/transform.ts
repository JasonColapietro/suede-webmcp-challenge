/**
 * Data transform node. Reshapes data between steps (pluck a field, build a
 * new object, filter/format a list) without round-tripping through an LLM.
 * Evaluates one expression from src/lib/flow/expr/ against the node's
 * inputs and emits the result as { result }.
 *
 * This is NOT a code-execution node. The expression language is a small,
 * non-Turing-complete grammar (see expr/parser.ts and expr/evaluate.ts):
 * no eval/new Function, no globals, no network, no filesystem, no
 * require/import, no user-defined functions, no loops beyond the single
 * fixed-arity map() builtin. It is local computation only, so it is a
 * free node and runs in dry-run (see FREE_NODE_TYPES in ../executor.ts).
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../executor";
import { getNodeDefinition } from "../node-definitions";
import { errMessage } from "./_util";
import { evaluateExpression, DEFAULT_EXPR_LIMITS, type ExprLimits } from "../expr";

export const transformParamsSchema = z.object({
  expression: z.string().min(1, "expression is required"),
});

export type TransformParams = z.infer<typeof transformParamsSchema>;

export interface TransformExecutorOptions {
  /** Injectable for tests; defaults to expr/index.ts's DEFAULT_EXPR_LIMITS. */
  limits?: Partial<ExprLimits>;
  /** Injectable clock, so tests can simulate a timeout deterministically. */
  now?: () => number;
}

export function createTransformExecutor(opts: TransformExecutorOptions = {}): NodeExecutor {
  const limits: ExprLimits = { ...DEFAULT_EXPR_LIMITS, ...opts.limits };

  return async (_ctx, rawParams, inputs) => {
    let params: TransformParams;
    try {
      params = transformParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    const result = evaluateExpression(params.expression, inputs, { limits, now: opts.now });
    if (!result.ok) {
      return { ok: false, error: result.error, costUsdc: 0 };
    }
    return { ok: true, outputs: { result: result.value }, costUsdc: 0 };
  };
}

export const transformNode = defineExecutableNode(getNodeDefinition("transform"), {
  paramsSchema: transformParamsSchema,
  executor: createTransformExecutor(),
});
