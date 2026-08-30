import { describe, expect, it, vi } from "vitest";
import { planFlowTestScope } from "@/lib/flow/test-scope";
import {
  decideTestNodePolicy,
  preflightPlannedTestNodes,
} from "@/lib/flow/test-node-policy";
import { NODE_DEFS } from "@/lib/flow/nodes";
import type { NodeDef, NodeRegistry } from "@/lib/flow/executor";
import type { FlowGraphV2, NodeType } from "@/lib/flow/types";
import type { PlannedFlowTestScope } from "@/lib/flow/test-scope";

function graph(types: readonly NodeType[]): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "policy-graph",
    name: "Policy graph",
    nodes: types.map((type, index) => ({
      id: `node-${index}`,
      type,
      params: {},
      bindings: {},
      position: { x: 0, y: 0 },
    })),
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function plan(nodeIds: readonly string[]): PlannedFlowTestScope {
  return {
    status: "planned",
    scope: { kind: "node", nodeId: nodeIds[0] ?? "none" },
    executionOrder: [...nodeIds],
    nodeIds: [...nodeIds],
    edgeIds: [],
    boundaryPins: [],
    boundaryNodeIds: [],
    unreachableNodeIds: [],
    disabledNodeIds: [],
  };
}

function registry(definitions: readonly NodeDef[]): NodeRegistry {
  return Object.fromEntries(definitions.map((definition) => [definition.type, definition]));
}

