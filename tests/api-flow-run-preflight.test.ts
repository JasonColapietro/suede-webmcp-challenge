import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraph, FlowGraphV2, SubflowReference, SupportedFlowGraph } from "@/lib/flow/types";

const state = vi.hoisted(() => ({
  root: null as null | { id: string; ownerId: string; name: string; graph: SupportedFlowGraph; updatedAt: number },
  children: new Map<string, SupportedFlowGraph>(),
  versions: new Map<string, SupportedFlowGraph>(),
  runCalls: [] as unknown[][],
  projectRepoCalls: 0,
  projectRepoError: false,
}));

vi.mock("@/lib/auth", () => ({
  resolveOwnerId: async () => "owner",
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error { status = 401; },
}));
vi.mock("@/lib/db/repo", () => ({
  getRepo: async () => ({
    getOwnedFlow: async (id: string, ownerId: string) => {
      if (state.root?.id === id && state.root.ownerId === ownerId) return state.root;
      const graph = ownerId === "owner" ? state.children.get(id) : undefined;
      return graph ? { id, ownerId, name: graph.name, graph, updatedAt: 1 } : null;
    },
  }),
}));
vi.mock("@/lib/projects/provider", () => ({
  getProjectRepo: async () => {
    state.projectRepoCalls += 1;
    if (state.projectRepoError) throw new Error("project store unavailable");
    return {
      getFlowVersion: async ({ flowId, versionId, ownerId }: { flowId: string; versionId: string; ownerId: string }) => {
        const graph = ownerId === "owner" ? state.versions.get(`${flowId}:${versionId}`) : undefined;
        return graph ? { id: versionId, flowId, graph, semanticHash: "0".repeat(64), dependencies: [] } : null;
      },
    };
  },
}));
vi.mock("@/lib/run-service", () => ({
  runAndStream: (...args: unknown[]) => {
    state.runCalls.push(args);
    return (async function* () {
      yield { kind: "run:start", runId: "run", at: 1 };
      yield { kind: "run:done", runId: "run", totalCostUsdc: 0, status: "done" };
    })();
  },
  sseFrame: (event: unknown) => `data: ${JSON.stringify(event)}\n\n`,
}));

const { POST } = await import("@/app/api/v2/flows/[flowId]/run/route");
const iface: FlowCallableInterface = { inputs: [], outputs: [] };

function child(callableInterface = iface): FlowGraphV2 {
  return {
    schemaVersion: 2, id: "child-graph", name: "Child", callableInterface,
    nodes: [], edges: [], variables: [], groups: [], annotations: [],
  };
}

function parent(reference: SubflowReference): FlowGraphV2 {
  return {
    schemaVersion: 2, id: "parent-graph", name: "Parent",
    nodes: [{ id: "child", type: "subflow", params: { reference } as never, bindings: {}, position: { x: 0, y: 0 } }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

function draft(flowId: string, callableInterface = iface): SubflowReference {
  return { kind: "draft", flowId, interface: callableInterface, interfaceHash: hashCallableInterface(callableInterface) };
}

function request(flowVersionId?: string): Request {
  return new Request("https://agents.suedeai.ai/api/v2/flows/root/run", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ triggerInput: {}, ...(flowVersionId ? { flowVersionId } : {}) }),
  });
}

async function run(): Promise<Response> {
  return POST(request(), { params: Promise.resolve({ flowId: "root" }) });
}

beforeEach(() => {
  state.root = null;
  state.children.clear();
  state.versions.clear();
  state.runCalls.length = 0;
  state.projectRepoCalls = 0;
  state.projectRepoError = false;
});

