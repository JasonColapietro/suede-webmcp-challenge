/** Error types for the constrained expression language used by the transform node. */

export class ExprParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprParseError";
  }
}

export class ExprEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprEvalError";
  }
}
