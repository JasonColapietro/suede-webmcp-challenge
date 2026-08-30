import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { preflightV2Execution } from "@/lib/flow/engine";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { downconvertFlowGraph } from "@/lib/flow/graph-v2-codec";
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import {
  resolveChildCapabilityReceipt,
  resolveNodeCapabilityReceipt,
  resolveNodePorts,
  createValidatedNodePortResolver,
  assertGraphPortReferences,
} from "@/lib/flow/node-ports";
import { validateTypedConnection } from "@/lib/flow/port-compatibility";
import { validateFlowGraph } from "@/lib/flow/validate";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { NodeDefinitionV2 } from "@/lib/flow/node-definition-types";
import type { NodeRegistry } from "@/lib/flow/executor";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  FlowNodeV2,
  SubflowReference,
} from "@/lib/flow/types";
import {
  canvasNodePortSignature,
  createCanvasNodePortResolver,
  decideCanvasConnectionForRenderedGraph,
  resolveCanvasNodePorts,
  verdictForCanvasConnection,
} from "@/components/canvas/FlowCanvas";
import Inspector from "@/components/canvas/Inspector";
import SuedeNode from "@/components/canvas/SuedeNode";

const callable: FlowCallableInterface = {
  inputs: [
    {
      id: "prompt",
      label: "Prompt",
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      target: { kind: "trigger", path: "/request/prompt" },
    },
    {
      id: "tags",
      label: "Tags",
      schema: { type: "array", items: { type: "string" } },
      required: false,
      cardinality: "many",
      target: { kind: "trigger", path: "/request/tags" },
    },
  ],
  outputs: [
    {
      id: "answer",
      label: "Answer",
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      source: { nodeId: "sink", portId: "result", path: "/answer" },
    },
    {
      id: "citations",
      label: "Citations",
      schema: { type: "array", items: { type: "string" } },
      required: false,
      cardinality: "many",
      source: { nodeId: "sink", portId: "result", path: "/citations" },
    },
  ],
};

function reference(kind: "draft" | "pinned" = "draft"): SubflowReference {
  const base = {
    flowId: "child:opaque/@row",
    interface: callable,
    interfaceHash: hashCallableInterface(callable),
  };
  return kind === "draft"
    ? { kind, ...base }
    : { kind, ...base, versionId: "version:opaque/@row", contentHash: "a".repeat(64) };
}

function node(type: FlowNodeV2["type"], id: string, params: Record<string, unknown> = {}): FlowNodeV2 {
  return { id, type, params: params as FlowNodeV2["params"], bindings: {}, position: { x: 0, y: 0 } };
}

function graph(nodes: readonly FlowNodeV2[], edges: FlowGraphV2["edges"] = []): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "parent",
    name: "Parent",
    nodes,
    edges,
    variables: [],
    groups: [],
    annotations: [],
  };
}

