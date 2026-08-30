/**
 * The full allowlist of callable functions in the expression language.
 * Every entry here is a pure, hand-written function operating only on its
 * arguments (plus a size-limit context) - no closures over Node globals,
 * no I/O, nothing reachable outside this file's own logic. `map()` is not
 * in this table; it is special-cased in evaluate.ts because its second
 * argument is a lambda AST node, not a runtime value.
 */
import { ExprEvalError } from "./errors";
import { DENIED_KEYS } from "./safety";

export interface BuiltinCtx {
  maxArrayOpItems: number;
  maxJsonInputLength: number;
}

export type Builtin = (args: unknown[], ctx: BuiltinCtx) => unknown;

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

function expectArgs(name: string, args: unknown[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    const range = min === max ? `exactly ${min}` : `${min} to ${max}`;
    throw new ExprEvalError(`${name}() takes ${range} argument(s), got ${args.length}.`);
  }
}

function expectString(name: string, v: unknown): string {
  if (typeof v !== "string") throw new ExprEvalError(`${name}() expects a string, got ${describe(v)}.`);
  return v;
}

function expectArray(name: string, v: unknown, cap: number): unknown[] {
  if (!Array.isArray(v)) throw new ExprEvalError(`${name}() expects an array, got ${describe(v)}.`);
  if (v.length > cap) {
    throw new ExprEvalError(`${name}() input array has ${v.length} items, exceeding the limit of ${cap}.`);
  }
  return v;
}

/** Renders any value as a display string without ever invoking a data-owned method. */
function toDisplayString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export const BUILTINS: Record<string, Builtin> = {
  len: (args) => {
    expectArgs("len", args, 1);
    const v = args[0];
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (v !== null && typeof v === "object") return Object.keys(v).length;
    throw new ExprEvalError(`len() expects a string, array, or object, got ${describe(v)}.`);
  },

  upper: (args) => {
    expectArgs("upper", args, 1);
    return expectString("upper", args[0]).toUpperCase();
  },

  lower: (args) => {
    expectArgs("lower", args, 1);
    return expectString("lower", args[0]).toLowerCase();
  },

  trim: (args) => {
    expectArgs("trim", args, 1);
    return expectString("trim", args[0]).trim();
  },

  join: (args, ctx) => {
    expectArgs("join", args, 1, 2);
    const arr = expectArray("join", args[0], ctx.maxArrayOpItems);
    const separator = args[1] === undefined ? "," : expectString("join", args[1]);
    return arr.map((item) => toDisplayString(item)).join(separator);
  },

  split: (args, ctx) => {
    expectArgs("split", args, 1, 2);
    const s = expectString("split", args[0]);
    const sep = args[1] === undefined ? "" : expectString("split", args[1]);
    const parts = s.split(sep);
    if (parts.length > ctx.maxArrayOpItems) {
      throw new ExprEvalError(`split() produced ${parts.length} items, exceeding the limit of ${ctx.maxArrayOpItems}.`);
    }
    return parts;
  },

  get: (args) => {
    expectArgs("get", args, 2, 3);
    const [obj, pathArg, fallback] = args;
    const path = expectString("get", pathArg);
    const segments = path.split(".").filter((s) => s.length > 0);
    if (segments.length > 200) {
      throw new ExprEvalError("get() path is too long.");
    }
    let cur: unknown = obj;
    for (const seg of segments) {
      if (DENIED_KEYS.has(seg)) throw new ExprEvalError(`Access to "${seg}" is not allowed.`);
      if (cur === null || cur === undefined) {
        cur = undefined;
        break;
      }
      if (Array.isArray(cur)) {
        const idx = Number(seg);
        cur = Number.isInteger(idx) && idx >= 0 && idx < cur.length ? cur[idx] : undefined;
      } else if (typeof cur === "object") {
        cur = Object.prototype.hasOwnProperty.call(cur, seg)
          ? (cur as Record<string, unknown>)[seg]
          : undefined;
      } else {
        cur = undefined;
      }
    }
    return cur === undefined ? fallback : cur;
  },

  jsonParse: (args, ctx) => {
    expectArgs("jsonParse", args, 1);
    const s = expectString("jsonParse", args[0]);
    if (s.length > ctx.maxJsonInputLength) {
      throw new ExprEvalError(`jsonParse() input is too large (limit ${ctx.maxJsonInputLength} characters).`);
    }
    try {
      return JSON.parse(s) as unknown;
    } catch {
      throw new ExprEvalError("jsonParse() received invalid JSON.");
    }
  },

  jsonStringify: (args) => {
    expectArgs("jsonStringify", args, 1);
    if (args[0] === undefined) {
      throw new ExprEvalError("jsonStringify() cannot stringify undefined.");
    }
    const out = JSON.stringify(args[0]);
    if (out === undefined) {
      throw new ExprEvalError("jsonStringify() could not serialize this value.");
    }
    return out;
  },

  number: (args) => {
    expectArgs("number", args, 1);
    const v = args[0];
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") return Number(v);
    if (v === null) return 0;
    throw new ExprEvalError(`number() cannot convert ${describe(v)}.`);
  },

  string: (args) => {
    expectArgs("string", args, 1);
    return toDisplayString(args[0]);
  },

  default: (args) => {
    expectArgs("default", args, 2);
    const [v, fallback] = args;
    return v === undefined || v === null ? fallback : v;
  },
};
