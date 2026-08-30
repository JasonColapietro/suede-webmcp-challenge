import { describe, expect, it } from "vitest";
import {
  BUILDER_COMMAND_IDS,
  commandState,
  commandForShortcut,
  commandForSelectionDelete,
  commandForSelectionDuplicate,
  type BuilderCommandContext,
} from "@/lib/flow/builder-command-registry";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import type { FlowGraph } from "@/lib/flow/types";

const emptyContext: BuilderCommandContext = {
  canUndo: false,
  canRedo: false,
  canPaste: false,
  selectedNodeIds: [],
  selectedEdgeIds: [],
  boundedNodeIds: [],
  graphNodeCount: 0,
};

describe("builder command registry", () => {
  it("enumerates every command family exactly once", () => {
    expect(BUILDER_COMMAND_IDS).toEqual([
      "history.undo", "history.redo", "selection.copy", "selection.paste",
      "selection.duplicate", "selection.delete",
      "selection.align-left", "selection.align-center-x", "selection.align-right",
      "selection.align-top", "selection.align-center-y", "selection.align-bottom",
      "selection.distribute-x", "selection.distribute-y",
      "graph.auto-layout", "palette.open",
    ]);
    expect(new Set(BUILDER_COMMAND_IDS).size).toBe(BUILDER_COMMAND_IDS.length);
  });

  it("returns explicit disabled reasons from one availability model", () => {
    expect(commandState("selection.delete", emptyContext)).toMatchObject({
      enabled: false, reason: "Select at least one node or edge.",
    });
    expect(commandState("selection.copy", emptyContext).reason).toBe("Select at least one node.");
    expect(commandState("selection.paste", emptyContext).reason).toBe("Clipboard does not contain a graph fragment yet.");
    expect(commandState("history.undo", emptyContext).reason).toBe("Nothing to undo.");
    expect(commandState("history.redo", emptyContext).reason).toBe("Nothing to redo.");
    expect(commandState("graph.auto-layout", emptyContext).reason).toBe("Add at least one node.");
    expect(commandState("palette.open", emptyContext).enabled).toBe(true);
  });

  it("enables node, edge, history, and clipboard commands at their exact thresholds", () => {
    const oneNode = { ...emptyContext, selectedNodeIds: ["a"], canUndo: true, canRedo: true, canPaste: true, graphNodeCount: 1 };
    for (const id of ["history.undo", "history.redo", "selection.copy", "selection.paste", "selection.duplicate", "selection.delete", "graph.auto-layout"] as const) {
      expect(commandState(id, oneNode).enabled, id).toBe(true);
    }
    expect(commandState("selection.delete", { ...emptyContext, selectedEdgeIds: ["e"] }).enabled).toBe(true);
  });

  it("requires complete bounds for six align and two distribute actions", () => {
    const two = { ...emptyContext, selectedNodeIds: ["a", "b"], boundedNodeIds: ["a", "b"] };
    for (const id of ["selection.align-left", "selection.align-center-x", "selection.align-right", "selection.align-top", "selection.align-center-y", "selection.align-bottom"] as const) {
      expect(commandState(id, two).enabled, id).toBe(true);
    }
    expect(commandState("selection.distribute-x", two)).toMatchObject({ enabled: false, reason: "Select at least three nodes." });
    const three = { ...two, selectedNodeIds: ["a", "b", "c"], boundedNodeIds: ["a", "b", "c"] };
    expect(commandState("selection.distribute-x", three).enabled).toBe(true);
    expect(commandState("selection.distribute-y", three).enabled).toBe(true);
    expect(commandState("selection.align-left", { ...two, boundedNodeIds: ["a"] }).reason).toBe("Wait for selected node sizes to be measured.");
  });

  it("publishes stable labels, descriptions, and discoverable shortcuts", () => {
    const undo = commandState("history.undo", { ...emptyContext, canUndo: true });
    expect(undo.label).toBe("Undo");
    expect(undo.description.length).toBeGreaterThan(0);
    expect(undo.shortcutLabel).toMatch(/Z/);
    expect(commandState("palette.open", emptyContext).shortcutLabel).toMatch(/K/);
    expect(commandState("graph.auto-layout", { ...emptyContext, graphNodeCount: 2 }).shortcutLabel).toMatch(/L/);
  });

  it("matches every keyboard alternative from the registry", () => {
    const key = (value: string, options: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
      commandForShortcut({ key: value, metaKey: false, ctrlKey: false, shiftKey: false, ...options });
    expect(key("z", { metaKey: true })).toBe("history.undo");
    expect(key("z", { ctrlKey: true, shiftKey: true })).toBe("history.redo");
    expect(key("y", { ctrlKey: true })).toBe("history.redo");
    expect(key("c", { metaKey: true })).toBe("selection.copy");
    expect(key("v", { ctrlKey: true })).toBe("selection.paste");
    expect(key("d", { metaKey: true })).toBe("selection.duplicate");
    expect(key("Delete")).toBe("selection.delete");
    expect(key("Backspace")).toBe("selection.delete");
    expect(key("k", { ctrlKey: true })).toBe("palette.open");
    expect(key("l", { metaKey: true, shiftKey: true })).toBe("graph.auto-layout");
    expect(key("z")).toBeNull();
  });

  it("compiles deterministic duplicate maps and an exact surgical inverse", () => {
    const graph: FlowGraph = {
      id: "g", name: "G",
      nodes: [
        { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } },
        { id: "b", type: "output", params: {}, position: { x: 100, y: 0 } },
      ],
      edges: [{ id: "a-b", source: "a", target: "b" }],
    };
    const command = commandForSelectionDuplicate(graph, { nodeIds: ["b", "a"], edgeIds: [], primaryNodeId: "b" }, "duplicate_1");
    expect(command).toMatchObject({
      nodeIds: ["a", "b"],
      nodeIdMap: { a: "node_duplicate_1_0", b: "node_duplicate_1_1" },
      edgeIdMap: { "a-b": "edge_duplicate_1_0" },
    });
    const result = applyGraphCommand(graph, command);
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(graph);
  });

  it("deletes selected standalone edges before sorted nodes and undoes exactly", () => {
    const graph: FlowGraph = {
      id: "g", name: "G",
      nodes: ["a", "b", "c", "d"].map((id) => ({ id, type: "input" as const, params: {}, position: { x: 0, y: 0 } })),
      edges: [{ id: "a-b", source: "a", target: "b" }, { id: "c-d", source: "c", target: "d" }],
    };
    const command = commandForSelectionDelete(graph, { nodeIds: ["b"], edgeIds: ["a-b", "c-d"], primaryNodeId: "b" }, "delete_1");
    expect(command.commands).toEqual([
      { v: 1, id: "delete_1:edge:0", kind: "edge.remove", edgeId: "c-d" },
      { v: 1, id: "delete_1:node:0", kind: "node.remove", nodeId: "b" },
    ]);
    const result = applyGraphCommand(graph, command);
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(graph);
  });
});
