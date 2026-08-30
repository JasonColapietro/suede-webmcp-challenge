import { z } from "zod";
import { RunLogger } from "@/lib/log";
import { X402Client } from "@/lib/rails/x402-client";
import { createStubLlm } from "@/lib/llm";
import type { NodeContext, NodeDef, NodeRegistry } from "@/lib/flow/executor";
import type { FlowGraph, FlowNode, FlowEdge, NodeType } from "@/lib/flow/types";

export function makeCtx(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    runId: "test-run",
    dryRun: true,
    wallet: { address: null, network: "base-mainnet" },
    x402: new X402Client({ dryRun: true }),
    llm: createStubLlm(),
    logger: new RunLogger(),
    loadSubflow: async () => {
      throw new Error("no subflow loader in test");
    },
    resolveSubflow: async () => {
      throw new Error("no typed subflow resolver in test");
    },
    resolveResourcePack: async () => null,
    registry: {},
    depth: 0,
    flowAncestry: Object.freeze([]),
    // Generous default so existing tests that don't care about the cost
    // ceiling never trip it by accident. Tests exercising the ceiling
    // itself override this explicitly.
    costCeiling: { limitUsdc: 1_000_000, spentUsdc: 0 },
    runVariables: {},
    resolveSecretReference: async ({ connectionId, field }) => {
      throw new Error(`No test secret resolver for ${connectionId}:${field}`);
    },
    ...overrides,
  };
}

/**
 * A pass-through stub node that forwards its inputs and charges `cost`.
 * `priceUsdc` is set to the same value so the engine's pre-execution
 * ceiling check (which projects cost from priceUsdc) can be exercised
 * against it, matching how real cost-bearing nodes declare a list price.
 *
 * Deliberately does NOT set `costBearing` — most callers pass a real node
 * type name (e.g. "llm", "http") to exercise `isCostBearingNode`'s
 * deny-by-default classification and the in-run cost ceiling exactly as a
 * real cost-bearing node would. That means `requiresDryRunStub` is true
 * for most uses of this helper, so it also declares a `dryRunStub` — the
 * engine's central dry-run gate (engine.ts's executeNode) would otherwise
 * refuse to run it at all under the many existing tests that use
 * `makeCtx()`'s default `dryRun: true` without caring about dry-run
 * semantics one way or the other. The stub mirrors the real executor
 * exactly except cost is forced to 0, matching the invariant that a dry
 * run never actually spends anything.
 */
export function passNode(type: NodeType, cost = 0): NodeDef {
  return {
    type,
    label: type,
    group: "Logic",
    priceUsdc: cost,
    paramsSchema: z.any(),
    inputs: ["in"],
    outputs: ["result"],
    executor: async (_ctx, _params, inputs) => ({ ok: true, outputs: { result: inputs }, costUsdc: cost }),
    dryRunStub: async (_ctx, _params, inputs) => ({ ok: true, outputs: { result: inputs }, costUsdc: 0 }),
  };
}

/** A stub node that always fails. */
export function failNode(type: NodeType): NodeDef {
  return {
    type,
    label: type,
    group: "Logic",
    paramsSchema: z.any(),
    inputs: ["in"],
    outputs: ["result"],
    executor: async () => ({ ok: false, error: "boom", costUsdc: 0 }),
  };
}

export function node(id: string, type: NodeType): FlowNode {
  return { id, type, params: {}, position: { x: 0, y: 0 } };
}

export function edge(source: string, target: string, sourceHandle?: string): FlowEdge {
  return { id: `${source}->${target}`, source, target, sourceHandle };
}

export function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { id: "g1", name: "test", nodes, edges };
}

export function registry(defs: NodeDef[]): NodeRegistry {
  const r: NodeRegistry = {};
  for (const d of defs) r[d.type] = d;
  return r;
}
