import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCanonicalIdempotencyKey, isCanonicalOpaqueId, parseDurableActionBody, parseDurableRunBody, readBoundedJson } from "@/lib/runtime/api-contract";

const state = vi.hoisted(() => ({
  trace: [] as string[],
  ownerCalls: 0, readOwnerCalls: 0, adoptionCalls: 0, providerCalls: 0, flowCalls: 0, versionCalls: 0, enqueueCalls: 0, viewCalls: 0, controlCalls: 0,
  ownerError: false, runtimeAvailable: true, owned: true, version: true,
  viewState: "queued" as "queued" | "succeeded",
  enqueueStatus: "created" as "created" | "duplicate" | "conflict" | "not-found" | "refused" | "admission-refused",
  actionStatus: "applied" as "applied" | "idempotent" | "conflict" | "not-found" | "refused",
}));

class TestUnauthenticatedError extends Error { readonly status = 401; }
vi.mock("@/lib/auth", () => ({
  UnauthenticatedOwnerError: TestUnauthenticatedError,
  resolveOwnerId: async () => { state.trace.push("resolveOwnerId"); state.ownerCalls += 1; if (state.ownerError) throw new TestUnauthenticatedError(); return "owner"; },
  resolveReadOnlyOwnerId: async () => { state.trace.push("resolveReadOnlyOwnerId"); state.readOwnerCalls += 1; if (state.ownerError) throw new TestUnauthenticatedError(); return "owner"; },
  adoptAnonymousWorkspaceForVerifiedOwner: async () => { state.trace.push("adoptAnonymousWorkspace"); state.adoptionCalls += 1; },
}));

const graph = { id: "flow", name: "Flow", nodes: [], edges: [] };
vi.mock("@/lib/db/repo", () => ({ getRepo: async () => { state.trace.push("getRepo"); return ({
  getOwnedFlow: async () => { state.trace.push("getOwnedFlow"); state.flowCalls += 1; return state.owned ? { id: "flow", ownerId: "owner", graph } : null; },
});
} }));
vi.mock("@/lib/projects/provider", () => ({ getProjectRepo: async () => { state.trace.push("getProjectRepo"); return ({
  getFlowVersion: async () => { state.trace.push("getFlowVersion"); state.versionCalls += 1; return state.version ? { id: "version", flowId: "flow", graph, fullHash: "d".repeat(64), semanticHash: "s".repeat(64), dependencies: [] } : null; },
});
} }));
vi.mock("@/lib/flow/subflow-resolver", () => ({ createSubflowResolver: () => async () => { throw new Error("unused"); } }));

const projection = { schemaVersion: 1, executionId: "run", definitionHash: "d".repeat(64), sequence: 2, state: "queued", desiredState: "running", attempt: 0, jobId: "job", attemptId: null, costMicroUsdc: 0, tokens: 0, output: null, error: null, nodes: {}, logs: [], logCount: 0, controlRequests: [], controlRequestCount: 0, retry: null, deadLetter: null } as const;
const view = { executionId: "run", flowId: "flow", flowVersionId: "version", parentExecutionId: null, createdAt: 1, updatedAt: 1, finishedAt: null, deadlineAt: 2, projection } as const;
const repository = {
  hasExecution: async () => state.owned,
  getExecutionView: async () => { state.trace.push("getExecutionView"); state.viewCalls += 1; return state.owned ? { ...view, projection: { ...projection, state: state.viewState } } : null; },
  listEvents: async () => [],
  controlExecution: async () => { state.trace.push("controlExecution"); state.controlCalls += 1; return state.actionStatus === "applied" || state.actionStatus === "idempotent" ? { status: state.actionStatus, execution: projection } : { status: state.actionStatus }; },
  retryExecution: async () => ({ status: "created", execution: { ...view, executionId: "retry", parentExecutionId: "run", projection: { ...projection, executionId: "retry" } } }),
};
class TestDurableRuntimeUnavailableError extends Error {}
vi.mock("@/lib/runtime/provider", () => ({
  DurableRuntimeUnavailableError: TestDurableRuntimeUnavailableError,
  getDurableRuntimeRepository: async () => {
    state.trace.push("getDurableRuntimeRepository");
    state.providerCalls += 1;
    if (!state.runtimeAvailable) throw new TestDurableRuntimeUnavailableError();
    return repository;
  },
}));
vi.mock("@/lib/runtime/enqueue", () => ({ enqueueDurableExecution: async () => {
  state.trace.push("enqueueDurableExecution");
  state.enqueueCalls += 1;
  return state.enqueueStatus === "created" || state.enqueueStatus === "duplicate" ? { status: state.enqueueStatus, execution: projection }
    : state.enqueueStatus === "admission-refused" ? { status: "admission-refused", code: "unsafe-node" } : { status: state.enqueueStatus };
} }));

