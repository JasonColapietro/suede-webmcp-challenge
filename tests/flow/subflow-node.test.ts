import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MAX_SUBFLOW_DEPTH } from "@/lib/flow/engine";
import { subflowNode } from "@/lib/flow/nodes/subflow";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraphV2, FlowNodeV2, SubflowReference } from "@/lib/flow/types";
import type { NodeDef } from "@/lib/flow/executor";
import { makeCtx, registry } from "../_helpers";

const callable: FlowCallableInterface = {
  inputs: [{ id: "customer", label: "Customer", schema: {}, required: true, cardinality: "one", target: { kind: "trigger", path: "/payload/customer" } }],
  outputs: [{ id: "greeting", label: "Greeting", schema: {}, required: true, cardinality: "one", source: { nodeId: "echo", portId: "result", path: "/payload/customer/name" } }],
};

const reference: SubflowReference = {
  kind: "draft",
  flowId: "child-row",
  interface: callable,
  interfaceHash: hashCallableInterface(callable),
};

const graph: FlowGraphV2 = {
  schemaVersion: 2,
  id: "child-graph-id",
  name: "Child",
  variables: [], groups: [], annotations: [], callableInterface: callable,
  nodes: [{ id: "echo", type: "transform", position: { x: 0, y: 0 }, params: {}, bindings: {} }],
  edges: [],
};

const echo: NodeDef = {
  type: "transform", label: "Echo", group: "Logic", costBearing: false,
  paramsSchema: z.any(), inputs: ["in"], outputs: ["result"],
  executor: async (_ctx, _params, inputs) => ({ ok: true, outputs: { result: inputs }, costUsdc: 0 }),
};

