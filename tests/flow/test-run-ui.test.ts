import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assembleTestRunRequest,
  createTestRunUiPlan,
  parseTestRunPinValues,
  parseTestRunResultEnvelope,
  pruneTestRunPinValues,
} from "@/lib/flow/test-run-ui";
import type { FlowEdgeV2, FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";
import {
  TEST_RUN_CAPTURE_LIMITS,
  captureTestLog,
  captureTestValue,
  createTestCaptureBudget,
  createTestLogBudget,
} from "@/lib/flow/test-runner-contract";

const node = (
  id: string,
  type: FlowNodeV2["type"] = "transform",
  bindings: FlowNodeV2["bindings"] = {},
): FlowNodeV2 => ({
  id,
  type,
  params: type === "transform" ? { expression: "input" } : {},
  bindings,
  position: { x: 0, y: 0 },
});

const edge = (
  id: string,
  source: string,
  target: string,
  condition?: FlowEdgeV2["condition"],
): FlowEdgeV2 => ({
  id,
  source,
  sourceHandle: "result",
  target,
  targetHandle: "in",
  ...(condition === undefined ? {} : { condition }),
});

function graph(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "ui-test-graph",
    name: "UI test graph",
    nodes: [],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    ...overrides,
  };
}

function dependencyGraph(): FlowGraphV2 {
  return graph({
    nodes: [
      node("a", "input"),
      node("b", "transform", {
        injected: { kind: "port", nodeId: "x", portId: "result", path: "nested.value" },
      }),
      node("c", "output"),
      node("d", "input"),
      node("x", "input"),
    ],
    edges: [
      edge("a-b", "a", "b"),
      edge("b-c", "b", "c", { kind: "port", nodeId: "d", portId: "result", path: "allowed" }),
    ],
  });
}

