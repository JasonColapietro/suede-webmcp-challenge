import { describe, expect, it } from "vitest";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import { layoutGraph, layoutGraphTopDown } from "@/lib/flow/graph-layout";
import { hashFlowGraph } from "@/lib/projects/hash";
import type { FlowGraph, FlowNode } from "@/lib/flow/types";

const node = (id: string, extra: Record<string, unknown> = {}): FlowNode => ({
  id,
  type: "input",
  params: { id, nested: { keep: true } },
  position: { x: 999, y: -777 },
  ...extra,
} as FlowNode);

function graph(nodes: string[], edges: Array<[string, string]>): FlowGraph {
  return {
    id: "layout-graph",
    name: "Layout graph",
    nodes: nodes.map((id) => node(id)),
    edges: edges.map(([source, target], index) => ({ id: `e${index}`, source, target })),
    meta: { runtime: { retries: 3 }, viewport: { x: 1, y: 2, zoom: 1 } },
  };
}

describe("deterministic local graph layout", () => {
  it("lays out chains and diamonds in longest-path layers", () => {
    expect(layoutGraph(graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]))).toEqual({
      a: { x: 80, y: 80 }, b: { x: 380, y: 80 }, c: { x: 680, y: 80 },
    });
    const diamond = layoutGraph(graph(["d", "c", "b", "a"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]));
    expect(diamond.a).toEqual({ x: 80, y: 80 });
    expect([diamond.b, diamond.c]).toEqual([{ x: 380, y: 80 }, { x: 380, y: 230 }]);
    expect(diamond.d).toEqual({ x: 680, y: 80 });
  });

  it("is independent of collection order and prior positions and is idempotent", () => {
    const source = graph(["root-b", "leaf-b", "root-a", "leaf-a", "solo"], [
      ["root-b", "leaf-b"], ["root-a", "leaf-a"],
    ]);
    const first = layoutGraph(source);
    const shuffled = layoutGraph({
      ...source,
      nodes: [...source.nodes].reverse().map((value) => ({
        ...value,
        position: { x: value.position.x + 12345, y: value.position.y - 9876 },
      })),
      edges: [...source.edges].reverse(),
    });
    expect(shuffled).toEqual(first);
    expect(layoutGraph({
      ...source,
      nodes: source.nodes.map((value) => ({ ...value, position: first[value.id]! })),
    })).toEqual(first);
    expect(first).toEqual({
      "leaf-a": { x: 380, y: 80 },
      "root-a": { x: 80, y: 80 },
      "leaf-b": { x: 380, y: 230 },
      "root-b": { x: 80, y: 230 },
      solo: { x: 80, y: 380 },
    });
  });

  it("swaps axes for top-down orientation without changing layoutGraph", () => {
    expect(layoutGraphTopDown(graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]))).toEqual({
      a: { x: 80, y: 80 }, b: { x: 80, y: 380 }, c: { x: 80, y: 680 },
    });
  });

  it("refuses cycles, duplicate IDs, and dangling endpoints without mutation", () => {
    const cyclic = graph(["a", "b"], [["a", "b"], ["b", "a"]]);
    const before = structuredClone(cyclic);
    expect(() => layoutGraph(cyclic)).toThrow(/cycle/i);
    expect(cyclic).toEqual(before);
    expect(() => layoutGraph({ ...graph(["a"], []), nodes: [node("a"), node("a")] })).toThrow(/duplicate/i);
    expect(() => layoutGraph(graph(["a"], [["a", "missing"]]))).toThrow(/endpoint|missing|dangling/i);
  });

  it("changes positions only, preserves semantic identity, and has an exact move inverse", () => {
    const source = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]) as FlowGraph & {
      futureGraphField?: { keep: boolean };
    };
    source.futureGraphField = { keep: true };
    source.nodes = source.nodes.map((value, index) => ({ ...value, futureNodeField: `keep-${index}` } as FlowNode));
    source.edges = source.edges.map((value, index) => ({ ...value, futureEdgeField: `keep-${index}` }));
    const before = structuredClone(source);
    const positions = layoutGraph(source);
    const result = applyGraphCommand(source, { v: 1, id: "layout", kind: "layout.apply", positions });
    expect(hashFlowGraph(result.graph, { semantic: true })).toBe(hashFlowGraph(source, { semantic: true }));
    expect(hashFlowGraph(result.graph, { semantic: false })).not.toBe(hashFlowGraph(source, { semantic: false }));
    expect(result.inverse).toMatchObject({ kind: "selection.move" });
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(source);
    expect(source).toEqual(before);
    expect({ ...result.graph, nodes: result.graph.nodes.map((value) => ({ ...value, position: before.nodes.find((old) => old.id === value.id)!.position })) }).toEqual(source);
  });
});
