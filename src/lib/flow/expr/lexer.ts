/** Hand-rolled lexer for the transform node's expression language. */
import { ExprParseError } from "./errors";

export interface Token {
  type: "num" | "str" | "ident" | "punct" | "eof";
  value: string;
  pos: number;
}

const PUNCT_MULTI = ["==", "!=", "<=", ">=", "&&", "||", "=>"];
const PUNCT_SINGLE = new Set("+-*/%<>!?:,.()[]{}".split(""));

const IDENT_START = /[A-Za-z_]/;
const IDENT_REST = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/** Tokenize `source`, throwing ExprParseError if it exceeds `maxTokens`. */
export function tokenize(source: string, maxTokens: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    const start = i;

    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let value = "";
      const escapes: Record<string, string> = { n: "\n", t: "\t", '"': '"', "'": "'", "\\": "\\" };
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          const next = source[i + 1];
          value += escapes[next] ?? next;
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      if (i >= n) throw new ExprParseError("Unterminated string literal.");
      i++; // closing quote
      tokens.push({ type: "str", value, pos: start });
    } else if (DIGIT.test(c)) {
      let j = i;
      while (j < n && DIGIT.test(source[j])) j++;
      if (source[j] === "." && DIGIT.test(source[j + 1] ?? "")) {
        j++;
        while (j < n && DIGIT.test(source[j])) j++;
      }
      tokens.push({ type: "num", value: source.slice(i, j), pos: start });
      i = j;
    } else if (IDENT_START.test(c)) {
      let j = i;
      while (j < n && IDENT_REST.test(source[j])) j++;
      tokens.push({ type: "ident", value: source.slice(i, j), pos: start });
      i = j;
    } else {
      const two = source.slice(i, i + 2);
      if (PUNCT_MULTI.includes(two)) {
        tokens.push({ type: "punct", value: two, pos: start });
        i += 2;
      } else if (PUNCT_SINGLE.has(c)) {
        tokens.push({ type: "punct", value: c, pos: start });
        i += 1;
      } else {
        throw new ExprParseError(`Unexpected character "${c}" at position ${start}.`);
      }
    }

    if (tokens.length > maxTokens) {
      throw new ExprParseError(`Expression has too many tokens (limit ${maxTokens}).`);
    }
  }

  tokens.push({ type: "eof", value: "", pos: n });
  return tokens;
}
