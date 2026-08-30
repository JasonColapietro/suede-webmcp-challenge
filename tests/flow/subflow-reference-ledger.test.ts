import { describe, expect, it } from "vitest";
import {
  materializeResolvedPendingNodes,
  SubflowReferenceLedger,
  referenceFingerprint,
  stripTypedReferencesForPendingResolution,
  type StudioReferenceAction,
} from "@/lib/flow/subflow-reference-ledger";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { FlowGraphV2Schema } from "@/lib/flow/graph-schema";
import { serializeGraphFragment } from "@/lib/flow/graph-fragment";
import type {
  FlowCallableInterface,
  FlowNode,
  FlowGraphV2,
  FlowNodeV2,
  JsonValue,
  SubflowReference,
} from "@/lib/flow/types";

const callable: FlowCallableInterface = { inputs: [], outputs: [] };

function reference(flowId = "child"): SubflowReference {
  return {
    kind: "draft",
    flowId,
    interface: callable,
    interfaceHash: hashCallableInterface(callable),
  };
}

function wrapper(id: string, value: SubflowReference = reference()): FlowNodeV2 {
  return {
    id,
    type: "subflow",
    params: { reference: value as unknown as JsonValue },
    bindings: {},
    position: { x: 0, y: 0 },
  };
}

function graph(nodes: readonly FlowNodeV2[]): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "local-parent",
    name: "Parent",
    nodes,
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

describe("ephemeral subflow reference ledger", () => {
  it("uses a browser-safe canonical fingerprint independent of object key order", () => {
    const current = reference();
    const reordered = {
      interfaceHash: current.interfaceHash,
      interface: current.interface,
      flowId: current.flowId,
      kind: current.kind,
    } as SubflowReference;
    expect(referenceFingerprint(current)).toMatch(/^[a-f0-9]{64}$/);
    expect(referenceFingerprint(reordered)).toBe(referenceFingerprint(current));
  });

  it("refuses references outside the bounded public interface contract", () => {
    const oversized: FlowCallableInterface = {
      inputs: Array.from({ length: 65 }, (_, index) => ({
        id: `input_${index}`,
        label: `Input ${index}`,
        schema: {},
        required: false,
        cardinality: "one" as const,
        target: { kind: "trigger" as const, path: `/input_${index}` },
      })),
      outputs: [],
    };
    const value: SubflowReference = {
      kind: "draft",
      flowId: "child",
      interface: oversized,
      interfaceHash: hashCallableInterface(oversized),
    };
    expect(() => referenceFingerprint(value)).toThrow(/bound|interface/i);
  });

  it("loads every typed reference unresolved and resolves only the exact parent, node, and reference", () => {
    const value = reference();
    const current = graph([wrapper("typed", value), {
      id: "legacy", type: "subflow", params: { flowId: "old-child" }, bindings: {}, position: { x: 0, y: 0 },
    }]);
    const ledger = new SubflowReferenceLedger("parent-a", current);
    expect(ledger.unresolvedNodeIds(current)).toEqual(["typed"]);

    expect(ledger.markResolved("parent-b", "typed", value)).toBe(false);
    expect(ledger.markResolved("parent-a", "missing", value)).toBe(false);
    expect(ledger.markResolved("parent-a", "typed", reference("other"))).toBe(false);
    expect(ledger.unresolvedNodeIds(current)).toEqual(["typed"]);

    expect(ledger.markResolved("parent-a", "typed", value)).toBe(true);
    expect(ledger.unresolvedNodeIds(current)).toEqual([]);
  });

  it("retains an exact receipt across ordinary edits, invalidates changed/history/reset contexts, and removes deleted nodes", () => {
    const first = reference("one");
    const second = reference("two");
    const initial = graph([wrapper("one", first), wrapper("two", second)]);
    const ledger = new SubflowReferenceLedger("parent", initial);
    ledger.markResolved("parent", "one", first);
    ledger.markResolved("parent", "two", second);

    const renamed = { ...initial, name: "Renamed" };
    ledger.reconcile("parent", renamed, "edit");
    expect(ledger.unresolvedNodeIds(renamed)).toEqual([]);

    const changed = graph([wrapper("one", reference("changed")), wrapper("two", second)]);
    ledger.reconcile("parent", changed, "edit");
    expect(ledger.unresolvedNodeIds(changed)).toEqual(["one"]);

    ledger.reconcile("parent", graph([wrapper("two", second)]), "edit");
    expect(ledger.receiptNodeIds()).toEqual(["two"]);

    for (const transition of ["undo", "redo", "reset"] as const) {
      ledger.markResolved("parent", "two", second);
      ledger.reconcile("parent", graph([wrapper("two", second)]), transition);
      expect(ledger.unresolvedNodeIds(graph([wrapper("two", second)])), transition).toEqual(["two"]);
    }
  });

  it("keeps existing exact receipts but treats pasted and duplicated typed nodes as unresolved", () => {
    const value = reference();
    const initial = graph([wrapper("original", value)]);
    const ledger = new SubflowReferenceLedger("parent", initial);
    ledger.markResolved("parent", "original", value);

    for (const transition of ["paste", "duplicate"] as const) {
      const next = graph([wrapper("original", value), wrapper(`new-${transition}`, value)]);
      ledger.reconcile("parent", next, transition);
      expect(ledger.unresolvedNodeIds(next)).toEqual([`new-${transition}`]);
    }
  });

  it("derives one blocker contract for every save, execution, publication, and navigation action", () => {
    const current = graph([wrapper("b"), wrapper("a")]);
    const ledger = new SubflowReferenceLedger("parent", current);
    const actions: readonly StudioReferenceAction[] = [
      "save", "retry-save", "version", "run", "launch", "workbook-navigation", "global-navigation",
    ];
    for (const action of actions) {
      expect(ledger.blocker(action, current)).toEqual({
        action,
        nodeIds: ["a", "b"],
        message: "Verify 2 reusable flow references before continuing.",
      });
    }
    ledger.markResolved("parent", "a", reference());
    ledger.markResolved("parent", "b", reference());
    expect(ledger.blocker("save", current)).toBeNull();
  });
});

