import { describe, expect, it, vi } from "vitest";
import { runEphemeralScopedTest } from "@/lib/flow/test-runner";
import type { FlowEdgeV2, FlowGraphV2, FlowNodeV2, JsonValue } from "@/lib/flow/types";

const node = (
  id: string,
  type: FlowNodeV2["type"] = "output",
  bindings: FlowNodeV2["bindings"] = {},
  params: Readonly<Record<string, JsonValue>> = {},
): FlowNodeV2 => ({ id, type, params, bindings, position: { x: 0, y: 0 } });

const edge = (
  id: string,
  source: string,
  target: string,
  condition?: FlowEdgeV2["condition"],
): FlowEdgeV2 => ({
  id, source, sourceHandle: "result", target, targetHandle: "in",
  ...(condition === undefined ? {} : { condition }),
});

function graph(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "runner-graph",
    name: "Runner graph",
    nodes: [],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    ...overrides,
  };
}

function request(
  source: FlowGraphV2,
  scope: { readonly kind: "node" | "to-node" | "from-node"; readonly nodeId: string },
  pinnedInputs: Readonly<Record<string, JsonValue>>,
): Record<string, unknown> {
  return {
    graph: source,
    scope,
    pinnedInputs,
    mode: "test",
    environmentId: "ephemeral-test",
  };
}

const edgePin = (edgeId: string, source: string, target: string): string =>
  JSON.stringify(["edge-input", edgeId, source, "result", target, "in"]);
const bindingPin = (target: string, key: string, source: string): string =>
  JSON.stringify(["node-binding", target, key, source, "result", null]);
const conditionPin = (edgeId: string, target: string, source: string): string =>
  JSON.stringify(["edge-condition", edgeId, target, source, "result", null]);

function scopedGraph(): FlowGraphV2 {
  return graph({
    nodes: [
      node("a", "input", {}, { fields: {} }),
      node("x", "input", {}, { fields: {} }),
      node("d", "transform", {}, { expression: "true" }),
      node("b", "output", { injected: { kind: "port", nodeId: "x", portId: "result" } }),
      node("c", "output"),
      node("excluded", "llm", {}, { prompt: "MUST-NOT-DISPATCH" }),
    ],
    edges: [
      edge("a-b", "a", "b"),
      edge("b-c", "b", "c", { kind: "port", nodeId: "d", portId: "result" }),
    ],
  });
}

