import { describe, expect, it } from "vitest";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import {
  createGraphHistory,
  dispatchGraphCommand,
  redoGraphCommand,
  undoGraphCommand,
} from "@/lib/flow/graph-history";
import type { GraphCommand } from "@/lib/flow/graph-command-types";
import type { FlowGraphV1, FlowGraphV2, FlowVariable } from "@/lib/flow/types";

const variable = (overrides: Partial<FlowVariable> = {}): FlowVariable => ({
  id: "customer-id",
  name: "Customer ID",
  scope: "workflow",
  schema: { type: "string" },
  ...overrides,
});

function v1(): FlowGraphV1 {
  return {
    id: "legacy",
    name: "Legacy",
    nodes: [{ id: "output", type: "output", params: {}, position: { x: 10, y: 20 } }],
    edges: [],
    meta: { preserved: true },
  };
}

function v2(): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "v2",
    name: "Version two",
    nodes: [{
      id: "output",
      type: "output",
      params: {},
      bindings: {},
      position: { x: 10, y: 20 },
      meta: { compatibleUnknown: { kept: true } },
    }],
    edges: [],
    variables: [
      variable(),
      variable({ id: "region", name: "Region", default: "us-east" }),
    ],
    groups: [],
    annotations: [],
    meta: { compatibleUnknown: { kept: true } },
  };
}

function exactUndo(graph: FlowGraphV1 | FlowGraphV2, command: GraphCommand): void {
  const before = JSON.stringify(graph);
  const result = applyGraphCommand(graph, command);
  expect(JSON.stringify(applyGraphCommand(result.graph, result.inverse).graph)).toBe(before);
}

