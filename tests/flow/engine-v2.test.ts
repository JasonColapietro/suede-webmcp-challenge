import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collectRun, MAX_SUBFLOW_DEPTH, runFlow, topoSort } from "@/lib/flow/engine";
import {
  listProvenanceSecretKeys,
  readProvenanceSecret,
  type NodeDef,
  type NodeRegistry,
} from "@/lib/flow/executor";
import type { FlowGraphV2, JsonValue, NodeType } from "@/lib/flow/types";
import { getRegistry } from "@/lib/flow/registry";
import { makeCtx } from "../_helpers";

function def(
  type: NodeType,
  executor: NodeDef["executor"],
  inputs = ["in"],
  outputs = ["result"],
  inputCardinality?: Readonly<Record<string, "one" | "many">>,
): NodeDef {
  return {
    type,
    label: type,
    group: "Logic",
    costBearing: false,
    paramsSchema: z.any(),
    inputs,
    outputs,
    ...(inputCardinality ? { inputCardinality } : {}),
    executor,
  };
}

function graph(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "v2-runtime",
    name: "V2 runtime",
    nodes: [
      { id: "source", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
      {
        id: "target",
        type: "output",
        params: { stable: "param" },
        bindings: { injected: { kind: "variable", variableId: "message" } },
        position: { x: 100, y: 0 },
      },
    ],
    edges: [{ id: "edge", source: "source", sourceHandle: "chosen", target: "target", targetHandle: "payload" }],
    variables: [{ id: "message", name: "Message", scope: "workflow", schema: {}, default: "hello" }],
    groups: [],
    annotations: [],
    ...overrides,
  };
}

