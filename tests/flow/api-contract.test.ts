import { describe, expect, it } from "vitest";
import fixture from "../fixtures/compat/v0/flow-row-id.json";
import {
  isFlowGraph,
  parseCreatedFlowId,
  parsePersistedFlow,
  parseTemplateGraph,
} from "@/lib/flow/api-contract";
import { CreateFlowRequestSchema, UpdateFlowRequestSchema } from "@/lib/flow/request-schema";

describe("flow API client contract", () => {
  it("keeps the row id authoritative when graph id differs", () => {
    const parsed = parsePersistedFlow(fixture);
    expect(parsed?.rowId).toBe(fixture.flow.id);
    expect(parsed?.graph.id).toBe(fixture.flow.graph.id);
    expect(parsed?.rowId).not.toBe(parsed?.graph.id);
  });

  it("rejects a flow envelope with no persisted row id", () => {
    expect(parsePersistedFlow({ flow: { graph: fixture.flow.graph } })).toBeNull();
    expect(parseCreatedFlowId({ flow: { graph: fixture.flow.graph } })).toBeNull();
  });

  it("keeps template parsing separate from persisted flow parsing", () => {
    expect(parseTemplateGraph({ template: { graph: fixture.flow.graph } })).toEqual(
      fixture.flow.graph,
    );
    expect(parsePersistedFlow({ template: { graph: fixture.flow.graph } })).toBeNull();
  });

  it("rejects malformed nested nodes", () => {
    const graph = fixture.flow.graph;
    const node = graph.nodes[0];
    const malformedNodes: unknown[] = [
      {},
      { ...node, type: "unknown-node" },
      { ...node, params: [] },
      { ...node, position: { x: Number.POSITIVE_INFINITY, y: 0 } },
      { ...node, position: { x: 0, y: Number.NaN } },
    ];

    for (const malformedNode of malformedNodes) {
      expect(isFlowGraph({ ...graph, nodes: [malformedNode] })).toBe(false);
    }
  });

  it("rejects malformed nested edges", () => {
    const graph = fixture.flow.graph;
    const edge = graph.edges[0];
    const malformedEdges: unknown[] = [
      {},
      { id: edge.id, source: edge.source },
      { ...edge, sourceHandle: 42 },
      { ...edge, targetHandle: null },
    ];

    for (const malformedEdge of malformedEdges) {
      expect(isFlowGraph({ ...graph, edges: [malformedEdge] })).toBe(false);
    }
  });

  it("accepts compatible extra graph, node, and edge fields", () => {
    const graph = fixture.flow.graph;
    expect(
      isFlowGraph({
        ...graph,
        futureGraphField: true,
        nodes: graph.nodes.map((node) => ({ ...node, futureNodeField: true })),
        edges: graph.edges.map((edge) => ({ ...edge, futureEdgeField: true })),
      }),
    ).toBe(true);
  });

  it("parses a persisted graph with a valid loop node", () => {
    const loopNode = {
      id: "loop",
      type: "loop",
      params: { maxIterations: 3 },
      position: { x: 130, y: 80 },
    };
    const graph = {
      ...fixture.flow.graph,
      nodes: [...fixture.flow.graph.nodes, loopNode],
    };

    expect(parsePersistedFlow({ flow: { id: fixture.flow.id, graph } })).toEqual({
      rowId: fixture.flow.id,
      graph,
    });
  });

  it("accepts an exact v2 graph at create and update request boundaries", () => {
    const graph = {
      schemaVersion: 2,
      id: "v2-graph",
      name: "V2 graph",
      nodes: [
        {
          id: "input",
          type: "input",
          params: {},
          bindings: {},
          implementationVersion: "input@2",
          meta: { reviewed: true },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      variables: [],
      groups: [],
      annotations: [],
    };

    expect(CreateFlowRequestSchema.parse({ name: "create", graph }).graph).toEqual(graph);
    expect(UpdateFlowRequestSchema.parse({ name: "update", graph }).graph).toEqual(graph);
  });

  it("preserves compatible unknown fields on legacy request graphs", () => {
    const graph = {
      ...fixture.flow.graph,
      futureGraphField: true,
      nodes: fixture.flow.graph.nodes.map((node) => ({ ...node, futureNodeField: true })),
      edges: fixture.flow.graph.edges.map((edge) => ({ ...edge, futureEdgeField: true })),
    };

    const parsed = CreateFlowRequestSchema.parse({ name: "legacy", graph }).graph;
    expect(parsed).toEqual(graph);
  });

  it.each([0, 3, 999])("refuses schemaVersion %i at every API parser", (schemaVersion) => {
    const graph = { ...fixture.flow.graph, schemaVersion };
    const envelope = { flow: { id: fixture.flow.id, graph } };

    expect(CreateFlowRequestSchema.safeParse({ name: "bad", graph }).success).toBe(false);
    expect(UpdateFlowRequestSchema.safeParse({ name: "bad", graph }).success).toBe(false);
    expect(isFlowGraph(graph)).toBe(false);
    expect(parsePersistedFlow(envelope)).toBeNull();
    expect(parseTemplateGraph({ template: { graph } })).toBeNull();
  });
});
