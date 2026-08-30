import type { FlowMutationResult } from "@/lib/flow/flow-mutation-service";

export type RefusedFlowVersionMutation = Exclude<
  FlowMutationResult,
  { readonly status: "saved" } | { readonly status: "not-found" }
>;

export class FlowVersionMutationError extends Error {
  constructor(readonly result: RefusedFlowVersionMutation) {
    super("Flow version mutation refused");
    this.name = "FlowVersionMutationError";
  }
}
