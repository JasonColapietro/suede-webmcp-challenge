/**
 * Tree-walking interpreter for the parsed expression AST. This is the
 * runtime half of the bound: the parser already caps AST shape (depth,
 * node count); this file caps the *work* of walking that AST -
 *  - `maxSteps`: every AST node visited increments a counter; exceeding it
 *    aborts. This is what bounds map() fanning a small-looking expression
 *    out over a large array.
 *  - `maxTimeMs`: wall-clock budget, checked on every step via an
 *    injectable clock (`now`) so tests can simulate a timeout
 *    deterministically instead of needing to actually run slow.
 * Property access never touches the prototype chain: `safeGet` only ever
 * reads via `Object.prototype.hasOwnProperty.call`, and `assertSafeKey`
 * denylists `__proto__`/`constructor`/`prototype` for every dynamic key
 * (computed index, get()'s path segments) as a second line of defense
 * behind the parser's static checks.
 */
import type { BinaryOp, Expr, LambdaExpr } from "./ast";
import { assertSafeKey } from "./safety";
import { ExprEvalError } from "./errors";
import { BUILTINS, type BuiltinCtx } from "./builtins";

export interface EvalLimits {
  maxSteps: number;
  maxTimeMs: number;
  maxArrayOpItems: number;
  maxJsonInputLength: number;
}

interface EvalState {
  limits: EvalLimits;
  steps: number;
  startedAt: number;
  now: () => number;
}

