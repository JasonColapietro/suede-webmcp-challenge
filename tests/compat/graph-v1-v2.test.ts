import { describe, expect, it } from "vitest";
import {
  adaptFlowGraphV1,
  downconvertFlowGraph,
  inspectV2OnlyFeatures,
} from "@/lib/flow/graph-v2-codec";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import type { FlowGraphV1, FlowGraphV2 } from "@/lib/flow/types";
import byteOrderFixture from "../fixtures/compat/v1/graph-byte-order.json";

describe("graph v1/v2 compatibility", () => {
  it("restores the frozen v1 fixture with passthrough fields, named handles, identity, and bytes intact", () => {
    const graph = byteOrderFixture as unknown as FlowGraphV1;
    const before = JSON.stringify(graph);

    const adapted = adaptFlowGraphV1(graph);
    const result = downconvertFlowGraph(adapted);

    expect(adapted).not.toHaveProperty("futureGraphField");
    expect(adapted.nodes[0]).not.toHaveProperty("futureNodeField");
    expect(adapted.edges[0]).not.toHaveProperty("futureEdgeField");
    expect(parseSupportedFlowGraph(adapted)).toEqual(adapted);
    expect(inspectV2OnlyFeatures(adapted)).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected provenance-backed conversion");
    expect(result.graph).toBe(graph);
    expect(JSON.stringify(result.graph)).toBe(before);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("round-trips a lossless v1 graph byte-for-byte without mutation", () => {
    const source = {
      meta: { zeta: true, alpha: false },
      edges: [
        {
          target: "output",
          source: "input",
          id: "edge",
        },
      ],
      nodes: [
        {
          position: { y: 2, x: 1 },
          params: { zeta: "first", alpha: "second" },
          type: "input",
          id: "input",
        },
        { position: { y: 4, x: 3 }, params: {}, type: "output", id: "output" },
      ],
      name: "Byte stable",
      id: "byte-stable",
    } satisfies FlowGraphV1;
    const before = JSON.stringify(source);

    const result = downconvertFlowGraph(adaptFlowGraphV1(source));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected lossless conversion");
    expect(JSON.stringify(result.graph)).toBe(before);
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([
    ["variables", (graph: FlowGraphV2): FlowGraphV2 => ({ ...graph, variables: [{ id: "v", name: "V", scope: "run", schema: {} }] })],
    ["bindings", (graph: FlowGraphV2): FlowGraphV2 => ({ ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, bindings: { x: { kind: "literal", value: 1 } } } : node) })],
    ["multiple ports", (graph: FlowGraphV2): FlowGraphV2 => ({ ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, type: "branch" } : node), edges: graph.edges.map((edge) => ({ ...edge, sourceHandle: "true" })) })],
    ["non-default ports", (graph: FlowGraphV2): FlowGraphV2 => ({ ...graph, edges: graph.edges.map((edge) => ({ ...edge, sourceHandle: "custom" })) })],
    ["groups", (graph: FlowGraphV2): FlowGraphV2 => ({ ...graph, groups: [{ id: "g", label: "G", nodeIds: [] }] })],
    ["annotations", (graph: FlowGraphV2): FlowGraphV2 => ({ ...graph, annotations: [{ id: "a", text: "A", position: { x: 0, y: 0 } }] })],
    ["node metadata", (graph: FlowGraphV2): FlowGraphV2 => ({ ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, meta: { v2: true } } : node) })],
  ])("refuses %s because it cannot round-trip through v1", (_name, addFeature) => {
    const v1: FlowGraphV1 = {
      id: "g",
      name: "G",
      nodes: [
        { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
        { id: "output", type: "output", params: {}, position: { x: 1, y: 0 } },
      ],
      edges: [{ id: "e", source: "input", target: "output" }],
    };
    const graph = addFeature({ ...adaptFlowGraphV1(v1) });

    const result = downconvertFlowGraph(graph);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("graph");
  });
});
