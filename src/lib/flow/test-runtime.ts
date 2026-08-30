import type { LedgerRow, RunEvent } from "./types";
import type { NodeContext, NodeDef, NodeExecutor, NodeRegistry, NodeResult } from "./executor";
import { getRegistry } from "./registry";
import { NODE_DEFS } from "./nodes";
import { decideTestNodePolicy } from "./test-node-policy";
import { scopedTestStubFor } from "./test-scoped-stubs";
import { captureTestValue, createTestCaptureBudget } from "./test-runner-contract";

const GENERIC_FAILURE = "Scoped test node failed.";
const COST_INVARIANT_FAILURE = "Scoped test cost invariant failed.";
const CAPABILITY_DENIED = "Capability unavailable in an ephemeral scoped test.";
const DEFAULT_RUN_ID = "ephemeral-scoped-test";
const CONTROL = /[\u0000-\u001f\u007f]/u;

export interface SafeScopedTestRuntime {
  readonly ctx: NodeContext;
  readonly registry: NodeRegistry;
  readonly invariantViolated: () => boolean;
}

function safeRunId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !CONTROL.test(value)
    ? value
    : DEFAULT_RUN_ID;
}

function failure(error: string): NodeResult {
  return { ok: false, error, costUsdc: 0 };
}

function safeExecutor(executor: NodeExecutor, budget: ReturnType<typeof createTestCaptureBudget>): NodeExecutor {
  return async (ctx, params, inputs) => {
    let result: NodeResult;
    try { result = await executor(ctx, params, inputs); } catch { return failure(GENERIC_FAILURE); }
    if (result.costUsdc !== 0) return failure(COST_INVARIANT_FAILURE);
    if (!result.ok) return failure(GENERIC_FAILURE);
    const captured = captureTestValue(result.outputs, budget);
    if (captured.kind !== "value" || captured.value === null ||
        typeof captured.value !== "object" || Array.isArray(captured.value)) {
      return failure(GENERIC_FAILURE);
    }
    return { ok: true, outputs: captured.value as Record<string, unknown>, costUsdc: 0 };
  };
}

function createRegistry(): NodeRegistry | null {
  const canonical = getRegistry();
  const budget = createTestCaptureBudget();
  const registry: NodeRegistry = Object.create(null) as NodeRegistry;
  for (const runtime of NODE_DEFS) {
    if (canonical[runtime.type] !== runtime) return null;
    const decision = decideTestNodePolicy(runtime);
    if (!decision.ok) return null;
    let wrapped: NodeDef;
    if (decision.action === "native") {
      wrapped = { ...runtime, executor: safeExecutor(runtime.executor, budget) };
    } else if (decision.action === "scoped-stub-required") {
      const stub = scopedTestStubFor(runtime.type);
      if (!stub) return null;
      wrapped = {
        ...runtime,
        executor: async () => failure(GENERIC_FAILURE),
        dryRunStub: safeExecutor(stub, budget),
      };
    } else {
      wrapped = {
        ...runtime,
        executor: async () => failure(GENERIC_FAILURE),
        dryRunStub: undefined,
      };
    }
    registry[runtime.type] = Object.freeze(wrapped);
  }
  return Object.freeze(registry);
}

function dataValue(descriptors: Record<string, PropertyDescriptor>, key: string): unknown {
  const descriptor = descriptors[key];
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function createSafeScopedTestRuntime(runId: unknown): SafeScopedTestRuntime | null {
  const registry = createRegistry();
  if (!registry) return null;
  let violated = false;
  const logger = {
    emit(_event: RunEvent): void {
      // Engine events are streamed directly. Node-side logger emission is discarded.
    },
    record(row: LedgerRow): void {
      try {
        const descriptors = Object.getOwnPropertyDescriptors(row);
        if (dataValue(descriptors, "costUsdc") !== 0 || dataValue(descriptors, "settled") !== false) {
          violated = true;
        }
      } catch {
        violated = true;
      }
    },
  } as NodeContext["logger"];
  const denied = async (): Promise<never> => {
    throw new Error(CAPABILITY_DENIED);
  };
  const ctx: NodeContext = {
    runId: safeRunId(runId),
    dryRun: true,
    ownerId: null,
    wallet: { address: null, network: "base-mainnet" },
    x402: { call: denied } as unknown as NodeContext["x402"],
    llm: { generate: denied },
    logger,
    loadSubflow: denied,
    resolveSubflow: denied,
    resolveResourcePack: denied,
    registry,
    depth: 0,
    flowAncestry: Object.freeze([]),
    costCeiling: { limitUsdc: 0, spentUsdc: 0, reservedUsdc: 0 },
    runVariables: Object.freeze({}),
    resolveSecretReference: denied,
  };
  return Object.freeze({
    ctx,
    registry,
    invariantViolated: () => violated || ctx.costCeiling.spentUsdc !== 0 ||
      (ctx.costCeiling.reservedUsdc ?? 0) !== 0,
  });
}