describe("clipboard pending reference metadata", () => {
  it("fails closed on a forged v1 wrapper carrying typed reference params", () => {
    const value = reference("private-child-id");
    const forged: FlowNode = {
      id: "forged",
      type: "subflow",
      params: { reference: value },
      position: { x: 0, y: 0 },
    };
    expect(() => stripTypedReferencesForPendingResolution([forged])).toThrow(/v2|bindings/i);
  });

  it("fails closed on malformed typed and empty reusable-flow wrappers", () => {
    const malformed: FlowNodeV2 = {
      ...wrapper("malformed"),
      params: { reference: { kind: "draft", flowId: "child" } },
    };
    const empty: FlowNodeV2 = { ...wrapper("empty"), params: {} };
    expect(() => stripTypedReferencesForPendingResolution([malformed])).toThrow(/reference|invalid/i);
    expect(() => stripTypedReferencesForPendingResolution([empty])).toThrow(/reference|flowId|invalid/i);
  });

  it("structurally validates zero-pending materialization", () => {
    const legacy: FlowNodeV2 = {
      ...wrapper("legacy"),
      params: { flowId: "legacy-child" },
    };
    const detached = stripTypedReferencesForPendingResolution([legacy]);
    expect(materializeResolvedPendingNodes(detached, [])).toEqual([legacy]);

    const malformedOrdinary: FlowNodeV2 = {
      ...wrapper("ordinary"),
      type: "llm",
      params: {},
      position: { x: Number.NaN, y: 0 },
    };
    expect(() => materializeResolvedPendingNodes(
      stripTypedReferencesForPendingResolution([malformedOrdinary]),
      [],
    )).toThrow();
  });

  it("strips typed references from fragment nodes into non-serializable, secret-free pending metadata", () => {
    const value = reference("private-child-id");
    const node = {
      ...wrapper("typed", value),
      type: "loop" as const,
      params: { reference: value as unknown as JsonValue, maxIterations: 7 },
      bindings: { token: { kind: "secret" as const, connectionId: "connection-only", field: "token" } },
    };
    const fragment = serializeGraphFragment(graph([node]), {
      nodeIds: ["typed"], edgeIds: [], primaryNodeId: "typed",
    });
    const result = stripTypedReferencesForPendingResolution(fragment.nodes);

    expect(JSON.stringify(result)).toBeUndefined();
    expect(Object.hasOwn(result, "nodes")).toBe(false);
    expect(Object.hasOwn(result, "pending")).toBe(false);
    expect(fragment.redactionCount).toBe(1);
    expect(result.requests()).toEqual([{
      nodeId: "typed",
      reference: value,
      fingerprint: referenceFingerprint(value),
    }]);
    expect(JSON.stringify(result.requests())).not.toContain("connection-only");
    expect(FlowGraphV2Schema.safeParse(result).success).toBe(false);
    const materialized = materializeResolvedPendingNodes(result, [{
      nodeId: "typed",
      requestedFingerprint: referenceFingerprint(value),
      projection: {
        reference: value,
        interface: value.interface,
        interfaceHash: value.interfaceHash,
        issues: [],
      },
    }]);
    expect("bindings" in materialized[0]! ? materialized[0].bindings : null).toEqual({});
    expect(FlowGraphV2Schema.safeParse(graph(materialized as readonly FlowNodeV2[])).success).toBe(true);
  });

  it("materializes detached nodes only from exact drift-free server projections", () => {
    const value = reference("private-child-id");
    const original = wrapper("typed", value);
    const stripped = stripTypedReferencesForPendingResolution([original]);
    const projection = {
      reference: value,
      interface: value.interface,
      interfaceHash: value.interfaceHash,
      issues: [] as const,
    };
    expect(stripped.requiresResolutionBeforePersistence).toBe(true);
    expect(materializeResolvedPendingNodes(
      stripped,
      [{ nodeId: "typed", requestedFingerprint: referenceFingerprint(value), projection }],
    )).toEqual([original]);
  });

  it("refuses missing, drifted, and fingerprint-mismatched materialization receipts", () => {
    const value = reference("private-child-id");
    const stripped = stripTypedReferencesForPendingResolution([wrapper("typed", value)]);
    const exact = {
      nodeId: "typed",
      requestedFingerprint: referenceFingerprint(value),
      projection: {
        reference: value,
        interface: value.interface,
        interfaceHash: value.interfaceHash,
        issues: [] as const,
      },
    };
    expect(() => materializeResolvedPendingNodes(stripped, []))
      .toThrow(/every pending/i);
    expect(() => materializeResolvedPendingNodes(stripped, [{
      ...exact,
      projection: { ...exact.projection, issues: ["interface-drift"] as const },
    }])).toThrow(/drift/i);
    expect(() => materializeResolvedPendingNodes(stripped, [{
      ...exact,
      requestedFingerprint: "0".repeat(64),
    }])).toThrow(/fingerprint/i);
  });

  it("remaps pending metadata to the detached node ID that the server resolves", () => {
    const value = reference("private-child-id");
    const stripped = stripTypedReferencesForPendingResolution([wrapper("source-id", value)]);
    const remapped = stripped.remap({ "source-id": "node_paste_0" });
    expect(remapped.requests()).toEqual([{
      nodeId: "node_paste_0",
      reference: value,
      fingerprint: referenceFingerprint(value),
    }]);
    expect(materializeResolvedPendingNodes(remapped, [{
      nodeId: "node_paste_0",
      requestedFingerprint: referenceFingerprint(value),
      projection: {
        reference: value,
        interface: value.interface,
        interfaceHash: value.interfaceHash,
        issues: [],
      },
    }])[0]?.id).toBe("node_paste_0");
    expect(() => stripped.remap({})).toThrow(/exact/i);
    expect(() => stripped.remap({ "source-id": "node_paste_0", extra: "node_paste_1" }))
      .toThrow(/exact/i);
  });
});