describe("manual run route reusable-flow preflight", () => {
  it("returns stable private 409 JSON before opening a stream for missing and drifted children", async () => {
    for (const setup of [
      () => { state.root = { id: "root", ownerId: "owner", name: "Parent", graph: parent(draft("missing")), updatedAt: 1 }; },
      () => {
        const changed: FlowCallableInterface = {
          inputs: [{ id: "x", label: "X", schema: {}, required: false, cardinality: "one", target: { kind: "trigger", path: "/x" } }],
          outputs: [],
        };
        state.root = { id: "root", ownerId: "owner", name: "Parent", graph: parent(draft("child")), updatedAt: 1 };
        state.children.set("child", child(changed));
      },
    ]) {
      setup();
      const response = await run();
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "reusable flow unavailable" });
      expect(state.runCalls).toEqual([]);
      state.children.clear();
    }
  });

  it("returns stable 422 JSON for an invalid persisted root before streaming", async () => {
    state.root = {
      id: "root", ownerId: "owner", name: "Broken",
      graph: { ...child(), nodes: [{ id: "bad", type: "unknown", params: {}, bindings: {}, position: { x: 0, y: 0 } }] } as never,
      updatedAt: 1,
    };
    const response = await run();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "flow is not runnable" });
    expect(state.runCalls).toEqual([]);
  });

  it("preflights a valid typed closure then preserves dry-run SSE behavior", async () => {
    const graph = parent(draft("child"));
    state.root = { id: "root", ownerId: "owner", name: "Parent", graph, updatedAt: 1 };
    state.children.set("child", child());
    const response = await run();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"kind":"run:done"');
    expect(state.runCalls).toHaveLength(1);
    expect(state.runCalls[0]?.[1]).toMatchObject({
      flowId: "root", dryRun: true, trigger: "manual",
      subflowSnapshot: {
        loadSubflow: expect.any(Function), resolveSubflow: expect.any(Function),
      },
    });
  });

  it("preserves v1 stream behavior", async () => {
    const graph: FlowGraph = { id: "legacy", name: "Legacy", nodes: [], edges: [] };
    state.root = { id: "root", ownerId: "owner", name: "Legacy", graph, updatedAt: 1 };
    state.projectRepoError = true;
    const response = await run();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(state.runCalls).toHaveLength(1);
    expect(state.projectRepoCalls).toBe(0);
  });

  it("preserves bodyless v1 stream behavior", async () => {
    const graph: FlowGraph = { id: "legacy", name: "Legacy", nodes: [], edges: [] };
    state.root = { id: "root", ownerId: "owner", name: "Legacy", graph, updatedAt: 1 };
    state.projectRepoError = true;
    const bodyless = new Request("https://agents.suedeai.ai/api/v2/flows/root/run", { method: "POST" });

    const response = await POST(bodyless, { params: Promise.resolve({ flowId: "root" }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(state.runCalls).toHaveLength(1);
    expect(state.projectRepoCalls).toBe(0);
  });

  it("executes the requested immutable root instead of the mutable draft", async () => {
    const mutable: FlowGraph = { id: "mutable", name: "Mutable", nodes: [], edges: [] };
    const immutable: FlowGraph = { id: "immutable", name: "Immutable", nodes: [], edges: [] };
    state.root = { id: "root", ownerId: "owner", name: "Mutable", graph: mutable, updatedAt: 1 };
    state.versions.set("root:00000000-0000-4000-8000-000000000001", immutable);

    const response = await POST(request("00000000-0000-4000-8000-000000000001"), {
      params: Promise.resolve({ flowId: "root" }),
    });

    expect(response.status).toBe(200);
    expect(state.runCalls[0]?.[0]).toMatchObject({ id: "immutable", name: "Immutable" });
  });

  it("refuses a malformed immutable version id without executing the mutable draft", async () => {
    const mutable: FlowGraph = { id: "mutable", name: "Mutable", nodes: [], edges: [] };
    state.root = { id: "root", ownerId: "owner", name: "Mutable", graph: mutable, updatedAt: 1 };
    const malformed = new Request("https://agents.suedeai.ai/api/v2/flows/root/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ triggerInput: {}, flowVersionId: "not-a-uuid" }),
    });

    const response = await POST(malformed, { params: Promise.resolve({ flowId: "root" }) });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.projectRepoCalls).toBe(0);
    expect(state.runCalls).toEqual([]);
  });
});
