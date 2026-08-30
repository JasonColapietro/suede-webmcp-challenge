import type { FlowRecord, FlowRepo } from "@/lib/db/repo";
import type { SupportedFlowGraph } from "./types";
import { parseSupportedFlowGraph } from "./graph-schema";
import { CONNECTOR_LAB_FLAG } from "@/lib/connectors/flags";
import { graphContainsApiOperation } from "@/lib/connectors/operation-closure";
import type { NodeAvailabilityProjection } from "./node-definitions";
import { ApiOperationV1UnsupportedError } from "./api-operation-contract";

export interface FlowImpactDependent {
  readonly flowId: string;
  readonly name: string;
  readonly nodeIds: readonly string[];
}

export interface FlowImpactSummary {
  readonly dependents: readonly FlowImpactDependent[];
  readonly truncated: boolean;
  readonly total: number;
}

export interface FlowMutationInput {
  readonly id?: string;
  /** Route-level updates set this so a missing private target cannot become a create. */
  readonly mustExist?: boolean;
  /** Recovery/import paths set this so an existing row can never be overwritten. */
  readonly createOnly?: boolean;
  readonly ownerId: string;
  readonly name: string;
  readonly graph: SupportedFlowGraph;
  /** Exact persisted revision required for an update; stale writers fail with conflict. */
  readonly expectedUpdatedAt?: number;
  readonly impactReceipt?: string;
  /** Internal versioning path: validate the exact owned snapshot without changing draft bytes. */
  readonly validateOnly?: boolean;
}

export type FlowMutationResult =
  | { readonly status: "saved"; readonly flow: FlowRecord }
  | { readonly status: "not-found" }
  | { readonly status: "invalid-reference" }
  | { readonly status: "cycle"; readonly flowIds: readonly string[] }
  | {
      readonly status: "impact-required";
      readonly receipt: string;
      readonly impact: FlowImpactSummary;
    }
  | { readonly status: "conflict" };

export interface FlowMutationRepository {
  mutateFlow(input: FlowMutationInput): Promise<FlowMutationResult>;
}

export class FlowMutationStoreUnavailableError extends Error {
  constructor() {
    super("Flow mutation store unavailable");
    this.name = "FlowMutationStoreUnavailableError";
  }
}

export class FlowMutationService {
  constructor(
    private readonly repo: FlowRepo,
    private readonly availability: NodeAvailabilityProjection = CONNECTOR_LAB_FLAG,
  ) {}

  async save(input: FlowMutationInput): Promise<FlowMutationResult> {
    if (
      !mutationValueWithinBudget(input.graph) ||
      typeof input.name !== "string" ||
      typeof input.ownerId !== "string" ||
      (input.id !== undefined && typeof input.id !== "string") ||
      (input.createOnly !== undefined && typeof input.createOnly !== "boolean") ||
      (input.expectedUpdatedAt !== undefined &&
        (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt < 0)) ||
      (input.impactReceipt !== undefined && typeof input.impactReceipt !== "string") ||
      input.name.length < 1 || input.name.trim() !== input.name || Buffer.byteLength(input.name, "utf8") > 200 ||
      input.ownerId.length < 1 || input.ownerId.length > 512 ||
      (input.id !== undefined && (input.id.length < 1 || input.id.length > 512)) ||
      (input.createOnly === true && (input.id === undefined || input.mustExist === true)) ||
      (input.expectedUpdatedAt !== undefined && input.id === undefined) ||
      (input.impactReceipt !== undefined && (input.impactReceipt.length < 32 || input.impactReceipt.length > 256))
    ) {
      return { status: "invalid-reference" };
    }
    let graph: SupportedFlowGraph;
    try {
      graph = parseSupportedFlowGraph(input.graph);
    } catch (error) {
      if (error instanceof ApiOperationV1UnsupportedError) throw error;
      return { status: "invalid-reference" };
    }
    // Stored prototype graphs remain readable, but a disabled server never
    // admits a new or updated prototype graph through any mutation caller.
    if (!input.validateOnly && !this.availability.enabled && graphContainsApiOperation(graph)) {
      return { status: "invalid-reference" };
    }
    const boundary = (this.repo as FlowRepo & Partial<FlowMutationRepository>).mutateFlow;
    if (typeof boundary !== "function") throw new FlowMutationStoreUnavailableError();
    return boundary.call(this.repo, { ...input, graph });
  }
}

const MAX_MUTATION_VALUE_DEPTH = 64;
const MAX_MUTATION_VALUE_NODES = 100_000;
const MAX_MUTATION_VALUE_BYTES = 2 * 1024 * 1024;

/** Iterative preflight so hostile direct-object inputs cannot reach recursive parsers/hashes. */
export function mutationValueWithinBudget(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_MUTATION_VALUE_NODES || current.depth > MAX_MUTATION_VALUE_DEPTH) return false;
    if (current.value === null || typeof current.value === "boolean") {
      bytes += 5;
    } else if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      bytes += 24;
    } else if (typeof current.value === "string") {
      if (current.value.length > MAX_MUTATION_VALUE_BYTES) return false;
      bytes += Buffer.byteLength(current.value, "utf8") + 2;
    } else if (typeof current.value === "object") {
      if (seen.has(current.value)) return false;
      seen.add(current.value);
      const prototype = Object.getPrototypeOf(current.value);
      if (Array.isArray(current.value)) {
        if (prototype !== Array.prototype) return false;
      } else if (prototype !== Object.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(current.value).length > 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      bytes += 2;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(current.value) && key === "length") continue;
        if (!("value" in descriptor) || !descriptor.enumerable) return false;
        bytes += Buffer.byteLength(key, "utf8") + 3;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } else return false;
    if (bytes > MAX_MUTATION_VALUE_BYTES) return false;
  }
  return true;
}
