import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StudioReferenceSessionGate } from "@/lib/flow/studio-reference-session-gate";
import * as GateModule from "@/lib/flow/studio-reference-session-gate";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { FlowSaveCoordinator } from "@/lib/flow/save-queue";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  FlowNodeV2,
  JsonValue,
  SubflowReference,
} from "@/lib/flow/types";
import type { StudioReferenceAction } from "@/lib/flow/subflow-reference-ledger";

const callable: FlowCallableInterface = { inputs: [], outputs: [] };
const actions: readonly StudioReferenceAction[] = [
  "save", "retry-save", "version", "run", "launch", "workbook-navigation", "global-navigation",
];

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
    id: "local-graph",
    name: "Parent",
    nodes,
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

describe("Studio reference session gate", () => {
  it("blocks every persistence and execution surface until the exact route/node/reference resolves", () => {
    const value = reference();
    const current = graph([wrapper("call", value)]);
    const gate = new StudioReferenceSessionGate();
    gate.reset("parent-a", current);

    for (const action of actions) {
      expect(gate.blocker(action)).toEqual({
        action,
        nodeIds: ["call"],
        message: "Verify 1 reusable flow reference before continuing.",
      });
    }
    expect(gate.markResolved("parent-b", "call", value)).toBe(false);
    expect(gate.markResolved("parent-a", "missing", value)).toBe(false);
    expect(gate.markResolved("parent-a", "call", reference("other"))).toBe(false);
    expect(gate.markResolved("parent-a", "call", value)).toBe(true);
    for (const action of actions) expect(gate.blocker(action)).toBeNull();
  });

  it("keeps exact receipts across ordinary edits, removes deleted nodes, and invalidates changed/history/reset state", () => {
    const one = reference("one");
    const two = reference("two");
    const initial = graph([wrapper("one", one), wrapper("two", two)]);
    const gate = new StudioReferenceSessionGate();
    gate.reset("parent", initial);
    gate.markResolved("parent", "one", one);
    gate.markResolved("parent", "two", two);

    const renamed = { ...initial, name: "Renamed" };
    gate.reconcile("parent", renamed, "edit");
    expect(gate.blocker("save")).toBeNull();

    const changed = graph([wrapper("one", reference("changed")), wrapper("two", two)]);
    gate.reconcile("parent", changed, "edit");
    expect(gate.blocker("save")?.nodeIds).toEqual(["one"]);

    const deleted = graph([wrapper("two", two)]);
    gate.reconcile("parent", deleted, "edit");
    expect(gate.blocker("save")).toBeNull();

    for (const transition of ["undo", "redo", "reset"] as const) {
      gate.markResolved("parent", "two", two);
      gate.reconcile("parent", deleted, transition);
      expect(gate.blocker("save")?.nodeIds, transition).toEqual(["two"]);
    }
  });

  it("resets receipts when the exact parent route changes and refuses receipts before persistence", () => {
    const value = reference();
    const current = graph([wrapper("call", value)]);
    const gate = new StudioReferenceSessionGate();
    gate.reset("parent-a", current);
    expect(gate.markResolved("parent-a", "call", value)).toBe(true);

    gate.reconcile("parent-b", current, "edit");
    expect(gate.blocker("run")?.nodeIds).toEqual(["call"]);
    expect(gate.markResolved("parent-a", "call", value)).toBe(false);

    gate.reset(null, current);
    expect(gate.markResolved(null, "call", value)).toBe(false);
    expect(gate.blocker("save")?.nodeIds).toEqual(["call"]);
  });

  it("is browser-safe and has no blocker before a graph loads", () => {
    const gate = new StudioReferenceSessionGate();
    expect(gate.blocker("save")).toBeNull();
    const source = readFileSync(join(process.cwd(), "src/lib/flow/studio-reference-session-gate.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']node:|Buffer|better-sqlite3|@supabase/);
  });

  it("bootstraps a safe parent and hands the exact deferred graph across one authoritative route remount", () => {
    const api = GateModule as unknown as {
      createReferenceBootstrapGraph?: (value: FlowGraphV2) => FlowGraphV2;
      stageReferenceBootstrapGraph?: (value: FlowGraphV2) => string;
      updateReferenceBootstrapGraph?: (token: string, value: FlowGraphV2) => boolean;
      bindReferenceBootstrapGraph?: (token: string, rowId: string) => boolean;
      consumeReferenceBootstrapGraph?: (rowId: string) => FlowGraphV2 | null;
      peekReferenceBootstrapGraph?: (rowId: string) => FlowGraphV2 | null;
      discardBoundReferenceBootstrapGraph?: (rowId: string) => boolean;
      hasReferenceBootstrapMarker?: (value: FlowGraphV2) => boolean;
    };
    const intended = {
      ...graph([wrapper("call")]),
      meta: { privateDraftNote: "must not persist" },
    };
    const bootstrap = api.createReferenceBootstrapGraph?.(intended);
    expect(bootstrap?.nodes).toEqual([]);
    expect(bootstrap?.edges).toEqual([]);
    expect(bootstrap?.meta).toEqual({ studioReferenceBootstrap: true });
    expect(api.hasReferenceBootstrapMarker?.(bootstrap!)).toBe(true);

    const token = api.stageReferenceBootstrapGraph?.(intended);
    expect(typeof token).toBe("string");
    expect(api.bindReferenceBootstrapGraph?.(token!, "parent-row")).toBe(true);
    const latest = { ...intended, name: "Latest parent" };
    expect(api.updateReferenceBootstrapGraph?.(token!, latest)).toBe(true);
    (intended as { name: string }).name = "mutated-after-stage";
    (latest as { name: string }).name = "mutated-after-update";
    expect(api.consumeReferenceBootstrapGraph?.("wrong-row")).toBeNull();
    expect(api.peekReferenceBootstrapGraph?.("parent-row")?.name).toBe("Latest parent");
    expect(api.peekReferenceBootstrapGraph?.("parent-row")?.name).toBe("Latest parent");
    expect(api.consumeReferenceBootstrapGraph?.("parent-row")?.name).toBe("Latest parent");
    expect(api.consumeReferenceBootstrapGraph?.("parent-row")).toBeNull();

    const discarded = api.stageReferenceBootstrapGraph?.(latest);
    expect(api.bindReferenceBootstrapGraph?.(discarded!, "discarded-row")).toBe(true);
    expect(api.discardBoundReferenceBootstrapGraph?.("discarded-row")).toBe(true);
    expect(api.consumeReferenceBootstrapGraph?.("discarded-row")).toBeNull();
  });

  it("retries only a safe bootstrap after a blocked edit supersedes an in-flight create", async () => {
    const intended = graph([wrapper("call")]);
    const token = GateModule.stageReferenceBootstrapGraph(intended);
    const createPayloads: FlowGraphV2[] = [];
    let rejectFirstCreate: ((error: Error) => void) | undefined;
    const coordinator = new FlowSaveCoordinator(
      null,
      {
        create: async (submitted) => {
          createPayloads.push(structuredClone(submitted) as FlowGraphV2);
          if (createPayloads.length === 1) {
            await new Promise<never>((_resolve, reject) => {
              rejectFirstCreate = reject;
            });
          }
          GateModule.bindReferenceBootstrapGraph(token, "parent-after-retry");
          return "parent-after-retry";
        },
        update: async () => undefined,
      },
      {},
      0,
    );

    const firstCreate = coordinator.saveNow(GateModule.createReferenceBootstrapGraph(intended));
    const latest = graph([wrapper("latest-call", reference("latest-child"))]);
    GateModule.updateReferenceBootstrapGraph(token, latest);
    coordinator.supersedeWithoutSaving(latest);
    rejectFirstCreate?.(new Error("temporary create failure"));
    await expect(firstCreate).rejects.toThrow("temporary create failure");

    await coordinator.saveNow(GateModule.createReferenceBootstrapGraph(latest));

    expect(createPayloads).toHaveLength(2);
    expect(createPayloads.every((submitted) => submitted.nodes.length === 0)).toBe(true);
    expect(GateModule.consumeReferenceBootstrapGraph("parent-after-retry")).toEqual(latest);
  });

  it("binds a create that finishes after the mounted UI session disposes", async () => {
    const intended = graph([wrapper("call")]);
    const token = GateModule.stageReferenceBootstrapGraph(intended);
    let finishCreate: ((rowId: string) => void) | undefined;
    const created = new Promise<string>((resolve) => {
      finishCreate = resolve;
    });
    let mountedCallbackCalled = false;
    const coordinator = new FlowSaveCoordinator(
      null,
      {
        create: async () => {
          const rowId = await created;
          GateModule.bindReferenceBootstrapGraph(token, rowId);
          return rowId;
        },
        update: async () => undefined,
      },
      { onCreated: () => { mountedCallbackCalled = true; } },
      0,
    );

    const saving = coordinator.saveNow(GateModule.createReferenceBootstrapGraph(intended));
    const disposing = coordinator.dispose();
    finishCreate?.("parent-after-dispose");
    await Promise.all([saving, disposing]);

    expect(mountedCallbackCalled).toBe(false);
    expect(GateModule.consumeReferenceBootstrapGraph("parent-after-dispose")).toEqual(intended);
  });
});
