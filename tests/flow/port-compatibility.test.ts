import { describe, expect, it } from "vitest";
import {
  comparePortSchemas,
  validateTypedConnection,
  type NodeDefinitionResolver,
} from "@/lib/flow/port-compatibility";
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import type { FlowGraphV2 } from "@/lib/flow/types";

const v2Graph = (overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 => ({
  schemaVersion: 2,
  id: "typed",
  name: "Typed",
  nodes: [
    { id: "source", type: "llm", params: {}, bindings: {}, position: { x: 0, y: 0 } },
    { id: "target", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
  ],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
  ...overrides,
});

describe("comparePortSchemas", () => {
  it("proves equal primitive types and integer widening", () => {
    expect(comparePortSchemas({ type: "string" }, { type: "string" }).status).toBe("compatible");
    expect(comparePortSchemas({ type: "integer" }, { type: "number" }).status).toBe("compatible");
  });

  it("refuses number narrowing and disjoint unions", () => {
    expect(comparePortSchemas({ type: "number" }, { type: "integer" }).status).toBe("incompatible");
    expect(comparePortSchemas(
      { anyOf: [{ type: "string" }, { type: "boolean" }] },
      { anyOf: [{ type: "number" }, { type: "null" }] },
    ).status).toBe("incompatible");
  });

  it("proves equivalent disjoint union spellings but not overlapping oneOf branches", () => {
    expect(comparePortSchemas(
      { type: ["string", "number"] },
      { anyOf: [{ type: "number" }, { type: "string" }] },
    ).status).toBe("compatible");
    expect(comparePortSchemas(
      { type: "integer" },
      { oneOf: [{ type: "integer" }, { type: "number" }] },
    ).status).toBe("untyped");
  });

  it("compares enum containment", () => {
    expect(comparePortSchemas({ enum: ["a"] }, { enum: ["a", "b"] }).status).toBe("compatible");
    expect(comparePortSchemas({ enum: ["a", "c"] }, { enum: ["a", "b"] }).status).toBe("incompatible");
  });

  it("recursively compares array items", () => {
    expect(comparePortSchemas(
      { type: "array", items: { type: "integer" } },
      { type: "array", items: { type: "number" } },
    ).status).toBe("compatible");
    expect(comparePortSchemas(
      { type: "array", items: { type: "number" } },
      { type: "array", items: { type: "integer" } },
    ).status).toBe("incompatible");
  });

  it("accepts a constrained source when the target admits every JSON type", () => {
    expect(comparePortSchemas(
      { type: "object", required: ["status"], properties: { status: { type: "integer" } } },
      { type: ["array", "boolean", "null", "number", "object", "string"] },
    ).status).toBe("compatible");
  });

  it("requires source objects to guarantee target-required properties", () => {
    expect(comparePortSchemas(
      {
        type: "object",
        required: ["user"],
        properties: {
          user: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "integer" } },
          },
        },
      },
      {
        type: "object",
        required: ["user"],
        properties: {
          user: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "number" } },
          },
        },
      },
    ).status).toBe("compatible");

    expect(comparePortSchemas(
      { type: "object", properties: { id: { type: "string" } } },
      { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    ).status).toBe("incompatible");
  });

  it("refuses incompatible nested properties", () => {
    expect(comparePortSchemas(
      {
        type: "object",
        required: ["user"],
        properties: { user: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
      },
      {
        type: "object",
        required: ["user"],
        properties: { user: { type: "object", required: ["id"], properties: { id: { type: "number" } } } },
      },
    ).status).toBe("incompatible");
  });

  it("does not prove open source objects against optional constrained target properties", () => {
    expect(comparePortSchemas(
      { type: "object" },
      { type: "object", properties: { id: { type: "string" } } },
    ).status).toBe("untyped");
    expect(comparePortSchemas(
      { type: "object", additionalProperties: false },
      { type: "object", properties: { id: { type: "string" } } },
    ).status).toBe("compatible");
  });

  it("treats empty and unsupported schemas as untyped", () => {
    expect(comparePortSchemas({}, { type: "string" }).status).toBe("untyped");
    expect(comparePortSchemas({ type: "string" }, {}).status).toBe("untyped");
    expect(comparePortSchemas({ type: "string", pattern: "^x" }, { type: "string" }).status).toBe("untyped");
  });
});

