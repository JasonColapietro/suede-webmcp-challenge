import { describe, expect, it } from "vitest";
import { planFlowTestScope } from "@/lib/flow/test-scope";
import type { FlowEdgeV2, FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";

const node = (
  id: string,
  type: FlowNodeV2["type"] = "transform",
  bindings: FlowNodeV2["bindings"] = {},
): FlowNodeV2 => ({
  id,
  type,
  params: type === "transform" ? { expression: "input" } : {},
  bindings,
  position: { x: 0, y: 0 },
});

const edge = (
  id: string,
  source: string,
  target: string,
  condition?: FlowEdgeV2["condition"],
): FlowEdgeV2 => ({
  id,
  source,
  sourceHandle: "result",
  target,
  targetHandle: "in",
  ...(condition === undefined ? {} : { condition }),
});

function graph(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "scope-graph",
    name: "Scope graph",
    nodes: [],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    ...overrides,
  };
}

function dependencyGraph(): FlowGraphV2 {
  return graph({
    nodes: [
      node("a", "input"),
      node("b", "transform", {
        injected: { kind: "port", nodeId: "x", portId: "result", path: "nested.value" },
        literal: { kind: "literal", value: true },
        variable: { kind: "variable", variableId: "v" },
        secret: { kind: "secret", connectionId: "conn", field: "token" },
      }),
      node("c", "output"),
      node("d", "input"),
      node("x", "input"),
      node("z", "output"),
    ],
    edges: [
      edge("a-b", "a", "b"),
      edge("b-c", "b", "c", { kind: "port", nodeId: "d", portId: "result", path: "allowed" }),
    ],
    variables: [{ id: "v", name: "V", scope: "run", schema: {} }],
  });
}

