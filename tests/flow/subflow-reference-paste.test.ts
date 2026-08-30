import { describe, expect, it } from "vitest";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import { parseGraphCommand } from "@/lib/flow/graph-command-schema";
import type { GraphCommand } from "@/lib/flow/graph-command-types";
import { serializeGraphFragment } from "@/lib/flow/graph-fragment";
import {
  PendingSubflowPasteController,
  type PendingSubflowPastePlan,
} from "@/lib/flow/subflow-reference-paste";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  FlowNodeV2,
  JsonValue,
  SubflowReference,
} from "@/lib/flow/types";

const callable: FlowCallableInterface = {
  inputs: [{
    id: "in", label: "Input", schema: {}, required: false, cardinality: "one",
    target: { kind: "trigger", path: "" },
  }],
  outputs: [{
    id: "result", label: "Result", schema: {}, required: false, cardinality: "one",
    source: { nodeId: "child-output", portId: "result" },
  }],
};

function reference(flowId = "child"): SubflowReference {
  return {
    kind: "draft",
    flowId,
    interface: callable,
    interfaceHash: hashCallableInterface(callable),
  };
}

function wrapper(id: string, value = reference()): FlowNodeV2 {
  return {
    id,
    type: "subflow",
    params: { reference: value as unknown as JsonValue },
    bindings: {
      credential: { kind: "secret", connectionId: "private-connection", field: "token" },
    },
    position: { x: 10, y: 20 },
  };
}

function graph(nodes: readonly FlowNodeV2[], edges: FlowGraphV2["edges"] = []): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "graph",
    name: "Graph",
    nodes,
    edges,
    variables: [],
    groups: [],
    annotations: [],
  };
}

function fragmentFor(nodes: readonly FlowNodeV2[], edges: FlowGraphV2["edges"] = []) {
  const source = graph(nodes, edges);
  return serializeGraphFragment(source, {
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
    primaryNodeId: nodes[0]?.id ?? null,
  });
}

function exactResolution(plan: PendingSubflowPastePlan) {
  return plan.requests().map((request) => ({
    nodeId: request.nodeId,
    requestedFingerprint: request.fingerprint,
    projection: {
      reference: request.reference,
      interface: request.reference.interface,
      interfaceHash: request.reference.interfaceHash,
      ...(request.reference.kind === "pinned" ? { contentHash: request.reference.contentHash } : {}),
      issues: [] as const,
    },
  }));
}

function commitPlan(
  controller: PendingSubflowPasteController,
  plan: PendingSubflowPastePlan,
  resolutions: ReturnType<typeof exactResolution>,
  target: FlowGraphV2,
  parentFlowId = "parent",
): Extract<GraphCommand, { kind: "graph.batch" }> {
  let committed: Extract<GraphCommand, { kind: "graph.batch" }> | null = null;
  const returned = controller.commit(plan, resolutions, {
    parentFlowId,
    currentTargetGraph: target,
    apply: (command) => { committed = command; },
  });
  expect(returned).toBeUndefined();
  if (committed === null) throw new Error("Expected synchronous commit callback");
  return committed;
}