describe("v2 graph commands", () => {
  it("classifies node and edge payload versions without creating hybrid graphs", () => {
    const v2Node = {
      id: "v2-node",
      type: "output" as const,
      params: {},
      bindings: {},
      position: { x: 1, y: 2 },
    };
    const upgradedByNode = applyGraphCommand(v1(), {
      v: 1, id: "v2-node-add", kind: "node.add", node: v2Node,
    });
    expect(upgradedByNode.graph).toMatchObject({ schemaVersion: 2 });
    expect(JSON.stringify(applyGraphCommand(upgradedByNode.graph, upgradedByNode.inverse).graph)).toBe(JSON.stringify(v1()));

    const adaptedNode = applyGraphCommand(v2(), {
      v: 1,
      id: "v1-node-add",
      kind: "node.add",
      node: { id: "legacy-node", type: "input", params: {}, position: { x: 3, y: 4 } },
    });
    expect(adaptedNode.graph.nodes.find((node) => node.id === "legacy-node")).toMatchObject({ bindings: {} });

    const legacyConnected: FlowGraphV1 = {
      ...v1(),
      nodes: [
        { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
        { id: "output", type: "output", params: {}, position: { x: 10, y: 0 } },
      ],
    };
    const upgradedByEdge = applyGraphCommand(legacyConnected, {
      v: 1,
      id: "v2-edge-add",
      kind: "edge.add",
      edge: {
        id: "condition-edge",
        source: "input",
        sourceHandle: "result",
        target: "output",
        targetHandle: "in",
        condition: { kind: "literal", value: true },
      },
    });
    expect(upgradedByEdge.graph).toMatchObject({ schemaVersion: 2 });

    const v2WithInput: FlowGraphV2 = {
      ...v2(),
      nodes: [
        { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        ...v2().nodes,
      ],
    };
    const adaptedEdge = applyGraphCommand(v2WithInput, {
      v: 1,
      id: "v1-edge-add",
      kind: "edge.add",
      edge: { id: "legacy-edge", source: "input", target: "output" },
    });
    expect(adaptedEdge.graph.edges[0]).toMatchObject({ sourceHandle: "result", targetHandle: "in" });
  });

  it("upgrades a v1 graph exactly once for the first v2-only command and undoes to exact v1 bytes", () => {
    const source = v1();
    const before = JSON.stringify(source);
    const added = applyGraphCommand(source, {
      v: 1,
      id: "add-variable",
      kind: "variable.add",
      variable: variable(),
    });

    expect(added.graph).toMatchObject({ schemaVersion: 2, variables: [variable()] });
    expect(added.inverse.kind).toBe("graph.replace");
    expect(JSON.stringify(applyGraphCommand(added.graph, added.inverse).graph)).toBe(before);

    const bound = applyGraphCommand(added.graph, {
      v: 1,
      id: "set-binding",
      kind: "binding.set",
      nodeId: "output",
      key: "value",
      binding: { kind: "variable", variableId: "customer-id" },
    });
    expect(bound.graph).toMatchObject({ schemaVersion: 2 });
    expect(bound.inverse.kind).toBe("binding.remove");
  });

  it("adds, patches, and removes variables with byte-exact inverses and stable array order", () => {
    exactUndo(v2(), {
      v: 1,
      id: "variable-add",
      kind: "variable.add",
      index: 1,
      variable: variable({ id: "account", name: "Account" }),
    });
    exactUndo(v2(), {
      v: 1,
      id: "variable-patch",
      kind: "variable.patch",
      variableId: "region",
      patch: [
        { op: "replace", path: "/name", value: "Deployment Region" },
        { op: "replace", path: "/default", value: "eu-west" },
      ],
    });
    exactUndo(v2(), {
      v: 1,
      id: "variable-remove",
      kind: "variable.remove",
      variableId: "customer-id",
    });
  });

  it("sets, replaces, and removes bindings with byte-exact inverses", () => {
    exactUndo(v2(), {
      v: 1,
      id: "binding-set-new",
      kind: "binding.set",
      nodeId: "output",
      key: "value",
      binding: { kind: "literal", value: { ok: true } },
    });
    const withBinding: FlowGraphV2 = {
      ...v2(),
      nodes: [{
        ...v2().nodes[0]!,
        bindings: { value: { kind: "variable", variableId: "region", path: "$.code" } },
      }],
    };
    exactUndo(withBinding, {
      v: 1,
      id: "binding-replace",
      kind: "binding.set",
      nodeId: "output",
      key: "value",
      binding: { kind: "secret", connectionId: "connection-ref", field: "token" },
    });
    exactUndo(withBinding, {
      v: 1,
      id: "binding-remove",
      kind: "binding.remove",
      nodeId: "output",
      key: "value",
    });
  });

  it("keeps supported graphs through dispatch, undo, and redo without downconversion", () => {
    const initial = createGraphHistory(v2());
    const changed = dispatchGraphCommand(initial, {
      v: 1,
      id: "history-binding",
      kind: "binding.set",
      nodeId: "output",
      key: "value",
      binding: { kind: "secret", connectionId: "connection-ref", field: "token" },
    });
    expect(changed.graph).toMatchObject({ schemaVersion: 2 });
    expect(undoGraphCommand(changed).graph).toEqual(v2());
    expect(redoGraphCommand(undoGraphCommand(changed)).graph).toEqual(changed.graph);
  });

  it("leaves ordinary v1 commands byte-stable and unversioned", () => {
    const source = v1();
    const before = JSON.stringify(source);
    const renamed = applyGraphCommand(source, {
      v: 1,
      id: "rename-v1",
      kind: "graph.rename",
      name: "Renamed",
    });
    expect(renamed.graph).not.toHaveProperty("schemaVersion");
    expect(JSON.stringify(applyGraphCommand(renamed.graph, renamed.inverse).graph)).toBe(before);
  });

  it("restores noncanonical v2 key and binding order byte-for-byte", () => {
    const source: FlowGraphV2 = {
      name: "Noncanonical",
      id: "noncanonical",
      schemaVersion: 2,
      edges: [],
      nodes: [{
        position: { y: 2, x: 1 },
        bindings: {
          z: { value: "z", kind: "literal" },
          middle: { value: "middle", kind: "literal" },
          a: { value: "a", kind: "literal" },
        },
        params: {},
        type: "output",
        id: "output",
      }],
      annotations: [],
      groups: [],
      variables: [{
        name: "Region",
        id: "region",
        schema: { type: "string" },
        scope: "run",
      }],
    };
    exactUndo(source, {
      v: 1,
      id: "noncanonical-variable",
      kind: "variable.patch",
      variableId: "region",
      patch: [{ op: "replace", path: "/name", value: "Area" }],
    });
    exactUndo(source, {
      v: 1,
      id: "middle-binding",
      kind: "binding.remove",
      nodeId: "output",
      key: "middle",
    });
    exactUndo(source, {
      v: 1,
      id: "noncanonical-replace",
      kind: "graph.replace",
      graph: v2(),
    });
  });

  it("restores a removed middle v2 node param key byte-for-byte", () => {
    const source: FlowGraphV2 = {
      ...v2(),
      nodes: [{
        ...v2().nodes[0]!,
        params: { first: 1, middle: 2, last: 3 },
      }],
    };
    exactUndo(source, {
      v: 1,
      id: "remove-middle-param",
      kind: "node.patch",
      nodeId: "output",
      patch: [{ op: "remove", path: "/middle" }],
    });
  });

  it("remaps internal duplicate port references in node bindings and edge conditions", () => {
    const source: FlowGraphV2 = {
      schemaVersion: 2,
      id: "duplicate-refs",
      name: "Duplicate refs",
      nodes: [
        { id: "a", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        {
          id: "b",
          type: "output",
          params: {},
          bindings: {
            internal: { kind: "port", nodeId: "a", portId: "result" },
            external: { kind: "port", nodeId: "outside", portId: "result" },
            externalConstructor: { kind: "port", nodeId: "constructor", portId: "result" },
            externalProto: { kind: "port", nodeId: "__proto__", portId: "result" },
            externalPrototype: { kind: "port", nodeId: "prototype", portId: "result" },
          },
          position: { x: 100, y: 0 },
        },
        { id: "outside", type: "input", params: {}, bindings: {}, position: { x: 200, y: 0 } },
        { id: "constructor", type: "input", params: {}, bindings: {}, position: { x: 300, y: 0 } },
        { id: "__proto__", type: "input", params: {}, bindings: {}, position: { x: 400, y: 0 } },
        { id: "prototype", type: "input", params: {}, bindings: {}, position: { x: 500, y: 0 } },
      ],
      edges: [
        {
          id: "a-b",
          source: "a",
          sourceHandle: "result",
          target: "b",
          targetHandle: "in",
          condition: { kind: "port", nodeId: "a", portId: "result" },
        },
        {
          id: "a-b-external",
          source: "a",
          sourceHandle: "result",
          target: "b",
          targetHandle: "other",
          condition: { kind: "port", nodeId: "outside", portId: "result" },
        },
      ],
      variables: [],
      groups: [],
      annotations: [],
    };
    const result = applyGraphCommand(source, {
      v: 1,
      id: "duplicate-port-refs",
      kind: "selection.duplicate",
      nodeIds: ["a", "b"],
      offset: { x: 20, y: 20 },
      nodeIdMap: { a: "copy-a", b: "copy-b" },
      edgeIdMap: { "a-b": "copy-a-b", "a-b-external": "copy-a-b-external" },
    });
    expect(result.graph.nodes.find((node) => node.id === "copy-b")).toMatchObject({
      bindings: {
        internal: { kind: "port", nodeId: "copy-a", portId: "result" },
        external: { kind: "port", nodeId: "outside", portId: "result" },
        externalConstructor: { kind: "port", nodeId: "constructor", portId: "result" },
        externalProto: { kind: "port", nodeId: "__proto__", portId: "result" },
        externalPrototype: { kind: "port", nodeId: "prototype", portId: "result" },
      },
    });
    expect(result.graph.edges.find((edge) => edge.id === "copy-a-b")).toMatchObject({
      condition: { kind: "port", nodeId: "copy-a", portId: "result" },
    });
    expect(result.graph.edges.find((edge) => edge.id === "copy-a-b-external")).toMatchObject({
      condition: { kind: "port", nodeId: "outside", portId: "result" },
    });
    expect(JSON.stringify(applyGraphCommand(result.graph, result.inverse).graph)).toBe(JSON.stringify(source));
  });
});
