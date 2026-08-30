import { describe, expect, it, vi } from "vitest";
import {
  SUBFLOW_BREADCRUMB_MAX_BYTES,
  SUBFLOW_BREADCRUMB_TTL_MS,
  appendSubflowBreadcrumb,
  consumeSubflowFocusAfterGraphLoad,
  clearSubflowBreadcrumbSession,
  deriveSubflowAncestorReturn,
  getOrCreateSubflowBreadcrumbNonce,
  readSubflowBreadcrumbTrail,
  projectSubflowBreadcrumbRequest,
  validateSubflowBreadcrumbResponse,
  stageSubflowBreadcrumbRouteEffect,
  type SubflowBreadcrumbEntry,
  type SubflowBreadcrumbStorage,
} from "@/lib/flow/subflow-breadcrumb-session";

class MemoryStorage implements SubflowBreadcrumbStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const nonce = "tab_nonce_abcdefghijkl";
const now = 10_000;
const hash = (value: string) => value.repeat(64).slice(0, 64);
const root = (flowId: string): SubflowBreadcrumbEntry => ({ flowId, via: null });
const child = (
  parentFlowId: string,
  flowId: string,
  pinned = false,
): SubflowBreadcrumbEntry => ({
  flowId,
  via: {
    parentFlowId,
    originNodeId: `node:${parentFlowId}->${flowId}`,
    reference: pinned
      ? { kind: "pinned", flowId, versionId: `version:${flowId}`, interfaceHash: hash("a"), contentHash: hash("b") }
      : { kind: "draft", flowId, interfaceHash: hash("c") },
  },
});