describe("opaque pending subflow paste plan", () => {
  it("exposes only bounded future-ID resolution requests and never serializes nodes or secrets", () => {
    const controller = new PendingSubflowPasteController();
    const plan = controller.begin({
      parentFlowId: "parent",
      fragment: fragmentFor([wrapper("source")]),
      commandId: "paste_1",
      targetOrigin: { x: 300, y: 400 },
      targetGraph: graph([]),
    });

    expect(plan.requests()).toMatchObject([{
      nodeId: "node_paste_1_0",
      reference: { flowId: "child" },
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(plan.requests().length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(plan)).toBeUndefined();
    expect(Object.hasOwn(plan, "nodes")).toBe(false);
    expect(Object.hasOwn(plan, "fragment")).toBe(false);
    expect(JSON.stringify(plan.requests())).not.toContain("private-connection");
  });

  it("materializes every exact projection into one validated batch with remapped nodes and edges", () => {
    const first = wrapper("a", reference("child-a"));
    const second = { ...wrapper("b", reference("child-b")), position: { x: 110, y: 20 } };
    const edge = {
      id: "edge",
      source: "a",
      sourceHandle: "result",
      target: "b",
      targetHandle: "in",
    };
    const target = graph([]);
    const controller = new PendingSubflowPasteController();
    const plan = controller.begin({
      parentFlowId: "parent",
      fragment: fragmentFor([first, second], [edge]),
      commandId: "paste_exact",
      targetOrigin: { x: 500, y: 600 },
      targetGraph: target,
    });
    const command = commitPlan(controller, plan, exactResolution(plan), target);

    expect(parseGraphCommand(command)).toEqual(command);
    expect(command.kind).toBe("graph.batch");
    expect(command.commands.filter((child) => child.kind === "node.add")).toHaveLength(2);
    expect(command.commands.filter((child) => child.kind === "edge.add")).toHaveLength(1);
    const result = applyGraphCommand(target, command).graph as FlowGraphV2;
    expect(result.nodes.map((node) => node.id)).toEqual(["node_paste_exact_0", "node_paste_exact_1"]);
    expect(result.nodes.map((node) => node.position)).toEqual([{ x: 500, y: 600 }, { x: 600, y: 600 }]);
    expect(result.nodes.every((node) => Object.hasOwn(node.params, "reference"))).toBe(true);
    expect(result.nodes.every((node) => Object.keys(node.bindings).length === 0)).toBe(true);
    expect(result.edges).toMatchObject([{
      id: "edge_paste_exact_0",
      source: "node_paste_exact_0",
      target: "node_paste_exact_1",
    }]);
    expect(controller.isActive(plan)).toBe(false);
  });

  it("fails all-or-nothing for missing, drifted, duplicate, or fingerprint-mismatched projections", () => {
    const target = graph([]);
    const makePlan = () => {
      const controller = new PendingSubflowPasteController();
      const plan = controller.begin({
        parentFlowId: "parent",
        fragment: fragmentFor([wrapper("a"), wrapper("b")]),
        commandId: `paste_${Math.random().toString(36).slice(2)}`,
        targetOrigin: { x: 0, y: 0 },
        targetGraph: target,
      });
      return { controller, plan, exact: exactResolution(plan) };
    };

    const missing = makePlan();
    expect(() => missing.controller.commit(missing.plan, missing.exact.slice(0, 1), {
      parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined,
    })).toThrow(/every|missing/i);
    expect(missing.controller.isActive(missing.plan)).toBe(true);
    expect(() => applyGraphCommand(target, commitPlan(missing.controller, missing.plan, missing.exact, target))).not.toThrow();
    expect(missing.controller.isActive(missing.plan)).toBe(false);

    const drifted = makePlan();
    expect(() => drifted.controller.commit(drifted.plan, [
      { ...drifted.exact[0]!, projection: { ...drifted.exact[0]!.projection, issues: ["interface-drift"] as const } },
      drifted.exact[1]!,
    ], { parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined })).toThrow(/drift/i);

    const duplicate = makePlan();
    expect(() => duplicate.controller.commit(duplicate.plan, [duplicate.exact[0]!, duplicate.exact[0]!], {
      parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined,
    }))
      .toThrow(/duplicate|every/i);

    const mismatched = makePlan();
    expect(() => mismatched.controller.commit(mismatched.plan, [
      { ...mismatched.exact[0]!, requestedFingerprint: "0".repeat(64) },
      mismatched.exact[1]!,
    ], { parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined })).toThrow(/fingerprint/i);

    const oversized = makePlan();
    expect(() => oversized.controller.commit(
      oversized.plan,
      Array.from({ length: 101 }, () => oversized.exact[0]!),
      { parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined },
    )).toThrow(/100|resolution|limit/i);
  });

  it("fails closed when cancelled, superseded, consumed, or materialized against a changed graph", () => {
    const target = graph([]);
    const controller = new PendingSubflowPasteController();
    const old = controller.begin({
      parentFlowId: "parent",
      fragment: fragmentFor([wrapper("old")]), commandId: "paste_old",
      targetOrigin: { x: 0, y: 0 }, targetGraph: target,
    });
    const current = controller.begin({
      parentFlowId: "parent",
      fragment: fragmentFor([wrapper("current")]), commandId: "paste_current",
      targetOrigin: { x: 0, y: 0 }, targetGraph: target,
    });
    expect(() => controller.commit(old, exactResolution(old), {
      parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined,
    })).toThrow(/superseded|active/i);

    const changed = { ...target, name: "Changed while resolving" };
    let staleApplyCalls = 0;
    expect(() => controller.commit(current, exactResolution(current), {
      parentFlowId: "parent", currentTargetGraph: changed, apply: () => { staleApplyCalls += 1; },
    })).toThrow(/target|changed|stale/i);
    expect(() => controller.commit(current, exactResolution(current), {
      parentFlowId: "other-parent", currentTargetGraph: target, apply: () => { staleApplyCalls += 1; },
    })).toThrow(/parent|changed|stale/i);
    expect(staleApplyCalls).toBe(0);
    expect(controller.isActive(current)).toBe(true);
    controller.cancel();
    expect(() => controller.commit(current, exactResolution(current), {
      parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined,
    })).toThrow(/cancel|active/i);

    const finalPlan = controller.begin({
      parentFlowId: "parent",
      fragment: fragmentFor([wrapper("final")]), commandId: "paste_final",
      targetOrigin: { x: 0, y: 0 }, targetGraph: target,
    });
    commitPlan(controller, finalPlan, exactResolution(finalPlan), target);
    expect(() => controller.commit(finalPlan, exactResolution(finalPlan), {
      parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined,
    })).toThrow(/consumed|active/i);
  });

  it("consumes before external apply so reentrancy and throw-after-recording cannot replay", () => {
    const target = graph([]);
    const controller = new PendingSubflowPasteController();
    const reentrant = controller.begin({
      parentFlowId: "parent", fragment: fragmentFor([wrapper("reentrant")]), commandId: "paste_reentrant",
      targetOrigin: { x: 0, y: 0 }, targetGraph: target,
    });
    let nestedError: unknown;
    controller.commit(reentrant, exactResolution(reentrant), {
      parentFlowId: "parent",
      currentTargetGraph: target,
      apply: () => {
        try {
          controller.commit(reentrant, exactResolution(reentrant), {
            parentFlowId: "parent", currentTargetGraph: target, apply: () => undefined,
          });
        } catch (error) {
          nestedError = error;
        }
      },
    });
    expect(nestedError).toBeInstanceOf(Error);
    expect((nestedError as Error).message).toMatch(/active|consumed/i);
    expect(controller.isActive(reentrant)).toBe(false);

    const throwing = controller.begin({
      parentFlowId: "parent", fragment: fragmentFor([wrapper("throwing")]), commandId: "paste_throwing",
      targetOrigin: { x: 0, y: 0 }, targetGraph: target,
    });
    let recorded = 0;
    expect(() => controller.commit(throwing, exactResolution(throwing), {
      parentFlowId: "parent",
      currentTargetGraph: target,
      apply: () => {
        recorded += 1;
        throw new Error("dispatch reported failure after recording");
      },
    })).toThrow(/after recording/i);
    expect(recorded).toBe(1);
    expect(controller.isActive(throwing)).toBe(false);
    expect(() => controller.commit(throwing, exactResolution(throwing), {
      parentFlowId: "parent", currentTargetGraph: target, apply: () => { recorded += 1; },
    })).toThrow(/active|consumed/i);
    expect(recorded).toBe(1);
  });

  it("rejects more than 100 pending references before any plan becomes active", () => {
    const sharedReference = reference();
    const nodes = Array.from({ length: 101 }, (_, index) =>
      wrapper(`node-${String(index).padStart(3, "0")}`, sharedReference));
    const controller = new PendingSubflowPasteController();
    expect(() => controller.begin({
      parentFlowId: "parent",
      fragment: fragmentFor(nodes), commandId: "paste_bounded",
      targetOrigin: { x: 0, y: 0 }, targetGraph: graph([]),
    })).toThrow(/100|pending|limit/i);
    expect(controller.hasActivePlan()).toBe(false);
  });

  it("rejects oversized and sparse direct node arrays before scanning their contents", () => {
    const base = fragmentFor([wrapper("base")]);
    const controller = new PendingSubflowPasteController();
    const oversized = { ...base, nodes: new Array(1_000_000) };
    expect(() => controller.begin({
      parentFlowId: "parent", fragment: oversized as typeof base, commandId: "paste_oversized",
      targetOrigin: { x: 0, y: 0 }, targetGraph: graph([]),
    })).toThrow(/500|nodes/i);

    const sparse = [base.nodes[0]!];
    sparse.length = 2;
    expect(() => controller.begin({
      parentFlowId: "parent", fragment: { ...base, nodes: sparse }, commandId: "paste_sparse",
      targetOrigin: { x: 0, y: 0 }, targetGraph: graph([]),
    })).toThrow(/sparse|accessor|nodes/i);
    expect(controller.hasActivePlan()).toBe(false);
  });

  it("supports a zero-resolution plain duplicate plan without exposing intermediate nodes", () => {
    const ordinary: FlowNodeV2 = {
      id: "ordinary", type: "llm", params: {}, bindings: {}, position: { x: 20, y: 30 },
    };
    const target = graph([]);
    const controller = new PendingSubflowPasteController();
    const plan = controller.begin({
      parentFlowId: "parent",
      fragment: fragmentFor([ordinary]), commandId: "duplicate_plain",
      targetOrigin: { x: 40, y: 50 }, targetGraph: target,
    });
    expect(plan.requests()).toEqual([]);
    const command = commitPlan(controller, plan, [], target);
    expect(applyGraphCommand(target, command).graph.nodes).toMatchObject([{
      id: "node_duplicate_plain_0", position: { x: 40, y: 50 },
    }]);
  });
});
