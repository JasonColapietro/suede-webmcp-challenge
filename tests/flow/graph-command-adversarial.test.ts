import { describe, expect, it } from "vitest";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import { parseGraphCommand } from "@/lib/flow/graph-command-schema";
import type { GraphCommand } from "@/lib/flow/graph-command-types";
import type { FlowGraph } from "@/lib/flow/types";

function legacy(): FlowGraph {
  return {
    id: "legacy", name: "Legacy",
    nodes: [
      { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "b", type: "input", params: {}, position: { x: 10, y: 0 } },
      { id: "c", type: "output", params: {}, position: { x: 20, y: 0 } },
    ],
    edges: [
      { id: "a-c", source: "a", target: "c", targetHandle: "in" },
      { id: "b-c", source: "b", target: "c", targetHandle: "in" },
    ],
  };
}

function isolated(count: number): FlowGraph {
  return {
    id: "isolated",
    name: "Isolated",
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `node-${String(index).padStart(3, "0")}`,
      type: "input" as const,
      params: {},
      position: { x: index, y: 0 },
    })),
    edges: [],
  };
}

function duplicateAll(graph: FlowGraph, id = "duplicate-all"): GraphCommand {
  const nodeIds = graph.nodes.map((node) => node.id);
  return {
    v: 1,
    id,
    kind: "selection.duplicate",
    nodeIds,
    offset: { x: 1, y: 1 },
    nodeIdMap: Object.fromEntries(nodeIds.map((nodeId) => [nodeId, `copy-${nodeId}`])),
    edgeIdMap: {},
  };
}