describe("node-aware typed subflow ports", () => {
  it("projects the exact callable ABI for typed subflows without mapping fields", () => {
    const subflow = node("subflow", "child", { reference: reference() });
    const resolved = resolveNodePorts(graph([subflow]), subflow);

    expect(resolved.inputPorts).toEqual(callable.inputs.map(({ target: _target, ...port }) => port));
    expect(resolved.outputPorts).toEqual(callable.outputs.map(({ source: _source, ...port }) => port));
    expect(resolved.inputPorts[0]).not.toHaveProperty("target");
    expect(resolved.outputPorts[0]).not.toHaveProperty("source");
  });

  it("gives typed loops one items input, ordered nullable arrays, then reserved errors", () => {
    const loop = node("loop", "loop", { reference: reference("pinned") });
    const resolved = resolveNodePorts(graph([loop]), loop);

    expect(resolved.inputPorts).toEqual([{
      id: "items",
      label: "Items",
      required: true,
      cardinality: "one",
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    }]);
    expect(resolved.outputPorts.map((port) => port.id)).toEqual(["answer", "citations", "errors"]);
    expect(resolved.outputPorts[0]?.schema).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
    expect(resolved.outputPorts[1]?.schema).toEqual({
      type: "array",
      items: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    });
    expect(resolved.outputPorts[2]).toEqual(getNodeDefinition("loop").outputPorts[1]);
  });

  it("keeps an empty typed ABI empty and refuses a loop child that claims reserved errors", () => {
    const empty: FlowCallableInterface = { inputs: [], outputs: [] };
    const emptyReference = { kind: "draft", flowId: "empty", interface: empty, interfaceHash: hashCallableInterface(empty) } as const;
    const subflow = node("subflow", "empty-subflow", { reference: emptyReference });
    expect(resolveNodePorts(graph([subflow]), subflow)).toEqual({ inputPorts: [], outputPorts: [] });

    const colliding: FlowCallableInterface = {
      inputs: [],
      outputs: [{
        id: "errors", label: "Child errors", schema: { type: "string" }, required: false,
        cardinality: "one", source: { nodeId: "sink", portId: "result" },
      }],
    };
    const collidingReference = {
      kind: "draft", flowId: "colliding", interface: colliding, interfaceHash: hashCallableInterface(colliding),
    } as const;
    const loop = node("loop", "bad-loop", { reference: collidingReference });
    expect(() => resolveNodePorts(graph([loop]), loop)).toThrow(/reserved.*errors|errors.*reserved/i);
    expect(() => parseSupportedFlowGraph(graph([loop]))).toThrow(/reserved.*errors|errors.*reserved/i);
  });

  it("keeps legacy subflow and loop ports byte-equivalent to the static catalog", () => {
    for (const current of [node("subflow", "sub", { flowId: "legacy" }), node("loop", "loop", { flowId: "legacy" })]) {
      const resolved = resolveNodePorts(graph([current]), current);
      const definition = getNodeDefinition(current.type);
      expect(resolved.inputPorts).toBe(definition.inputPorts);
      expect(resolved.outputPorts).toBe(definition.outputPorts);
    }
  });

  it("fails closed on malformed v2 references while never activating dynamic ports for v1", () => {
    const malformed = node("subflow", "bad", { reference: { kind: "draft", flowId: "child" } });
    expect(() => resolveNodePorts(graph([malformed]), malformed)).toThrow(/invalid|interface|reference|hash/i);
    expect(() => assertGraphPortReferences(graph([malformed]))).toThrow(/invalid|interface|reference|schemaVersion 2/i);

    const legacyWithReferenceField = {
      id: "legacy",
      name: "Legacy",
      nodes: [{ id: "sub", type: "subflow" as const, params: { reference: reference() }, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const resolved = resolveNodePorts(legacyWithReferenceField, legacyWithReferenceField.nodes[0]!);
    expect(resolved.inputPorts).toBe(getNodeDefinition("subflow").inputPorts);
    expect(resolved.outputPorts).toBe(getNodeDefinition("subflow").outputPorts);
  });

  it("uses the supplied static resolver for custom registries", () => {
    const custom = {
      ...getNodeDefinition("transform"),
      inputPorts: [{ id: "custom-in", label: "Custom input", schema: { type: "number" }, required: true, cardinality: "many" }],
      outputPorts: [{ id: "custom-out", label: "Custom output", schema: { type: "number" }, required: true, cardinality: "one" }],
    } satisfies NodeDefinitionV2;
    const transform = node("transform", "custom");
    const resolved = resolveNodePorts(graph([transform]), transform, (type) => type === "transform" ? custom : getNodeDefinition(type));
    expect(resolved.inputPorts).toBe(custom.inputPorts);
    expect(resolved.outputPorts).toBe(custom.outputPorts);
  });

  it("projects dynamic canvas geometry and a stable handle-change signature", () => {
    const subflow = node("subflow", "child", { reference: reference() });
    const parent = graph([subflow]);
    expect(resolveCanvasNodePorts(parent, subflow).inputPorts.map((port) => port.id)).toEqual(["prompt", "tags"]);
    expect(resolveCanvasNodePorts(parent, subflow).outputPorts.map((port) => port.id)).toEqual(["answer", "citations"]);
    const inputs = [
      '["prompt","Prompt",true,"one",{"type":"string"}]',
      '["tags","Tags",false,"many",{"items":{"type":"string"},"type":"array"}]',
    ].join("\u0000");
    const outputs = [
      '["answer","Answer",true,"one",{"type":"string"}]',
      '["citations","Citations",false,"many",{"items":{"type":"string"},"type":"array"}]',
    ].join("\u0000");
    expect(canvasNodePortSignature(parent, subflow)).toBe(`${inputs}\u0001${outputs}`);
  });

  it("validates a large graph once before resolving every typed wrapper", () => {
    const wrappers = Array.from({ length: 80 }, (_, index) =>
      node("subflow", `child-${index}`, { reference: reference() }));
    let rootEnumerations = 0;
    const observed = new Proxy(graph(wrappers), {
      ownKeys(target) {
        rootEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const resolve = createValidatedNodePortResolver(observed);
    const afterValidation = rootEnumerations;
    for (const wrapper of wrappers) {
      expect(resolve(wrapper).outputPorts.map((port) => port.id)).toEqual(["answer", "citations"]);
    }
    expect(afterValidation).toBeGreaterThan(0);
    expect(rootEnumerations).toBe(afterValidation);
  });

  it("resolves a large authoring canvas snapshot without repeatedly enumerating the graph", () => {
    const wrappers = Array.from({ length: 80 }, (_, index) =>
      node("subflow", `canvas-child-${index}`, { reference: reference() }));
    const target = node("output", "canvas-target");
    let rootEnumerations = 0;
    const observed = new Proxy(graph([...wrappers, target]), {
      ownKeys(target) {
        rootEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const resolve = createCanvasNodePortResolver(observed);
    for (const wrapper of wrappers) {
      expect(resolve(wrapper).outputPorts).toHaveLength(2);
      expect(verdictForCanvasConnection(observed, {
        source: wrapper.id, sourceHandle: "answer", target: target.id, targetHandle: "in",
      }, resolve).status).toBe("compatible");
    }
    expect(rootEnumerations).toBe(0);
  });

  it("uses one rendered graph and resolver snapshot for an immediate ABI connection", () => {
    const revisedInterface: FlowCallableInterface = {
      inputs: callable.inputs,
      outputs: [{ ...callable.outputs[0]!, id: "revised-answer", label: "Revised answer" }],
    };
    const source = node("subflow", "race-source", {
      reference: {
        kind: "draft",
        flowId: "race-child",
        interface: revisedInterface,
        interfaceHash: hashCallableInterface(revisedInterface),
      },
    });
    const target = node("output", "race-target");
    const rendered = graph([source, target]);
    const resolveRenderedPorts = createCanvasNodePortResolver(rendered);
    const decision = decideCanvasConnectionForRenderedGraph(
      rendered,
      resolveRenderedPorts,
      { source: source.id, sourceHandle: "revised-answer", target: target.id, targetHandle: "in" },
      "connect-now",
      "edge-now",
    );
    expect(decision.verdict.status).toBe("compatible");
    expect(decision.command).toMatchObject({
      kind: "edge.add",
      edge: { sourceHandle: "revised-answer", targetHandle: "in" },
    });
  });

  it("renders dynamic Inspector port receipts and visible stale-handle issues", () => {
    const subflow = node("subflow", "child", { reference: reference() });
    const parent = graph([subflow]);
    const markup = renderToStaticMarkup(createElement(Inspector, {
      node: subflow,
      graph: parent,
      graphVersion: 2,
      validationIssues: ['Edge "stale" references undeclared source port "child.result"'],
    }));
    expect(markup).toContain("Prompt · prompt");
    expect(markup).toContain("Answer · answer");
    expect(markup).toContain("child.result");
    expect(markup).toContain("Variable cost");
  });

  it("clips long visible callable labels in side-aware gutters without truncating accessible names", () => {
    const longInput = "A very long callable input label that must stay fully accessible";
    const longOutput = "A very long callable output label that must stay fully accessible";
    const markup = renderToStaticMarkup(createElement(
      ReactFlowProvider,
      null,
      createElement(SuedeNode, {
        data: {
          nodeType: "subflow",
          label: "Subflow",
          graphVersion: 2,
          inputPorts: [{ id: "long-input", label: longInput, schema: { type: "string" }, required: true, cardinality: "one" }],
          outputPorts: [{ id: "long-output", label: longOutput, schema: { type: "string" }, required: true, cardinality: "one" }],
        },
        selected: false,
      } as unknown as ComponentProps<typeof SuedeNode>),
    ));
    expect(markup).toContain(`aria-label="Subflow input ${longInput} (long-input), typed"`);
    expect(markup).toContain(`title="Subflow output ${longOutput} (long-output), typed"`);
    expect(markup).toContain("max-width:74px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left");
    expect(markup).toContain("max-width:86px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right");
  });
});

describe("dynamic ports in graph consumers", () => {
  it("validates typed handles in runtime preflight and connection checks", () => {
    const source = node("subflow", "source", { reference: reference() });
    const target = node("output", "target");
    const connected = graph([source, target], [{
      id: "edge",
      source: source.id,
      sourceHandle: "answer",
      target: target.id,
      targetHandle: "in",
    }]);
    const registry: NodeRegistry = {
      subflow: {
        type: "subflow", label: "Subflow", group: "Logic", costBearing: false,
        paramsSchema: { parse: (value: unknown) => value } as never,
        inputs: ["in"], outputs: ["result"],
        executor: async () => ({ ok: true, outputs: {}, costUsdc: 0 }),
      },
      output: {
        type: "output", label: "Output", group: "I/O", costBearing: false,
        paramsSchema: { parse: (value: unknown) => value } as never,
        inputs: ["in"], outputs: ["result"],
        executor: async () => ({ ok: true, outputs: {}, costUsdc: 0 }),
      },
    };

    expect(() => preflightV2Execution(connected, registry)).not.toThrow();
    expect(validateTypedConnection(graph([source, target]), {
      source: "source", sourceHandle: "answer", target: "target", targetHandle: "in",
    }).status).toBe("compatible");
    expect(validateTypedConnection(graph([source, target]), {
      source: "source", sourceHandle: "result", target: "target", targetHandle: "in",
    }).status).toBe("incompatible");
  });

  it("preserves custom runtime cardinality when canonical port ids are reused", () => {
    const first = node("input", "first");
    const second = node("input", "second");
    const target = node("output", "target");
    const connected = graph([first, second, target], [
      { id: "one", source: "first", sourceHandle: "result", target: "target", targetHandle: "in" },
      { id: "two", source: "second", sourceHandle: "result", target: "target", targetHandle: "in" },
    ]);
    const executor = async () => ({ ok: true as const, outputs: { result: null }, costUsdc: 0 });
    const registry: NodeRegistry = {
      input: {
        type: "input", label: "Input", group: "Triggers", costBearing: false,
        paramsSchema: { parse: (value: unknown) => value } as never,
        inputs: [], outputs: ["result"], executor,
      },
      output: {
        type: "output", label: "Output", group: "I/O", costBearing: false,
        paramsSchema: { parse: (value: unknown) => value } as never,
        inputs: ["in"], outputs: ["result"], inputCardinality: { in: "many" }, executor,
      },
    };
    expect(() => preflightV2Execution(connected, registry)).not.toThrow();
  });

  it("infers a sole dynamic handle in commands and refuses typed-reference downconversion", () => {
    const singleCallable: FlowCallableInterface = { inputs: [callable.inputs[0]!], outputs: [callable.outputs[0]!] };
    const typedReference = { kind: "draft", flowId: "child", interface: singleCallable, interfaceHash: hashCallableInterface(singleCallable) } as const;
    const source = node("subflow", "source", { reference: typedReference });
    const target = node("output", "target");
    const original = graph([source, target]);
    const result = applyGraphCommand(original, {
      v: 1,
      id: "add-edge",
      kind: "edge.add",
      edge: { id: "edge", source: "source", target: "target" },
    });
    expect(result.graph.edges[0]).toMatchObject({ sourceHandle: "answer", targetHandle: "in" });
    expect(downconvertFlowGraph(original)).toEqual({
      ok: false,
      nonRoundTrippableFeatures: ["typed-reference:source"],
    });
  });

  it("classifies zero-input typed subflows as launch triggers without mutating static NODE_META", () => {
    const triggerInterface: FlowCallableInterface = { inputs: [], outputs: [callable.outputs[0]!] };
    const typedReference = {
      kind: "draft", flowId: "child", interface: triggerInterface,
      interfaceHash: hashCallableInterface(triggerInterface),
    } as const;
    const source = node("subflow", "source", { reference: typedReference });
    const target = node("output", "target");
    const launchable = graph([source, target], [{
      id: "edge", source: "source", sourceHandle: "answer", target: "target", targetHandle: "in",
    }]);
    expect(validateFlowGraph(launchable)).toBeNull();
  });
});

describe("resolved child capability receipts", () => {
  it("unions inherited effects and never understates variable cost", () => {
    const child = graph([
      node("transform", "pure"),
      node("http", "write"),
      node("llm", "spend"),
    ]);
    const receipt = resolveChildCapabilityReceipt(child);
    expect(receipt.effects).toEqual(expect.arrayContaining(["read", "write", "spend"]));
    expect(receipt.cost.kind).toBe("variable");
    expect(receipt.nodeTypes).toEqual(["http", "llm", "transform"]);
  });

  it("never lets a resolved child downgrade an inherits-graph wrapper", () => {
    const wrapper = node("subflow", "wrapper", { reference: reference() });
    const pureChild = graph([node("transform", "pure")]);
    const receipt = resolveNodeCapabilityReceipt(graph([wrapper]), wrapper, pureChild);
    expect(receipt.effects).toEqual(getNodeDefinition("subflow").effects);
    expect(receipt.cost.kind).toBe("variable");
  });
});
