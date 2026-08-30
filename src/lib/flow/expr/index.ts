/**
 * Public entry point for the transform node's expression language: a
 * constrained, non-Turing-complete evaluator over the flow's input data.
 * NOT arbitrary JavaScript - there is no eval/new Function/vm anywhere in
 * this module, no access to Node globals, no network, no filesystem, no
 * require/import, and no user-defined functions or loops. See parser.ts
 * and evaluate.ts for the specific bounds (depth, node count, steps, time).
 */
import { parseExpression } from "./parser";
import { evaluate } from "./evaluate";
import { ExprEvalError, ExprParseError } from "./errors";

export interface ExprLimits {
  /** Characters allowed in the raw expression source. */
  maxSourceLength: number;
  /** Tokens allowed after lexing. */
  maxTokens: number;
  /** Parser recursion depth (nested parens/ternaries/lambdas/literals). */
  maxDepth: number;
  /** Total AST nodes allowed (bounds width, not just depth). */
  maxNodes: number;
  /** AST nodes visited during evaluation, including map() fan-out. */
  maxSteps: number;
  /**
   * Wall-clock backstop for a single evaluation, in milliseconds. This is NOT
   * the primary bound — `maxSteps` is. Wall-clock is the only limit here whose
   * outcome depends on how busy the host is rather than on what the expression
   * does, so a tight value fails legitimate work whenever the process is
   * descheduled (GC pause, cold start, a noisy neighbour on shared CPU).
   * Keep it loose enough that only genuine pathology trips it.
   */
  maxTimeMs: number;
  /** Max array length accepted by map()/join()/split(). */
  maxArrayOpItems: number;
  /** Max input string length accepted by jsonParse(). */
  maxJsonInputLength: number;
}

export const DEFAULT_EXPR_LIMITS: ExprLimits = {
  maxSourceLength: 5000,
  maxTokens: 1000,
  maxDepth: 24,
  maxNodes: 500,
  maxSteps: 20000,
  maxTimeMs: 1000,
  maxArrayOpItems: 1000,
  maxJsonInputLength: 200_000,
};

export type ExprResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface EvaluateExpressionOptions {
  limits?: Partial<ExprLimits>;
  /** Injectable clock, so tests can simulate a timeout deterministically. */
  now?: () => number;
}

/**
 * Parses and evaluates `source` against `scope` (the node's upstream
 * inputs). Never throws - parse errors, eval errors, and safety
 * rejections all come back as `{ ok: false, error }` so callers (the
 * transform node executor) can return the engine's standard
 * non-throwing NodeResult contract.
 */
export function evaluateExpression(
  source: string,
  scope: Record<string, unknown>,
  opts: EvaluateExpressionOptions = {},
): ExprResult {
  const limits: ExprLimits = { ...DEFAULT_EXPR_LIMITS, ...opts.limits };

  if (source.length > limits.maxSourceLength) {
    return { ok: false, error: `Expression is too long (limit ${limits.maxSourceLength} characters).` };
  }

  try {
    const ast = parseExpression(source, limits);
    const value = evaluate(ast, scope, limits, opts.now);
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ExprParseError || e instanceof ExprEvalError || e instanceof Error) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: String(e) };
  }
}

export { ExprParseError, ExprEvalError };