describe("v2 flow execution", () => {
  it("selects a guarded dry-run stub before resolving secret bindings", async () => {
    const resolver = vi.fn(async () => ({ Authorization: "Bearer must-not-resolve" }));
    const realExecutor = vi.fn(async () => ({
      ok: true as const,
      outputs: { result: "real" },
      costUsdc: 1,
    }));
    const dryRunStub = vi.fn(async (_ctx, params, _inputs, provenance) => ({
      ok: true as const,
      outputs: {
        result: {
          params,
          secretKeys: listProvenanceSecretKeys(provenance),
        },
      },
      costUsdc: 0,
    }));
    const dryGraph = graph({
      nodes: [{
        id: "request",
        type: "http",
        params: { url: "https://example.test", method: "POST" },
        bindings: {
          headers: { kind: "secret", connectionId: "connection", field: "headers" },
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [],
    });
    const http = {
      ...def("http", realExecutor, [], ["result"]),
      sideEffecting: true,
      dryRunStub,
    };

    const summary = await collectRun(runFlow(
      dryGraph,
      makeCtx({ dryRun: true, resolveSecretReference: resolver }),
      { http },
    ));

    expect(summary.status).toBe("done");
    expect(resolver).not.toHaveBeenCalled();
    expect(realExecutor).not.toHaveBeenCalled();
    expect(dryRunStub).toHaveBeenCalledTimes(1);
    expect(dryRunStub.mock.calls[0]?.[1]).toEqual({
      url: "https://example.test",
      method: "POST",
    });
    expect(dryRunStub.mock.calls[0]?.[3]).toBeDefined();
    expect(listProvenanceSecretKeys(dryRunStub.mock.calls[0]?.[3])).toEqual([]);
  });

  it("keeps resolved HTTP headers out of params and passes them only as trusted provenance", async () => {
    const headers = Object.freeze({ Authorization: "Bearer exact-secret" });
    const resolver = vi.fn(async () => headers);
    const inspect = vi.fn(async (_ctx, params, _inputs, provenance) => ({
      ok: true as const,
      outputs: {
        result: {
          params,
          secretKeys: listProvenanceSecretKeys(provenance),
          headers: readProvenanceSecret(provenance, "headers"),
        },
      },
      costUsdc: 0,
    }));
    const liveGraph = graph({
      nodes: [{
        id: "request",
        type: "http",
        params: { method: "GET" },
        bindings: {
          url: { kind: "variable", variableId: "url" },
          headers: { kind: "secret", connectionId: "connection", field: "headers" },
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [{
        id: "url",
        name: "URL",
        scope: "workflow",
        schema: {},
        default: "https://example.test",
      }],
    });

    const summary = await collectRun(runFlow(
      liveGraph,
      makeCtx({ dryRun: false, resolveSecretReference: resolver }),
      { http: def("http", inspect, [], ["result"]) },
    ));

    expect(summary.status).toBe("done");
    expect(resolver).toHaveBeenCalledWith({ connectionId: "connection", field: "headers" });
    expect(inspect.mock.calls[0]?.[1]).toEqual({ method: "GET", url: "https://example.test" });
    expect(Object.hasOwn(inspect.mock.calls[0]?.[1] as object, "headers")).toBe(false);
    expect(inspect.mock.calls[0]?.[3]).toBeDefined();
    expect(listProvenanceSecretKeys(inspect.mock.calls[0]?.[3])).toEqual(["headers"]);
    expect(readProvenanceSecret(inspect.mock.calls[0]?.[3], "headers")).toEqual(headers);
  });

  it("passes a declared business-action connection only through trusted provenance", async () => {
    const credential = Object.freeze({
      "X-Suede-Webhook-Url": "https://hooks.example.test/incoming",
    });
    const resolver = vi.fn(async () => credential);
    const inspect = vi.fn(async (_ctx, params, _inputs, provenance) => ({
      ok: true as const,
      outputs: {
        result: {
          params,
          secretKeys: listProvenanceSecretKeys(provenance),
          connection: readProvenanceSecret(provenance, "connection"),
        },
      },
      costUsdc: 0,
    }));
    const canonical = getRegistry()["comms.slackMessage"]!;
    const action = { ...canonical, sideEffecting: false, executor: inspect };
    const actionGraph = graph({
      nodes: [{
        id: "notify",
        type: "comms.slackMessage",
        params: { text: "hello" },
        bindings: {
          connection: { kind: "secret", connectionId: "slack-connection", field: "webhook" },
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [],
    });

    const summary = await collectRun(runFlow(
      actionGraph,
      makeCtx({ dryRun: false, resolveSecretReference: resolver }),
      { "comms.slackMessage": action },
    ));

    expect(summary.status).toBe("done");
    expect(resolver).toHaveBeenCalledWith({ connectionId: "slack-connection", field: "webhook" });
    expect(inspect.mock.calls[0]?.[1]).toEqual({ text: "hello" });
    expect(listProvenanceSecretKeys(inspect.mock.calls[0]?.[3])).toEqual(["connection"]);
    expect(readProvenanceSecret(inspect.mock.calls[0]?.[3], "connection")).toEqual(credential);
  });

  it("rejects unsupported secret bindings before calling the resolver", async () => {
    const resolver = vi.fn(async () => ({ Authorization: "Bearer must-not-resolve" }));
    const execute = vi.fn(async () => ({ ok: true as const, outputs: { result: true }, costUsdc: 0 }));
    const registry: NodeRegistry = {
      input: def("input", execute, [], ["chosen"]),
      output: def("output", execute, ["payload"]),
      http: def("http", execute, [], ["result"]),
    };
    const unsupported = [
      graph({
        nodes: [{
          id: "target",
          type: "output",
          params: {},
          bindings: { headers: { kind: "secret", connectionId: "connection", field: "headers" } },
          position: { x: 0, y: 0 },
        }],
        edges: [],
        variables: [],
      }),
      graph({
        nodes: [{
          id: "request",
          type: "http",
          params: {},
          bindings: { auth: { kind: "secret", connectionId: "connection", field: "headers" } },
          position: { x: 0, y: 0 },
        }],
        edges: [],
        variables: [],
      }),
      graph({
        nodes: [{
          id: "request",
          type: "http",
          params: {},
          bindings: { headers: { kind: "secret", connectionId: "connection", field: "token" } },
          position: { x: 0, y: 0 },
        }],
        edges: [],
        variables: [],
      }),
      graph({
        edges: [{
          ...graph().edges[0]!,
          condition: { kind: "secret", connectionId: "connection", field: "headers" },
        }],
      }),
    ];

    for (const candidate of unsupported) {
      await expect(collectRun(runFlow(
        candidate,
        makeCtx({ dryRun: false, resolveSecretReference: resolver }),
        registry,
      ))).rejects.toThrow(/secret binding/i);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("topologically sorts v2 graphs and routes exact source and target handles", async () => {
    const target = vi.fn(async (_ctx, params, inputs) => ({ ok: true as const, outputs: { result: { params, inputs } }, costUsdc: 0 }));
    const registry: NodeRegistry = {
      input: def("input", async () => ({ ok: true, outputs: { chosen: 0, result: "wrong" }, costUsdc: 0 }), [], ["chosen", "result"]),
      output: def("output", target, ["payload"]),
    };
    const v2 = graph();
    expect(topoSort(v2)).toEqual(["source", "target"]);
    const summary = await collectRun(runFlow(v2, makeCtx(), registry));
    expect(summary.status).toBe("done");
    expect(target).toHaveBeenCalledTimes(1);
    expect(target.mock.calls[0]?.[1]).toEqual({ stable: "param", injected: "hello" });
    expect(target.mock.calls[0]?.[2]).toEqual({ payload: 0 });
    expect(v2.nodes[1]?.params).toEqual({ stable: "param" });
  });

  it("does not fall back when the declared v2 source handle is absent", async () => {
    const target = vi.fn();
    const registry: NodeRegistry = {
      input: def("input", async () => ({ ok: true, outputs: { result: "wrong" }, costUsdc: 0 }), [], ["chosen", "result"]),
      output: def("output", target, ["payload"]),
    };
    const summary = await collectRun(runFlow(graph(), makeCtx(), registry));
    expect(summary.status).toBe("done");
    expect(target).not.toHaveBeenCalled();
    expect(summary.outputs).toEqual({ source: { result: "wrong" } });
  });

  it("fails closed when a v2 edge names a noncanonical target handle", async () => {
    const target = vi.fn();
    const invalid = graph({
      edges: [{ ...graph().edges[0]!, targetHandle: "__proto__" }],
    });
    await expect(collectRun(runFlow(invalid, makeCtx(), {
      input: def("input", async () => ({ ok: true, outputs: { chosen: true }, costUsdc: 0 }), [], ["chosen"]),
      output: def("output", target, ["payload"]),
    }))).rejects.toThrow(/target port/i);
    expect(target).not.toHaveBeenCalled();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("applies boolean conditions and skips false edges", async () => {
    const target = vi.fn(async () => ({ ok: true as const, outputs: { result: true }, costUsdc: 0 }));
    const registry: NodeRegistry = {
      input: def("input", async () => ({ ok: true, outputs: { chosen: "yes" }, costUsdc: 0 }), [], ["chosen"]),
      output: def("output", target, ["payload"]),
    };
    const falseGraph = graph({ edges: [{ ...graph().edges[0]!, condition: { kind: "literal", value: false } }] });
    await collectRun(runFlow(falseGraph, makeCtx(), registry));
    expect(target).not.toHaveBeenCalled();
    const trueGraph = graph({ edges: [{ ...graph().edges[0]!, condition: { kind: "literal", value: true } }] });
    await collectRun(runFlow(trueGraph, makeCtx(), registry));
    expect(target).toHaveBeenCalledTimes(1);
  });

  it("fails before executor dispatch and at zero cost on bad conditions or bindings", async () => {
    const target = vi.fn(async () => ({ ok: true as const, outputs: { result: true }, costUsdc: 9 }));
    const registry: NodeRegistry = {
      input: def("input", async () => ({ ok: true, outputs: { chosen: "yes" }, costUsdc: 0 }), [], ["chosen"]),
      output: { ...def("output", target, ["payload"]), costBearing: true, priceUsdc: 9, dryRunStub: target },
    };
    const badCondition = graph({ edges: [{ ...graph().edges[0]!, condition: { kind: "literal", value: "yes" } }] });
    const conditionSummary = await collectRun(runFlow(badCondition, makeCtx(), registry));
    expect(conditionSummary.status).toBe("error");
    expect(conditionSummary.totalCostUsdc).toBe(0);
    expect(target).not.toHaveBeenCalled();

    const badBinding = graph({
      nodes: graph().nodes.map((node) => node.id === "target"
        ? { ...node, bindings: { injected: { kind: "variable" as const, variableId: "missing" } } }
        : node),
    });
    await expect(collectRun(runFlow(badBinding, makeCtx(), registry))).rejects.toThrow(/missing variable/i);
    expect(target).not.toHaveBeenCalled();
  });

  it("keeps secret values out of emitted errors when a resolver fails", async () => {
    const target = vi.fn();
    const secret = "engine-secret-never-log-9c2";
    const secretGraph = graph({
      nodes: graph().nodes.map((node) => node.id === "target"
        ? {
          ...node,
          type: "http" as const,
          bindings: { headers: { kind: "secret" as const, connectionId: "conn", field: "headers" } },
        }
        : node),
    });
    const summary = await collectRun(runFlow(secretGraph, makeCtx({
      resolveSecretReference: async () => { throw new Error(secret); },
    }), {
      input: def("input", async () => ({ ok: true, outputs: { chosen: true }, costUsdc: 0 }), [], ["chosen"]),
      http: def("http", target, ["payload"]),
    }));
    expect(summary.status).toBe("error");
    expect(JSON.stringify(summary.events)).not.toContain(secret);
    expect(target).not.toHaveBeenCalled();
  });

  it("deep-clones params, binding values, routed outputs, overrides, and secrets before dispatch", async () => {
    const sourceValue = { nested: { value: "source" } };
    const runOverride = { nested: { value: "override" } };
    const secretValue = { Authorization: "Bearer secret" };
    const mutationGraph = graph({
      nodes: [
        graph().nodes[0]!,
        {
          ...graph().nodes[1]!,
          type: "http",
          params: { nestedParam: { value: "param" } },
          bindings: {
            literal: { kind: "literal", value: { nested: { value: "literal" } } },
            port: { kind: "port", nodeId: "source", portId: "chosen" },
            workflow: { kind: "variable", variableId: "workflow" },
            override: { kind: "variable", variableId: "override" },
            headers: { kind: "secret", connectionId: "conn", field: "headers" },
          },
        },
      ],
      variables: [
        { id: "workflow", name: "Workflow", scope: "workflow", schema: {}, default: { nested: { value: "default" } } },
        { id: "override", name: "Override", scope: "run", schema: {} },
      ],
    });
    const target = vi.fn(async (_ctx, rawParams, rawInputs, provenance) => {
      const params = rawParams as Record<string, any>;
      const inputs = rawInputs as Record<string, any>;
      params.nestedParam.value = "mutated";
      params.literal.nested.value = "mutated";
      params.port.nested.value = "mutated";
      params.workflow.nested.value = "mutated";
      params.override.nested.value = "mutated";
      expect(Object.hasOwn(params, "headers")).toBe(false);
      const resolvedSecret = readProvenanceSecret(provenance, "headers");
      expect(resolvedSecret).toEqual(secretValue);
      expect(resolvedSecret).not.toBe(secretValue);
      expect(Object.isFrozen(resolvedSecret)).toBe(true);
      inputs.payload.nested.value = "mutated";
      return { ok: true as const, outputs: { result: true }, costUsdc: 0 };
    });
    const summary = await collectRun(runFlow(mutationGraph, makeCtx({
      runVariables: { override: runOverride },
      resolveSecretReference: async () => secretValue,
    }), {
      input: def("input", async () => ({ ok: true, outputs: { chosen: sourceValue }, costUsdc: 0 }), [], ["chosen"]),
      http: def("http", target, ["payload"]),
    }));
    expect(summary.status).toBe("done");
    expect(mutationGraph.nodes[1]?.params).toEqual({ nestedParam: { value: "param" } });
    expect((mutationGraph.nodes[1]?.bindings.literal as { value: unknown }).value).toEqual({ nested: { value: "literal" } });
    expect(mutationGraph.variables[0]?.default).toEqual({ nested: { value: "default" } });
    expect(sourceValue).toEqual({ nested: { value: "source" } });
    expect(runOverride).toEqual({ nested: { value: "override" } });
    expect(secretValue).toEqual({ Authorization: "Bearer secret" });
  });

  it("keeps own __proto__ params and bindings while isolating nested trigger input", async () => {
    const ownProtoParams = Object.create(null) as Record<string, JsonValue>;
    Object.defineProperty(ownProtoParams, "__proto__", {
      value: { source: "param" },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const ownProtoBindings = Object.create(null) as FlowGraphV2["nodes"][number]["bindings"];
    Object.defineProperty(ownProtoBindings, "__proto__", {
      value: { kind: "literal", value: { source: "binding" } },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const hostileGraph = graph({
      nodes: [
        { id: "param", type: "input", params: ownProtoParams, bindings: {}, position: { x: 0, y: 0 } },
        { id: "binding", type: "output", params: {}, bindings: ownProtoBindings, position: { x: 100, y: 0 } },
      ],
      edges: [],
      variables: [],
    });
    const triggerInput = { nested: { value: "caller" } };
    const inspect = vi.fn(async (_ctx, params, inputs) => {
      expect(Object.getPrototypeOf(params)).toBeNull();
      expect(Object.hasOwn(params as object, "__proto__")).toBe(true);
      (inputs.nested as { value: string }).value = "executor";
      return { ok: true as const, outputs: { result: true }, costUsdc: 0 };
    });
    const summary = await collectRun(runFlow(hostileGraph, makeCtx(), {
      input: def("input", inspect, [], ["result"]),
      output: def("output", inspect, [], ["result"]),
    }, triggerInput));
    expect(summary.status).toBe("done");
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect.mock.calls[0]?.[1].__proto__).toEqual({ source: "param" });
    expect(inspect.mock.calls[1]?.[1].__proto__).toEqual({ source: "binding" });
    expect(triggerInput).toEqual({ nested: { value: "caller" } });
    expect(({} as { source?: string }).source).toBeUndefined();
  });

  it("preflights the complete v2 graph before dispatching any node", async () => {
    const effectfulSource = vi.fn(async () => ({ ok: true as const, outputs: { chosen: true }, costUsdc: 4 }));
    const target = vi.fn(async () => ({ ok: true as const, outputs: { result: true }, costUsdc: 0 }));
    const registry: NodeRegistry = {
      input: { ...def("input", effectfulSource, [], ["chosen"]), costBearing: true, priceUsdc: 4, dryRunStub: effectfulSource },
      output: def("output", target, ["payload"]),
    };
    const malformed = [
      graph({ edges: [{ ...graph().edges[0]!, target: "dangling" }] }),
      graph({ nodes: graph().nodes.map((node) => node.id === "target" ? {
        ...node,
        bindings: { bad: { kind: "port" as const, nodeId: "source", portId: "undeclared" } },
      } : node) }),
      graph({ edges: [{
        ...graph().edges[0]!,
        condition: { kind: "port" as const, nodeId: "source", portId: "undeclared" },
      }] }),
    ];
    for (const candidate of malformed) {
      await expect(collectRun(runFlow(candidate, makeCtx(), registry))).rejects.toThrow(/edge|port|binding/i);
    }
    expect(effectfulSource).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
  });

  it("rejects malformed v2 and unknown numeric versions from direct callers", async () => {
    const executor = vi.fn(async () => ({ ok: true as const, outputs: { result: true }, costUsdc: 0 }));
    const registry: NodeRegistry = { input: def("input", executor, [], ["result"]) };
    const malformedV2 = {
      schemaVersion: 2,
      id: "malformed",
      name: "Malformed",
      nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
      edges: [],
      variables: [],
      groups: [],
      annotations: [],
    };
    const future = { ...malformedV2, schemaVersion: 999 };
    await expect(collectRun(runFlow(malformedV2 as never, makeCtx(), registry))).rejects.toThrow(/schemaVersion 2|invalid/i);
    await expect(collectRun(runFlow(future as never, makeCtx(), registry))).rejects.toThrow(/schemaVersion 999|unsupported/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it("collects all declared many-cardinality inputs in edge order", async () => {
    const target = vi.fn(async (_ctx, _params, inputs) => ({ ok: true as const, outputs: { result: inputs }, costUsdc: 0 }));
    const manyGraph = graph({
      nodes: [
        { ...graph().nodes[0]!, id: "a" },
        { ...graph().nodes[0]!, id: "b" },
        graph().nodes[1]!,
      ],
      edges: [
        { id: "a-target", source: "a", sourceHandle: "chosen", target: "target", targetHandle: "payload" },
        { id: "b-target", source: "b", sourceHandle: "chosen", target: "target", targetHandle: "payload" },
      ],
    });
    let call = 0;
    const summary = await collectRun(runFlow(manyGraph, makeCtx(), {
      input: def("input", async () => ({ ok: true, outputs: { chosen: ++call }, costUsdc: 0 }), [], ["chosen"]),
      output: def("output", target, ["payload"], ["result"], { payload: "many" }),
    }));
    expect(summary.status).toBe("done");
    expect(target.mock.calls[0]?.[2]).toEqual({ payload: [1, 2] });
  });

  it("executes nested v2 subflows and loops with one shared cost ledger and bounded depth", async () => {
    const paidLeaf: FlowGraphV2 = {
      ...graph(),
      id: "paid-leaf",
      nodes: [{ id: "paid", type: "llm", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
      edges: [],
      variables: [],
    };
    const paidExecutor = vi.fn(async () => ({ ok: true as const, outputs: { result: "done" }, costUsdc: 2 }));
    const paid = def("llm", paidExecutor, [], ["result"]);
    paid.costBearing = true;
    paid.priceUsdc = 2;
    const registry: NodeRegistry = { ...getRegistry(), llm: paid };

    const subflowOuter: FlowGraphV2 = {
      ...graph(),
      id: "subflow-outer",
      nodes: [{ id: "nested", type: "subflow", params: { flowId: paidLeaf.id }, bindings: {}, position: { x: 0, y: 0 } }],
      edges: [],
      variables: [],
    };
    const subflowCtx = makeCtx({
      dryRun: false,
      registry,
      loadSubflow: async () => paidLeaf,
      costCeiling: { limitUsdc: 10, spentUsdc: 0 },
    });
    const subflowSummary = await collectRun(runFlow(subflowOuter, subflowCtx, registry));
    expect(subflowSummary).toMatchObject({ status: "done", totalCostUsdc: 2 });
    expect(subflowCtx.costCeiling.spentUsdc).toBe(2);

    const loopOuter: FlowGraphV2 = {
      ...graph(),
      id: "loop-outer",
      nodes: [
        { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        {
          id: "loop",
          type: "loop",
          params: { flowId: paidLeaf.id, itemsPath: "items", concurrency: 1 },
          bindings: {},
          position: { x: 100, y: 0 },
        },
      ],
      edges: [{ id: "items", source: "input", sourceHandle: "result", target: "loop", targetHandle: "in" }],
      variables: [],
    };
    const loopCtx = makeCtx({
      dryRun: false,
      registry,
      loadSubflow: async () => paidLeaf,
      costCeiling: { limitUsdc: 10, spentUsdc: 0 },
    });
    const loopSummary = await collectRun(runFlow(loopOuter, loopCtx, registry, { items: [1, 2] }));
    expect(loopSummary).toMatchObject({ status: "done", totalCostUsdc: 4 });
    expect(loopCtx.costCeiling.spentUsdc).toBe(4);

    const middle: FlowGraphV2 = {
      ...subflowOuter,
      id: "middle",
      nodes: [{ ...subflowOuter.nodes[0]!, params: { flowId: paidLeaf.id } }],
    };
    const depthCtx = makeCtx({
      dryRun: false,
      depth: MAX_SUBFLOW_DEPTH - 1,
      registry,
      loadSubflow: async (flowId) => flowId === middle.id ? middle : paidLeaf,
      costCeiling: { limitUsdc: 10, spentUsdc: 0 },
    });
    const tooDeep = { ...subflowOuter, nodes: [{ ...subflowOuter.nodes[0]!, params: { flowId: middle.id } }] };
    const depthSummary = await collectRun(runFlow(tooDeep, depthCtx, registry));
    expect(depthSummary.status).toBe("error");
    expect(depthCtx.costCeiling.spentUsdc).toBe(0);
    expect(paidExecutor).toHaveBeenCalledTimes(3);
  });
});
