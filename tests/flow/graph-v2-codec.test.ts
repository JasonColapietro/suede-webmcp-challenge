import { describe, expect, it } from "vitest";
import {
  adaptFlowGraphV1,
  downconvertFlowGraph,
  GraphVersionError,
  inspectV2OnlyFeatures,
  upgradeFlowGraph,
} from "@/lib/flow/graph-v2-codec";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import type { FlowGraphV1, FlowGraphV2 } from "@/lib/flow/types";

const legacyGraph = (): FlowGraphV1 => ({
  id: "legacy",
  name: "Legacy",
  nodes: [
    { id: "input", type: "input", params: { prompt: "hello" }, position: { x: 0, y: 0 } },
    { id: "output", type: "output", params: {}, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "input-output", source: "input", target: "output" }],
  meta: { owner: "legacy" },
});

describe("flow graph v2 codec", () => {
  it("adapts v1 with canonical unique ports and explicit empty v2 collections", () => {
    const source = legacyGraph();
    const before = JSON.stringify(source);
    const adapted = adaptFlowGraphV1(source);

    expect(adapted).toEqual({
      schemaVersion: 2,
      ...source,
      nodes: source.nodes.map((node) => ({ ...node, bindings: {} })),
      edges: [
        {
          id: "input-output",
          source: "input",
          target: "output",
          sourceHandle: "result",
          targetHandle: "in",
        },
      ],
      variables: [],
      groups: [],
      annotations: [],
    });
    expect(adapted.nodes.every((node) => Object.hasOwn(node, "bindings"))).toBe(true);
    expect(parseSupportedFlowGraph(adapted)).toEqual(adapted);
    expect(JSON.stringify(source)).toBe(before);
    expect(adapted).not.toBe(source);
    expect(adapted.nodes[0]).not.toBe(source.nodes[0]);
  });

  it("preserves named handles and compatible unknown v1 fields", () => {
    const source = legacyGraph();
    const graph = {
      ...source,
      nodes: [
        {
          ...source.nodes[0],
          implementationVersion: "input@1",
          meta: { locked: true },
        },
        source.nodes[1],
      ],
      edges: [
        {
          ...source.edges[0],
          sourceHandle: "legacy-result",
          targetHandle: "in",
          condition: { kind: "literal", value: true },
        },
      ],
    } as unknown as FlowGraphV1;

    const adapted = adaptFlowGraphV1(graph);

    expect(adapted.nodes[0]).toMatchObject({
      implementationVersion: "input@1",
      meta: { locked: true },
    });
    expect(adapted.edges[0]).toMatchObject({
      sourceHandle: "legacy-result",
      targetHandle: "in",
      condition: { kind: "literal", value: true },
    });
    expect(inspectV2OnlyFeatures(adapted)).toEqual([]);

    const result = downconvertFlowGraph(adapted);
    expect(result).toEqual({ ok: true, graph });
    if (!result.ok) throw new Error("expected provenance-backed conversion");
    expect(result.graph).toBe(graph);
    expect(JSON.stringify(result.graph)).toBe(JSON.stringify(graph));
  });

  it("flags v2-only values that change after legacy adaptation", () => {
    const source = legacyGraph();
    const graph = {
      ...source,
      nodes: [
        {
          ...source.nodes[0],
          implementationVersion: "input@1",
          meta: { locked: true },
        },
        source.nodes[1],
      ],
      edges: [
        {
          ...source.edges[0],
          sourceHandle: "legacy-result",
          condition: { kind: "literal", value: true },
        },
      ],
    } as unknown as FlowGraphV1;
    const adapted = adaptFlowGraphV1(graph);
    const mutable = adapted as unknown as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };

    mutable.nodes[0] = {
      ...mutable.nodes[0],
      implementationVersion: "input@2",
      meta: { locked: false },
    };
    mutable.edges[0] = {
      ...mutable.edges[0],
      sourceHandle: "changed-result",
      condition: { kind: "literal", value: false },
    };

    expect(inspectV2OnlyFeatures(adapted)).toEqual([
      "edge-port:input-output:changed-result->in",
      "meta:edge-condition:input-output",
      "meta:implementation-version:input",
      "meta:node:input",
    ]);
  });

  it("refuses to guess a missing endpoint with zero or multiple canonical ports", () => {
    const base = legacyGraph();
    const branchSource: FlowGraphV1 = {
      ...base,
      nodes: [{ ...base.nodes[0], type: "branch" }, base.nodes[1]],
    };
    const inputTarget: FlowGraphV1 = {
      ...base,
      nodes: [base.nodes[0], { ...base.nodes[1], type: "input" }],
    };

    for (const graph of [branchSource, inputTarget]) {
      expect(() => adaptFlowGraphV1(graph)).toThrow(GraphVersionError);
      expect(() => adaptFlowGraphV1(graph)).toThrow(/input-output/);
    }
  });

  it("returns v2 unchanged from upgrade and adapts v1 explicitly", () => {
    const adapted = adaptFlowGraphV1(legacyGraph());
    expect(upgradeFlowGraph(adapted)).toBe(adapted);
    expect(upgradeFlowGraph(legacyGraph())).toEqual(adapted);
  });

  it("reports v2-only features in deterministic lexicographic order", () => {
    const base = adaptFlowGraphV1(legacyGraph());
    const graph: FlowGraphV2 = {
      ...base,
      variables: [
        { id: "z", name: "Z", scope: "run", schema: {} },
        { id: "a", name: "A", scope: "workflow", schema: {} },
      ],
      nodes: [
        {
          ...base.nodes[0],
          bindings: {
            z: { kind: "literal", value: 1 },
            a: { kind: "variable", variableId: "a" },
          },
          implementationVersion: "input@2",
          meta: { locked: true },
        },
        base.nodes[1],
      ],
      edges: [{ ...base.edges[0], sourceHandle: "not-default", condition: { kind: "literal", value: true } }],
      groups: [{ id: "g", label: "Group", nodeIds: ["input"] }],
      annotations: [{ id: "n", text: "Note", position: { x: 1, y: 2 } }],
    };

    expect(inspectV2OnlyFeatures(graph)).toEqual([
      "annotation:n",
      "binding:input:a",
      "binding:input:z",
      "edge-port:input-output:not-default->in",
      "group:g",
      "meta:edge-condition:input-output",
      "meta:implementation-version:input",
      "meta:node:input",
      "variable:a",
      "variable:z",
    ]);
  });

  it("refuses down-conversion without returning a partial graph", () => {
    const base = adaptFlowGraphV1(legacyGraph());
    const graph: FlowGraphV2 = {
      ...base,
      nodes: [{ ...base.nodes[0], bindings: { prompt: { kind: "literal", value: "x" } } }, base.nodes[1]],
    };

    const result = downconvertFlowGraph(graph);

    expect(result).toEqual({ ok: false, nonRoundTrippableFeatures: ["binding:input:prompt"] });
    expect(result).not.toHaveProperty("graph");
  });
});