describe("ephemeral scoped test runner", () => {
  it("compiles raw input internally, runs one node with exact edge/binding pins, and excludes outgoing nodes", async () => {
    const source = scopedGraph();
    const raw = request(source, { kind: "node", nodeId: "b" }, {
      [edgePin("a-b", "a", "b")]: { edge: true },
      [bindingPin("b", "injected", "x")]: { bound: true },
    });
    const before = structuredClone(raw);
    const result = await runEphemeralScopedTest(raw, { runId: "runner-one" });

    expect(result).toMatchObject({ runId: "runner-one", status: "done", costUsdc: 0 });
    expect(result.events.filter(({ kind }) => kind === "node:start").map((event) =>
      "nodeId" in event ? event.nodeId : null)).toEqual(["b"]);
    expect(Object.keys(result.outputs)).toEqual(["b"]);
    expect(JSON.stringify(result)).not.toContain("MUST-NOT-DISPATCH");
    expect(raw).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.outputs)).toBe(true);
  });

  it("runs to-node and from-node plans with exact condition boundary pins", async () => {
    const source = scopedGraph();
    const to = await runEphemeralScopedTest(
      request(source, { kind: "to-node", nodeId: "c" }, {}),
      { runId: "runner-to" },
    );
    expect(to.status).toBe("done");
    expect(to.events.filter(({ kind }) => kind === "node:start").map((event) =>
      "nodeId" in event ? event.nodeId : null)).toEqual(["a", "d", "x", "b", "c"]);

    const from = await runEphemeralScopedTest(
      request(source, { kind: "from-node", nodeId: "b" }, {
        [edgePin("a-b", "a", "b")]: { edge: true },
        [bindingPin("b", "injected", "x")]: { bound: true },
        [conditionPin("b-c", "c", "d")]: true,
      }),
      { runId: "runner-from" },
    );
    expect(from.status).toBe("done");
    expect(from.events.filter(({ kind }) => kind === "node:start").map((event) =>
      "nodeId" in event ? event.nodeId : null)).toEqual(["b", "c"]);
  });

  it("uses only non-echoing scoped stubs and never calls ambient fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const canary = "RUNNER-STUB-CANARY-92fc";
    const source = graph({ nodes: [node("model", "llm", {}, { prompt: canary })] });
    const result = await runEphemeralScopedTest(
      request(source, { kind: "node", nodeId: "model" }, {}),
      { runId: "runner-stub" },
    );
    vi.unstubAllGlobals();

    expect(result).toMatchObject({ status: "done", costUsdc: 0 });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("withholds unsafe native output before downstream execution and never echoes raw failures", async () => {
    const canary = "RAW-ERROR-CANARY-71ce";
    const unsafe = graph({
      nodes: [
        node("unsafe", "transform", {}, { expression: "{ apiKey: 'placeholder' }" }),
        node("downstream", "output", {}, { label: canary }),
      ],
      edges: [edge("unsafe-downstream", "unsafe", "downstream")],
    });
    const unsafeResult = await runEphemeralScopedTest(
      request(unsafe, { kind: "from-node", nodeId: "unsafe" }, {}),
      { runId: "runner-unsafe" },
    );
    expect(unsafeResult.status).toBe("error");
    expect(unsafeResult.events.filter(({ kind }) => kind === "node:start").map((event) =>
      "nodeId" in event ? event.nodeId : null)).toEqual(["unsafe"]);
    expect(JSON.stringify(unsafeResult)).not.toMatch(/apiKey|placeholder|RAW-ERROR-CANARY-71ce/);

    const throwing = graph({
      nodes: [node("bad", "transform", {}, { expression: canary })],
    });
    const failure = await runEphemeralScopedTest(
      request(throwing, { kind: "node", nodeId: "bad" }, {}),
      { runId: "runner-error" },
    );
    expect(failure.status).toBe("error");
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  it("refuses subflow and loop plans before live loading can occur", async () => {
    for (const candidate of [
      node("nested", "subflow", {}, { flowId: "must-not-load" }),
      node("nested", "loop", {}, { flowId: "must-not-load" }),
    ]) {
      const result = await runEphemeralScopedTest(
        request(graph({ nodes: [candidate] }), { kind: "node", nodeId: "nested" }, {}),
        { runId: "runner-nested" },
      );
      expect(result).toMatchObject({ status: "error", costUsdc: 0 });
      expect(JSON.stringify(result)).not.toContain("must-not-load");
      expect(result.events.some(({ kind }) => kind === "node:start")).toBe(false);
    }
  });

  it("returns a frozen generic error for invalid raw input", async () => {
    const raw = { marker: "INVALID-CANARY-8c11" };
    const result = await runEphemeralScopedTest(raw, { runId: "runner-invalid" });
    expect(result).toMatchObject({ status: "error", costUsdc: 0, outputs: {}, logs: [] });
    expect(JSON.stringify(result)).not.toContain(raw.marker);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("cancels before compilation/dispatch without emitting a node event", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runEphemeralScopedTest(
      request(graph({ nodes: [node("safe")] }), { kind: "node", nodeId: "safe" }, {}),
      { signal: controller.signal, runId: "runner-cancelled" },
    );
    expect(result).toMatchObject({ status: "cancelled", costUsdc: 0 });
    expect(result.events.map(({ kind }) => kind)).toEqual(["test:start", "test:done"]);
  });

  it("includes latency only from a valid optional clock", async () => {
    const ticks = [10, 22];
    const result = await runEphemeralScopedTest(
      request(graph({ nodes: [node("safe")] }), { kind: "node", nodeId: "safe" }, {}),
      { runId: "runner-clock", now: () => ticks.shift()! },
    );
    expect(result.latencyMs).toBe(12);
    expect(result.tokens).toBeUndefined();
  });

  it("cancels a paused raw run before dispatching the yielded node start", async () => {
    const controller = new AbortController();
    vi.resetModules();
    vi.doMock("@/lib/flow/engine", () => ({
      runCompiledTestFlow: async function* (
        _compiled: unknown,
      ) {
        yield { kind: "run:start", runId: "raw-run", at: 1 };
        controller.abort();
        yield { kind: "node:start", runId: "raw-run", nodeId: "safe", nodeType: "output" };
      },
    }));
    try {
      const isolated = await import("@/lib/flow/test-runner");
      const result = await isolated.runEphemeralScopedTest(
        request(graph({ nodes: [node("safe")] }), { kind: "node", nodeId: "safe" }, {}),
        { signal: controller.signal, runId: "runner-hostile-hook" },
      );
      expect(result).toMatchObject({ status: "cancelled", costUsdc: 0, outputs: {} });
      expect(result.events.map(({ kind }) => kind)).toEqual(["test:start", "test:done"]);
    } finally {
      vi.doUnmock("@/lib/flow/engine");
      vi.resetModules();
    }
  });

  it("returns promptly when abort wins against a never-resolving iterator next", async () => {
    const controller = new AbortController();
    vi.resetModules();
    vi.doMock("@/lib/flow/engine", () => ({
      runCompiledTestFlow: async function* () {
        yield { kind: "run:start", runId: "raw-run", at: 1 };
        await new Promise<never>(() => undefined);
      },
    }));
    try {
      const isolated = await import("@/lib/flow/test-runner");
      const startedAt = performance.now();
      const pending = isolated.runEphemeralScopedTest(
        request(graph({ nodes: [node("safe")] }), { kind: "node", nodeId: "safe" }, {}),
        { signal: controller.signal, runId: "runner-stuck-abort" },
      );
      setTimeout(() => controller.abort(), 10);
      const result = await pending;
      expect(result).toMatchObject({ status: "cancelled", costUsdc: 0 });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      vi.doUnmock("@/lib/flow/engine");
      vi.resetModules();
    }
  });

  it("pairs an active node start with a fixed cancelled error when abort wins", async () => {
    const controller = new AbortController();
    vi.resetModules();
    vi.doMock("@/lib/flow/engine", () => ({
      runCompiledTestFlow: async function* () {
        yield { kind: "run:start", runId: "raw-run", at: 1 };
        yield { kind: "node:start", runId: "raw-run", nodeId: "safe", nodeType: "output" };
        await new Promise<never>(() => undefined);
      },
    }));
    try {
      const isolated = await import("@/lib/flow/test-runner");
      const pending = isolated.runEphemeralScopedTest(
        request(graph({ nodes: [node("safe")] }), { kind: "node", nodeId: "safe" }, {}),
        { signal: controller.signal, runId: "runner-active-abort" },
      );
      await vi.waitFor(() => expect(controller.signal.aborted).toBe(false));
      setTimeout(() => controller.abort(), 10);
      const result = await pending;
      expect(result).toMatchObject({ status: "cancelled", costUsdc: 0, outputs: {} });
      expect(result.events.map(({ kind }) => kind)).toEqual([
        "test:start", "node:start", "node:error", "test:done",
      ]);
      expect(result.events[2]).toMatchObject({
        kind: "node:error", nodeId: "safe", nodeType: "output",
        code: "cancelled", message: "Scoped test node cancelled.", costUsdc: 0,
      });
    } finally {
      vi.doUnmock("@/lib/flow/engine");
      vi.resetModules();
    }
  });

  it("contains hostile raw cost, settlement, output, and log fields", async () => {
    const rawMarker = "RAW-HOOK-CANARY-a4f2";
    vi.resetModules();
    vi.doMock("@/lib/flow/engine", () => ({
      runCompiledTestFlow: async function* () {
        yield { kind: "run:start", runId: "raw-run", at: 1 };
        yield { kind: "node:start", runId: "raw-run", nodeId: "safe", nodeType: "output" };
        yield {
          kind: "node:log", runId: "raw-run", nodeId: "safe", level: "error",
          msg: `Bearer ${rawMarker}`,
        };
        yield {
          kind: "node:done", runId: "raw-run", nodeId: "safe", nodeType: "output",
          outputs: { result: rawMarker }, costUsdc: 9,
        };
      },
    }));
    try {
      const isolated = await import("@/lib/flow/test-runner");
      const result = await isolated.runEphemeralScopedTest(
        request(graph({ nodes: [node("safe")] }), { kind: "node", nodeId: "safe" }, {}),
        { runId: "runner-hostile-hook" },
      );
      expect(result).toMatchObject({ status: "error", costUsdc: 0, outputs: {} });
      expect(result.events.some((event) => event.kind === "node:done")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(rawMarker);
    } finally {
      vi.doUnmock("@/lib/flow/engine");
      vi.resetModules();
    }
  });

  it("fails closed on foreign identities, invalid status, and broken lifecycle", async () => {
    const marker = "RAW-PROTOCOL-CANARY-c91d";
    const lifecycleGraph = graph({
      nodes: [node("first"), node("second")],
      edges: [edge("first-second", "first", "second")],
    });
    const raw = request(lifecycleGraph, { kind: "from-node", nodeId: "first" }, {});
    const scenarios = [
      {
        name: "foreign node",
        events: [
          { kind: "run:start", runId: "raw", at: 1 },
          { kind: "node:start", runId: "raw", nodeId: marker, nodeType: "output" },
        ],
      },
      {
        name: "invalid terminal status after output",
        events: [
          { kind: "run:start", runId: "raw", at: 1 },
          { kind: "node:start", runId: "raw", nodeId: "first", nodeType: "output" },
          { kind: "node:done", runId: "raw", nodeId: "first", nodeType: "output", outputs: { result: "safe" }, costUsdc: 0 },
          { kind: "run:done", runId: "raw", totalCostUsdc: 0, status: marker },
        ],
      },
      {
        name: "duplicate start",
        events: [
          { kind: "run:start", runId: "raw", at: 1 },
          { kind: "node:start", runId: "raw", nodeId: "first", nodeType: "output" },
          { kind: "node:start", runId: "raw", nodeId: "first", nodeType: "output" },
        ],
      },
      {
        name: "out of order",
        events: [
          { kind: "run:start", runId: "raw", at: 1 },
          { kind: "node:start", runId: "raw", nodeId: "second", nodeType: "output" },
          { kind: "node:done", runId: "raw", nodeId: "second", nodeType: "output", outputs: { result: true }, costUsdc: 0 },
          { kind: "node:start", runId: "raw", nodeId: "first", nodeType: "output" },
        ],
      },
      {
        name: "mismatched completion",
        events: [
          { kind: "run:start", runId: "raw", at: 1 },
          { kind: "node:start", runId: "raw", nodeId: "first", nodeType: "output" },
          { kind: "node:done", runId: "raw", nodeId: "second", nodeType: "output", outputs: { result: true }, costUsdc: 0 },
        ],
      },
    ] as const;

    for (const scenario of scenarios) {
      vi.resetModules();
      vi.doMock("@/lib/flow/engine", () => ({
        runCompiledTestFlow: async function* () {
          for (const event of scenario.events) yield event;
        },
      }));
      try {
        const isolated = await import("@/lib/flow/test-runner");
        const result = await isolated.runEphemeralScopedTest(raw, {
          runId: `runner-${scenario.name.replaceAll(" ", "-")}`,
        });
        expect(result, scenario.name).toMatchObject({ status: "error", costUsdc: 0, outputs: {} });
        expect(JSON.stringify(result), scenario.name).not.toContain(marker);
        expect(result.events.some((event) => event.kind === "node:done"), scenario.name).toBe(false);
      } finally {
        vi.doUnmock("@/lib/flow/engine");
        vi.resetModules();
      }
    }
  });
});
