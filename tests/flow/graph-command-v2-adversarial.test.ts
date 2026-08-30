import { describe, expect, it } from "vitest";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import { parseGraphCommand } from "@/lib/flow/graph-command-schema";
import type { FlowGraphV2 } from "@/lib/flow/types";

function graph(): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "v2",
    name: "Adversarial",
    nodes: [{
      id: "output",
      type: "output",
      params: {},
      bindings: { value: { kind: "variable", variableId: "used" } },
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [
      { id: "used", name: "Used", scope: "workflow", schema: { type: "string" } },
      { id: "other", name: "Other", scope: "run", schema: {} },
    ],
    groups: [],
    annotations: [],
  };
}

describe("v2 graph command adversarial behavior", () => {
  it("refuses variable removal while referenced by a node binding or edge condition", () => {
    expect(() => applyGraphCommand(graph(), {
      v: 1,
      id: "remove-used",
      kind: "variable.remove",
      variableId: "used",
    })).toThrow(/referenced|binding/i);

    const edgeReferenced: FlowGraphV2 = {
      ...graph(),
      nodes: [
        { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { ...graph().nodes[0]!, bindings: {} },
      ],
      edges: [{
        id: "edge",
        source: "input",
        sourceHandle: "result",
        target: "output",
        targetHandle: "in",
        condition: { kind: "variable", variableId: "used" },
      }],
    };
    expect(() => applyGraphCommand(edgeReferenced, {
      v: 1,
      id: "remove-edge-used",
      kind: "variable.remove",
      variableId: "used",
    })).toThrow(/referenced|condition/i);
  });

  it("enforces unique variable IDs and case-insensitive names", () => {
    expect(() => applyGraphCommand(graph(), {
      v: 1,
      id: "duplicate-id",
      kind: "variable.add",
      variable: { id: "used", name: "Fresh", scope: "run", schema: {} },
    })).toThrow(/duplicate|id/i);
    expect(() => applyGraphCommand(graph(), {
      v: 1,
      id: "duplicate-name",
      kind: "variable.add",
      variable: { id: "fresh", name: "uSeD", scope: "run", schema: {} },
    })).toThrow(/unique|name/i);
    expect(() => applyGraphCommand(graph(), {
      v: 1,
      id: "patch-name",
      kind: "variable.patch",
      variableId: "other",
      patch: [{ op: "replace", path: "/name", value: "USED" }],
    })).toThrow(/unique|name/i);
  });

  it("forbids variable ID patches and sensitive defaults", () => {
    expect(() => parseGraphCommand({
      v: 1,
      id: "patch-id",
      kind: "variable.patch",
      variableId: "other",
      patch: [{ op: "replace", path: "/id", value: "renamed" }],
    })).toThrow(/id|forbidden/i);
    expect(() => parseGraphCommand({
      v: 1,
      id: "secret-default",
      kind: "variable.add",
      variable: {
        id: "secret",
        name: "Secret",
        scope: "workflow",
        schema: { type: "string" },
        sensitive: true,
        default: "must-not-exist",
      },
    })).toThrow(/sensitive|default/i);
  });

  it("accepts secret bindings only as references and keeps batch limits active", () => {
    expect(parseGraphCommand({
      v: 1,
      id: "secret-reference",
      kind: "binding.set",
      nodeId: "output",
      key: "token",
      binding: { kind: "secret", connectionId: "connection-id", field: "token" },
    })).toMatchObject({ kind: "binding.set" });
    expect(() => parseGraphCommand({
      v: 1,
      id: "secret-value",
      kind: "binding.set",
      nodeId: "output",
      key: "token",
      binding: { kind: "secret", connectionId: "connection-id", field: "token", value: "plaintext" },
    })).toThrow();

    const children = Array.from({ length: 501 }, (_, index) => ({
      v: 1,
      id: `binding-${index}`,
      kind: "binding.remove",
      nodeId: "output",
      key: `key-${index}`,
    }));
    expect(() => parseGraphCommand({ v: 1, id: "too-many", kind: "graph.batch", commands: children })).toThrow(/500|batch/i);
  });

  it("refuses a variable binding that names a missing variable", () => {
    expect(() => applyGraphCommand(graph(), {
      v: 1,
      id: "missing-variable-binding",
      kind: "binding.set",
      nodeId: "output",
      key: "missing",
      binding: { kind: "variable", variableId: "does-not-exist" },
    })).toThrow(/variable|missing/i);
  });

  it("graph.replace accepts supported versions, preserves v1 unknown fields, and rejects future versions", () => {
    const legacy = {
      id: "legacy",
      name: "Legacy",
      nodes: [],
      edges: [],
      compatibleUnknown: { kept: true },
    };
    const parsed = parseGraphCommand({ v: 1, id: "replace", kind: "graph.replace", graph: legacy });
    expect(parsed).toEqual({ v: 1, id: "replace", kind: "graph.replace", graph: legacy });
    expect(() => parseGraphCommand({
      v: 1,
      id: "future",
      kind: "graph.replace",
      graph: { ...legacy, schemaVersion: 3 },
    })).toThrow(/schemaVersion|version/i);
  });
});