describe("validateTypedConnection", () => {
  it("reports missing endpoints and handles without mutating the graph", () => {
    const graph = v2Graph();
    const before = JSON.stringify(graph);
    expect(validateTypedConnection(graph, {
      source: "missing", sourceHandle: "result", target: "target", targetHandle: "in",
    }).status).toBe("incompatible");
    expect(validateTypedConnection(graph, {
      source: "source", sourceHandle: "missing", target: "target", targetHandle: "in",
    }).status).toBe("incompatible");
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("refuses one-cardinality collisions and permits many-cardinality fan-in", () => {
    const graph = v2Graph({
      nodes: [
        { id: "a", type: "llm", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "b", type: "llm", params: {}, bindings: {}, position: { x: 0, y: 100 } },
        { id: "target", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "existing", source: "a", sourceHandle: "result", target: "target", targetHandle: "in" }],
    });
    expect(validateTypedConnection(graph, {
      source: "b", sourceHandle: "result", target: "target", targetHandle: "in",
    }).status).toBe("incompatible");

    const resolveMany: NodeDefinitionResolver = (type) => {
      const definition = getNodeDefinition(type);
      if (type !== "output") return definition;
      return {
        ...definition,
        inputPorts: definition.inputPorts.map((port) => ({ ...port, cardinality: "many" as const })),
      };
    };
    expect(validateTypedConnection(graph, {
      source: "b", sourceHandle: "result", target: "target", targetHandle: "in",
    }, resolveMany).status).toBe("compatible");
  });

  it("refuses cycles and reports untyped provider ports with both port names", () => {
    const cycleGraph = v2Graph({
      edges: [{ id: "forward", source: "source", sourceHandle: "result", target: "target", targetHandle: "in" }],
    });
    expect(validateTypedConnection(cycleGraph, {
      source: "target", sourceHandle: "result", target: "source", targetHandle: "in",
    }).status).toBe("incompatible");

    const graph = v2Graph({
      nodes: [
        { id: "provider", type: "suede.styleCoach", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "sink", type: "suede.lyrics", params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
    });
    const verdict = validateTypedConnection(graph, {
      source: "provider", sourceHandle: "result", target: "sink", targetHandle: "in",
    });
    expect(verdict.status).toBe("untyped");
    expect(verdict.message).toContain("provider.result");
    expect(verdict.message).toContain("sink.in");
  });

  it("never proves config-dependent loop input while keeping loop outputs typed", () => {
    const intoLoop = v2Graph({
      nodes: [
        { id: "source", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "array-source", type: "loop", params: {}, bindings: {}, position: { x: 0, y: 100 } },
        { id: "loop", type: "loop", params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
    });
    const inputVerdict = validateTypedConnection(intoLoop, {
      source: "source", sourceHandle: "result", target: "loop", targetHandle: "in",
    });
    expect(inputVerdict.status).toBe("untyped");
    expect(inputVerdict.status).not.toBe("compatible");
    const arrayVerdict = validateTypedConnection(intoLoop, {
      source: "array-source", sourceHandle: "result", target: "loop", targetHandle: "in",
    });
    expect(arrayVerdict.status).toBe("untyped");
    expect(arrayVerdict.status).not.toBe("compatible");

    const fromLoop = v2Graph({
      nodes: [
        { id: "loop", type: "loop", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "target", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
    });
    expect(validateTypedConnection(fromLoop, {
      source: "loop", sourceHandle: "result", target: "target", targetHandle: "in",
    }).status).toBe("compatible");
    expect(validateTypedConnection(fromLoop, {
      source: "loop", sourceHandle: "errors", target: "target", targetHandle: "in",
    }).status).toBe("compatible");
  });
});
