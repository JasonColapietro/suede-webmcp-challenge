/** Client-safe fixed compatibility contract for the v2-only operation node. */
export const API_OPERATION_V1_UNSUPPORTED = "API_OPERATION_V1_UNSUPPORTED" as const;

export const API_OPERATION_V1_UNSUPPORTED_RESULT = Object.freeze({
  ok: false as const,
  code: API_OPERATION_V1_UNSUPPORTED,
});

export class ApiOperationV1UnsupportedError extends Error {
  readonly code = API_OPERATION_V1_UNSUPPORTED;
  constructor() {
    super(API_OPERATION_V1_UNSUPPORTED);
    this.name = "ApiOperationV1UnsupportedError";
  }
}

export function graphContainsApiOperation(
  graph: { readonly nodes: readonly { readonly type: unknown }[] },
): boolean {
  return graph.nodes.some((node) => node.type === "api.operation");
}
