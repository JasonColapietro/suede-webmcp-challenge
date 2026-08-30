/**
 * Recursive-descent parser for the transform node's expression language.
 * Two independent bombs are guarded here, at parse time, before a single
 * evaluation step runs:
 *  - `maxDepth`: caps parser recursion (nested parens/ternaries/lambdas/
 *    unary chains/object-array literals). Prevents a crafted expression
 *    like `((((((...))))))` from blowing the call stack.
 *  - `maxNodes`: caps total AST node count, so a *wide* bomb like a
 *    50,000-element array literal is rejected even though it isn't deep.
 * Property names are also denylisted here for every statically-known key
 * (dot access, object literal keys, identifiers, lambda params) so
 * `__proto__` / `constructor` / `prototype` never make it into the AST.
 */
import type { Expr, LambdaExpr } from "./ast";
import { tokenize, type Token } from "./lexer";
import { ExprParseError } from "./errors";
import { assertSafeKey } from "./safety";

export interface ParserLimits {
  maxTokens: number;
  maxDepth: number;
  maxNodes: number;
}

const RESERVED_LITERALS = new Set(["true", "false", "null"]);

class Parser {
  private pos = 0;
  private depth = 0;
  private nodeCount = 0;

  constructor(
    private tokens: Token[],
    private limits: ParserLimits,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private peekNext(): Token | undefined {
    return this.tokens[this.pos + 1];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private check(type: Token["type"], value?: string): boolean {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  private match(type: Token["type"], value?: string): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(type: Token["type"], value?: string): Token {
    if (!this.check(type, value)) {
      const t = this.peek();
      throw new ExprParseError(
        `Expected ${value ?? type} but found "${t.value || t.type}" at position ${t.pos}.`,
      );
    }
    return this.advance();
  }

  private enterDepth(): void {
    this.depth++;
    if (this.depth > this.limits.maxDepth) {
      throw new ExprParseError(`Expression is nested too deeply (limit ${this.limits.maxDepth}).`);
    }
  }

  private exitDepth(): void {
    this.depth--;
  }

  private countNode(): void {
    this.nodeCount++;
    if (this.nodeCount > this.limits.maxNodes) {
      throw new ExprParseError(`Expression is too large (limit ${this.limits.maxNodes} nodes).`);
    }
  }

  parseProgram(): Expr {
    const expr = this.parseExpr();
    this.expect("eof");
    return expr;
  }

  private parseExpr(): Expr {
    this.enterDepth();
    try {
      return this.parseConditional();
    } finally {
      this.exitDepth();
    }
  }

  private parseConditional(): Expr {
    const test = this.parseLogicalOr();
    if (this.match("punct", "?")) {
      const consequent = this.parseExpr();
      this.expect("punct", ":");
      const alternate = this.parseExpr();
      this.countNode();
      return { kind: "Conditional", test, consequent, alternate };
    }
    return test;
  }

  private parseLogicalOr(): Expr {
    let left = this.parseLogicalAnd();
    while (this.match("punct", "||")) {
      const right = this.parseLogicalAnd();
      this.countNode();
      left = { kind: "Logical", op: "||", left, right };
    }
    return left;
  }

  private parseLogicalAnd(): Expr {
    let left = this.parseEquality();
    while (this.match("punct", "&&")) {
      const right = this.parseEquality();
      this.countNode();
      left = { kind: "Logical", op: "&&", left, right };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseRelational();
    while (this.check("punct", "==") || this.check("punct", "!=")) {
      const op = this.advance().value as "==" | "!=";
      const right = this.parseRelational();
      this.countNode();
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  private parseRelational(): Expr {
    let left = this.parseAdditive();
    while (
      this.check("punct", "<") ||
      this.check("punct", "<=") ||
      this.check("punct", ">") ||
      this.check("punct", ">=")
    ) {
      const op = this.advance().value as "<" | "<=" | ">" | ">=";
      const right = this.parseAdditive();
      this.countNode();
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.check("punct", "+") || this.check("punct", "-")) {
      const op = this.advance().value as "+" | "-";
      const right = this.parseMultiplicative();
      this.countNode();
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.check("punct", "*") || this.check("punct", "/") || this.check("punct", "%")) {
      const op = this.advance().value as "*" | "/" | "%";
      const right = this.parseUnary();
      this.countNode();
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    this.enterDepth();
    try {
      if (this.check("punct", "!") || this.check("punct", "-")) {
        const op = this.advance().value as "!" | "-";
        const argument = this.parseUnary();
        this.countNode();
        return { kind: "Unary", op, argument };
      }
      return this.parsePostfix();
    } finally {
      this.exitDepth();
    }
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimaryOrCall();
    for (;;) {
      if (this.match("punct", ".")) {
        const prop = this.expect("ident").value;
        assertSafeKey(prop);
        this.countNode();
        expr = { kind: "Member", object: expr, property: prop };
      } else if (this.match("punct", "[")) {
        const index = this.parseExpr();
        this.expect("punct", "]");
        this.countNode();
        expr = { kind: "Index", object: expr, index };
      } else {
        break;
      }
    }
    return expr;
  }

  /**
   * A bare identifier immediately followed by "(" is a call to an
   * allowlisted builtin (checked at eval time). Anything else falls
   * through to parsePrimary. Method-call syntax (`x.map(...)`) is
   * intentionally not supported: calls are only ever a name resolved
   * against our own builtin table, never a value pulled from data.
   */
  private parsePrimaryOrCall(): Expr {
    if (this.check("ident")) {
      const name = this.peek().value;
      const next = this.peekNext();
      if (!RESERVED_LITERALS.has(name) && next?.type === "punct" && next.value === "(") {
        this.advance(); // name
        this.advance(); // (
        const args = this.parseCallArgs();
        this.expect("punct", ")");
        this.countNode();
        return { kind: "Call", name, args };
      }
    }
    return this.parsePrimary();
  }

  private parseCallArgs(): Array<Expr | LambdaExpr> {
    const args: Array<Expr | LambdaExpr> = [];
    if (this.check("punct", ")")) return args;
    for (;;) {
      args.push(this.parseCallArg());
      if (!this.match("punct", ",")) break;
    }
    return args;
  }

  private parseCallArg(): Expr | LambdaExpr {
    const next = this.peekNext();
    if (this.check("ident") && next?.type === "punct" && next.value === "=>") {
      const param = this.advance().value;
      assertSafeKey(param);
      this.advance(); // =>
      this.enterDepth();
      let body: Expr;
      try {
        body = this.parseExpr();
      } finally {
        this.exitDepth();
      }
      this.countNode();
      return { kind: "Lambda", param, body };
    }
    return this.parseExpr();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === "num") {
      this.advance();
      this.countNode();
      return { kind: "Literal", value: Number(t.value) };
    }

    if (t.type === "str") {
      this.advance();
      this.countNode();
      return { kind: "Literal", value: t.value };
    }

    if (t.type === "ident") {
      if (t.value === "true") {
        this.advance();
        this.countNode();
        return { kind: "Literal", value: true };
      }
      if (t.value === "false") {
        this.advance();
        this.countNode();
        return { kind: "Literal", value: false };
      }
      if (t.value === "null") {
        this.advance();
        this.countNode();
        return { kind: "Literal", value: null };
      }
      assertSafeKey(t.value);
      this.advance();
      this.countNode();
      return { kind: "Identifier", name: t.value };
    }

    if (this.match("punct", "(")) {
      const expr = this.parseExpr();
      this.expect("punct", ")");
      return expr;
    }

    if (this.match("punct", "{")) {
      return this.parseObjectLiteral();
    }

    if (this.match("punct", "[")) {
      return this.parseArrayLiteral();
    }

    throw new ExprParseError(`Unexpected token "${t.value || t.type}" at position ${t.pos}.`);
  }

  private parseObjectLiteral(): Expr {
    this.enterDepth();
    try {
      const properties: Array<{ key: string; value: Expr }> = [];
      if (!this.check("punct", "}")) {
        for (;;) {
          const keyTok = this.peek();
          let key: string;
          if (keyTok.type === "ident" || keyTok.type === "str") {
            key = keyTok.value;
            this.advance();
          } else {
            throw new ExprParseError(`Expected an object key at position ${keyTok.pos}.`);
          }
          assertSafeKey(key);
          this.expect("punct", ":");
          const value = this.parseExpr();
          this.countNode();
          properties.push({ key, value });
          if (!this.match("punct", ",")) break;
        }
      }
      this.expect("punct", "}");
      this.countNode();
      return { kind: "ObjectLiteral", properties };
    } finally {
      this.exitDepth();
    }
  }

  private parseArrayLiteral(): Expr {
    this.enterDepth();
    try {
      const elements: Expr[] = [];
      if (!this.check("punct", "]")) {
        for (;;) {
          elements.push(this.parseExpr());
          if (!this.match("punct", ",")) break;
        }
      }
      this.expect("punct", "]");
      this.countNode();
      return { kind: "ArrayLiteral", elements };
    } finally {
      this.exitDepth();
    }
  }
}

export function parseExpression(source: string, limits: ParserLimits): Expr {
  const tokens = tokenize(source, limits.maxTokens);
  const parser = new Parser(tokens, limits);
  return parser.parseProgram();
}
