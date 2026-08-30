import { describe, expect, it } from "vitest";
import type { FlowGraphV1, FlowGraphV2, SupportedFlowGraph } from "@/lib/flow/types";
import { compareFlowVersionDetails } from "@/lib/projects/version-diff";
import { hashFlowGraph } from "@/lib/projects/hash";
import type { DependencyPin, FlowVersionRecord } from "@/lib/projects/types";

function pin(
  kind: DependencyPin["kind"],
  resourceId: string,
  version: string,
  contentHash?: string,
): DependencyPin {
  return {
    id: `pin-${kind}-${resourceId}`,
    flowVersionId: "version",
    kind,
    resourceId,
    version,
    ...(contentHash === undefined ? {} : { contentHash }),
    createdAt: 1,
  };
}

function version(
  graph: SupportedFlowGraph,
  overrides: Partial<FlowVersionRecord> = {},
): FlowVersionRecord {
  const dependencies = overrides.dependencies ?? [];
  const dependencyInput = dependencies.map(({ kind, resourceId, version, contentHash }) => ({
    kind,
    resourceId,
    version,
    ...(contentHash === undefined ? {} : { contentHash }),
  }));
  return {
    id: "version-1",
    flowId: "flow-1",
    versionNumber: 1,
    schemaVersion: "schemaVersion" in graph ? graph.schemaVersion : 1,
    graph,
    semanticHash: hashFlowGraph(graph, { semantic: true }, dependencyInput),
    fullHash: hashFlowGraph(graph, { semantic: false }, dependencyInput),
    createdBy: "owner",
    createdAt: 1,
    dependencies,
    ...overrides,
  };
}

function graphV2(): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "graph-1",
    name: "Structural diff",
    nodes: [
      { id: "a", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
      {
        id: "b",
        type: "transform",
        params: { revision: 1, ordered: ["one", "two"] },
        bindings: {},
        position: { x: 100, y: 0 },
      },
    ],
    edges: [
      { id: "edge-remove", source: "a", sourceHandle: "out", target: "b", targetHandle: "in" },
      { id: "edge-change", source: "a", sourceHandle: "out", target: "b", targetHandle: "in" },
    ],
    variables: [
      { id: "var-remove", name: "Remove", scope: "run", schema: { type: "string" } },
      { id: "var-change", name: "Change", scope: "run", schema: { type: "string" }, default: "a" },
    ],
    groups: [],
    annotations: [],
    meta: { runtime: { retries: 1 }, display: { zoom: 1 } },
  };
}