const enqueueRoute = await import("@/app/api/v3/flows/[flowId]/runs/route");
const runRoute = await import("@/app/api/v3/runs/[runId]/route");
const actionRoute = await import("@/app/api/v3/runs/[runId]/actions/route");
const eventsRoute = await import("@/app/api/v3/runs/[runId]/events/route");

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function streamed(url: string, body: ReadableStream<Uint8Array>, init: Omit<RequestInit, "body"> = {}): Request {
  return new Request(url, { method: "POST", ...init, body, duplex: "half" } as RequestInit);
}
const flowParams = { params: Promise.resolve({ flowId: "flow" }) };
const runParams = { params: Promise.resolve({ runId: "run" }) };

beforeEach(() => {
  vi.unstubAllEnvs();
  state.trace.length = 0;
  Object.assign(state, { ownerCalls: 0, readOwnerCalls: 0, adoptionCalls: 0, providerCalls: 0, flowCalls: 0, versionCalls: 0, enqueueCalls: 0, viewCalls: 0, controlCalls: 0, ownerError: false, runtimeAvailable: true, owned: true, version: true, viewState: "queued", enqueueStatus: "created", actionStatus: "applied" });
});

describe("private v3 durable run API", () => {
  it("capability-gates Supabase to exact-version streaming before durable storage", async () => {
    vi.stubEnv("DB_DRIVER", "supabase");
    const response = await enqueueRoute.POST(post(
      "https://studio.test/api/v3/flows/flow/runs",
      { flowVersionId: "version" },
      { "idempotency-key": "key" },
    ), flowParams);
    expect(response.status).toBe(422);
    expect(state.providerCalls).toBe(0);
    expect(state.adoptionCalls).toBe(0);
  });

  it("uses descriptor-safe exact bounded body, path, and key contracts", async () => {
    expect(parseDurableRunBody({ flowVersionId: "v", extra: true })).toBeNull();
    expect(parseDurableRunBody({ flowVersionId: "v", triggerInput: { value: "x".repeat(65_537) } })).toBeNull();
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "flowVersionId", { enumerable: true, get: () => { throw new Error("getter"); } });
    expect(() => parseDurableRunBody(hostile)).not.toThrow(); expect(parseDurableRunBody(hostile)).toBeNull();
    expect(parseDurableActionBody({ action: "cancel", extra: 1 })).toBeNull();
    expect(isCanonicalIdempotencyKey("雪".repeat(43))).toBe(false);
    expect(isCanonicalOpaqueId("雪".repeat(171), 512)).toBe(false);

    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const request = streamed("https://studio.test/x", body, { headers: { "content-type": "application/json" }, signal: abort.signal });
    const pending = readBoundedJson(request); abort.abort();
    await expect(pending).resolves.toBeNull();

    expect(parseDurableRunBody({ flowVersionId: "version", triggerInput: { ok: [1, true, null] }, runVariables: {} })).toEqual({ flowVersionId: "version", triggerInput: { ok: [1, true, null] }, runVariables: {} });
    let deep: unknown = "leaf"; for (let index = 0; index < 30; index += 1) deep = { child: deep };
    expect(parseDurableRunBody({ flowVersionId: "version", triggerInput: { deep } })).toBeNull();
    expect(parseDurableRunBody({ flowVersionId: "version", triggerInput: Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`k${index}`, index])) })).toBeNull();
    expect(parseDurableRunBody(JSON.parse('{"flowVersionId":"version","triggerInput":{"__proto__":1}}'))).toBeNull();

    const oversizedByHeader = new Request("https://studio.test/x", { method: "POST", headers: { "content-length": String(256 * 1024 + 1) }, body: "{}" });
    await expect(readBoundedJson(oversizedByHeader)).resolves.toBeNull();
    let cancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedJson(streamed("https://studio.test/x", oversizedStream))).resolves.toBeNull();
    expect(cancelled).toBe(true);
    await expect(readBoundedJson(new Request("https://studio.test/x", { method: "POST", body: new Uint8Array([0xff]) }))).resolves.toBeNull();
    await expect(readBoundedJson(new Request("https://studio.test/x", { method: "POST", body: "{" }))).resolves.toBeNull();
  });
  it("enforces same-origin, no Authorization, then media before identity", async () => {
    const missingOrigin = new Request("https://studio.test/api/v3/flows/flow/runs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await enqueueRoute.POST(missingOrigin, flowParams)).status).toBe(403);
    expect((await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", {}, { authorization: "Bearer x" }), flowParams)).status).toBe(403);
    expect((await enqueueRoute.POST(new Request("https://studio.test/api/v3/flows/flow/runs", { method: "POST", headers: { origin: "https://studio.test", "content-type": "text/plain" }, body: "{}" }), flowParams)).status).toBe(415);
    expect(state.ownerCalls).toBe(0); expect(state.readOwnerCalls).toBe(0); expect(state.providerCalls).toBe(0);
  });

  it("authenticates then owner-filters before idempotency/body/version work", async () => {
    state.ownerError = true;
    expect((await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", {}, { "idempotency-key": "key" }), flowParams)).status).toBe(401);
    state.ownerError = false; state.owned = false;
    const hostile = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const request = streamed("https://studio.test/api/v3/flows/flow/runs", hostile, { headers: { origin: "https://studio.test", "content-type": "application/json" } });
    expect((await enqueueRoute.POST(request, flowParams)).status).toBe(404);
    expect(state.versionCalls).toBe(0); expect(state.enqueueCalls).toBe(0);
  });

  it("authenticates before durable refusal and touches no legacy or action storage when unavailable", async () => {
    state.ownerError = true; state.runtimeAvailable = false;
    expect((await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", { flowVersionId: "version" }, { "idempotency-key": "key" }), flowParams)).status).toBe(401);
    expect(state.readOwnerCalls).toBe(1); expect(state.providerCalls).toBe(0);
    expect(state.trace).toEqual(["resolveReadOnlyOwnerId"]);

    state.ownerError = false;
    state.trace.length = 0;
    expect((await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", { flowVersionId: "version" }, { "idempotency-key": "key" }), flowParams)).status).toBe(503);
    expect(state.readOwnerCalls).toBe(2); expect(state.providerCalls).toBe(1);
    expect(state.adoptionCalls).toBe(0); expect(state.flowCalls).toBe(0); expect(state.versionCalls).toBe(0); expect(state.enqueueCalls).toBe(0);
    expect(state.trace).toEqual(["resolveReadOnlyOwnerId", "getDurableRuntimeRepository"]);

    state.trace.length = 0;
    expect((await actionRoute.POST(post("https://studio.test/api/v3/runs/run/actions", { action: "pause" }), runParams)).status).toBe(503);
    expect(state.providerCalls).toBe(2); expect(state.controlCalls).toBe(0);
    expect(state.adoptionCalls).toBe(0); expect(state.flowCalls).toBe(0); expect(state.versionCalls).toBe(0); expect(state.enqueueCalls).toBe(0);
    expect(state.trace).toEqual(["resolveReadOnlyOwnerId", "getDurableRuntimeRepository"]);
  });

  it("orders successful enqueue identity, durable storage, adoption, owner lookup, version, then persistence", async () => {
    const response = await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", { flowVersionId: "version" }, { "idempotency-key": "key" }), flowParams);
    expect(response.status).toBe(202);
    expect(state.trace).toEqual([
      "resolveReadOnlyOwnerId", "getDurableRuntimeRepository", "adoptAnonymousWorkspace",
      "getRepo", "getOwnedFlow", "getProjectRepo", "getFlowVersion", "enqueueDurableExecution",
    ]);
  });

  it("strictly requires immutable version body and bounded idempotency, then only enqueues", async () => {
    expect((await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", { flowVersionId: "version" }), flowParams)).status).toBe(400);
    expect((await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", { flowVersionId: "draft" }, { "idempotency-key": "key" }), flowParams)).status).toBe(400);
    const response = await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", { flowVersionId: "version", triggerInput: {}, runVariables: {} }, { "idempotency-key": "key" }), flowParams);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: "run", state: "queued", statusUrl: "/api/v3/runs/run", eventsUrl: "/api/v3/runs/run/events" });
    expect(state.enqueueCalls).toBe(1);
  });

  it.each([["conflict", 409], ["not-found", 404], ["admission-refused", 422], ["refused", 503]] as const)("maps enqueue %s to fixed private %i", async (status, expected) => {
    state.enqueueStatus = status;
    const response = await enqueueRoute.POST(post("https://studio.test/api/v3/flows/flow/runs", { flowVersionId: "version" }, { "idempotency-key": "key" }), flowParams);
    expect(response.status).toBe(expected); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("uses read-only identity and returns a sanitized owner view", async () => {
    const response = await runRoute.GET(new Request("https://studio.test/api/v3/runs/run"), runParams);
    expect(response.status).toBe(200); expect(state.readOwnerCalls).toBe(1); expect(state.ownerCalls).toBe(0);
    expect(JSON.stringify(await response.json())).not.toContain("definitionHash");
    state.owned = false;
    expect((await runRoute.GET(new Request("https://studio.test/api/v3/runs/run"), runParams)).status).toBe(404);
  });

  it("owner-filters actions before parsing and requires idempotency only for retry", async () => {
    state.owned = false;
    expect((await actionRoute.POST(post("https://studio.test/api/v3/runs/run/actions", { action: "pause" }), runParams)).status).toBe(404);
    state.owned = true;
    expect((await actionRoute.POST(post("https://studio.test/api/v3/runs/run/actions", { action: "pause" }, { "idempotency-key": "wrong" }), runParams)).status).toBe(400);
    expect((await actionRoute.POST(post("https://studio.test/api/v3/runs/run/actions", { action: "retry" }), runParams)).status).toBe(400);
    expect((await actionRoute.POST(post("https://studio.test/api/v3/runs/run/actions", { action: "pause" }), runParams)).status).toBe(200);
    const retry = await actionRoute.POST(post("https://studio.test/api/v3/runs/run/actions", { action: "retry" }, { "idempotency-key": "retry-key" }), runParams);
    expect(retry.status).toBe(202); expect(await retry.json()).toMatchObject({ action: "retry", runId: "retry", state: "queued" });
  });

  it("owner-filters SSE before cursor parsing and rejects cursor ahead of persisted head", async () => {
    state.owned = false;
    expect((await eventsRoute.GET(new Request("https://studio.test/api/v3/runs/run/events?after=bad"), runParams)).status).toBe(404);
    state.owned = true;
    expect((await eventsRoute.GET(new Request("https://studio.test/api/v3/runs/run/events?after=bad"), runParams)).status).toBe(400);
    expect((await eventsRoute.GET(new Request("https://studio.test/api/v3/runs/run/events?after=3"), runParams)).status).toBe(400);
    state.viewState = "succeeded";
    const response = await eventsRoute.GET(new Request("https://studio.test/api/v3/runs/run/events?after=2"), runParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(response.headers.get("connection")).toBeNull();
    expect(await response.text()).toBe("");
  });
});