describe("flow test scope planner", () => {
  it("plans one node and exposes every omitted incoming producer as a boundary pin", () => {
    const result = planFlowTestScope(dependencyGraph(), { kind: "node", nodeId: "b" });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.executionOrder).toEqual(["b"]);
    expect(result.edgeIds).toEqual([]);
    expect(result.boundaryPins).toMatchObject([
      {
        kind: "edge-input", edgeId: "a-b", sourceNodeId: "a", sourcePortId: "result",
        targetNodeId: "b", targetPortId: "in",
      },
      {
        kind: "node-binding", sourceNodeId: "x", sourcePortId: "result",
        targetNodeId: "b", bindingKey: "injected", path: "nested.value",
      },
    ]);
    expect(result.boundaryPins.every(({ key }) => typeof key === "string" && key.startsWith("["))).toBe(true);
    expect(result.boundaryNodeIds).toEqual(["a", "x"]);
    expect(result.unreachableNodeIds).toEqual(["c", "d", "z"]);
    expect(result.disabledNodeIds).toEqual(["a", "c", "d", "x", "z"]);
  });

  it("uses edges, port bindings, and port conditions for upstream and downstream closure", () => {
    const source = dependencyGraph();
    const to = planFlowTestScope(source, { kind: "to-node", nodeId: "c" });
    expect(to).toMatchObject({
      status: "planned",
      executionOrder: ["a", "d", "x", "b", "c"],
      edgeIds: ["a-b", "b-c"],
      boundaryPins: [],
      unreachableNodeIds: ["z"],
    });

    const from = planFlowTestScope(source, { kind: "from-node", nodeId: "b" });
    expect(from.status).toBe("planned");
    if (from.status !== "planned") return;
    expect(from.executionOrder).toEqual(["b", "c"]);
    expect(from.edgeIds).toEqual(["b-c"]);
    expect(from.boundaryPins.map((pin) => pin.kind)).toEqual([
      "edge-input", "edge-condition", "node-binding",
    ]);
    expect(from.boundaryPins.find((pin) => pin.kind === "edge-condition")).toMatchObject({
      edgeId: "b-c", sourceNodeId: "d", targetNodeId: "c", path: "allowed", expected: "boolean",
    });
    expect(from.boundaryNodeIds).toEqual(["a", "d", "x"]);
    expect(from.unreachableNodeIds).toEqual(["z"]);
  });

  it("is byte-stable across node, edge, and binding insertion order", () => {
    const first = dependencyGraph();
    const b = first.nodes.find(({ id }) => id === "b")!;
    const shuffled = graph({
      ...first,
      nodes: [...first.nodes].reverse().map((candidate) => candidate.id === "b" ? {
        ...b,
        bindings: Object.fromEntries(Object.entries(b.bindings).reverse()),
      } : candidate),
      edges: [...first.edges].reverse(),
      variables: first.variables,
      groups: first.groups,
      annotations: first.annotations,
    });
    expect(JSON.stringify(planFlowTestScope(first, { kind: "from-node", nodeId: "b" }))).toBe(
      JSON.stringify(planFlowTestScope(shuffled, { kind: "from-node", nodeId: "b" })),
    );
  });

  it("disables explicit, hidden, and self cycles without returning a partial plan", () => {
    const explicit = graph({
      nodes: [node("a"), node("b")],
      edges: [edge("a-b", "a", "b"), edge("b-a", "b", "a")],
    });
    expect(planFlowTestScope(explicit, { kind: "to-node", nodeId: "a" })).toEqual({
      status: "disabled", code: "CYCLE", message: "The selected test scope contains a dependency cycle.",
      cycleNodeIds: ["a", "b"],
    });

    const hidden = graph({
      nodes: [node("a", "transform", { fromB: { kind: "port", nodeId: "b", portId: "result" } }), node("b")],
      edges: [edge("a-b", "a", "b")],
    });
    expect(planFlowTestScope(hidden, { kind: "from-node", nodeId: "a" })).toMatchObject({
      status: "disabled", code: "CYCLE", cycleNodeIds: ["a", "b"],
    });

    const self = graph({
      nodes: [node("self", "transform", { itself: { kind: "port", nodeId: "self", portId: "result" } })],
    });
    expect(planFlowTestScope(self, { kind: "node", nodeId: "self" })).toMatchObject({
      status: "disabled", code: "CYCLE", cycleNodeIds: ["self"],
    });
  });

  it("cuts an outside cycle for node-only testing and leaves an unrelated cycle outside closure", () => {
    const source = graph({
      nodes: [node("a"), node("b"), node("safe")],
      edges: [edge("a-b", "a", "b"), edge("b-a", "b", "a")],
    });
    expect(planFlowTestScope(source, { kind: "node", nodeId: "a" })).toMatchObject({
      status: "planned", executionOrder: ["a"], boundaryNodeIds: ["b"], unreachableNodeIds: ["safe"],
    });
    expect(planFlowTestScope(source, { kind: "node", nodeId: "safe" })).toMatchObject({
      status: "planned", executionOrder: ["safe"], boundaryNodeIds: [], unreachableNodeIds: ["a", "b"],
    });
  });

  it("returns typed disabled results for missing selection and unsafe graph identity", () => {
    expect(planFlowTestScope(graph(), { kind: "node", nodeId: "missing" })).toEqual({
      status: "disabled", code: "MISSING_NODE", message: 'Test node "missing" does not exist.',
    });
    const duplicate = graph({ nodes: [node("same"), node("same")] });
    expect(planFlowTestScope(duplicate, { kind: "node", nodeId: "same" })).toMatchObject({
      status: "disabled", code: "INVALID_GRAPH",
    });
  });

  it("ignores dangling dependencies wholly outside a node-only execution boundary", () => {
    const source = graph({
      nodes: [
        node("selected"),
        node("unrelated", "transform", {
          missing: { kind: "port", nodeId: "missing-binding-source", portId: "result" },
        }),
      ],
      edges: [
        edge("selected-outgoing", "selected", "missing-target"),
        edge("unrelated-dangling", "missing-source", "unrelated"),
      ],
    });
    expect(planFlowTestScope(source, { kind: "node", nodeId: "selected" })).toMatchObject({
      status: "planned",
      executionOrder: ["selected"],
      boundaryPins: [],
      edgeIds: [],
      unreachableNodeIds: ["unrelated"],
    });
  });

  it("fails closed when a missing producer feeds the included node", () => {
    const edgeSourceMissing = graph({
      nodes: [node("selected")],
      edges: [edge("missing-input", "missing", "selected")],
    });
    expect(planFlowTestScope(edgeSourceMissing, { kind: "node", nodeId: "selected" })).toMatchObject({
      status: "disabled", code: "INVALID_GRAPH",
    });

    const bindingSourceMissing = graph({
      nodes: [node("selected", "transform", {
        missing: { kind: "port", nodeId: "missing", portId: "result" },
      })],
    });
    expect(planFlowTestScope(bindingSourceMissing, { kind: "node", nodeId: "selected" })).toMatchObject({
      status: "disabled", code: "INVALID_GRAPH",
    });
  });

  it("fails closed when directional closure reaches a dangling dependency", () => {
    const upstreamMissing = graph({
      nodes: [node("target")],
      edges: [edge("missing-upstream", "missing", "target")],
    });
    expect(planFlowTestScope(upstreamMissing, { kind: "to-node", nodeId: "target" })).toMatchObject({
      status: "disabled", code: "INVALID_GRAPH",
    });

    const downstreamMissing = graph({
      nodes: [node("source")],
      edges: [edge("missing-downstream", "source", "missing")],
    });
    expect(planFlowTestScope(downstreamMissing, { kind: "from-node", nodeId: "source" })).toMatchObject({
      status: "disabled", code: "INVALID_GRAPH",
    });
  });

  it("fails closed on a relevant undeclared port while ignoring no runtime values", () => {
    const invalid = graph({
      nodes: [node("a", "input"), node("b")],
      edges: [{ ...edge("bad-port", "a", "b"), sourceHandle: "missing" }],
    });
    expect(planFlowTestScope(invalid, { kind: "to-node", nodeId: "b" })).toMatchObject({
      status: "disabled", code: "INVALID_GRAPH",
    });
  });

  it("does not mutate the graph and handles long chains iteratively", () => {
    const nodes = [node("n0000", "input")];
    const edges: FlowEdgeV2[] = [];
    for (let index = 1; index < 2_000; index += 1) {
      const id = `n${String(index).padStart(4, "0")}`;
      const prior = `n${String(index - 1).padStart(4, "0")}`;
      nodes.push(node(id));
      edges.push(edge(`e${index}`, prior, id));
    }
    const source = graph({ nodes, edges });
    const before = structuredClone(source);
    const result = planFlowTestScope(source, { kind: "to-node", nodeId: "n1999" });
    expect(result).toMatchObject({ status: "planned" });
    if (result.status === "planned") expect(result.executionOrder).toHaveLength(2_000);
    expect(source).toEqual(before);
  });

  it("treats opaque and prototype-like ids as data", () => {
    const source = graph({
      nodes: [node("__proto__", "input"), node("子/%:target")],
      edges: [edge("edge/%", "__proto__", "子/%:target")],
    });
    expect(planFlowTestScope(source, { kind: "to-node", nodeId: "子/%:target" })).toMatchObject({
      status: "planned", executionOrder: ["__proto__", "子/%:target"], edgeIds: ["edge/%"],
    });
  });
});
