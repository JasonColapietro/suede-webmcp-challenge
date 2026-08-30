import { describe, expect, it } from "vitest";
import type { FlowGraph } from "@/lib/flow/types";
import {
  canonicalizeGraph,
  hashFlowGraph,
  VISUAL_ONLY_META_KEYS,
} from "@/lib/projects/hash";

const graph = (): FlowGraph => ({
  id: "flow-1",
  name: "Versioned flow",
  nodes: [
    {
      id: "output",
      type: "output",
      params: { fields: ["title", "body"] },
      position: { x: 520, y: 120 },
    },
    {
      id: "input",
      type: "input",
      params: { schema: { topic: "string", audience: "string" } },
      position: { x: 80, y: 120 },
    },
  ],
  edges: [
    {
      id: "input-output",
      source: "input",
      sourceHandle: "result",
      target: "output",
      targetHandle: "value",
    },
  ],
  meta: {
    createdBy: "studio",
    viewport: { x: 12, y: 30, zoom: 0.8 },
  },
});

describe("canonical flow hashing", () => {
  it("hashes identical content identically despite object and graph collection order", () => {
    const left = graph();
    const right = {
      meta: {
        viewport: { zoom: 0.8, y: 30, x: 12 },
        createdBy: "studio",
      },
      edges: [...left.edges].reverse(),
      nodes: [...left.nodes]
        .reverse()
        .map((node) => ({
          position: { y: node.position.y, x: node.position.x },
          params: node.params,
          type: node.type,
          id: node.id,
        })),
      name: left.name,
      id: left.id,
    } as FlowGraph;

    expect(hashFlowGraph(left, { semantic: false })).toBe(
      hashFlowGraph(right, { semantic: false }),
    );
    expect(hashFlowGraph(left, { semantic: true })).toBe(
      hashFlowGraph(right, { semantic: true }),
    );
  });

  it("treats node positions and explicitly visual metadata as visual only", () => {
    const moved = structuredClone(graph());
    moved.nodes[0].position = { x: 900, y: 700 };
    moved.meta = {
      ...moved.meta,
      viewport: { x: 100, y: 200, zoom: 2 },
      comments: [{ id: "note-1", body: "Move this later" }],
    };

    expect(hashFlowGraph(moved, { semantic: false })).not.toBe(
      hashFlowGraph(graph(), { semantic: false }),
    );
    expect(hashFlowGraph(moved, { semantic: true })).toBe(
      hashFlowGraph(graph(), { semantic: true }),
    );
    expect(VISUAL_ONLY_META_KEYS).toEqual(
      expect.arrayContaining(["viewport", "comments"]),
    );
    expect(VISUAL_ONLY_META_KEYS).toEqual([
      "canvas",
      "comments",
      "display",
      "groups",
      "viewport",
    ]);
    expect(Object.isFrozen(VISUAL_ONLY_META_KEYS)).toBe(true);
  });

  it("strips visual keys only from graph.meta and node.meta boundaries", () => {
    const baseline = graph();
    const withNodeMeta = structuredClone(baseline) as FlowGraph & {
      nodes: Array<FlowGraph["nodes"][number] & { meta?: Record<string, unknown> }>;
    };
    withNodeMeta.nodes[0].meta = { viewport: { zoom: 2 } };

    expect(hashFlowGraph(withNodeMeta, { semantic: true })).toBe(
      hashFlowGraph(baseline, { semantic: true }),
    );

    const withNodeRuntimeMeta = structuredClone(withNodeMeta);
    withNodeRuntimeMeta.nodes[0].meta = {
      viewport: { zoom: 2 },
      retryPolicy: { attempts: 3 },
    };
    expect(hashFlowGraph(withNodeRuntimeMeta, { semantic: true })).not.toBe(
      hashFlowGraph(baseline, { semantic: true }),
    );

    const withParamsMeta = structuredClone(baseline);
    withParamsMeta.nodes[0].params = {
      ...withParamsMeta.nodes[0].params,
      meta: { viewport: { runtimeScale: 2 } },
    };
    expect(hashFlowGraph(withParamsMeta, { semantic: true })).not.toBe(
      hashFlowGraph(baseline, { semantic: true }),
    );

    const withNestedMeta = structuredClone(baseline);
    withNestedMeta.meta = {
      ...withNestedMeta.meta,
      runtime: { meta: { comments: "runtime-significant" } },
    };
    expect(hashFlowGraph(withNestedMeta, { semantic: true })).not.toBe(
      hashFlowGraph(baseline, { semantic: true }),
    );
  });

  it("does not depend on locale-sensitive string comparison", () => {
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not be used");
    };
    try {
      expect(() => hashFlowGraph(graph(), { semantic: true })).not.toThrow();
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it.each([
    ["params", (value: FlowGraph) => (value.nodes[0].params = { fields: ["body"] })],
    ["edge handles", (value: FlowGraph) => (value.edges[0].targetHandle = "other")],
    ["node types", (value: FlowGraph) => (value.nodes[0].type = "transform")],
    [
      "runtime metadata",
      (value: FlowGraph) => {
        value.meta = { ...value.meta, retryPolicy: { attempts: 3 } };
      },
    ],
  ])("changes the semantic hash when %s change", (_label, mutate) => {
    const changed = structuredClone(graph());
    mutate(changed);
    expect(hashFlowGraph(changed, { semantic: true })).not.toBe(
      hashFlowGraph(graph(), { semantic: true }),
    );
  });

  it("does not mutate input graphs and preserves unknown fields in full output", () => {
    const input = {
      ...graph(),
      futureGraphField: { enabled: true },
      nodes: graph().nodes.map((node, index) => ({
        ...node,
        futureNodeField: `node-${index}`,
      })),
    } as FlowGraph & {
      futureGraphField: { enabled: boolean };
      nodes: Array<FlowGraph["nodes"][number] & { futureNodeField: string }>;
    };
    const before = structuredClone(input);

    const canonical = canonicalizeGraph(input, { semantic: false });

    expect(input).toEqual(before);
    expect(canonical).toMatchObject({
      futureGraphField: { enabled: true },
      nodes: expect.arrayContaining([
        expect.objectContaining({ futureNodeField: "node-0" }),
        expect.objectContaining({ futureNodeField: "node-1" }),
      ]),
    });
  });

  it("preserves ordering in arrays outside the graph node and edge collections", () => {
    const reversed = graph();
    reversed.nodes[0].params = { fields: ["body", "title"] };

    expect(hashFlowGraph(reversed, { semantic: true })).not.toBe(
      hashFlowGraph(graph(), { semantic: true }),
    );
  });

  it("matches a known lowercase SHA-256 vector", () => {
    const vector: FlowGraph = {
      id: "vector",
      name: "Known",
      nodes: [],
      edges: [],
    };

    const hash = hashFlowGraph(vector, { semantic: false });
    expect(hash).toBe("46803edff10121bac6809957ba24a96d882ba962bdf2c14c9c6b86c8f9a2c70e");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