describe("deterministic flow version structural diff", () => {
  it("sorts exact node, edge, variable, and dependency changes with field paths", () => {
    const leftGraph = graphV2();
    const rightGraph: FlowGraphV2 = {
      ...structuredClone(leftGraph),
      nodes: [
        {
          ...(structuredClone(leftGraph.nodes[1])),
          params: { ...leftGraph.nodes[1].params, revision: 2 },
        },
        { id: "c", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
      edges: [
        { ...leftGraph.edges[1], targetHandle: "changed" },
        { id: "edge-add", source: "b", sourceHandle: "out", target: "c", targetHandle: "in" },
      ],
      variables: [
        { ...leftGraph.variables[1], default: "b" },
        { id: "var-add", name: "Add", scope: "workflow", schema: { type: "number" } },
      ],
    };
    const left = version(leftGraph, {
      dependencies: [pin("agent", "remove", "1"), pin("skill", "change", "1", "aaa")],
    });
    const right = version(rightGraph, {
      id: "version-2",
      versionNumber: 2,
      dependencies: [pin("skill", "change", "2", "bbb"), pin("template", "add", "1")],
    });

    const diff = compareFlowVersionDetails(left, right);

    expect(diff.entries).toEqual([
      { kind: "node", id: "a", change: "removed", fields: [] },
      { kind: "node", id: "b", change: "changed", fields: ["params.revision"] },
      { kind: "node", id: "c", change: "added", fields: [] },
      { kind: "edge", id: "edge-add", change: "added", fields: [] },
      { kind: "edge", id: "edge-change", change: "changed", fields: ["targetHandle"] },
      { kind: "edge", id: "edge-remove", change: "removed", fields: [] },
      { kind: "variable", id: "var-add", change: "added", fields: [] },
      { kind: "variable", id: "var-change", change: "changed", fields: ["default"] },
      { kind: "variable", id: "var-remove", change: "removed", fields: [] },
      { kind: "dependency", id: "[\"agent\",\"remove\"]", change: "removed", fields: [] },
      { kind: "dependency", id: "[\"skill\",\"change\"]", change: "changed", fields: ["contentHash", "version"] },
      { kind: "dependency", id: "[\"template\",\"add\"]", change: "added", fields: [] },
    ]);
    expect(diff.counts).toEqual({ added: 4, removed: 4, changed: 4 });
    expect(diff.changedSections).toEqual(["dependencies", "edges", "nodes", "variables"]);
    expect(diff.visualOnly).toBe(false);
    expect(diff.semanticEqual).toBe(false);
    expect(diff.fullEqual).toBe(false);
    expect(diff.from).toEqual({ id: "version-1", versionNumber: 1, semanticHash: left.semanticHash });
    expect(diff.to).toEqual({ id: "version-2", versionNumber: 2, semanticHash: right.semanticHash });
  });

  it("reports node position and visual metadata changes as visual-only", () => {
    const left = graphV2();
    const right: FlowGraphV2 = {
      ...structuredClone(left),
      nodes: left.nodes.map((node, index) => index === 0
        ? { ...structuredClone(node), position: { ...node.position, x: 999 } }
        : structuredClone(node)),
      meta: { ...left.meta, display: { zoom: 2 } },
    };

    expect(compareFlowVersionDetails(version(left), version(right))).toMatchObject({
      semanticEqual: true,
      fullEqual: false,
      visualOnly: true,
      changedSections: [],
      counts: { added: 0, removed: 0, changed: 0 },
      entries: [],
      truncated: false,
    });
  });

  it("reports semantic graph metadata changes without inventing entity entries", () => {
    const left = graphV2();
    const right: FlowGraphV2 = {
      ...structuredClone(left),
      meta: { ...left.meta, runtime: { retries: 2 } },
    };

    expect(compareFlowVersionDetails(version(left), version(right))).toMatchObject({
      semanticEqual: false,
      fullEqual: false,
      visualOnly: false,
      changedSections: ["meta"],
      counts: { added: 0, removed: 0, changed: 0 },
      entries: [],
    });
  });

  it("supports v1 graphs without variables and ignores canonical collection reorder", () => {
    const left: FlowGraphV1 = {
      id: "v1",
      name: "Legacy",
      nodes: [
        { id: "z", type: "output", params: {}, position: { x: 2, y: 0 } },
        { id: "a", type: "input", params: {}, position: { x: 1, y: 0 } },
      ],
      edges: [{ id: "e", source: "a", target: "z" }],
    };
    const right: FlowGraphV1 = {
      ...structuredClone(left),
      nodes: [...left.nodes].reverse(),
      edges: [...left.edges].reverse(),
    };

    expect(compareFlowVersionDetails(version(left), version(right))).toMatchObject({
      semanticEqual: true,
      fullEqual: true,
      visualOnly: false,
      changedSections: [],
      entries: [],
    });
  });

  it("treats array order inside an entity as semantic and equal records as equal", () => {
    const left = graphV2();
    const equal = version(structuredClone(left), { id: "same", versionNumber: 2 });
    expect(compareFlowVersionDetails(version(left), equal)).toMatchObject({
      semanticEqual: true,
      fullEqual: true,
      visualOnly: false,
      entries: [],
    });

    const reordered: FlowGraphV2 = {
      ...structuredClone(left),
      nodes: left.nodes.map((node, index) => index === 1
        ? { ...structuredClone(node), params: { ...node.params, ordered: ["two", "one"] } }
        : structuredClone(node)),
    };
    expect(compareFlowVersionDetails(version(left), version(reordered)).entries).toEqual([
      { kind: "node", id: "b", change: "changed", fields: ["params.ordered"] },
    ]);
  });

  it("caps entries at 200 while preserving exact counts", () => {
    const left = graphV2();
    const right: FlowGraphV2 = {
      ...structuredClone(left),
      nodes: Array.from({ length: 205 }, (_, index) => ({
        id: `new-${String(index).padStart(3, "0")}`,
        type: "input" as const,
        params: {},
        bindings: {},
        position: { x: index, y: 0 },
      })),
    };

    const diff = compareFlowVersionDetails(version(left), version(right));
    expect(diff.entries).toHaveLength(200);
    expect(diff.counts).toEqual({ added: 205, removed: 2, changed: 0 });
    expect(diff.truncated).toBe(true);
  });

  it("fails closed on duplicate entity IDs and dependency keys", () => {
    const source = graphV2();
    const duplicateNodes: FlowGraphV2 = {
      ...source,
      nodes: [source.nodes[0], structuredClone(source.nodes[0])],
    };
    expect(() => compareFlowVersionDetails(version(duplicateNodes), version(graphV2())))
      .toThrow(/duplicate node id/i);

    const graph = graphV2();
    const duplicateDependencies = [pin("skill", "same", "1"), pin("skill", "same", "2")];
    expect(() => compareFlowVersionDetails(
      version(graph, { dependencies: duplicateDependencies }),
      version(graph),
    )).toThrow(/duplicate dependency id/i);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });
});
