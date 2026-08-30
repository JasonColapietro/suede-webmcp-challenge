import { describe, expect, it } from "vitest";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import {
  createGraphHistory,
  dispatchGraphCommand,
  redoGraphCommand,
  undoGraphCommand,
} from "@/lib/flow/graph-history";
import type { FlowCallableInterface, FlowGraph, FlowGraphV2 } from "@/lib/flow/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CallableInterfaceEditor, {
  callableInterfaceFromEditorRows,
  createCallableEditorRows,
  reduceCallableEditorRows,
} from "@/components/canvas/CallableInterfaceEditor";
import Inspector from "@/components/canvas/Inspector";
import { readFileSync } from "node:fs";

function v1(): FlowGraph {
  return {
    id: "legacy",
    name: "Legacy",
    nodes: [
      { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, position: { x: 200, y: 0 } },
    ],
    edges: [],
  };
}

function v2(): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "typed",
    name: "Typed",
    nodes: [
      { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{
      id: "kept-invalid-edge",
      source: "input",
      sourceHandle: "result",
      target: "output",
      targetHandle: "in",
    }],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function callable(id = "answer"): FlowCallableInterface {
  return {
    inputs: [{
      id: "prompt",
      label: "Prompt",
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      target: { kind: "trigger", path: "/prompt" },
    }],
    outputs: [{
      id,
      label: "Answer",
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      source: { nodeId: "output", portId: "result" },
    }],
  };
}

describe("callable interface graph commands", () => {
  it("sets, undoes, and redoes the root interface without deleting incompatible edges", () => {
    const source = v2();
    const command = {
      v: 1 as const,
      id: "set-interface",
      kind: "callable-interface.set" as const,
      interface: callable(),
    };
    const changed = dispatchGraphCommand(createGraphHistory(source), command, {
      label: "Edit callable interface",
    });

    expect((changed.graph as FlowGraphV2).callableInterface).toEqual(callable());
    expect(changed.graph.edges).toEqual(source.edges);
    expect(undoGraphCommand(changed).graph).toEqual(source);
    expect(redoGraphCommand(undoGraphCommand(changed)).graph).toEqual(changed.graph);
  });

  it("renders one labelled flow-level editor even when no node is selected", () => {
    const markup = renderToStaticMarkup(createElement(Inspector, {
      node: null,
      graph: v2(),
      graphVersion: 2,
      onCallableInterfaceSet: () => undefined,
      onCallableInterfaceRemove: () => undefined,
    }));
    expect(markup).toContain('aria-label="Callable interface editor"');
    expect(markup).toContain("Apply interface");
    expect(markup).toContain("Select a node");
    expect(markup.match(/Callable interface editor/g)?.length).toBe(1);

    const direct = renderToStaticMarkup(createElement(CallableInterfaceEditor, {
      graph: v2(),
      onSet: () => undefined,
      onRemove: () => undefined,
    }));
    expect(direct).toContain('aria-live="polite"');
    expect(direct).not.toMatch(/password|api.?key|secret value/i);
  });

  it("removes an interface with an exact inverse", () => {
    const source = { ...v2(), callableInterface: callable() };
    const result = applyGraphCommand(source, {
      v: 1,
      id: "remove-interface",
      kind: "callable-interface.remove",
    });
    expect((result.graph as FlowGraphV2).callableInterface).toBeUndefined();
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(source);
  });

  it("upgrades v1 once and exact undo restores the original bytes", () => {
    const source = v1();
    const before = JSON.stringify(source);
    const result = applyGraphCommand(source, {
      v: 1,
      id: "upgrade-interface",
      kind: "callable-interface.set",
      interface: callable(),
    });
    expect((result.graph as FlowGraphV2).schemaVersion).toBe(2);
    expect(JSON.stringify(applyGraphCommand(result.graph, result.inverse).graph)).toBe(before);
  });

  it("refuses duplicate, prototype-like, and oversized interface mappings", () => {
    const base = callable();
    const duplicate: FlowCallableInterface = {
      ...base,
      inputs: [base.inputs[0]!, base.inputs[0]!],
    };
    const unsafe: FlowCallableInterface = {
      ...base,
      inputs: [{
        ...base.inputs[0]!,
        target: { kind: "trigger", path: "/__proto__" },
      }],
    };
    const oversized: FlowCallableInterface = {
      ...base,
      inputs: Array.from({ length: 65 }, (_, index) => ({
        ...base.inputs[0]!, id: `input_${index}`,
      })),
    };

    for (const interfaceValue of [duplicate, unsafe, oversized]) {
      expect(() => applyGraphCommand(v2(), {
        v: 1,
        id: "invalid-interface",
        kind: "callable-interface.set",
        interface: interfaceValue,
      })).toThrow(/interface|unique|unsafe|bound|64|pointer/i);
    }
  });

  it("refuses a callable output receipt for a missing node port", () => {
    const stale: FlowCallableInterface = {
      ...callable(),
      outputs: [{
        ...callable().outputs[0]!,
        source: { nodeId: "output", portId: "missing" },
      }],
    };
    expect(() => applyGraphCommand(v2(), {
      v: 1,
      id: "stale-output",
      kind: "callable-interface.set",
      interface: stale,
    })).toThrow(/output|port|missing|source/i);
  });

  it("gives every structured row a unique accessible name and controlled stable schema state", () => {
    const first = callable();
    const value: FlowCallableInterface = {
      inputs: [first.inputs[0]!, { ...first.inputs[0]!, id: "context", label: "Context", target: { kind: "trigger", path: "/context" } }],
      outputs: [first.outputs[0]!, { ...first.outputs[0]!, id: "citations", label: "Citations" }],
    };
    const markup = renderToStaticMarkup(createElement(CallableInterfaceEditor, {
      graph: v2(), value, onSet: () => undefined, onRemove: () => undefined,
    }));
    for (const label of [
      "Input 1 (prompt) ID", "Input 2 (context) ID",
      "Output 1 (answer) ID", "Output 2 (citations) ID",
      "Remove input 1 (prompt)", "Remove output 2 (citations)",
    ]) expect(markup).toContain(label);

    const source = readFileSync("src/components/canvas/CallableInterfaceEditor.tsx", "utf8");
    expect(source).toContain("schemaText");
    expect(source).toMatch(/value=\{(?:row|port)\.schemaText\}/);
    expect(source).not.toContain("defaultValue={schemaText");
    expect(source).not.toMatch(/key=\{`(?:input|output)-\$\{index\}`\}/);
  });

  it("keeps schema drafts bound to stable rows through reorder, remove, and external reset", () => {
    let sequence = 0;
    const makeKey = (direction: "input" | "output") => `${direction}-${sequence++}`;
    const value: FlowCallableInterface = {
      ...callable(),
      inputs: [callable().inputs[0]!, {
        ...callable().inputs[0]!, id: "context", target: { kind: "trigger", path: "/context" },
      }],
    };
    let rows = createCallableEditorRows(value, makeKey);
    const contextKey = rows.inputs[1]!.key;
    rows = reduceCallableEditorRows(rows, {
      kind: "schema.set", direction: "inputs", key: contextKey, text: '{"type":"number"}',
    });
    rows = reduceCallableEditorRows(rows, {
      kind: "move", direction: "inputs", key: contextKey, offset: -1,
    });
    rows = reduceCallableEditorRows(rows, {
      kind: "remove", direction: "inputs", key: rows.inputs[1]!.key,
    });
    expect(callableInterfaceFromEditorRows(rows).inputs).toEqual([{
      ...value.inputs[1]!, schema: { type: "number" },
    }]);

    const reset = createCallableEditorRows(callable("fresh"), makeKey);
    rows = reduceCallableEditorRows(rows, { kind: "reset", rows: reset });
    expect(callableInterfaceFromEditorRows(rows)).toEqual(callable("fresh"));
  });
});
