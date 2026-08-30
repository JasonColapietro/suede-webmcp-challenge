import { beforeAll, describe, expect, it } from "vitest";
import { collectRun, runCompiledTestFlow, runFlow } from "@/lib/flow/engine";
import { validateAndCompileTestRunRequest, type CompiledTestRunRequest } from "@/lib/flow/test-run-contract";
import type { FlowGraphV2, FlowNodeV2, JsonValue } from "@/lib/flow/types";

function node(
  id: string,
  type: FlowNodeV2["type"] = "transform",
  bindings: FlowNodeV2["bindings"] = {},
  params?: Readonly<Record<string, JsonValue>>,
): FlowNodeV2 {
  const defaults: Record<string, JsonValue> = type === "transform" ? { expression: "in" }
    : type === "input" ? { fields: {} }
    : type === "llm" ? { prompt: "must-not-reach-provider" }
    : {};
  return { id, type, params: params ?? defaults, bindings, position: { x: 0, y: 0 } };
}

function graph(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2, id: "scoped-engine", name: "Scoped engine", nodes: [], edges: [],
    variables: [], groups: [], annotations: [], ...overrides,
  };
}

function compile(
  value: FlowGraphV2,
  scope: CompiledTestRunRequest["scope"],
  pinnedInputs: Record<string, JsonValue>,
): CompiledTestRunRequest {
  const result = validateAndCompileTestRunRequest({
    graph: value, scope, pinnedInputs, mode: "test", environmentId: "test-environment",
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("fixture did not compile");
  return result.value;
}

const edgeKey = (edgeId: string, source: string, target: string) =>
  JSON.stringify(["edge-input", edgeId, source, "result", target, "in"]);

describe("compiled scoped test execution", () => {
  // The engine lazy-imports the scoped test runtime (and with it the full node
  // registry) on the first runCompiledTestFlow call. Under a saturated parallel
  // suite that one-time transform can exceed a single test's 5s budget, so pay
  // it here under an explicit hook budget instead of inside the first test.
  beforeAll(async () => {
    await import("@/lib/flow/test-runtime");
  }, 60_000);

  it("executes only selected canonical nodes and injects an exact edge pin", async () => {
    const source = graph({
      nodes: [node("outside", "input"), node("selected")],
      edges: [{ id: "outside-selected", source: "outside", sourceHandle: "result", target: "selected", targetHandle: "in" }],
    });
    const key = edgeKey("outside-selected", "outside", "selected");
    const summary = await collectRun(runCompiledTestFlow(
      compile(source, { kind: "node", nodeId: "selected" }, { [key]: { fixture: true } }),
      { runId: "scoped-edge" },
    ));
    expect(summary.status).toBe("done");
    expect(summary.outputs).toEqual({ selected: { result: { fixture: true } } });
    expect(summary.events.filter(({ kind }) => kind === "node:start").map((event) =>
      "nodeId" in event ? event.nodeId : null)).toEqual(["selected"]);
  });

  it("materializes boundary node bindings as final pinned values", async () => {
    const source = graph({
      nodes: [
        node("outside", "input"),
        node("selected", "transform", {
          injected: { kind: "port", nodeId: "outside", portId: "result", path: "/nested" },
        }, { expression: "true" }),
      ],
    });
    const key = JSON.stringify(["node-binding", "selected", "injected", "outside", "result", "/nested"]);
    const summary = await collectRun(runCompiledTestFlow(
      compile(source, { kind: "node", nodeId: "selected" }, { [key]: { final: true } }),
      { runId: "scoped-binding" },
    ));
    expect(summary).toMatchObject({ status: "done", outputs: { selected: { result: true } } });
  });

  it("injects boolean edge-condition pins and skips a false boundary edge", async () => {
    const source = graph({
      nodes: [node("outside", "input"), node("condition", "input"), node("target")],
      edges: [{
        id: "conditional", source: "outside", sourceHandle: "result", target: "target", targetHandle: "in",
        condition: { kind: "port", nodeId: "condition", portId: "result" },
      }],
    });
    const inputKey = edgeKey("conditional", "outside", "target");
    const conditionKey = JSON.stringify(["edge-condition", "conditional", "target", "condition", "result", null]);
    const skipped = await collectRun(runCompiledTestFlow(compile(
      source, { kind: "node", nodeId: "target" }, { [inputKey]: "value", [conditionKey]: false },
    )));
    expect(skipped.outputs).toEqual({});
    const passed = await collectRun(runCompiledTestFlow(compile(
      source, { kind: "node", nodeId: "target" }, { [inputKey]: "value", [conditionKey]: true },
    )));
    expect(passed.outputs.target?.result).toBe("value");
  });

  it("uses the closed scoped stub for paid nodes and reports exactly zero cost", async () => {
    const source = graph({ nodes: [node("model", "llm")] });
    const summary = await collectRun(runCompiledTestFlow(
      compile(source, { kind: "node", nodeId: "model" }, {}),
      { runId: "scoped-stub" },
    ));
    expect(summary).toMatchObject({ status: "done", totalCostUsdc: 0 });
    expect(summary.outputs).toEqual({ model: { result: "[Scoped test stub]" } });
  });

  it("fails before run:start on forged plan metadata or forged credential pins", async () => {
    const source = graph({
      nodes: [node("outside", "input"), node("selected")],
      edges: [{ id: "e", source: "outside", sourceHandle: "result", target: "selected", targetHandle: "in" }],
    });
    const key = edgeKey("e", "outside", "selected");
    const compiled = compile(source, { kind: "node", nodeId: "selected" }, { [key]: "safe" });
    const forgedPlan = structuredClone(compiled) as CompiledTestRunRequest;
    (forgedPlan.plan.boundaryPins as unknown as Array<unknown>).push({ kind: "edge-input", key: "forged" });
    await expect(collectRun(runCompiledTestFlow(forgedPlan))).rejects.toThrow(/scoped test execution is invalid/i);

    const forgedPin = structuredClone(compiled) as CompiledTestRunRequest;
    (forgedPin.pinnedInputs as Record<string, unknown>)[key] = { apiKey: "FORGED-CREDENTIAL" };
    await expect(collectRun(runCompiledTestFlow(forgedPin))).rejects.toThrow(/scoped test execution is invalid/i);
  });

  it("keeps the live runFlow signature and exposes no context or registry parameters", () => {
    expect(runFlow.length).toBe(3);
    expect(runCompiledTestFlow.length).toBe(1);
  });
});