function tick(state: EvalState): void {
  state.steps++;
  if (state.steps > state.limits.maxSteps) {
    throw new ExprEvalError(`Expression exceeded the evaluation step limit (${state.limits.maxSteps}).`);
  }
  if (state.now() - state.startedAt > state.limits.maxTimeMs) {
    throw new ExprEvalError(`Expression exceeded the ${state.limits.maxTimeMs}ms time limit.`);
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a property without ever touching the prototype chain. */
function safeGet(obj: unknown, key: string | number): unknown {
  if (obj === null || obj === undefined) return undefined;

  if (Array.isArray(obj)) {
    if (typeof key === "number") {
      return Number.isInteger(key) && key >= 0 && key < obj.length ? obj[key] : undefined;
    }
    if (key === "length") return obj.length;
    return undefined;
  }

  if (typeof obj === "string") {
    if (key === "length") return obj.length;
    if (typeof key === "number") {
      return Number.isInteger(key) && key >= 0 && key < obj.length ? obj[key] : undefined;
    }
    return undefined;
  }

  if (isPlainObject(obj)) {
    const k = String(key);
    assertSafeKey(k);
    return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined;
  }

  return undefined;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  throw new ExprEvalError(`Expected a number but got ${describe(v)}.`);
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}

/** Primitive equality is strict; object/array equality is structural via JSON. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function compareOp(op: "<" | "<=" | ">" | ">=", a: number | string, b: number | string): boolean {
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}

function evalBinary(op: BinaryOp, left: unknown, right: unknown): unknown {
  switch (op) {
    case "+":
      if (typeof left === "number" && typeof right === "number") return left + right;
      if (typeof left === "string" && typeof right === "string") return left + right;
      throw new ExprEvalError(
        `"+" requires two numbers or two strings, got ${describe(left)} and ${describe(right)}. Use number()/string() to convert first.`,
      );
    case "-":
      return toNumber(left) - toNumber(right);
    case "*":
      return toNumber(left) * toNumber(right);
    case "/":
      return toNumber(left) / toNumber(right);
    case "%":
      return toNumber(left) % toNumber(right);
    case "==":
      return looseEquals(left, right);
    case "!=":
      return !looseEquals(left, right);
    case "<":
    case "<=":
    case ">":
    case ">=":
      if (typeof left === "number" && typeof right === "number") return compareOp(op, left, right);
      if (typeof left === "string" && typeof right === "string") return compareOp(op, left, right);
      throw new ExprEvalError(
        `"${op}" requires two numbers or two strings, got ${describe(left)} and ${describe(right)}.`,
      );
    default:
      throw new ExprEvalError(`Unsupported operator "${op}".`);
  }
}

export function evaluate(
  expr: Expr,
  scope: Record<string, unknown>,
  limits: EvalLimits,
  now: () => number = Date.now,
): unknown {
  const state: EvalState = { limits, steps: 0, startedAt: now(), now };
  return evalNode(expr, scope, state);
}

function evalNode(expr: Expr, scope: Record<string, unknown>, state: EvalState): unknown {
  tick(state);

  switch (expr.kind) {
    case "Literal":
      return expr.value;

    case "Identifier": {
      assertSafeKey(expr.name);
      if (!Object.prototype.hasOwnProperty.call(scope, expr.name)) {
        throw new ExprEvalError(
          `Unknown variable "${expr.name}". Available: ${Object.keys(scope).join(", ") || "(none)"}.`,
        );
      }
      return scope[expr.name];
    }

    case "Member": {
      const obj = evalNode(expr.object, scope, state);
      return safeGet(obj, expr.property);
    }

    case "Index": {
      const obj = evalNode(expr.object, scope, state);
      const key = evalNode(expr.index, scope, state);
      if (typeof key !== "string" && typeof key !== "number") {
        throw new ExprEvalError(`Index must be a string or number, got ${describe(key)}.`);
      }
      if (typeof key === "string") assertSafeKey(key);
      return safeGet(obj, key);
    }

    case "Unary":
      if (expr.op === "!") return !truthy(evalNode(expr.argument, scope, state));
      return -toNumber(evalNode(expr.argument, scope, state));

    case "Logical": {
      const left = evalNode(expr.left, scope, state);
      if (expr.op === "&&") return truthy(left) ? evalNode(expr.right, scope, state) : left;
      return truthy(left) ? left : evalNode(expr.right, scope, state);
    }

    case "Conditional": {
      const test = evalNode(expr.test, scope, state);
      return truthy(test) ? evalNode(expr.consequent, scope, state) : evalNode(expr.alternate, scope, state);
    }

    case "Binary": {
      const left = evalNode(expr.left, scope, state);
      const right = evalNode(expr.right, scope, state);
      return evalBinary(expr.op, left, right);
    }

    case "ObjectLiteral": {
      // Object.create(null) so a key literally named "__proto__" cannot
      // trigger the accessor setter on assignment (see safety.ts).
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const prop of expr.properties) {
        assertSafeKey(prop.key);
        result[prop.key] = evalNode(prop.value, scope, state);
      }
      return result;
    }

    case "ArrayLiteral":
      return expr.elements.map((el) => evalNode(el, scope, state));

    case "Call":
      return evalCall(expr, scope, state);

    default: {
      const exhaustive: never = expr;
      throw new ExprEvalError(`Unsupported expression node: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function evalCall(
  expr: Extract<Expr, { kind: "Call" }>,
  scope: Record<string, unknown>,
  state: EvalState,
): unknown {
  if (expr.name === "map") {
    if (expr.args.length !== 2) {
      throw new ExprEvalError("map() takes exactly 2 arguments: map(array, item => expr).");
    }
    const [arrArg, lambdaArg] = expr.args;
    if (lambdaArg.kind !== "Lambda") {
      throw new ExprEvalError("map()'s second argument must be a lambda, e.g. x => x.id.");
    }
    if (arrArg.kind === "Lambda") {
      throw new ExprEvalError("map()'s first argument must be an array expression, not a lambda.");
    }
    const arr = evalNode(arrArg, scope, state);
    if (!Array.isArray(arr)) {
      throw new ExprEvalError(`map()'s first argument must be an array, got ${describe(arr)}.`);
    }
    if (arr.length > state.limits.maxArrayOpItems) {
      throw new ExprEvalError(
        `map() input array has ${arr.length} items, exceeding the limit of ${state.limits.maxArrayOpItems}.`,
      );
    }
    const lambda: LambdaExpr = lambdaArg;
    return arr.map((item) => {
      tick(state);
      const childScope = { ...scope, [lambda.param]: item };
      return evalNode(lambda.body, childScope, state);
    });
  }

  const builtin = BUILTINS[expr.name];
  if (!builtin) {
    throw new ExprEvalError(
      `Unknown function "${expr.name}". Allowed: map, ${Object.keys(BUILTINS).join(", ")}.`,
    );
  }
  const args = expr.args.map((a) => {
    if (a.kind === "Lambda") {
      throw new ExprEvalError(`"${expr.name}" does not accept a lambda argument.`);
    }
    return evalNode(a, scope, state);
  });
  const ctx: BuiltinCtx = {
    maxArrayOpItems: state.limits.maxArrayOpItems,
    maxJsonInputLength: state.limits.maxJsonInputLength,
  };
  return builtin(args, ctx);
}