describe("subflow breadcrumb session", () => {
  it("builds one full unique trail whose current flow is last and rejects partial pins", () => {
    const ab = appendSubflowBreadcrumb([root("flow:A")], child("flow:A", "flow:B"));
    const abc = appendSubflowBreadcrumb(ab!, child("flow:B", "flow:C", true));
    expect(abc?.map(({ flowId }) => flowId)).toEqual(["flow:A", "flow:B", "flow:C"]);
    expect(appendSubflowBreadcrumb(abc!, child("flow:C", "flow:A"))).toBeNull();
    expect(appendSubflowBreadcrumb([root("flow:A")], child("wrong-parent", "flow:B"))).toBeNull();
    expect(appendSubflowBreadcrumb([root("flow:A")], {
      flowId: "flow:B",
      via: { parentFlowId: "flow:A", originNodeId: "node:partial", reference: {
        kind: "pinned", flowId: "flow:B", versionId: "version:B", interfaceHash: hash("a"),
      } as never },
    })).toBeNull();
  });

  it("stages trail and focus atomically immediately before the approved route effect", () => {
    const storage = new MemoryStorage();
    const order: string[] = [];
    const originalSet = storage.setItem.bind(storage);
    storage.setItem = (key, value) => { order.push("stage"); originalSet(key, value); };
    const route = vi.fn(() => { order.push("route"); });
    const result = stageSubflowBreadcrumbRouteEffect(storage, {
      nonce,
      targetFlowId: "flow:B",
      trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "node:call-B" },
      now,
    }, route);
    expect(result).toEqual({ status: "routed" });
    expect(order).toEqual(["stage", "route"]);
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toHaveLength(2);
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toEqual([]);
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:B", graphLoaded: true, nodeIds: ["node:call-B"], now,
    })).toEqual({ status: "focused", originNodeId: "node:call-B" });
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now: now + 1 })).toEqual([]);

    expect(() => stageSubflowBreadcrumbRouteEffect(storage, {
      nonce,
      targetFlowId: "flow:B",
      trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "node:call-B" },
      now,
    }, () => { throw new Error("route refused"); })).toThrow("route refused");
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toEqual([]);

    const unavailable = new MemoryStorage();
    unavailable.setItem = () => { throw new Error("private storage error"); };
    const refusedRoute = vi.fn();
    expect(stageSubflowBreadcrumbRouteEffect(unavailable, {
      nonce, targetFlowId: "flow:B", trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "node:B" }, now,
    }, refusedRoute)).toEqual({ status: "unavailable" });
    expect(refusedRoute).not.toHaveBeenCalled();
  });

  it("opens children without focus and derives ancestor return focus from the exited child edge", () => {
    const storage = new MemoryStorage();
    const ab = [root("flow:A"), {
      ...child("flow:A", "flow:B"),
      via: { ...child("flow:A", "flow:B").via!, originNodeId: "node:n1" },
    }];
    const abc = [...ab, {
      ...child("flow:B", "flow:C"),
      via: { ...child("flow:B", "flow:C").via!, originNodeId: "node:n2" },
    }];
    expect(stageSubflowBreadcrumbRouteEffect(storage, {
      nonce, targetFlowId: "flow:C", trail: abc, focus: null, now,
    }, () => undefined)).toEqual({ status: "routed" });
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:C", graphLoaded: true, nodeIds: ["node:n2"], now,
    })).toEqual({ status: "none" });

    expect(deriveSubflowAncestorReturn(abc, "flow:A")).toEqual({
      targetFlowId: "flow:A",
      trail: [root("flow:A")],
      focus: { targetFlowId: "flow:A", originNodeId: "node:n1" },
    });
    expect(deriveSubflowAncestorReturn(abc, "flow:B")).toEqual({
      targetFlowId: "flow:B",
      trail: ab,
      focus: { targetFlowId: "flow:B", originNodeId: "node:n2" },
    });
    expect(deriveSubflowAncestorReturn(abc, "flow:C")).toBeNull();
  });

  it("focuses the exact ancestor node once and rejects a missing or stale origin", () => {
    const storage = new MemoryStorage();
    const abc = [
      root("flow:A"),
      { ...child("flow:A", "flow:B"), via: { ...child("flow:A", "flow:B").via!, originNodeId: "node:n1" } },
      { ...child("flow:B", "flow:C"), via: { ...child("flow:B", "flow:C").via!, originNodeId: "node:n2" } },
    ];
    const backToA = deriveSubflowAncestorReturn(abc, "flow:A")!;
    stageSubflowBreadcrumbRouteEffect(storage, { nonce, ...backToA, now }, () => undefined);
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:A", graphLoaded: true, nodeIds: ["node:n1"], now,
    })).toEqual({ status: "focused", originNodeId: "node:n1" });
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:A", graphLoaded: true, nodeIds: ["node:n1"], now,
    })).toEqual({ status: "none" });

    expect(deriveSubflowAncestorReturn([
      root("flow:A"),
      { flowId: "flow:B", via: { parentFlowId: "flow:A", reference: child("flow:A", "flow:B").via!.reference } } as never,
    ], "flow:A")).toBeNull();
    const backToB = deriveSubflowAncestorReturn(abc, "flow:B")!;
    stageSubflowBreadcrumbRouteEffect(storage, { nonce, ...backToB, now: now + 1 }, () => undefined);
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:B", graphLoaded: true, nodeIds: ["different"], now: now + 1,
    })).toEqual({ status: "none" });
  });

  it("projects only backend adjacency receipts and excludes local origin and interface hashes", () => {
    const trail = [root("flow:A"), child("flow:A", "flow:B"), child("flow:B", "flow:C", true)];
    const projected = projectSubflowBreadcrumbRequest(trail, "flow:C");
    expect(projected).toEqual({
      currentFlowId: "flow:C",
      trail: [
        { flowId: "flow:A" },
        { flowId: "flow:B" },
        { flowId: "flow:C", versionId: "version:flow:C", contentHash: hash("b") },
      ],
    });
    expect(JSON.stringify(projected)).not.toMatch(/originNodeId|interfaceHash/);
    expect(projectSubflowBreadcrumbRequest([root("flow:A")], "flow:A")).toEqual({
      currentFlowId: "flow:A", trail: [],
    });
    expect(projectSubflowBreadcrumbRequest([], "flow:direct")).toEqual({
      currentFlowId: "flow:direct", trail: [],
    });
  });

  it("binds breadcrumb display names and complete pin receipts to the exact projected request", () => {
    const trail = [root("flow:A"), child("flow:A", "flow:B"), child("flow:B", "flow:C", true)];
    const request = projectSubflowBreadcrumbRequest(trail, "flow:C")!;
    const value = {
      crumbs: [
        { flowId: "flow:A", name: "Root" },
        { flowId: "flow:B", name: "Middle" },
        {
          flowId: "flow:C",
          name: "Current",
          versionId: "version:flow:C",
          versionNumber: 7,
          contentHash: hash("b"),
        },
      ],
    };
    expect(validateSubflowBreadcrumbResponse(value, request)).toEqual(value);
    expect(validateSubflowBreadcrumbResponse({ crumbs: [...value.crumbs].reverse() }, request)).toBeNull();
    expect(validateSubflowBreadcrumbResponse({ crumbs: value.crumbs.slice(0, 2) }, request)).toBeNull();
    expect(validateSubflowBreadcrumbResponse({ crumbs: value.crumbs.map((crumb) => ({ ...crumb, secret: "no" })) }, request)).toBeNull();
    expect(validateSubflowBreadcrumbResponse({ crumbs: value.crumbs.map((crumb, index) => index === 2
      ? { ...crumb, contentHash: hash("c") }
      : crumb) }, request)).toBeNull();
    expect(validateSubflowBreadcrumbResponse({ crumbs: value.crumbs.map((crumb, index) => index === 2
      ? { flowId: crumb.flowId, name: crumb.name, versionId: "version:flow:C", contentHash: hash("b") }
      : crumb) }, request)).toBeNull();
    expect(validateSubflowBreadcrumbResponse({ crumbs: [] }, { currentFlowId: "flow:direct", trail: [] })).toEqual({ crumbs: [] });
  });

  it("clears an untrusted trail and focus together after privacy validation fails", () => {
    const storage = new MemoryStorage();
    stageSubflowBreadcrumbRouteEffect(storage, {
      nonce, targetFlowId: "flow:B", trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "node:B" }, now,
    }, () => undefined);
    clearSubflowBreadcrumbSession(storage);
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toEqual([]);
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:B", graphLoaded: true, nodeIds: ["node:B"], now,
    })).toEqual({ status: "none" });
  });

  it("keeps direct routes empty and silently clears wrong-target, stale, oversized, or tampered data", () => {
    const storage = new MemoryStorage();
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:direct", now })).toEqual([]);
    stageSubflowBreadcrumbRouteEffect(storage, {
      nonce, targetFlowId: "flow:B", trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "node:B" }, now,
    }, () => undefined);
    const key = [...storage.values.keys()].find((candidate) => candidate.includes("navigation"))!;
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:C", now })).toEqual([]);

    storage.values.set(key, JSON.stringify({ v: 1, name: "Secret name", error: "raw backend id flow:private" }));
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:private", now })).toEqual([]);
    expect(storage.values.has(key)).toBe(false);
    storage.values.set(key, "x".repeat(SUBFLOW_BREADCRUMB_MAX_BYTES + 1));
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toEqual([]);

    stageSubflowBreadcrumbRouteEffect(storage, {
      nonce, targetFlowId: "flow:B", trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "node:B" }, now,
    }, () => undefined);
    expect(readSubflowBreadcrumbTrail(storage, {
      nonce, currentFlowId: "flow:B", now: now + SUBFLOW_BREADCRUMB_TTL_MS,
    })).toEqual([]);

    storage.values.set(key, JSON.stringify({ nested: [[[[[[[[[[[[[[[[["too deep"]]]]]]]]]]]]]]]]] }));
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toEqual([]);
  });

  it("consumes focus once only after the exact target graph loads and contains the origin node", () => {
    const storage = new MemoryStorage();
    stageSubflowBreadcrumbRouteEffect(storage, {
      nonce, targetFlowId: "flow:B", trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "node:B" }, now,
    }, () => undefined);
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:B", graphLoaded: false, nodeIds: ["node:B"], now,
    })).toEqual({ status: "waiting" });
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:B", graphLoaded: true, nodeIds: ["node:B"], now,
    })).toEqual({ status: "focused", originNodeId: "node:B" });
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:B", graphLoaded: true, nodeIds: ["node:B"], now,
    })).toEqual({ status: "none" });
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toHaveLength(2);
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:B", now })).toEqual([]);

    stageSubflowBreadcrumbRouteEffect(storage, {
      nonce, targetFlowId: "flow:B", trail: [root("flow:A"), child("flow:A", "flow:B")],
      focus: { targetFlowId: "flow:B", originNodeId: "missing" }, now,
    }, () => undefined);
    expect(consumeSubflowFocusAfterGraphLoad(storage, {
      nonce, targetFlowId: "flow:B", graphLoaded: true, nodeIds: ["other"], now,
    })).toEqual({ status: "none" });
  });

  it("accepts bounded Unicode opaque IDs and keeps only the latest staged destination", () => {
    const storage = new MemoryStorage();
    stageSubflowBreadcrumbRouteEffect(storage, {
      nonce,
      targetFlowId: "flow:子/二",
      trail: [root("flow:父 一"), child("flow:父 一", "flow:子/二")],
      focus: { targetFlowId: "flow:子/二", originNodeId: "node:入口" },
      now,
    }, () => undefined);
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:子/二", now }))
      .toHaveLength(2);
    stageSubflowBreadcrumbRouteEffect(storage, {
      nonce,
      targetFlowId: "flow:newest",
      trail: [root("flow:root"), child("flow:root", "flow:newest")],
      focus: { targetFlowId: "flow:newest", originNodeId: "node:newest" },
      now: now + 1,
    }, () => undefined);
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:newest", now: now + 1 })).toHaveLength(2);
    expect(readSubflowBreadcrumbTrail(storage, { nonce, currentFlowId: "flow:newest", now: now + 2 })).toEqual([]);
  });

  it("persists a strict tab nonce and falls back without exposing storage errors", () => {
    const storage = new MemoryStorage();
    expect(getOrCreateSubflowBreadcrumbNonce(storage, () => nonce)).toBe(nonce);
    expect(getOrCreateSubflowBreadcrumbNonce(storage, () => "different_nonce_value")).toBe(nonce);
    const unavailable = { getItem: () => { throw new Error("private"); }, setItem: () => { throw new Error("private"); }, removeItem: () => undefined };
    expect(getOrCreateSubflowBreadcrumbNonce(unavailable, () => "fallback_nonce_abcdef")).toBe("fallback_nonce_abcdef");
  });
});