describe("scoped test run UI model", () => {
  it("creates stable human form descriptors for all three scope kinds", () => {
    const source = dependencyGraph();
    const nodePlan = createTestRunUiPlan(source, { kind: "node", nodeId: "b" });
    const toPlan = createTestRunUiPlan(source, { kind: "to-node", nodeId: "c" });
    const fromPlan = createTestRunUiPlan(source, { kind: "from-node", nodeId: "b" });

    expect(nodePlan).toMatchObject({
      status: "ready",
      scope: { kind: "node", nodeId: "b" },
      pins: [
        { kind: "edge-input", control: "json", label: "a.result → b.in" },
        { kind: "node-binding", control: "json", label: "x.result → b.injected at nested.value" },
      ],
    });
    expect(toPlan).toMatchObject({ status: "ready", scope: { kind: "to-node", nodeId: "c" }, pins: [] });
    expect(fromPlan).toMatchObject({
      status: "ready",
      scope: { kind: "from-node", nodeId: "b" },
      pins: [
        { kind: "edge-input", control: "json", label: "a.result → b.in" },
        { kind: "edge-condition", control: "boolean", label: "d.result → condition on b-c at allowed" },
        { kind: "node-binding", control: "json", label: "x.result → b.injected at nested.value" },
      ],
    });
    if (fromPlan.status !== "ready") return;
    expect(fromPlan.pins.map(({ key }) => key)).toEqual(
      [...fromPlan.pins].map(({ key }) => key).sort((left, right) => {
        const rank = (key: string): number => key.startsWith('["edge-input"') ? 0 : key.startsWith('["edge-condition"') ? 1 : 2;
        return rank(left) - rank(right) || left.localeCompare(right);
      }),
    );
    expect(new Set(fromPlan.pins.map(({ key }) => key)).size).toBe(fromPlan.pins.length);
  });

  it("parses JSON data pins and exact boolean choices without mutating form input", () => {
    const plan = createTestRunUiPlan(dependencyGraph(), { kind: "from-node", nodeId: "b" });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const values = Object.fromEntries(plan.pins.map((pin, index) => [
      pin.key,
      pin.control === "boolean" ? "false" : index === 0 ? '{"song":"demo"}' : "[1,2,3]",
    ]));
    const before = structuredClone(values);

    expect(parseTestRunPinValues(plan.pins, values)).toEqual({
      ok: true,
      pinnedInputs: Object.fromEntries(plan.pins.map((pin, index) => [
        pin.key,
        pin.control === "boolean" ? false : index === 0 ? { song: "demo" } : [1, 2, 3],
      ])),
    });
    expect(values).toEqual(before);
    expect(parseTestRunPinValues(plan.pins, { ...values, [plan.pins[1]!.key]: "0" })).toEqual({
      ok: false,
      message: "Enter valid values for every required pin.",
    });
    expect(parseTestRunPinValues(plan.pins, { ...values, extra: "true" })).toEqual({
      ok: false,
      message: "Enter valid values for every required pin.",
    });
  });

  it("prunes stale pin values to the next plan without mutating either input", () => {
    const first = createTestRunUiPlan(dependencyGraph(), { kind: "from-node", nodeId: "b" });
    const next = createTestRunUiPlan(dependencyGraph(), { kind: "node", nodeId: "b" });
    expect(first.status).toBe("ready");
    expect(next.status).toBe("ready");
    if (first.status !== "ready" || next.status !== "ready") return;
    const values = Object.fromEntries(first.pins.map((pin) => [pin.key, pin.control === "boolean" ? "true" : "null"]));
    const pinsBefore = structuredClone(next.pins);
    const valuesBefore = structuredClone(values);

    expect(pruneTestRunPinValues(next.pins, values)).toEqual(
      Object.fromEntries(next.pins.map((pin) => [pin.key, values[pin.key]])),
    );
    expect(next.pins).toEqual(pinsBefore);
    expect(values).toEqual(valuesBefore);
  });

  it("assembles the exact request and returns one generic disabled result", () => {
    const source = dependencyGraph();
    const scope = { kind: "node", nodeId: "b" } as const;
    const plan = createTestRunUiPlan(source, scope);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const values = Object.fromEntries(plan.pins.map((pin) => [pin.key, "null"]));
    const sourceBefore = structuredClone(source);

    expect(assembleTestRunRequest({ graph: source, scope, environmentId: "test-environment", pinValues: values })).toEqual({
      ok: true,
      request: {
        graph: source,
        scope,
        pinnedInputs: Object.fromEntries(plan.pins.map((pin) => [pin.key, null])),
        mode: "test",
        environmentId: "test-environment",
      },
    });
    expect(source).toEqual(sourceBefore);
    expect(assembleTestRunRequest({ graph: graph(), scope, environmentId: "test-environment", pinValues: {} })).toEqual({
      ok: false,
      message: "This scoped test cannot run safely.",
    });
    expect(assembleTestRunRequest({ graph: source, scope, environmentId: "", pinValues: values })).toEqual({
      ok: false,
      message: "This scoped test cannot run safely.",
    });
  });

  it("strictly parses a bounded detached TestRunResult envelope", () => {
    const envelope = {
      result: {
        runId: "test-run-1",
        status: "done",
        costUsdc: 0,
        latencyMs: 12,
        tokens: 0,
        outputs: { b: { kind: "value", value: { ok: true } } },
        events: [
          { kind: "test:start", sequence: 0, runId: "test-run-1" },
          { kind: "node:start", sequence: 1, runId: "test-run-1", nodeId: "b", nodeType: "transform" },
          {
            kind: "node:done", sequence: 2, runId: "test-run-1", nodeId: "b", nodeType: "transform",
            outputs: { kind: "value", value: { ok: true } }, costUsdc: 0, latencyMs: 10,
          },
          { kind: "test:done", sequence: 3, runId: "test-run-1", status: "done", costUsdc: 0, latencyMs: 12, tokens: 0 },
        ],
        logs: [{ level: "info", message: "stubbed" }],
      },
    } as const;
    const before = structuredClone(envelope);
    const parsed = parseTestRunResultEnvelope(envelope);

    expect(parsed).toEqual(envelope.result);
    expect(parsed).not.toBe(envelope.result);
    expect(parsed?.outputs).not.toBe(envelope.result.outputs);
    expect(envelope).toEqual(before);
    expect(parseTestRunResultEnvelope({ ...envelope, extra: true })).toBeNull();
    expect(parseTestRunResultEnvelope({ result: { ...envelope.result, costUsdc: 0.001 } })).toBeNull();
    expect(parseTestRunResultEnvelope({ result: { ...envelope.result, events: [...envelope.result.events, { ...envelope.result.events[0], sequence: 4 }] } })).toBeNull();
    expect(parseTestRunResultEnvelope({ result: { ...envelope.result, logs: [{ level: "info", message: "x".repeat(2_049) }] } })).toBeNull();
  });

  it("mirrors the runner single-active lifecycle and output coherence", () => {
    const start = { kind: "test:start", sequence: 0, runId: "lifecycle" } as const;
    const nodeStart = { kind: "node:start", sequence: 1, runId: "lifecycle", nodeId: "a", nodeType: "transform" } as const;
    const nodeDone = {
      kind: "node:done", sequence: 2, runId: "lifecycle", nodeId: "a", nodeType: "transform",
      outputs: { kind: "value", value: true }, costUsdc: 0,
    } as const;
    const done = { kind: "test:done", sequence: 3, runId: "lifecycle", status: "done", costUsdc: 0 } as const;
    const base = {
      runId: "lifecycle", status: "done", costUsdc: 0,
      outputs: { a: { kind: "value", value: true } }, logs: [], events: [start, nodeStart, nodeDone, done],
    } as const;
    expect(parseTestRunResultEnvelope({ result: base })).not.toBeNull();

    const invalidEvents = [
      [start, { ...start, sequence: 1 }, { ...done, sequence: 2 }],
      [start, { ...nodeDone, sequence: 1 }, { ...done, sequence: 2 }],
      [start, nodeStart, { ...nodeStart, sequence: 2, nodeId: "b" }, done],
      [start, nodeStart, { ...nodeDone, nodeId: "b" }, done],
      [start, nodeStart, done],
      [start, nodeStart, nodeDone, { ...nodeStart, sequence: 3 }, { ...nodeDone, sequence: 4 }, { ...done, sequence: 5 }],
      [start, nodeStart, nodeDone, { ...done, sequence: 3 }, { ...done, sequence: 4 }],
    ];
    for (const events of invalidEvents) {
      expect(parseTestRunResultEnvelope({ result: { ...base, events } })).toBeNull();
    }
    expect(parseTestRunResultEnvelope({ result: { ...base, outputs: {} } })).toBeNull();
    expect(parseTestRunResultEnvelope({ result: { ...base, outputs: { ...base.outputs, foreign: { kind: "omitted", reason: "limit" } } } })).toBeNull();
    expect(parseTestRunResultEnvelope({ result: { ...base, outputs: { a: { kind: "value", value: false } } } })).toBeNull();
    const errorEvent = {
      kind: "node:error", sequence: 2, runId: "lifecycle", nodeId: "a", nodeType: "transform",
      code: "execution-failed", message: "Scoped test node failed.", costUsdc: 0,
    } as const;
    expect(parseTestRunResultEnvelope({ result: { ...base, events: [start, nodeStart, errorEvent, done] } })).toBeNull();
  });

  it("accepts a maximum valid runner envelope derived from exported limits", () => {
    const captureBudget = createTestCaptureBudget();
    const logBudget = createTestLogBudget();
    const events: unknown[] = [{ kind: "test:start", sequence: 0, runId: "max-run" }];
    const outputs: Record<string, unknown> = {};
    for (let index = 0; index < 500; index += 1) {
      const nodeId = `node-${String(index).padStart(3, "0")}`;
      const captured = captureTestValue("x".repeat(TEST_RUN_CAPTURE_LIMITS.valueBytes - 2), captureBudget);
      outputs[nodeId] = captured;
      events.push({ kind: "node:start", sequence: events.length, runId: "max-run", nodeId, nodeType: "transform" });
      events.push({
        kind: "node:done", sequence: events.length, runId: "max-run", nodeId, nodeType: "transform",
        outputs: captured, costUsdc: 0,
      });
    }
    events.push({ kind: "test:done", sequence: events.length, runId: "max-run", status: "done", costUsdc: 0 });
    const logs = Array.from({ length: TEST_RUN_CAPTURE_LIMITS.logCount }, () =>
      captureTestLog("info", "x".repeat(510), logBudget)).filter((value) => value !== null);
    expect(captureBudget.usedBytes).toBe(TEST_RUN_CAPTURE_LIMITS.aggregateValueBytes);
    expect(logBudget.usedBytes).toBe(TEST_RUN_CAPTURE_LIMITS.aggregateLogBytes);
    expect(events).toHaveLength(1_002);
    expect(logs).toHaveLength(TEST_RUN_CAPTURE_LIMITS.logCount);
    expect(parseTestRunResultEnvelope({
      result: { runId: "max-run", status: "done", costUsdc: 0, outputs, events, logs },
    })).not.toBeNull();
  });

  it("enforces canonical aggregate request parity after UI pin parsing", () => {
    const selected = node("selected", "transform", Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `binding${index}`,
        { kind: "port", nodeId: `source${index}`, portId: "result" } as const,
      ]),
    ));
    const source = graph({
      nodes: [selected, ...Array.from({ length: 5 }, (_, index) => node(`source${index}`, "input"))],
    });
    const scope = { kind: "node", nodeId: "selected" } as const;
    const plan = createTestRunUiPlan(source, scope);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const values = Object.fromEntries(plan.pins.map(({ key }) => [
      key,
      JSON.stringify("x".repeat(TEST_RUN_CAPTURE_LIMITS.valueBytes - 2)),
    ]));
    expect(parseTestRunPinValues(plan.pins, values).ok).toBe(true);
    expect(assembleTestRunRequest({ graph: source, scope, environmentId: "test-environment", pinValues: values })).toEqual({
      ok: false,
      message: "This scoped test cannot run safely.",
    });

    const oversized = graph({ nodes: Array.from({ length: 501 }, (_, index) => node(`n${index}`)) });
    expect(assembleTestRunRequest({
      graph: oversized, scope: { kind: "node", nodeId: "n0" }, environmentId: "test-environment", pinValues: {},
    })).toEqual({ ok: false, message: "This scoped test cannot run safely." });

    const sourceText = readFileSync("src/lib/flow/test-run-ui.ts", "utf8");
    expect(sourceText).toContain("parseTestRunRequest");
    expect(sourceText).toContain("validateAndCompileTestRunRequest");
  });

  it("contains hostile getters, proxies, and credential canaries with generic failures", () => {
    const marker = "UI-HOSTILE-CANARY-91f3";
    const hostile = new Proxy({}, { ownKeys() { throw new Error(marker); } });
    const getter = Object.defineProperty({}, "result", {
      enumerable: true,
      get() { throw new Error(marker); },
    });
    expect(createTestRunUiPlan(hostile as FlowGraphV2, hostile as never)).toEqual({
      status: "disabled", message: "This scoped test cannot run safely.",
    });
    expect(assembleTestRunRequest({
      graph: hostile as FlowGraphV2, scope: hostile as never, environmentId: "test", pinValues: hostile as never,
    })).toEqual({ ok: false, message: "This scoped test cannot run safely." });
    expect(parseTestRunResultEnvelope(hostile)).toBeNull();
    expect(parseTestRunResultEnvelope(getter)).toBeNull();

    const plan = createTestRunUiPlan(dependencyGraph(), { kind: "node", nodeId: "b" });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const credential = ["sk", "live", "TestFixtureOnlyNotASecret1234567890"].join("_");
    const credentialPlan = createTestRunUiPlan(graph({
      nodes: [node(credential, "input"), node("target")],
      edges: [edge("credential-edge", credential, "target")],
    }), { kind: "node", nodeId: "target" });
    expect(credentialPlan).toEqual({ status: "disabled", message: "This scoped test cannot run safely." });
    expect(JSON.stringify(credentialPlan)).not.toContain(credential);
    const credentialPins = Object.fromEntries(plan.pins.map(({ key }) => [key, JSON.stringify({ token: credential })]));
    const pinFailure = parseTestRunPinValues(plan.pins, credentialPins);
    expect(pinFailure).toEqual({ ok: false, message: "Enter valid values for every required pin." });
    expect(JSON.stringify(pinFailure)).not.toContain(credential);
    expect(pruneTestRunPinValues(plan.pins, credentialPins)).toEqual({});

    const safeEnvelope = {
      result: {
        runId: "safe-run", status: "done", costUsdc: 0, outputs: {},
        events: [
          { kind: "test:start", sequence: 0, runId: "safe-run" },
          { kind: "test:done", sequence: 1, runId: "safe-run", status: "done", costUsdc: 0 },
        ],
        logs: [{ level: "error", message: `Bearer ${credential}` }],
      },
    };
    expect(parseTestRunResultEnvelope(safeEnvelope)).toBeNull();
    expect(parseTestRunPinValues({} as never, {})).toEqual({
      ok: false, message: "Enter valid values for every required pin.",
    });
    expect(pruneTestRunPinValues({} as never, {})).toEqual({});
    expect(assembleTestRunRequest({
      graph: dependencyGraph(), scope: { kind: "node", nodeId: "b" },
      environmentId: 42 as never, pinValues: {},
    })).toEqual({ ok: false, message: "This scoped test cannot run safely." });
  });

  it("rejects aggregate outputs and logs beyond the runner capture budgets", () => {
    const runId = "aggregate-run";
    const oversizedCapture = { kind: "value", value: "x".repeat(TEST_RUN_CAPTURE_LIMITS.valueBytes - 2) } as const;
    const events: unknown[] = [{ kind: "test:start", sequence: 0, runId }];
    const outputs: Record<string, unknown> = {};
    for (let index = 0; index < 5; index += 1) {
      const nodeId = `n${index}`;
      outputs[nodeId] = oversizedCapture;
      events.push({ kind: "node:start", sequence: events.length, runId, nodeId, nodeType: "transform" });
      events.push({ kind: "node:done", sequence: events.length, runId, nodeId, nodeType: "transform", outputs: oversizedCapture, costUsdc: 0 });
    }
    events.push({ kind: "test:done", sequence: events.length, runId, status: "done", costUsdc: 0 });
    expect(parseTestRunResultEnvelope({
      result: { runId, status: "done", costUsdc: 0, outputs, events, logs: [] },
    })).toBeNull();

    expect(parseTestRunResultEnvelope({
      result: {
        runId, status: "done", costUsdc: 0, outputs: {},
        events: [
          { kind: "test:start", sequence: 0, runId },
          { kind: "test:done", sequence: 1, runId, status: "done", costUsdc: 0 },
        ],
        logs: Array.from({ length: TEST_RUN_CAPTURE_LIMITS.logCount }, () => ({
          level: "info", message: "x".repeat(TEST_RUN_CAPTURE_LIMITS.logBytes - 2),
        })),
      },
    })).toBeNull();
  });

  it("binds terminal metrics and accepts paired cancellation after earlier errors", () => {
    const runId = "cancelled-run";
    const events = [
      { kind: "test:start", sequence: 0, runId },
      { kind: "node:start", sequence: 1, runId, nodeId: "a", nodeType: "transform" },
      {
        kind: "node:error", sequence: 2, runId, nodeId: "a", nodeType: "transform",
        code: "execution-failed", message: "Scoped test node failed.", costUsdc: 0,
      },
      { kind: "node:start", sequence: 3, runId, nodeId: "b", nodeType: "transform" },
      {
        kind: "node:error", sequence: 4, runId, nodeId: "b", nodeType: "transform",
        code: "cancelled", message: "Scoped test node cancelled.", costUsdc: 0,
      },
      { kind: "test:done", sequence: 5, runId, status: "cancelled", costUsdc: 0, latencyMs: 12, tokens: 3 },
    ];
    const valid = {
      result: { runId, status: "cancelled", costUsdc: 0, latencyMs: 12, tokens: 3, outputs: {}, events, logs: [] },
    };
    expect(parseTestRunResultEnvelope(valid)).not.toBeNull();
    expect(parseTestRunResultEnvelope({ result: { ...valid.result, latencyMs: 13 } })).toBeNull();
    expect(parseTestRunResultEnvelope({ result: { ...valid.result, tokens: undefined } })).toBeNull();
    const terminalWithoutMetrics = { ...events[events.length - 1] } as Record<string, unknown>;
    delete terminalWithoutMetrics.latencyMs;
    delete terminalWithoutMetrics.tokens;
    expect(parseTestRunResultEnvelope({
      result: { ...valid.result, events: [...events.slice(0, -1), terminalWithoutMetrics] },
    })).toBeNull();
    const errorTerminal = { ...events[events.length - 1], status: "error" };
    expect(parseTestRunResultEnvelope({
      result: { ...valid.result, status: "error", events: [...events.slice(0, -1), errorTerminal] },
    })).toBeNull();
  });

  it("accepts an exact depth-16 captured value inside node events", () => {
    let value: unknown = true;
    for (let depth = 0; depth < TEST_RUN_CAPTURE_LIMITS.valueDepth; depth += 1) value = [value];
    const runId = "deep-run";
    const capture = { kind: "value", value } as const;
    expect(parseTestRunResultEnvelope({
      result: {
        runId, status: "done", costUsdc: 0, outputs: { deep: capture }, logs: [],
        events: [
          { kind: "test:start", sequence: 0, runId },
          { kind: "node:start", sequence: 1, runId, nodeId: "deep", nodeType: "transform" },
          { kind: "node:done", sequence: 2, runId, nodeId: "deep", nodeType: "transform", outputs: capture, costUsdc: 0 },
          { kind: "test:done", sequence: 3, runId, status: "done", costUsdc: 0 },
        ],
      },
    })).not.toBeNull();
  });

  it("rejects malformed, mismatched, and prototype-confusing pin descriptors", () => {
    const canonical = JSON.stringify(["edge-input", "edge", "source", "result", "target", "in"]);
    const values = { [canonical]: "null" };
    const base = { key: canonical, kind: "edge-input", label: "source.result → target.in", control: "json" } as const;
    expect(parseTestRunPinValues([base], values).ok).toBe(true);
    for (const descriptor of [
      { ...base, key: "not-json" },
      { ...base, kind: "node-binding" as const },
    ]) {
      const hostileValues = Object.create(null) as Record<string, string>;
      Object.defineProperty(hostileValues, descriptor.key, { value: "null", enumerable: true });
      expect(parseTestRunPinValues([descriptor] as never, hostileValues)).toEqual({
        ok: false, message: "Enter valid values for every required pin.",
      });
      expect(pruneTestRunPinValues([descriptor] as never, hostileValues)).toEqual({});
    }

    const ownProtoValues = Object.create(null) as Record<string, string>;
    Object.defineProperty(ownProtoValues, "__proto__", { value: "null", enumerable: true });
    expect(parseTestRunPinValues([{ ...base, key: "__proto__" }] as never, ownProtoValues)).toEqual({
      ok: false, message: "Enter valid values for every required pin.",
    });
    const ownConstructorValues = Object.create(null) as Record<string, string>;
    Object.defineProperty(ownConstructorValues, "constructor", { value: "null", enumerable: true });
    expect(parseTestRunPinValues([{ ...base, key: "constructor" }] as never, ownConstructorValues)).toEqual({
      ok: false, message: "Enter valid values for every required pin.",
    });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("accepts legal prototype-looking identities inside canonical tuple keys", () => {
    const source = graph({
      nodes: [
        node("__proto__", "input"),
        node("prototype", "input"),
        node("constructor", "transform", {
          bound: { kind: "port", nodeId: "prototype", portId: "result" },
        }),
      ],
      edges: [edge("prototype-edge", "__proto__", "constructor")],
    });
    const scope = { kind: "node", nodeId: "constructor" } as const;
    const plan = createTestRunUiPlan(source, scope);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.pins).toHaveLength(2);
    const values = Object.create(null) as Record<string, string>;
    for (const pin of plan.pins) Object.defineProperty(values, pin.key, { value: "null", enumerable: true });
    expect(parseTestRunPinValues(plan.pins, values).ok).toBe(true);
    const assembled = assembleTestRunRequest({
      graph: source, scope, environmentId: "test-environment", pinValues: values,
    });
    expect(assembled.ok).toBe(true);
    if (assembled.ok) {
      expect(Object.keys(assembled.request.pinnedInputs)).toEqual(plan.pins.map(({ key }) => key));
      expect(Object.getPrototypeOf(assembled.request.pinnedInputs)).toBeNull();
    }
  });

  it("requires exact bounded nonempty identities", () => {
    const envelope = (runId: string, outputId = "a") => ({
      result: {
        runId, status: "done", costUsdc: 0,
        outputs: { [outputId]: { kind: "value", value: true } },
        events: [
          { kind: "test:start", sequence: 0, runId },
          { kind: "node:start", sequence: 1, runId, nodeId: outputId, nodeType: "transform" },
          { kind: "node:done", sequence: 2, runId, nodeId: outputId, nodeType: "transform", outputs: { kind: "value", value: true }, costUsdc: 0 },
          { kind: "test:done", sequence: 3, runId, status: "done", costUsdc: 0 },
        ],
        logs: [],
      },
    });
    for (const id of ["", " spaced ", "line\nbreak", "x".repeat(129)]) {
      expect(parseTestRunResultEnvelope(envelope(id))).toBeNull();
      expect(parseTestRunResultEnvelope(envelope("safe", id))).toBeNull();
    }
  });
});
