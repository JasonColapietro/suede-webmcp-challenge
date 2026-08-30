import { describe, expect, it } from "vitest";
import {
  createGraphHistory,
  dispatchGraphCommand,
  redoGraphCommand,
  resetGraphHistory,
  undoGraphCommand,
} from "@/lib/flow/graph-history";
import type { GraphCommand } from "@/lib/flow/graph-command-types";
import type { FlowGraph } from "@/lib/flow/types";

const graph = (name = "Original"): FlowGraph => ({ id: "g", name, nodes: [], edges: [] });
const rename = (id: string, name: string): GraphCommand => ({ v: 1, id, kind: "graph.rename", name });

describe("bounded graph history", () => {
  it("coalesces adjacent commands only for the same explicit nonempty group", () => {
    let state = createGraphHistory(graph(), { limit: 100 });
    state = dispatchGraphCommand(state, rename("a", "A"), { label: "Name", groupId: "name-focus-1" });
    state = dispatchGraphCommand(state, rename("b", "B"), { label: "Name final", groupId: "name-focus-1" });

    expect(state.past).toHaveLength(1);
    expect(state.past[0]).toMatchObject({ forward: rename("b", "B"), label: "Name final", groupId: "name-focus-1" });
    const undone = undoGraphCommand(state);
    expect(undone.graph.name).toBe("Original");
    expect(redoGraphCommand(undone).graph.name).toBe("B");
  });

  it("does not coalesce absent, empty, nonadjacent, or distinct interaction groups", () => {
    let state = createGraphHistory(graph());
    state = dispatchGraphCommand(state, rename("a", "A"));
    state = dispatchGraphCommand(state, rename("b", "B"), { groupId: "" });
    state = dispatchGraphCommand(state, rename("c", "C"), { groupId: "one" });
    state = dispatchGraphCommand(state, rename("d", "D"), { groupId: "two" });
    state = dispatchGraphCommand(state, rename("e", "E"), { groupId: "one" });
    expect(state.past).toHaveLength(5);
  });

  it("clears redo when a new command branches from an undone state", () => {
    let state = dispatchGraphCommand(createGraphHistory(graph()), rename("a", "A"));
    state = dispatchGraphCommand(state, rename("b", "B"));
    state = undoGraphCommand(state);
    expect(state.future).toHaveLength(1);
    state = dispatchGraphCommand(state, rename("c", "C"));
    expect(state.future).toEqual([]);
    expect(state.graph.name).toBe("C");
  });

  it("evicts oldest entries at the configurable limit and defaults to 100", () => {
    let state = createGraphHistory(graph(), { limit: 2 });
    state = dispatchGraphCommand(state, rename("a", "A"));
    state = dispatchGraphCommand(state, rename("b", "B"));
    state = dispatchGraphCommand(state, rename("c", "C"));
    expect(state.past.map((entry) => entry.forward.id)).toEqual(["b", "c"]);

    let defaultState = createGraphHistory(graph());
    for (let index = 0; index < 101; index += 1) {
      defaultState = dispatchGraphCommand(defaultState, rename(`r-${index}`, String(index)));
    }
    expect(defaultState.past).toHaveLength(100);
    expect(defaultState.past[0]?.forward.id).toBe("r-1");
  });

  it("records a batch as one history entry", () => {
    const batch: GraphCommand = { v: 1, id: "batch", kind: "graph.batch", commands: [rename("a", "A"), rename("b", "B")] };
    const state = dispatchGraphCommand(createGraphHistory(graph()), batch, { label: "Two edits" });
    expect(state.past).toHaveLength(1);
    expect(state.past[0]).toMatchObject({ forward: batch, label: "Two edits" });
    expect(undoGraphCommand(state).graph).toEqual(graph());
  });

  it("reset replaces the graph when supplied and clears both stacks", () => {
    let state = dispatchGraphCommand(createGraphHistory(graph()), rename("a", "A"));
    state = undoGraphCommand(state);
    state = resetGraphHistory(state, graph("Loaded"));
    expect(state.graph).toEqual(graph("Loaded"));
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
  });

  it("returns the same state when undo or redo has no entry", () => {
    const state = createGraphHistory(graph());
    expect(undoGraphCommand(state)).toBe(state);
    expect(redoGraphCommand(state)).toBe(state);
  });

  it("preserves state when dispatch, undo, or redo application fails", () => {
    const state = createGraphHistory(graph());
    expect(() => dispatchGraphCommand(state, { v: 1, id: "bad", kind: "node.remove", nodeId: "missing" })).toThrow();
    expect(state).toEqual(createGraphHistory(graph()));

    const valid = dispatchGraphCommand(state, rename("a", "A"));
    const corruptUndo = {
      ...valid,
      past: [{
        ...valid.past[0],
        inverse: { v: 1 as const, id: "bad-undo", kind: "node.remove" as const, nodeId: "missing" },
      }],
    };
    const undoSnapshot = structuredClone(corruptUndo);
    expect(() => undoGraphCommand(corruptUndo)).toThrow();
    expect(corruptUndo).toEqual(undoSnapshot);

    const undone = undoGraphCommand(valid);
    const corruptRedo = {
      ...undone,
      future: [{
        ...undone.future[0],
        forward: { v: 1 as const, id: "bad-redo", kind: "node.remove" as const, nodeId: "missing" },
      }],
    };
    const redoSnapshot = structuredClone(corruptRedo);
    expect(() => redoGraphCommand(corruptRedo)).toThrow();
    expect(corruptRedo).toEqual(redoSnapshot);
  });

  it("rejects invalid limits", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => createGraphHistory(graph(), { limit })).toThrow(/limit/i);
    }
  });
});
