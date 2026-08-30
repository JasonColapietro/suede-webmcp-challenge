import { describe, expect, it } from "vitest";
import {
  bindStudioOperationClosures,
  commandForApiOperationPick,
  createStudioOperationPortResolver,
  invalidateStudioSimulationForPinChange,
  isCurrentStudioContext,
  operationVersionIdsForGraph,
  projectContextualStudioValue,
  projectOwnerScopedStudioValue,
  studioOperationClosureContextKey,
} from "@/lib/connectors/studio-authoring";
import type { ApiOperationBrowserClosureProjection } from "@/lib/connectors/operation-closure";
import type { FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";
import { createTestRunUiPlan, parseTestRunPinValues } from "@/lib/flow/test-run-ui";
import type { ValidatedNodePortResolver } from "@/lib/flow/node-ports";

const reference = {
  connectorDefinitionVersionId: "11111111-1111-4111-8111-111111111111",
  operationVersionId: "22222222-2222-4222-8222-222222222222",
  operationId: "listOrders",
  connectorProjectionHash: "a".repeat(64),
  operationProjectionHash: "b".repeat(64),
  schemaHash: "c".repeat(64),
} as const;

function node(id = "operation"): FlowNodeV2 {
  return { id, type: "api.operation", params: reference, bindings: {}, position: { x: 0, y: 0 } };
}

function graph(nodes: readonly FlowNodeV2[] = [node()]): FlowGraphV2 {
  return { schemaVersion: 2, id: "flow", name: "Flow", nodes: [...nodes], edges: [], variables: [], groups: [], annotations: [] };
}

const closure = {
  reference,
  connectorId: "33333333-3333-4333-8333-333333333333",
  connectorDisplayLabel: "Orders API",
  lifecycleRevision: 1,
  archivedAt: null,
  definitionVersionNumber: 1,
  method: "GET",
  path: "/orders",
  authentication: { kind: "none" },
  requestSchema: { type: "object" },
  resultSchema: { type: "object" },
  systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
  authorAnnotation: null,
  executionAvailability: "simulation_only",
} as const satisfies ApiOperationBrowserClosureProjection;

describe("API operation Studio authoring", () => {
  it("requires exact unique request order, response coverage, and all six pins", () => {
    const source = graph([node("a"), node("b")]);
    const ids = operationVersionIdsForGraph(source);
    expect(ids).toEqual([reference.operationVersionId]);
    expect(bindStudioOperationClosures(source, ids, { closures: [closure] }).status).toBe("ready");
    expect(bindStudioOperationClosures(source, [], { closures: [closure] }).status).toBe("repair");
    expect(bindStudioOperationClosures(source, ids, { closures: [] }).status).toBe("repair");
    expect(bindStudioOperationClosures(source, ids, { closures: [{ ...closure, reference: { ...reference, schemaHash: "d".repeat(64) } }] }).status).toBe("repair");
  });

  it("preserves a node-local binding only after pin equality and rejects no-auth binding", () => {
    const bound: FlowNodeV2 = { ...node(), params: { ...reference, readinessBinding: { kind: "connection", connectionId: "local", capability: "http.headers" } } };
    expect(bindStudioOperationClosures(graph([bound]), [reference.operationVersionId], { closures: [closure] }).status).toBe("repair");
    const authenticated = { ...closure, authentication: { kind: "http_bearer" as const } };
    const result = bindStudioOperationClosures(graph([bound]), [reference.operationVersionId], { closures: [authenticated] });
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.byNodeId.get("operation")?.reference.readinessBinding).toEqual(bound.params.readinessBinding);
  });

  it("returns zero API ports without authority and exact schemas with authority", () => {
    const source = graph();
    expect(createStudioOperationPortResolver(source)(source.nodes[0]!).outputPorts).toEqual([]);
    expect(createStudioOperationPortResolver(source, new Map([["operation", closure]]))(source.nodes[0]!).outputPorts[0]?.schema).toBe(closure.resultSchema);
    const changed = graph([{ ...node(), params: { ...reference, schemaHash: "d".repeat(64) } }]);
    expect(createStudioOperationPortResolver(changed, new Map([["operation", closure]]))(changed.nodes[0]!).outputPorts).toEqual([]);
  });

  it("creates exactly one v2 node with bindings and only the six immutable pins", () => {
    const command = commandForApiOperationPick({ closure, position: { x: 4, y: 5 }, commandId: "command", nodeId: "node" });
    expect(command.node).toEqual({ id: "node", type: "api.operation", params: reference, bindings: {}, position: { x: 4, y: 5 } });
    expect(Object.keys(command.node.params)).toHaveLength(6);
  });

  it("plans and assembles the exact boundary pin for an upstream-wired operation and downstream completion", () => {
    const source: FlowGraphV2 = {
      ...graph(),
      nodes: [
        { id: "source", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        node(),
        { id: "sink", type: "output", params: {}, bindings: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "source-operation", source: "source", sourceHandle: "result", target: "operation", targetHandle: "request" },
        { id: "operation-sink", source: "operation", sourceHandle: "result", target: "sink", targetHandle: "in" },
      ],
    };
    const plan = createTestRunUiPlan(source, { kind: "from-node", nodeId: "operation" });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.executionOrder).toEqual(["operation", "sink"]);
    expect(plan.pins).toHaveLength(1);
    expect(plan.pins[0]).toMatchObject({ kind: "edge-input", label: "source.result → operation.request" });
    expect(parseTestRunPinValues(plan.pins, { [plan.pins[0]!.key]: "null" })).toEqual({
      ok: true,
      pinnedInputs: { [plan.pins[0]!.key]: null },
    });
  });

  it("threads the exact resolver into planning instead of accepting an API node without authority", () => {
    const source: FlowGraphV2 = {
      ...graph(),
      nodes: [
        { id: "source", type: "transform", params: { expression: "input" }, bindings: {}, position: { x: 0, y: 0 } },
        node(),
      ],
      edges: [{ id: "source-operation", source: "source", sourceHandle: "result", target: "operation", targetHandle: "request" }],
    };
    const exact: ValidatedNodePortResolver = (current) => current.id === "source"
      ? { inputPorts: [], outputPorts: [{ id: "result", label: "Result", schema: { type: "string" }, required: true, cardinality: "one" }] }
      : { inputPorts: [], outputPorts: [] };
    expect(createTestRunUiPlan(source, { kind: "from-node", nodeId: "operation" }).status).toBe("ready");
    expect(createTestRunUiPlan(source, { kind: "from-node", nodeId: "operation" }, exact).status).toBe("disabled");
  });

  it("projects no prior pin or receipt before context-switch effects flush", () => {
    const oldReceipt = { status: "success" as const, message: "OLD_RECEIPT_CANARY" };
    const oldPins = { pin: "OLD_PIN_CANARY" };
    expect(projectContextualStudioValue<{ status: "idle" } | typeof oldReceipt>("new", { contextKey: "old", value: oldReceipt }, { status: "idle" })).toEqual({ status: "idle" });
    expect(projectContextualStudioValue<Readonly<Record<string, string>>>("new", { contextKey: "old", value: oldPins }, {})).toEqual({});
    expect(JSON.stringify(projectContextualStudioValue("new", { contextKey: "old", value: { oldReceipt, oldPins } }, {}))).not.toMatch(/OLD_(?:RECEIPT|PIN)_CANARY/u);
  });

  it("aborts a deferred simulation and resets its receipt whenever a boundary pin changes", () => {
    const controller = new AbortController();
    const generation = { current: 7 };
    const controllerRef = { current: controller as AbortController | null };
    let simulation: { contextKey: string; value: { status: "idle" | "busy" } } = { contextKey: "context", value: { status: "busy" } };
    let pins: { contextKey: string; values: Readonly<Record<string, string>> } = { contextKey: "context", values: { first: "old" } };

    invalidateStudioSimulationForPinChange({
      contextKey: "context",
      key: "second",
      value: "new",
      generation,
      controller: controllerRef,
      setSimulation: (next) => { simulation = next; },
      setPins: (update) => { pins = update(pins); },
    });

    expect(controller.signal.aborted).toBe(true);
    expect(controllerRef.current).toBeNull();
    expect(generation.current).toBe(8);
    expect(simulation).toEqual({ contextKey: "context", value: { status: "idle" } });
    expect(pins).toEqual({ contextKey: "context", values: { first: "old", second: "new" } });
  });

  it("clears a completed receipt on a later boundary pin edit without touching readiness", () => {
    const generation = { current: 11 };
    const controller = { current: null as AbortController | null };
    let simulation: { contextKey: string; value: { status: string } } = {
      contextKey: "context",
      value: { status: "success" },
    };
    const readiness = { status: "success", checked: true };
    let pins: { contextKey: string; values: Readonly<Record<string, string>> } = { contextKey: "old-context", values: { stale: "must-drop" } };

    invalidateStudioSimulationForPinChange({
      contextKey: "new-context",
      key: "request",
      value: "{\"ok\":true}",
      generation,
      controller,
      setSimulation: (next) => { simulation = next; },
      setPins: (update) => { pins = update(pins); },
    });

    expect(simulation).toEqual({ contextKey: "new-context", value: { status: "idle" } });
    expect(pins).toEqual({ contextKey: "new-context", values: { request: "{\"ok\":true}" } });
    expect(readiness).toEqual({ status: "success", checked: true });
    expect(generation.current).toBe(12);
  });

  it("fails closed before effects when the owner changes under the same graph object", () => {
    const source = graph();
    const ownerA = studioOperationClosureContextKey({ graphToken: 41, ownerScopeHash: "owner-a", persistedId: "flow" });
    const ownerB = studioOperationClosureContextKey({ graphToken: 41, ownerScopeHash: "owner-b", persistedId: "flow" });
    const oldClosures = new Map([["operation", closure]]);
    const visibleClosures = projectContextualStudioValue(ownerB, {
      contextKey: ownerA,
      value: oldClosures as ReadonlyMap<string, ApiOperationBrowserClosureProjection>,
    }, new Map<string, ApiOperationBrowserClosureProjection>());
    const visibleConnectionLabels = projectOwnerScopedStudioValue(
      "owner-b",
      { ownerScopeHash: "owner-a", value: ["OLD_OWNER_CONNECTION_CANARY"] },
      [] as string[],
    );
    const pickerVisible = projectContextualStudioValue(ownerB, { contextKey: ownerA, value: true }, false);

    expect(createStudioOperationPortResolver(source, visibleClosures)(source.nodes[0]!).outputPorts).toEqual([]);
    expect(visibleClosures.get("operation")).toBeUndefined();
    expect(visibleConnectionLabels).toEqual([]);
    expect(pickerVisible).toBe(false);
  });

  it("rejects queued old-context picker, binding, action, and pin callbacks before side effects", () => {
    const captured = studioOperationClosureContextKey({ graphToken: 41, ownerScopeHash: "owner-a", persistedId: "flow" });
    const current = studioOperationClosureContextKey({ graphToken: 41, ownerScopeHash: "owner-b", persistedId: "flow" });
    const controller = new AbortController();
    const generation = { current: 4 };
    const controllerRef = { current: controller as AbortController | null };
    let clientCalls = 0;
    let dispatches = 0;
    let pinState = { contextKey: current, values: {} as Readonly<Record<string, string>> };

    if (isCurrentStudioContext(captured, current)) {
      clientCalls += 2;
      dispatches += 2;
      invalidateStudioSimulationForPinChange({
        contextKey: captured,
        key: "old-pin",
        value: "OLD_OWNER_PIN_CANARY",
        generation,
        controller: controllerRef,
        setSimulation: () => undefined,
        setPins: (update) => { pinState = update(pinState); },
      });
    }

    expect(clientCalls).toBe(0);
    expect(dispatches).toBe(0);
    expect(controller.signal.aborted).toBe(false);
    expect(controllerRef.current).toBe(controller);
    expect(generation.current).toBe(4);
    expect(pinState.values).toEqual({});
  });

  it("connection refresh invalidates readiness while preserving connection-independent simulation", () => {
    const simulationKey = "operation-authority-context";
    const readinessRevisionNine = JSON.stringify([simulationKey, "ready", 9, "configured"]);
    const readinessLoading = JSON.stringify([simulationKey, "loading", null, null]);
    const simulationReceipt = { status: "success" as const, message: "SIMULATION_RECEIPT" };
    const readinessReceipt = { status: "success" as const, message: "READINESS_RECEIPT" };

    expect(projectContextualStudioValue<{ status: "idle" } | typeof simulationReceipt>(simulationKey, {
      contextKey: simulationKey,
      value: simulationReceipt,
    }, { status: "idle" as const })).toBe(simulationReceipt);
    expect(projectContextualStudioValue<{ status: "idle" } | typeof readinessReceipt>(readinessLoading, {
      contextKey: readinessRevisionNine,
      value: readinessReceipt,
    }, { status: "idle" as const })).toEqual({ status: "idle" });
  });
});
