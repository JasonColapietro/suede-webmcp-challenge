import { describe, expect, it } from "vitest";
import { commandForPaste, parseGraphFragment, serializeGraphFragment } from "@/lib/flow/graph-fragment";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import type { GraphSelection } from "@/lib/flow/graph-command-types";
import type { FlowGraphV2 } from "@/lib/flow/types";

const selection: GraphSelection = { nodeIds: ["output"], edgeIds: [], primaryNodeId: "output" };

function graph(): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "v2",
    name: "Clipboard",
    nodes: [{
      id: "output",
      type: "output",
      params: {},
      bindings: {
        literal: { kind: "literal", value: { public: true } },
        port: { kind: "port", nodeId: "input", portId: "result", path: "$.value" },
        variable: { kind: "variable", variableId: "region" },
        secret: { kind: "secret", connectionId: "connection-reference", field: "token" },
      },
      position: { x: 50, y: 60 },
    }],
    edges: [],
    variables: [{ id: "region", name: "Region", scope: "run", schema: { type: "string" } }],
    groups: [],
    annotations: [],
  };
}

describe("v2 graph fragments", () => {
  it("preserves structured non-secret bindings and redacts secret bindings with a count", () => {
    const fragment = serializeGraphFragment(graph(), selection);
    const node = fragment.nodes[0] as FlowGraphV2["nodes"][number];
    expect(node.bindings).toEqual({
      literal: { kind: "literal", value: { public: true } },
      port: { kind: "port", nodeId: "input", portId: "result", path: "$.value" },
      variable: { kind: "variable", variableId: "region" },
    });
    expect(fragment.redactionCount).toBe(1);
    expect(JSON.stringify(fragment)).not.toContain("connection-reference");
    expect(parseGraphFragment(JSON.stringify(fragment))).toEqual(fragment);
  });

  it("redacts secret edge conditions, preserves valid conditions, and rejects malformed ones", () => {
    const twoNodes: FlowGraphV2 = {
      ...graph(),
      nodes: [
        { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        ...graph().nodes,
      ],
      edges: [{
        id: "edge",
        source: "input",
        sourceHandle: "result",
        target: "output",
        targetHandle: "in",
        condition: { kind: "secret", connectionId: "connection-reference", field: "token" },
      }],
    };
    const redacted = serializeGraphFragment(twoNodes, { nodeIds: ["input", "output"], edgeIds: [], primaryNodeId: "input" });
    expect(redacted.edges[0]).not.toHaveProperty("condition");
    expect(redacted.redactionCount).toBe(2);

    const publicCondition: FlowGraphV2 = {
      ...twoNodes,
      edges: [{ ...twoNodes.edges[0]!, condition: { kind: "variable", variableId: "region" } }],
    };
    expect(serializeGraphFragment(publicCondition, { nodeIds: ["input", "output"], edgeIds: [], primaryNodeId: "input" }).edges[0]).toMatchObject({
      condition: { kind: "variable", variableId: "region" },
    });

    const malformed = structuredClone(publicCondition) as unknown as { edges: Array<Record<string, unknown>> };
    malformed.edges[0]!.condition = { kind: "variable", variableId: "region", plaintext: "no" };
    expect(() => serializeGraphFragment(malformed as unknown as FlowGraphV2, { nodeIds: ["input", "output"], edgeIds: [], primaryNodeId: "input" })).toThrow(/condition|binding|invalid/i);
  });

  it("remaps internal port bindings and validates variable references against the paste target", () => {
    const source: FlowGraphV2 = {
      ...graph(),
      nodes: [
        { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        {
          ...graph().nodes[0]!,
          bindings: {
            internal: { kind: "port", nodeId: "input", portId: "result" },
            variable: { kind: "variable", variableId: "region" },
          },
        },
      ],
    };
    const fragment = serializeGraphFragment(source, { nodeIds: ["input", "output"], edgeIds: [], primaryNodeId: "input" });
    const target: FlowGraphV2 = { ...graph(), nodes: [], edges: [] };
    const command = commandForPaste(fragment, "v2_paste", { x: 100, y: 100 }, target);
    const pasted = applyGraphCommand(target, command).graph;
    expect(pasted.nodes[1]).toMatchObject({
      bindings: { internal: { kind: "port", nodeId: "node_v2_paste_0", portId: "result" } },
    });

    const externalFragment = serializeGraphFragment(source, { nodeIds: ["output"], edgeIds: [], primaryNodeId: "output" });
    expect(() => commandForPaste(externalFragment, "external", { x: 0, y: 0 }, target)).toThrow(/external|port|selected|missing/i);
    const missingVariableTarget: FlowGraphV2 = { ...target, variables: [] };
    expect(() => commandForPaste(fragment, "missing_variable", { x: 0, y: 0 }, missingVariableTarget)).toThrow(/variable|missing/i);
  });

  it("upgrades a v1 target when pasting v2 nodes and adapts v1 fragments into v2", () => {
    const referenceFree: FlowGraphV2 = {
      ...graph(),
      nodes: [{ ...graph().nodes[0]!, bindings: { public: { kind: "literal", value: true } } }],
      variables: [],
    };
    const fragment = serializeGraphFragment(referenceFree, selection);
    const legacyTarget = { id: "legacy", name: "Legacy", nodes: [], edges: [] };
    const v2Paste = commandForPaste(fragment, "upgrade_paste", { x: 0, y: 0 }, legacyTarget);
    expect(applyGraphCommand(legacyTarget, v2Paste).graph).toMatchObject({ schemaVersion: 2 });

    const legacyFragment = parseGraphFragment(JSON.stringify({
      kind: "suede.graph-fragment",
      version: 1,
      redactionCount: 0,
      nodes: [{ id: "legacy-node", type: "input", params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    }));
    const target: FlowGraphV2 = { ...graph(), nodes: [], edges: [], variables: [] };
    const legacyPaste = commandForPaste(legacyFragment, "adapt_paste", { x: 0, y: 0 }, target);
    expect(applyGraphCommand(target, legacyPaste).graph.nodes[0]).toMatchObject({ bindings: {} });
  });
});