describe("canonical test node policy", () => {
  it("enumerates every registered canonical runtime without dispatching a current stub", () => {
    for (const runtime of NODE_DEFS) {
      const result = decideTestNodePolicy(runtime);
      if (runtime.definition.testMode === "stub") {
        expect(result, runtime.type).toEqual({ ok: true, action: "scoped-stub-required" });
      } else {
        expect(result, runtime.type).toEqual({ ok: true, action: "native" });
      }
    }
  });

  it("allows ordinary native nodes only when canonical, free, effect-empty, unguarded, and unstubbed", () => {
    const native = NODE_DEFS.find(({ type }) => type === "transform")!;
    expect(decideTestNodePolicy(native)).toEqual({ ok: true, action: "native" });
    for (const drift of [
      { ...native, costBearing: true },
      { ...native, sideEffecting: true },
      { ...native, dryRunStub: vi.fn() },
      { ...native, executor: vi.fn() },
      { ...native, definition: { ...native.definition } },
      { ...native, definition: NODE_DEFS.find(({ type }) => type === "input")!.definition },
    ]) {
      expect(decideTestNodePolicy(drift)).toEqual({
        ok: false,
        code: "invalid-test-node-policy",
      });
    }
  });

  it("allows only the exact subflow and loop inherits-graph native containers", () => {
    for (const type of ["subflow", "loop"] as const) {
      const container = NODE_DEFS.find((runtime) => runtime.type === type)!;
      expect(decideTestNodePolicy(container)).toEqual({ ok: true, action: "native" });
      expect(decideTestNodePolicy({
        ...container,
        definition: { ...container.definition, capabilityMode: "static" },
      })).toEqual({ ok: false, code: "invalid-test-node-policy" });
    }
  });

  it("requires guarded canonical stub nodes but returns only the scoped-stub action", () => {
    const stubbed = NODE_DEFS.find(({ definition }) => definition.testMode === "stub")!;
    expect(decideTestNodePolicy(stubbed)).toEqual({ ok: true, action: "scoped-stub-required" });
    expect(decideTestNodePolicy({ ...stubbed, dryRunStub: undefined })).toEqual({
      ok: false,
      code: "invalid-test-node-policy",
    });
    expect(decideTestNodePolicy({ ...stubbed, costBearing: false, sideEffecting: false })).toEqual({
      ok: false,
      code: "invalid-test-node-policy",
    });
  });

  it("invalidates synthetic refuse descriptors instead of widening the closed registry", () => {
    const runtime = NODE_DEFS.find(({ type }) => type === "transform")!;
    expect(decideTestNodePolicy({
      ...runtime,
      definition: { ...runtime.definition, testMode: "refuse" },
      costBearing: true,
      dryRunStub: undefined,
    })).toEqual({
      ok: false,
      code: "invalid-test-node-policy",
    });
  });

  it("generically refuses stateful runtime proxies without repeated property reads", () => {
    const native = NODE_DEFS.find(({ type }) => type === "input")!;
    let reads = 0;
    const proxy = new Proxy(native, {
      getOwnPropertyDescriptor(target, property) {
        reads += 1;
        if (property === "executor" && reads > 1) {
          return { value: vi.fn(), enumerable: true, configurable: true, writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => decideTestNodePolicy(proxy)).not.toThrow();
    expect(decideTestNodePolicy(proxy)).toEqual({ ok: false, code: "invalid-test-node-policy" });
  });

  it("generically invalidates unknown and malformed runtimes", () => {
    const native = NODE_DEFS.find(({ type }) => type === "input")!;
    for (const malformed of [
      undefined,
      { ...native, type: "unknown-node" as NodeType },
      { ...native, executor: null },
      { ...native, definition: null },
    ]) {
      expect(decideTestNodePolicy(malformed as never)).toEqual({
        ok: false,
        code: "invalid-test-node-policy",
      });
    }
  });

  it("preflights every planned node in stable plan order and returns no runtime values", () => {
    const actions = NODE_DEFS.map((runtime) => {
      const source = graph([runtime.type]);
      const result = preflightPlannedTestNodes(source, plan(["node-0"]), registry(NODE_DEFS));
      expect(JSON.stringify(result)).not.toMatch(/executor|dryRunStub|params|bindings/);
      expect(result.ok, runtime.type).toBe(true);
      return result.ok ? result.actions[0] : null;
    });
    expect(actions).toEqual(NODE_DEFS.map(({ definition }) =>
      definition.testMode === "stub" ? "scoped-stub-required" : "native"));
  });

  it("fails preflight generically before dispatch for missing, substituted, or inconsistent runtimes", () => {
    const native = NODE_DEFS.find(({ type }) => type === "transform")!;
    const source = graph([native.type]);
    const planned = plan([source.nodes[0]!.id]);
    const input = NODE_DEFS.find(({ type }) => type === "input")!;
    const failures = [
      preflightPlannedTestNodes(source, planned, {}),
      preflightPlannedTestNodes(source, planned, registry([{ ...native, costBearing: true }])),
      preflightPlannedTestNodes(source, { ...planned, nodeIds: ["secret-marker"] }, registry([native])),
      preflightPlannedTestNodes(source, planned, registry([{ ...native, executor: vi.fn() }])),
      preflightPlannedTestNodes(source, planned, { transform: input }),
      preflightPlannedTestNodes(source, {
        ...planned,
        nodeIds: ["node-0", "node-0"],
        executionOrder: ["node-0", "node-0"],
      }, registry([native])),
    ];
    expect(failures).toEqual([
      { ok: false, code: "invalid-test-node-policy" },
      { ok: false, code: "invalid-test-node-policy" },
      { ok: false, code: "invalid-test-node-policy" },
      { ok: false, code: "invalid-test-node-policy" },
      { ok: false, code: "invalid-test-node-policy" },
      { ok: false, code: "invalid-test-node-policy" },
    ]);
    expect(JSON.stringify(failures)).not.toContain("secret-marker");
  });

  it("recomputes and exact-compares a from-node plan before policy approval", () => {
    const transform = NODE_DEFS.find(({ type }) => type === "transform")!;
    const output = NODE_DEFS.find(({ type }) => type === "output")!;
    const source: FlowGraphV2 = {
      ...graph([transform.type, output.type]),
      nodes: [
        { ...graph([transform.type]).nodes[0]!, id: "source" },
        { ...graph([output.type]).nodes[0]!, id: "downstream", type: output.type },
      ],
      edges: [{
        id: "source-downstream",
        source: "source",
        sourceHandle: "result",
        target: "downstream",
        targetHandle: "in",
      }],
    };
    const forged = plan(["source"]);
    const forgedFrom = { ...forged, scope: { kind: "from-node" as const, nodeId: "source" } };
    const result = preflightPlannedTestNodes(source, forgedFrom, registry([transform, output]));
    expect(result).toEqual({ ok: false, code: "invalid-test-node-policy" });
    expect(JSON.stringify(result)).not.toContain("downstream");
  });

  it("rejects a forged plan whose toJSON impersonates the complete recomputed plan", () => {
    const transform = NODE_DEFS.find(({ type }) => type === "transform")!;
    const output = NODE_DEFS.find(({ type }) => type === "output")!;
    const source: FlowGraphV2 = {
      ...graph([transform.type, output.type]),
      nodes: [
        { ...graph([transform.type]).nodes[0]!, id: "source" },
        { ...graph([output.type]).nodes[0]!, id: "downstream", type: output.type },
      ],
      edges: [{
        id: "source-downstream",
        source: "source",
        sourceHandle: "result",
        target: "downstream",
        targetHandle: "in",
      }],
    };
    const scope = { kind: "from-node" as const, nodeId: "source" };
    const real = planFlowTestScope(source, scope);
    expect(real.status).toBe("planned");
    const forged = {
      ...plan(["source"]),
      scope,
      toJSON: () => real,
    } as unknown as PlannedFlowTestScope;
    expect(JSON.stringify(forged)).toBe(JSON.stringify(real));
    expect(preflightPlannedTestNodes(source, forged, registry([transform, output]))).toEqual({
      ok: false,
      code: "invalid-test-node-policy",
    });
  });

  it("rejects registry accessors and reflection traps without invoking or echoing them", () => {
    const transform = NODE_DEFS.find(({ type }) => type === "transform")!;
    const source = graph([transform.type]);
    const planned = plan(["node-0"]);
    let getterReads = 0;
    const accessor: NodeRegistry = {};
    Object.defineProperty(accessor, "transform", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? transform : { ...transform, executor: vi.fn() };
      },
    });
    const trapped = new Proxy({} as NodeRegistry, {
      ownKeys() { throw new Error("secret-marker"); },
    });
    for (const candidate of [accessor, trapped]) {
      expect(() => preflightPlannedTestNodes(source, planned, candidate)).not.toThrow();
      const result = preflightPlannedTestNodes(source, planned, candidate);
      expect(result).toEqual({ ok: false, code: "invalid-test-node-policy" });
      expect(JSON.stringify(result)).not.toContain("secret-marker");
    }
    expect(getterReads).toBe(0);
  });
});