describe("graph command adversarial compatibility", () => {
  it.each([
    { v: 1, id: "rename", kind: "graph.rename", name: "Renamed" },
    { v: 1, id: "patch", kind: "node.patch", nodeId: "a", patch: [{ op: "add", path: "/x", value: 1 }] },
    { v: 1, id: "move", kind: "selection.move", positions: { a: { x: 1, y: 2 } } },
    { v: 1, id: "layout", kind: "layout.apply", positions: { a: { x: 3, y: 4 } } },
  ] as const)("permits $kind without worsening a grandfathered collision", (command) => {
    expect(() => applyGraphCommand(legacy(), command)).not.toThrow();
  });

  it("lets removal reduce a legacy collision and exact undo restore it", () => {
    const before = legacy();
    for (const command of [
      { v: 1, id: "edge-remove", kind: "edge.remove", edgeId: "a-c" },
      { v: 1, id: "node-remove", kind: "node.remove", nodeId: "a" },
    ] as const) {
      const result = applyGraphCommand(before, command);
      expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(before);
    }
  });

  it("accepts legacy collisions through graph.replace but rejects structural corruption", () => {
    expect(applyGraphCommand({ id: "empty", name: "E", nodes: [], edges: [] }, { v: 1, id: "legacy", kind: "graph.replace", graph: legacy() }).graph).toEqual(legacy());
    const invalid = [
      { ...legacy(), nodes: [...legacy().nodes, legacy().nodes[0]] },
      { ...legacy(), edges: [...legacy().edges, { id: "dangling", source: "missing", target: "c" }] },
      { ...legacy(), nodes: legacy().nodes.map((node) => node.id === "a" ? { ...node, position: { x: Number.NaN, y: 0 } } : node) },
      { ...legacy(), edges: [...legacy().edges, { id: "cycle", source: "c", target: "a" }] },
    ];
    for (const graph of invalid) expect(() => applyGraphCommand(legacy(), { v: 1, id: "replace", kind: "graph.replace", graph })).toThrow();
  });

  it("rejects self-loops, longer cycles, dangling endpoints, duplicate IDs and new or worsened collisions", () => {
    const clean: FlowGraph = { ...legacy(), edges: [] };
    const cases = [
      { graph: clean, command: { v: 1, id: "self", kind: "edge.add", edge: { id: "self", source: "a", target: "a" } } },
      { graph: { ...clean, edges: [{ id: "a-b", source: "a", target: "b" }, { id: "b-c", source: "b", target: "c" }] }, command: { v: 1, id: "cycle", kind: "edge.add", edge: { id: "c-a", source: "c", target: "a" } } },
      { graph: clean, command: { v: 1, id: "dangling", kind: "edge.add", edge: { id: "x-a", source: "x", target: "a" } } },
      { graph: clean, command: { v: 1, id: "duplicate", kind: "node.add", node: clean.nodes[0] } },
      { graph: legacy(), command: { v: 1, id: "worse", kind: "edge.add", edge: { id: "third", source: "a", target: "c", targetHandle: "in" } } },
    ];
    for (const { graph, command } of cases) expect(() => applyGraphCommand(graph, command as never)).toThrow();
  });

  it("validates duplicate maps against graph IDs and the exact internal edge set", () => {
    const base = legacy();
    const common = { v: 1 as const, id: "dup", kind: "selection.duplicate" as const, nodeIds: ["a", "c"], offset: { x: 1, y: 1 }, nodeIdMap: { a: "aa", c: "cc" } };
    expect(() => applyGraphCommand(base, { ...common, edgeIdMap: {} })).toThrow(/edgeidmap|internal|cover/i);
    expect(() => applyGraphCommand(base, { ...common, edgeIdMap: { "a-c": "a-c" } })).toThrow(/collid/i);
    expect(() => applyGraphCommand(base, { ...common, nodeIdMap: { a: "b", c: "cc" }, edgeIdMap: { "a-c": "new-edge" } })).toThrow(/collid/i);
    expect(() => applyGraphCommand(base, { ...common, nodeIdMap: { a: "a-c", c: "cc" }, edgeIdMap: { "a-c": "new-edge" } })).toThrow(/collid/i);
    expect(() => applyGraphCommand(base, { ...common, nodeIdMap: { a: "aa", c: "cc" }, edgeIdMap: { "a-c": "a" } })).toThrow(/collid/i);
    expect(() => applyGraphCommand(base, { ...common, nodeIdMap: { a: "shared", c: "cc" }, edgeIdMap: { "a-c": "shared" } })).toThrow(/across maps|unique/i);
    expect(() => applyGraphCommand(base, { ...common, nodeIds: ["a", "missing"], nodeIdMap: { a: "aa", missing: "mm" }, edgeIdMap: {} })).toThrow(/missing/i);
  });

  it("preserves input graphs on every rejection", () => {
    const source = legacy();
    const before = structuredClone(source);
    expect(() => applyGraphCommand(source, { v: 1, id: "bad", kind: "selection.move", positions: { missing: { x: 1, y: 2 } } })).toThrow();
    expect(source).toEqual(before);
  });

  it("rejects a direct duplicate whose generated inverse exceeds the parser child limit", () => {
    const source = isolated(501);
    expect(() => applyGraphCommand(source, duplicateAll(source))).toThrow(/inverse|500|limit/i);
    expect(source).toEqual(isolated(501));
  });

  it("rejects a batch whose generated nested inverse exceeds the flattened child limit", () => {
    const source = isolated(251);
    const commands = source.nodes.map((node, index): GraphCommand => ({
      v: 1,
      id: `duplicate-${String(index).padStart(3, "0")}`,
      kind: "selection.duplicate",
      nodeIds: [node.id],
      offset: { x: 1, y: 1 },
      nodeIdMap: { [node.id]: `copy-${node.id}` },
      edgeIdMap: {},
    }));
    expect(() => applyGraphCommand(source, { v: 1, id: "outer", kind: "graph.batch", commands })).toThrow(/inverse|500|limit/i);
    expect(source).toEqual(isolated(251));
  });

  it("accepts the direct duplicate boundary and returns a parseable inverse", () => {
    const source = isolated(500);
    const result = applyGraphCommand(source, duplicateAll(source));
    expect(parseGraphCommand(result.inverse)).toEqual(result.inverse);
  });
});
