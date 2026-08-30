import { describe, expect, it } from "vitest";
import {
  isFlowGraphV1,
  isFlowGraphV2,
  parseSupportedFlowGraph,
  SupportedFlowGraphSchema,
} from "@/lib/flow/graph-schema";
import type { FlowGraphV1, FlowGraphV2, ValueBinding } from "@/lib/flow/types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import byteOrderFixture from "../fixtures/compat/v1/graph-byte-order.json";

const v1Graph: FlowGraphV1 = {
  id: "legacy-graph",
  name: "Legacy graph",
  nodes: [
    {
      id: "input",
      type: "input",
      params: { prompt: "hello" },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  meta: { compatibility: true },
};

const bindings = {
  literal: { kind: "literal", value: { nested: [true, null, 3] } },
  port: { kind: "port", nodeId: "input", portId: "text", path: "result.value" },
  variable: { kind: "variable", variableId: "var-input", path: "nested.value" },
  secret: { kind: "secret", connectionId: "conn-1", field: "apiKey" },
} satisfies Readonly<Record<string, ValueBinding>>;

const v2Graph: FlowGraphV2 = {
  schemaVersion: 2,
  id: "graph-v2",
  name: "Graph v2",
  nodes: [
    {
      id: "input",
      type: "input",
      params: { prompt: "hello", options: { temperature: 0.2 } },
      bindings,
      implementationVersion: "input@2.1.0",
      meta: { locked: false, tags: ["contract"] },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [
    {
      id: "edge-1",
      source: "input",
      sourceHandle: "text",
      target: "input",
      targetHandle: "prompt",
      condition: { kind: "variable", variableId: "var-enabled" },
    },
  ],
  variables: [
    {
      id: "var-input",
      name: "Input",
      scope: "workflow",
      schema: { type: "object", properties: { value: { type: "string" } } },
      default: { value: "hello" },
    },
    {
      id: "var-enabled",
      name: "Enabled",
      scope: "run",
      schema: { type: "boolean" },
      sensitive: true,
    },
  ],
  groups: [{ id: "group-1", label: "Inputs", nodeIds: ["input"] }],
  annotations: [{ id: "note-1", text: "Start here", position: { x: 10, y: 20 } }],
  meta: { owner: "contract-test", nested: [1, false, null] },
};

describe("explicit flow graph v2 contract", () => {
  it("parses an unversioned v1 graph without adding a version key", () => {
    const parsed = parseSupportedFlowGraph(v1Graph);

    expect(parsed).toEqual(v1Graph);
    expect(isFlowGraphV1(parsed)).toBe(true);
    expect(isFlowGraphV2(parsed)).toBe(false);
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty("schemaVersion");
  });

  it("returns a legacy graph unchanged with recursive JSON key order intact", () => {
    const before = JSON.stringify(byteOrderFixture);
    const firstNode = byteOrderFixture.nodes[0];
    const firstPosition = firstNode?.position;

    const parsed = parseSupportedFlowGraph(byteOrderFixture);
    const schemaParsed = SupportedFlowGraphSchema.parse(byteOrderFixture);

    expect(parsed).toBe(byteOrderFixture);
    expect(schemaParsed).toBe(byteOrderFixture);
    expect(parsed.nodes[0]).toBe(firstNode);
    expect(parsed.nodes[0]?.position).toBe(firstPosition);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(JSON.stringify(schemaParsed)).toBe(before);
    expect(JSON.stringify(byteOrderFixture)).toBe(before);
  });

  it("parses schemaVersion 2 with every binding arm and frozen semantic fields", () => {
    const parsed = parseSupportedFlowGraph(v2Graph);

    expect(parsed).toEqual(v2Graph);
    expect(isFlowGraphV1(parsed)).toBe(false);
    expect(isFlowGraphV2(parsed)).toBe(true);
    if (!isFlowGraphV2(parsed)) throw new Error("expected v2 graph");
    expect(Object.values(parsed.nodes[0]?.bindings ?? {}).map((binding) => binding.kind)).toEqual([
      "literal",
      "port",
      "variable",
      "secret",
    ]);
    expect(parsed.nodes[0]?.implementationVersion).toBe("input@2.1.0");
    expect(parsed.nodes[0]?.meta).toEqual({ locked: false, tags: ["contract"] });
    expect(parsed.edges[0]?.condition).toEqual({ kind: "variable", variableId: "var-enabled" });
  });

  it("accepts an optional strict callable interface without changing graphs that omit it", () => {
    const callableInterface = {
      inputs: [{
        id: "prompt",
        label: "Prompt",
        schema: { type: "string" },
        required: true,
        cardinality: "one",
        target: { kind: "trigger", path: "/prompt" },
      }],
      outputs: [{
        id: "answer",
        label: "Answer",
        schema: { type: "string" },
        required: true,
        cardinality: "one",
        source: { nodeId: "input", portId: "text", path: "" },
      }],
    } as const;
    const safeNodes = v2Graph.nodes.map((node) => ({ ...node, bindings: {} }));
    const parsed = parseSupportedFlowGraph({ ...v2Graph, nodes: safeNodes, edges: [], callableInterface });

    expect(parsed).toMatchObject({ callableInterface });
    expect(JSON.stringify(parseSupportedFlowGraph(v2Graph))).toBe(JSON.stringify(v2Graph));
    expect(() => parseSupportedFlowGraph({
      ...v2Graph,
      nodes: safeNodes,
      edges: [],
      callableInterface: { ...callableInterface, extra: true },
    })).toThrow();
  });

  it("validates embedded typed subflow references and refuses mixed envelopes", () => {
    const callableInterface = {
      inputs: [],
      outputs: [{
        id: "answer",
        label: "Answer",
        schema: { type: "string" },
        required: true,
        cardinality: "one",
        source: { nodeId: "input", portId: "text" },
      }],
    } as const;
    const reference = {
      kind: "draft",
      flowId: "opaque-child",
      interface: callableInterface,
      interfaceHash: hashCallableInterface(callableInterface),
    } as const;
    const subflowNode = { ...v2Graph.nodes[0], type: "subflow" as const, params: { reference } };

    expect(() => parseSupportedFlowGraph({ ...v2Graph, nodes: [subflowNode] })).not.toThrow();
    expect(() => parseSupportedFlowGraph({
      ...v2Graph,
      nodes: [{ ...subflowNode, params: { flowId: "legacy", reference } }],
    })).toThrow(/both|mixed/i);
    expect(() => parseSupportedFlowGraph({
      ...v2Graph,
      nodes: [{ ...subflowNode, params: { reference: { ...reference, interfaceHash: "bad" } } }],
    })).toThrow(/hash/i);
    expect(() => parseSupportedFlowGraph({
      ...v2Graph,
      nodes: [{ ...subflowNode, params: { flowId: "legacy" } }],
    })).not.toThrow();
  });

  it.each(["subflow", "loop"] as const)(
    "normalizes every v2 %s reference envelope at the graph boundary",
    (type) => {
      const callableInterface = { inputs: [], outputs: [] } as const;
      const reference = {
        kind: "draft",
        flowId: "opaque-child",
        interface: callableInterface,
        interfaceHash: hashCallableInterface(callableInterface),
      } as const;
      const base = { ...v2Graph.nodes[0], type };

      expect(() => parseSupportedFlowGraph({ ...v2Graph, nodes: [{ ...base, params: { flowId: "legacy" } }] })).not.toThrow();
      expect(() => parseSupportedFlowGraph({ ...v2Graph, nodes: [{ ...base, params: { reference } }] })).not.toThrow();
      for (const params of [{}, { unrelated: true }, { flowId: "" }, { flowId: 42 }, { flowId: "legacy", reference }]) {
        expect(() => parseSupportedFlowGraph({ ...v2Graph, nodes: [{ ...base, params }] })).toThrow(/flowId|reference|both/i);
      }
    },
  );

  it("rejects direct and transitive secret or sensitive callable-output lineage", () => {
    const callableInterface = {
      inputs: [],
      outputs: [{
        id: "answer",
        label: "Answer",
        schema: {},
        required: true,
        cardinality: "one",
        source: { nodeId: "output", portId: "result" },
      }],
    } as const;
    const graph = {
      ...v2Graph,
      callableInterface,
      nodes: [
        { id: "input", type: "input" as const, params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "middle", type: "transform" as const, params: {}, bindings: {}, position: { x: 100, y: 0 } },
        { id: "output", type: "output" as const, params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
      edges: [
        { id: "one", source: "input", sourceHandle: "result", target: "middle", targetHandle: "in" },
        { id: "two", source: "middle", sourceHandle: "result", target: "output", targetHandle: "in" },
      ],
    };
    const directSecret = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "output"
        ? { ...node, bindings: { credential: { kind: "secret" as const, connectionId: "connection", field: "token" } } }
        : node),
    };
    const transitiveSensitive = {
      ...graph,
      variables: [{ id: "sensitive", name: "Sensitive", scope: "run" as const, schema: {}, sensitive: true }],
      nodes: graph.nodes.map((node) => node.id === "input"
        ? { ...node, bindings: { source: { kind: "variable" as const, variableId: "sensitive" } } }
        : node),
    };

    expect(() => parseSupportedFlowGraph(directSecret)).toThrow(/secret/i);
    expect(() => parseSupportedFlowGraph(transitiveSensitive)).toThrow(/sensitive/i);
    expect(() => parseSupportedFlowGraph(graph)).not.toThrow();
  });

  it("requires both v2 edge handles", () => {
    const edge = v2Graph.edges[0];
    expect(() =>
      parseSupportedFlowGraph({ ...v2Graph, edges: [{ ...edge, sourceHandle: undefined }] }),
    ).toThrow();
    expect(() =>
      parseSupportedFlowGraph({ ...v2Graph, edges: [{ ...edge, targetHandle: undefined }] }),
    ).toThrow();
  });

  it("rejects duplicate variable ids and case-insensitive names", () => {
    const variable = v2Graph.variables[0];
    expect(() =>
      parseSupportedFlowGraph({
        ...v2Graph,
        variables: [variable, { ...variable, name: "Another" }],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      parseSupportedFlowGraph({
        ...v2Graph,
        variables: [variable, { ...variable, id: "another-id", name: "input" }],
      }),
    ).toThrow(/unique/i);
  });

  it("rejects a sensitive variable with a default", () => {
    for (const defaultValue of [v2Graph.variables[0]?.default, undefined]) {
      expect(() =>
        parseSupportedFlowGraph({
          ...v2Graph,
          variables: [
            {
              ...v2Graph.variables[0],
              sensitive: true,
              default: defaultValue,
            },
          ],
        }),
      ).toThrow(/sensitive/i);
    }
  });

  it("rejects non-JSON recursive values in schemas, defaults, params, bindings, and metadata", () => {
    const cases: unknown[] = [
      { ...v2Graph, variables: [{ ...v2Graph.variables[0], schema: { bad: undefined } }] },
      { ...v2Graph, variables: [{ ...v2Graph.variables[0], default: Number.NaN }] },
      { ...v2Graph, nodes: [{ ...v2Graph.nodes[0], params: { bad: () => true } }] },
      {
        ...v2Graph,
        nodes: [
          {
            ...v2Graph.nodes[0],
            bindings: { bad: { kind: "literal", value: Number.POSITIVE_INFINITY } },
          },
        ],
      },
      { ...v2Graph, nodes: [{ ...v2Graph.nodes[0], meta: { bad: undefined } }] },
      { ...v2Graph, meta: { bad: BigInt(1) } },
    ];

    for (const graph of cases) expect(() => parseSupportedFlowGraph(graph)).toThrow();
  });

  it("uses trimmed non-empty ids, finite coordinates, and unique entity ids", () => {
    expect(() => parseSupportedFlowGraph({ ...v2Graph, id: "   " })).toThrow();
    expect(() =>
      parseSupportedFlowGraph({
        ...v2Graph,
        nodes: [{ ...v2Graph.nodes[0], position: { x: Number.POSITIVE_INFINITY, y: 0 } }],
      }),
    ).toThrow();
    expect(() =>
      parseSupportedFlowGraph({
        ...v2Graph,
        annotations: [...v2Graph.annotations, { ...v2Graph.annotations[0] }],
      }),
    ).toThrow(/unique/i);
  });

  it.each([0, 3, 999])("fails closed for unsupported schemaVersion %i", (schemaVersion) => {
    const unknownVersion = { ...v2Graph, schemaVersion };

    expect(() => parseSupportedFlowGraph(unknownVersion)).toThrow(/schemaVersion/i);
    expect(() => SupportedFlowGraphSchema.parse(unknownVersion)).toThrow(/schemaVersion/i);
    expect(isFlowGraphV1(unknownVersion)).toBe(false);
    expect(isFlowGraphV2(unknownVersion)).toBe(false);
  });
});
