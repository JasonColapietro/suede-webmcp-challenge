import { describe, expect, it } from "vitest";
import {
  commandForConnection,
  commandForDragCompletion,
  commandForNodeDrop,
  commandRequestsCanvasFocus,
  graphSelectionsEqual,
  measuredBoundsForNodes,
  liveSelectionBounds,
  nodeBoundsRecordsEqual,
  normalizeGraphSelection,
  pruneGraphSelection,
  resolveFocusNodeId,
  retryExactNodeFocus,
  selectionForNodeClick,
  selectionForEdgeClick,
  selectionAfterCommand,
} from "@/components/canvas/FlowCanvas";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import type { FlowGraph } from "@/lib/flow/types";

const graph = (): FlowGraph => ({
  id: "g",
  name: "Graph",
  nodes: [
    { id: "a", type: "input", params: {}, position: { x: 0, y: 0 }, futureNode: { kept: true } },
    { id: "b", type: "output", params: {}, position: { x: 100, y: 20 } },
  ],
  edges: [{ id: "a-b", source: "a", target: "b", futureEdge: true }],
} as unknown as FlowGraph);

describe("builder gesture command integration", () => {
  it("accepts a focus handoff only for the exact node in the loaded graph", () => {
    expect(resolveFocusNodeId(graph(), { nodeId: "b", token: 1 })).toBe("b");
    expect(resolveFocusNodeId(graph(), { nodeId: "missing", token: 2 })).toBeNull();
    expect(resolveFocusNodeId(graph(), undefined)).toBeNull();
  });

  it("retries delayed React Flow registration once, cancels stale work, and bounds missing nodes", () => {
    const frames: Array<(time: number) => void> = [];
    const fit: string[] = [];
    let reads = 0;
    const cancel = retryExactNodeFocus({
      nodeId: "b",
      getNode: () => ++reads < 3 ? null : ({ id: "b" } as never),
      focus: () => fit.push("focus"),
      fit: (node) => fit.push(node.id),
      requestFrame: (callback) => { frames.push(callback); return frames.length; },
      cancelFrame: () => undefined,
      maxFrames: 4,
    });
    while (frames.length) frames.shift()!(0);
    expect(fit).toEqual(["focus", "b"]);
    cancel();

    let missingReads = 0;
    const missingFrames: Array<(time: number) => void> = [];
    retryExactNodeFocus({
      nodeId: "missing", getNode: () => { missingReads += 1; return null; },
      focus: () => undefined, fit: () => undefined,
      requestFrame: (callback) => { missingFrames.push(callback); return missingFrames.length; },
      cancelFrame: () => undefined, maxFrames: 3,
    });
    while (missingFrames.length) missingFrames.shift()!(0);
    expect(missingReads).toBe(3);
  });

  it("treats identical controlled selection and bounds as idempotent", () => {
    const left = normalizeGraphSelection(["b", "a"], ["e"], "b");
    const right = normalizeGraphSelection(["a", "b"], ["e"], "b");
    expect(graphSelectionsEqual(left, right)).toBe(true);
    expect(graphSelectionsEqual(left, { ...right, primaryNodeId: "a" })).toBe(false);
    const bounds = { a: { x: 1, y: 2, width: 3, height: 4 } };
    expect(nodeBoundsRecordsEqual(bounds, structuredClone(bounds))).toBe(true);
    expect(nodeBoundsRecordsEqual(bounds, { a: { ...bounds.a, width: 5 } })).toBe(false);
  });

  it("normalizes stable selection and keeps a selected preferred primary", () => {
    expect(normalizeGraphSelection(["b", "a", "b"], ["z", "a", "z"], "b")).toEqual({
      nodeIds: ["a", "b"], edgeIds: ["a", "z"], primaryNodeId: "b",
    });
    expect(normalizeGraphSelection(["b", "a"], [], "missing").primaryNodeId).toBe("a");
  });

  it("selects edges without dropping additive node selection", () => {
    const current = normalizeGraphSelection(["a", "b"], ["e1"], "b");
    expect(selectionForEdgeClick(current, "e2", true)).toEqual({
      nodeIds: ["a", "b"], edgeIds: ["e1", "e2"], primaryNodeId: "b",
    });
    expect(selectionForEdgeClick(current, "e1", true)).toEqual({
      nodeIds: ["a", "b"], edgeIds: [], primaryNodeId: "b",
    });
    expect(selectionForEdgeClick(current, "e2", false)).toEqual({
      nodeIds: [], edgeIds: ["e2"], primaryNodeId: null,
    });
  });

  it("toggles modifier-clicked nodes and reports the next stable primary", () => {
    const current = normalizeGraphSelection(["a", "b"], ["a-b"], "b");
    expect(selectionForNodeClick(current, "b", true)).toEqual({
      nodeIds: ["a"], edgeIds: ["a-b"], primaryNodeId: "a",
    });
    expect(selectionForNodeClick(current, "c", true)).toEqual({
      nodeIds: ["a", "b", "c"], edgeIds: ["a-b"], primaryNodeId: "c",
    });
    expect(selectionForNodeClick(current, "c", false)).toEqual({
      nodeIds: ["c"], edgeIds: [], primaryNodeId: "c",
    });
  });

  it("prunes removed selections and chooses the next stable primary", () => {
    const current = normalizeGraphSelection(["a", "b"], ["a-b", "missing"], "b");
    const next = applyGraphCommand(graph(), { v: 1, id: "remove", kind: "node.remove", nodeId: "b" }).graph;
    expect(pruneGraphSelection(current, next)).toEqual({ nodeIds: ["a"], edgeIds: [], primaryNodeId: "a" });
  });

  it("compiles connection and node-drop gestures into typed add commands", () => {
    expect(commandForConnection({ source: "a", target: "b", sourceHandle: "result", targetHandle: "in" }, "connect-1", "edge-1")).toEqual({
      v: 1, id: "connect-1", kind: "edge.add",
      edge: { id: "edge-1", source: "a", target: "b", sourceHandle: "result", targetHandle: "in" },
    });
    expect(commandForNodeDrop("http", { x: 12, y: 34 }, "drop-1", "node-1")).toEqual({
      v: 1, id: "drop-1", kind: "node.add",
      node: { id: "node-1", type: "http", params: {}, position: { x: 12, y: 34 } },
    });
    expect(commandForNodeDrop("api.operation", { x: 12, y: 34 }, "drop-2", "node-2")).toBeNull();
  });

  it("emits one multi-node drag command and preserves compatible unknown fields", () => {
    const command = commandForDragCompletion(graph(), [
      { id: "b", position: { x: 140, y: 50 } },
      { id: "a", position: { x: 20, y: 10 } },
    ], "drag-1");
    expect(command).toEqual({
      v: 1, id: "drag-1", kind: "selection.move",
      positions: { a: { x: 20, y: 10 }, b: { x: 140, y: 50 } },
    });
    if (!command) throw new Error("expected drag command");
    const result = applyGraphCommand(graph(), command);
    expect((result.graph.nodes[0] as unknown as { futureNode: unknown }).futureNode).toEqual({ kept: true });
    expect(result.graph.edges).toEqual(graph().edges);
  });

  it("returns no drag command when no persisted position changed", () => {
    expect(commandForDragCompletion(graph(), [{ id: "a", position: { x: 0, y: 0 } }], "drag-1")).toBeNull();
  });

  it("selects newly added, duplicated, and pasted nodes after a command", () => {
    const current = normalizeGraphSelection(["a"], [], "a");
    const added = { v: 1 as const, id: "add", kind: "node.add" as const, node: { id: "c", type: "input" as const, params: {}, position: { x: 0, y: 0 } } };
    const addedGraph = applyGraphCommand(graph(), added).graph;
    expect(selectionAfterCommand(current, addedGraph, added).nodeIds).toEqual(["c"]);

    const duplicated = {
      v: 1 as const, id: "dup", kind: "selection.duplicate" as const,
      nodeIds: ["a"], offset: { x: 10, y: 10 }, nodeIdMap: { a: "copy-a" }, edgeIdMap: {},
    };
    const duplicatedGraph = applyGraphCommand(graph(), duplicated).graph;
    expect(selectionAfterCommand(current, duplicatedGraph, duplicated).nodeIds).toEqual(["copy-a"]);

    const paste = { v: 1 as const, id: "paste", kind: "graph.batch" as const, commands: [added] };
    expect(selectionAfterCommand(current, addedGraph, paste).nodeIds).toEqual(["c"]);
  });

  it("requests canvas focus only for direct or batched deletion commands", () => {
    expect(commandRequestsCanvasFocus({ v: 1, id: "remove", kind: "node.remove", nodeId: "a" })).toBe(true);
    expect(commandRequestsCanvasFocus({
      v: 1, id: "batch", kind: "graph.batch",
      commands: [{ v: 1, id: "edge-remove", kind: "edge.remove", edgeId: "a-b" }],
    })).toBe(true);
    expect(commandRequestsCanvasFocus({ v: 1, id: "rename", kind: "graph.rename", name: "Name" })).toBe(false);
  });

  it("captures finite measured bounds without changing graph data", () => {
    const bounds = measuredBoundsForNodes([
      { id: "b", position: { x: 100, y: 20 }, measured: { width: 180, height: 72 } },
      { id: "a", position: { x: 0, y: 0 }, measured: { width: 160, height: 64 } },
    ]);
    expect(bounds).toEqual({
      a: { x: 0, y: 0, width: 160, height: 64 },
      b: { x: 100, y: 20, width: 180, height: 72 },
    });
    expect(graph()).not.toHaveProperty("bounds");
  });

  it("uses live graph positions with measured dimensions for geometry commands", () => {
    const current = graph();
    current.nodes = current.nodes.map((node) => node.id === "a"
      ? { ...node, position: { x: 48, y: 32 } }
      : { ...node, position: { x: 196, y: 84 } });
    const measured = {
      a: { x: 0, y: 0, width: 160, height: 64 },
      b: { x: 100, y: 20, width: 180, height: 72 },
    };
    const before = structuredClone(measured);

    expect(liveSelectionBounds(current, ["a", "b"], measured)).toEqual({
      a: { x: 48, y: 32, width: 160, height: 64 },
      b: { x: 196, y: 84, width: 180, height: 72 },
    });
    expect(measured).toEqual(before);
  });
});
