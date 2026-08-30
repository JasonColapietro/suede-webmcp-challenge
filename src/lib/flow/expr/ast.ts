/**
 * AST for the transform node's expression language. This is a deliberately
 * small, non-Turing-complete grammar: no user-defined functions, no
 * assignment, no loops, no statements. `map()` is the only binder (its
 * lambda parameter is scoped to the lambda body only) and it operates over
 * a fixed input array, so it cannot recurse or run unbounded.
 */

export type Literal = string | number | boolean | null;

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=";
export type LogicalOp = "&&" | "||";
export type UnaryOp = "!" | "-";

export type Expr =
  | { kind: "Literal"; value: Literal }
  | { kind: "Identifier"; name: string }
  | { kind: "Member"; object: Expr; property: string }
  | { kind: "Index"; object: Expr; index: Expr }
  | { kind: "Call"; name: string; args: Array<Expr | LambdaExpr> }
  | { kind: "Unary"; op: UnaryOp; argument: Expr }
  | { kind: "Binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "Logical"; op: LogicalOp; left: Expr; right: Expr }
  | { kind: "Conditional"; test: Expr; consequent: Expr; alternate: Expr }
  | { kind: "ObjectLiteral"; properties: Array<{ key: string; value: Expr }> }
  | { kind: "ArrayLiteral"; elements: Expr[] };

/** Only valid as the second argument to map(); never evaluated directly. */
export interface LambdaExpr {
  kind: "Lambda";
  param: string;
  body: Expr;
}