describe("typed subflow runtime ABI", () => {
  it("keeps legacy flowId execution compatible when old unknown params are present", async () => {
    const legacyGraph = {
      id: "legacy-child-graph", name: "Legacy",
      nodes: [{ id: "echo", type: "transform" as const, params: {}, position: { x: 0, y: 0 } }], edges: [],
    };
    const ctx = makeCtx({ loadSubflow: async () => legacyGraph, registry: registry([echo]) });
    const result = await subflowNode.executor(ctx, { flowId: "legacy-row", oldUnknown: "keep-at-rest" }, { value: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outputs.result).toEqual({ echo: { result: { value: 3 } } });
  });
  it("maps named inputs to the child trigger and projects only declared named outputs", async () => {
    const resolveSubflow = vi.fn().mockResolvedValue({
      graph, flowId: "child-row", semanticHash: "a".repeat(64), callableInterface: callable,
    });
    const ctx = makeCtx({ resolveSubflow, registry: registry([echo]) });
    const result = await subflowNode.executor(ctx, { reference }, { customer: { name: "Ada" }, ignored: "secret-ish" });
    expect(result).toEqual({ ok: true, outputs: { greeting: "Ada" }, costUsdc: 0 });
    expect(resolveSubflow).toHaveBeenCalledWith(reference);
  });

  it("refuses repeated authoritative flow row IDs before the child emits run:start", async () => {
    let dispatched = 0;
    const probe = { ...echo, executor: async () => { dispatched += 1; return { ok: true as const, outputs: { result: {} }, costUsdc: 0 }; } };
    const ctx = makeCtx({
      flowAncestry: Object.freeze(["root-row", "child-row"]),
      resolveSubflow: async () => ({ graph, flowId: "child-row", semanticHash: "a".repeat(64), callableInterface: callable }),
      registry: registry([probe]),
    });
    const result = await subflowNode.executor(ctx, { reference }, { customer: { name: "Ada" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/recursive subflow.*child-row/i);
    expect(dispatched).toBe(0);
  });

  it("treats another pinned version of an ancestor flow as the same recursion identity", async () => {
    const pinned: SubflowReference = {
      kind: "pinned", flowId: "child-row", versionId: "other-version",
      interface: callable, interfaceHash: hashCallableInterface(callable), contentHash: "b".repeat(64),
    };
    const ctx = makeCtx({
      flowAncestry: Object.freeze(["child-row"]),
      resolveSubflow: async () => ({ graph, flowId: "child-row", versionId: "other-version", semanticHash: "b".repeat(64), callableInterface: callable }),
      registry: registry([echo]),
    });
    const result = await subflowNode.executor(ctx, { reference: pinned }, { customer: { name: "Ada" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/recursive subflow.*child-row/i);
  });

  it("refuses a stale callable output source port before child dispatch", async () => {
    let dispatched = 0;
    const probe = { ...echo, executor: async () => { dispatched += 1; return { ok: true as const, outputs: { result: {} }, costUsdc: 0 }; } };
    const stale = {
      ...callable,
      outputs: [{ ...callable.outputs[0]!, source: { nodeId: "echo", portId: "missing" } }],
    };
    const ctx = makeCtx({
      resolveSubflow: async () => ({ graph: { ...graph, callableInterface: stale }, flowId: "child-row", semanticHash: "a".repeat(64), callableInterface: stale }),
      registry: registry([probe]),
    });
    const result = await subflowNode.executor(ctx, { reference }, { customer: { name: "Ada" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/callable output.*missing/i);
    expect(dispatched).toBe(0);
    expect(ctx.costCeiling.spentUsdc).toBe(0);
  });

  it("allows multi-level nesting and retains a finite maximum-depth backstop", async () => {
    const empty: FlowCallableInterface = { inputs: [], outputs: [] };
    const ref = (flowId: string): SubflowReference => ({ kind: "draft", flowId, interface: empty, interfaceHash: hashCallableInterface(empty) });
    const nested = (flowId: string, next?: string): FlowGraphV2 => ({
      schemaVersion: 2, id: `graph-${flowId}`, name: flowId, variables: [], groups: [], annotations: [], callableInterface: empty,
      nodes: next ? [{ id: `call-${next}`, type: "subflow", position: { x: 0, y: 0 }, bindings: {}, params: { reference: ref(next) } as unknown as FlowNodeV2["params"] }] : [],
      edges: [],
    });
    const graphs = new Map([["a", nested("a", "b")], ["b", nested("b", "c")], ["c", nested("c")]]);
    const ctx = makeCtx({
      flowAncestry: Object.freeze(["root"]), registry: registry([subflowNode]),
      resolveSubflow: async (value) => ({ graph: graphs.get(value.flowId)!, flowId: value.flowId, semanticHash: "a".repeat(64), callableInterface: empty }),
    });
    const valid = await subflowNode.executor(ctx, { reference: ref("a") }, {});
    expect(valid.ok).toBe(true);
    const tooDeep = await subflowNode.executor({ ...ctx, depth: MAX_SUBFLOW_DEPTH }, { reference: ref("a") }, {});
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.error).toMatch(/depth.*exceeds max/i);
  });

  it("gives every child an independent ancestry set while preserving shared ledger identity", async () => {
    const seen: Array<{ ancestry: readonly string[]; ledger: unknown; mutationRefused: boolean }> = [];
    const probe: NodeDef = {
      ...echo,
      executor: async (ctx, _params, inputs) => {
        let mutationRefused = false;
        try { (ctx.flowAncestry as string[]).push("hostile"); } catch { mutationRefused = true; }
        seen.push({ ancestry: ctx.flowAncestry, ledger: ctx.costCeiling, mutationRefused });
        return { ok: true, outputs: { result: inputs }, costUsdc: 0 };
      },
    };
    const ctx = makeCtx({
      flowAncestry: Object.freeze(["root-row"]),
      resolveSubflow: async () => ({ graph, flowId: "child-row", semanticHash: "a".repeat(64), callableInterface: callable }),
      registry: registry([probe]),
    });
    await Promise.all([
      subflowNode.executor(ctx, { reference }, { customer: { name: "A" } }),
      subflowNode.executor(ctx, { reference }, { customer: { name: "B" } }),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.ancestry).not.toBe(seen[1]!.ancestry);
    expect(seen[0]!.ledger).toBe(seen[1]!.ledger);
    expect(seen.every((entry) => entry.mutationRefused)).toBe(true);
    expect(ctx.flowAncestry).toEqual(["root-row"]);
  });

  it("keeps nested typed dry runs behind the central side-effect gate", async () => {
    let externalCalls = 0;
    const guarded: NodeDef = {
      type: "http", label: "Guarded HTTP", group: "Logic", costBearing: false, sideEffecting: true,
      paramsSchema: z.any(), inputs: ["in"], outputs: ["result"],
      executor: async () => { externalCalls += 1; return { ok: true, outputs: { result: "real" }, costUsdc: 0 }; },
      dryRunStub: async () => ({ ok: true, outputs: { result: "dry" }, costUsdc: 0 }),
    };
    const dryInterface: FlowCallableInterface = {
      inputs: [],
      outputs: [{ id: "value", label: "Value", schema: {}, required: true, cardinality: "one", source: { nodeId: "http", portId: "result" } }],
    };
    const dryGraph: FlowGraphV2 = {
      schemaVersion: 2, id: "dry-child", name: "Dry child", variables: [], groups: [], annotations: [], callableInterface: dryInterface,
      nodes: [{ id: "http", type: "http", position: { x: 0, y: 0 }, params: {}, bindings: {} }], edges: [],
    };
    const dryRef: SubflowReference = { kind: "draft", flowId: "dry-row", interface: dryInterface, interfaceHash: hashCallableInterface(dryInterface) };
    const ctx = makeCtx({ dryRun: true, registry: registry([guarded]), resolveSubflow: async () => ({ graph: dryGraph, flowId: "dry-row", semanticHash: "a".repeat(64), callableInterface: dryInterface }) });
    const result = await subflowNode.executor(ctx, { reference: dryRef }, {});
    expect(result).toEqual({ ok: true, outputs: { value: "dry" }, costUsdc: 0 });
    expect(externalCalls).toBe(0);
  });
});
