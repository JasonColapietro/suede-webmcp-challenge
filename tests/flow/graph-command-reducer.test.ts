import { describe, expect, it } from "vitest";
import { applyGraphCommand, canApplyGraphCommand } from "@/lib/flow/graph-command-reducer";
import type { GraphCommand } from "@/lib/flow/graph-command-types";
import type { FlowGraph } from "@/lib/flow/types";

const graph = (): FlowGraph => ({
  id: "g",
  name: "Before",
  nodes: [
    { id: "a", type: "input", params: { prompt: "old", nested: { n: 1 } }, position: { x: 0, y: 0 }, futureNode: { kept: true } },
    { id: "b", type: "output", params: {}, position: { x: 100, y: 50 } },
  ],
  edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "in", futureEdge: 7 }],
  meta: { stable: true },
  futureGraph: { kept: true },
} as unknown as FlowGraph);

describe("pure graph command reducer", () => {
  it("applies primitive commands immutably and every inverse restores the exact graph", () => {
    const commands: GraphCommand[] = [
      { v: 1, id: "node-append", kind: "node.add", node: { id: "c", type: "input", params: {}, position: { x: 2, y: 3 } } },
      { v: 1, id: "node-index", kind: "node.add", index: 1, node: { id: "c", type: "input", params: {}, position: { x: 2, y: 3 } } },
      { v: 1, id: "patch", kind: "node.patch", nodeId: "a", patch: [{ op: "replace", path: "/prompt", value: "new" }] },
      { v: 1, id: "remove-node", kind: "node.remove", nodeId: "a" },
      { v: 1, id: "edge-append", kind: "edge.add", edge: { id: "a-b-2", source: "a", target: "b", targetHandle: "other" } },
      { v: 1, id: "edge-index", kind: "edge.add", index: 0, edge: { id: "a-b-2", source: "a", target: "b", targetHandle: "other" } },
      { v: 1, id: "remove-edge", kind: "edge.remove", edgeId: "a-b" },
      { v: 1, id: "move", kind: "selection.move", positions: { a: { x: 8, y: 9 } } },
      { v: 1, id: "layout", kind: "layout.apply", positions: { a: { x: 9, y: 8 }, b: { x: 7, y: 6 } } },
      { v: 1, id: "rename", kind: "graph.rename", name: "After" },
      { v: 1, id: "replace", kind: "graph.replace", graph: { ...graph(), name: "Replacement" } },
    ];

    for (const command of commands) {
      const source = graph();
      const before = structuredClone(source);
      const result = applyGraphCommand(source, command);
      expect(source, command.kind).toEqual(before);
      expect(applyGraphCommand(result.graph, result.inverse).graph, command.kind).toEqual(before);
    }
  });

  it("removal inverses are exact graph replacements preserving order and unknown fields", () => {
    for (const command of [
      { v: 1, id: "rn", kind: "node.remove", nodeId: "a" },
      { v: 1, id: "re", kind: "edge.remove", edgeId: "a-b" },
    ] as const) {
      const source = graph();
      const result = applyGraphCommand(source, command);
      expect(result.inverse.kind).toBe("graph.replace");
      expect((result.inverse as Extract<GraphCommand, { kind: "graph.replace" }>).graph).toEqual(source);
    }
  });

  it("patches params only and preserves every other node field", () => {
    const source = graph();
    const result = applyGraphCommand(source, { v: 1, id: "p", kind: "node.patch", nodeId: "a", patch: [{ op: "add", path: "/new", value: true }] });
    expect(result.graph.nodes[0]).toEqual({ ...source.nodes[0], params: { ...source.nodes[0].params, new: true } });
    expect(() => applyGraphCommand(source, { v: 1, id: "bad", kind: "node.patch", nodeId: "a", patch: [{ op: "replace", path: "/id", value: "x" }] })).toThrow(/does not exist|patch/i);
  });

  it("duplicates exactly the selected nodes and internal edges using explicit maps", () => {
    const result = applyGraphCommand(graph(), {
      v: 1, id: "dup", kind: "selection.duplicate", nodeIds: ["a", "b"], offset: { x: 40, y: 20 },
      nodeIdMap: { a: "copy-a", b: "copy-b" }, edgeIdMap: { "a-b": "copy-edge" },
    });
    expect(result.graph.nodes.slice(-2).map((node) => [node.id, node.position])).toEqual([
      ["copy-a", { x: 40, y: 20 }], ["copy-b", { x: 140, y: 70 }],
    ]);
    expect(result.graph.edges.at(-1)).toMatchObject({ id: "copy-edge", source: "copy-a", target: "copy-b", futureEdge: 7 });
    expect(result.affectedIds).toEqual(["copy-a", "copy-b", "copy-edge"]);
    expect(result.inverse.kind).toBe("graph.batch");
    expect((result.inverse as Extract<GraphCommand, { kind: "graph.batch" }>).commands.map((command) => command.kind)).toEqual([
      "edge.remove",
      "node.remove",
      "node.remove",
    ]);
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(graph());
  });

  it("applies a successful batch atomically with sorted affected IDs and reverse inverses", () => {
    const command: GraphCommand = { v: 1, id: "batch", kind: "graph.batch", commands: [
      { v: 1, id: "add", kind: "node.add", node: { id: "c", type: "input", params: {}, position: { x: 1, y: 2 } } },
      { v: 1, id: "rename", kind: "graph.rename", name: "After" },
      { v: 1, id: "move", kind: "selection.move", positions: { b: { x: 3, y: 4 } } },
    ] };
    const source = graph();
    const result = applyGraphCommand(source, command);
    expect(source).toEqual(graph());
    expect(result.affectedIds).toEqual(["b", "c", "g"]);
    expect(result.inverse.kind).toBe("graph.batch");
    expect((result.inverse as Extract<GraphCommand, { kind: "graph.batch" }>).commands.map((child) => child.id)).toEqual(["move:inverse", "rename:inverse", "add:inverse"]);
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(source);
  });

  it("does not expose or mutate anything when a later batch child fails", () => {
    const source = graph();
    const before = structuredClone(source);
    expect(() => applyGraphCommand(source, { v: 1, id: "batch-fail", kind: "graph.batch", commands: [
      { v: 1, id: "add", kind: "node.add", node: { id: "c", type: "input", params: {}, position: { x: 0, y: 0 } } },
      { v: 1, id: "collision", kind: "edge.add", edge: { id: "c-b", source: "c", target: "b", targetHandle: "in" } },
    ] })).toThrow(/collision/i);
    expect(source).toEqual(before);
  });

  it("returns a boolean preflight without leaking a result", () => {
    expect(canApplyGraphCommand(graph(), { v: 1, id: "ok", kind: "graph.rename", name: "ok" })).toBe(true);
    expect(canApplyGraphCommand(graph(), { v: 1, id: "bad", kind: "node.remove", nodeId: "missing" })).toBe(false);
  });
});
