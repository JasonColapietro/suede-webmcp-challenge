import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ownerId: "owner-1",
  authError: null as Error | null,
  projectError: null as Error | null,
  ownedFlow: { id: "flow-1" } as object | null,
  flowContext: null as object | null,
  admission: { ok: true } as { ok: true } | { ok: false; retryAfterSec: number },
  resolveOwnerId: vi.fn(),
  tryAcquire: vi.fn(),
  getOwnedFlow: vi.fn(),
  getFlowContext: vi.fn(),
  runner: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error {},
  resolveReadOnlyOwnerId: state.resolveOwnerId,
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => ({
    getOwnedFlow: state.getOwnedFlow,
    saveFlow: vi.fn(() => { throw new Error("write attempted"); }),
    createRun: vi.fn(() => { throw new Error("write attempted"); }),
    appendStep: vi.fn(() => { throw new Error("write attempted"); }),
    finishRun: vi.fn(() => { throw new Error("write attempted"); }),
  })),
}));

vi.mock("@/lib/projects/provider", () => ({
  ProjectStoreUnavailableError: class ProjectStoreUnavailableError extends Error {},
  getProjectRepo: vi.fn(async () => {
    if (state.projectError) throw state.projectError;
    return {
      getFlowContext: state.getFlowContext,
      ensurePersonalContext: vi.fn(() => { throw new Error("write attempted"); }),
      bindFlow: vi.fn(() => { throw new Error("write attempted"); }),
    };
  }),
}));

vi.mock("@/lib/flow/test-route-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flow/test-route-admission")>();
  return {
    ...actual,
    createTestRouteAdmission: vi.fn(() => ({ tryAcquire: state.tryAcquire })),
  };
});

vi.mock("@/lib/flow/test-runner", () => ({
  runEphemeralScopedTest: state.runner,
}));

import * as route from "@/app/api/v2/flows/[flowId]/test/route";

const boundaryKey = JSON.stringify(["edge-input", "a-b", "a", "result", "b", "in"]);

function body(environmentId = "environment-test") {
  return {
    graph: {
      schemaVersion: 2,
      id: "test-graph",
      name: "Test graph",
      nodes: [
        { id: "a", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "b", type: "transform", params: { expression: "input" }, bindings: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "a-b", source: "a", sourceHandle: "result", target: "b", targetHandle: "in" }],
      variables: [], groups: [], annotations: [],
    },
    scope: { kind: "node", nodeId: "b" },
    pinnedInputs: { [boundaryKey]: { value: "fixture" } },
    mode: "test",
    environmentId,
  };
}

function projectContext(environment = { id: "environment-test", projectId: "project-1", kind: "test" }) {
  return {
    binding: { flowId: "flow-1", projectId: "project-1", workbookId: "workbook-1" },
    project: { id: "project-1" },
    environments: [environment],
  };
}

function request(value: unknown = body(), signal?: AbortSignal): Request {
  return new Request("https://agents.suedeai.ai/api/v2/flows/flow-1/test", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://agents.suedeai.ai" },
    body: JSON.stringify(value),
    signal,
  });
}

const context = (flowId = "flow-1") => ({ params: Promise.resolve({ flowId }) });

beforeEach(() => {
  vi.useRealTimers();
  state.ownerId = "owner-1";
  state.authError = null;
  state.projectError = null;
  state.ownedFlow = { id: "flow-1" };
  state.flowContext = projectContext();
  state.admission = { ok: true };
  state.resolveOwnerId.mockReset().mockImplementation(async () => {
    if (state.authError) throw state.authError;
    return state.ownerId;
  });
  state.tryAcquire.mockReset().mockImplementation(() => state.admission.ok
    ? { ok: true, release: state.release }
    : state.admission);
  state.getOwnedFlow.mockReset().mockImplementation(async () => state.ownedFlow);
  state.getFlowContext.mockReset().mockImplementation(async () => state.flowContext);
  state.runner.mockReset().mockResolvedValue({
    runId: "ephemeral-scoped-test", status: "done", costUsdc: 0,
    outputs: {}, events: [], logs: [],
  });
  state.release.mockReset();
});

describe("POST /api/v2/flows/[flowId]/test", () => {
  it("returns the sanitized runner result as private JSON using only exact owner-scoped reads", async () => {
    const response = await route.POST(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ result: { status: "done", costUsdc: 0 } });
    expect(state.getOwnedFlow).toHaveBeenCalledWith("flow-1", "owner-1");
    expect(state.getFlowContext).toHaveBeenCalledWith("flow-1", "owner-1");
    expect(state.runner).toHaveBeenCalledTimes(1);
    expect(state.runner.mock.calls[0]?.[0]).toEqual(body());
    expect(state.runner.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("fails privately before project lookup or execution for a foreign flow", async () => {
    state.ownedFlow = null;
    const response = await route.POST(request(), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(state.getFlowContext).not.toHaveBeenCalled();
    expect(state.runner).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing context", null],
    ["foreign environment", projectContext({ id: "other", projectId: "project-1", kind: "test" })],
    ["live environment", projectContext({ id: "environment-test", projectId: "project-1", kind: "live" })],
    ["cross-project environment", projectContext({ id: "environment-test", projectId: "project-2", kind: "test" })],
  ])("rejects %s without executing", async (_label, flowContext) => {
    state.flowContext = flowContext;
    const response = await route.POST(request(), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(state.runner).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and non-canonical requests without echoing input", async () => {
    const response = await route.POST(request({ ...body(), mode: "live", marker: "secret-marker" }), context());
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("secret-marker");
    expect(state.runner).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it.each(["", " flow-1", "flow-1\u0000", "x".repeat(513)])(
    "rejects a non-exact bounded flow id",
    async (flowId) => {
      const response = await route.POST(request(), context(flowId));
      expect(response.status).toBe(400);
      expect(state.getOwnedFlow).not.toHaveBeenCalled();
      expect(state.runner).not.toHaveBeenCalled();
      expect(state.release).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a fixed private admission error and Retry-After", async () => {
    state.admission = { ok: false, retryAfterSec: 7 };
    const response = await route.POST(request(), context());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "too many test runs" });
    expect(state.getOwnedFlow).not.toHaveBeenCalled();
  });

  it.each([
    ["authorization", "Bearer secret", 403, "forbidden"],
    ["origin", "https://evil.example", 403, "forbidden"],
    ["content-encoding", "gzip", 415, "unsupported media type"],
    ["content-type", "text/plain", 415, "unsupported media type"],
  ] as const)("rejects actual %s header behavior before auth or admission", async (header, value, status, error) => {
    const bad = request();
    bad.headers.set(header, value);
    const response = await route.POST(bad, context());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error });
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect(state.tryAcquire).not.toHaveBeenCalled();
    expect(state.getOwnedFlow).not.toHaveBeenCalled();
    expect(state.runner).not.toHaveBeenCalled();
  });

  it("returns a sanitized runner cancellation when neither route signal caused it", async () => {
    state.runner.mockResolvedValue({
      runId: "ephemeral-scoped-test", status: "cancelled", costUsdc: 0,
      outputs: {}, events: [], logs: [],
    });
    const response = await route.POST(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { status: "cancelled", costUsdc: 0 } });
  });

  it("returns a runner error result in the HTTP 200 envelope", async () => {
    state.runner.mockResolvedValue({
      runId: "ephemeral-scoped-test", status: "error", costUsdc: 0,
      outputs: {}, events: [], logs: [],
    });
    const response = await route.POST(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { status: "error", costUsdc: 0 } });
  });

  it("returns a fixed private 500 and releases admission when the runner throws", async () => {
    state.runner.mockRejectedValue(new Error("secret-canary"));
    const response = await route.POST(request(), context());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret-canary");
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("returns fixed private auth and project-store errors", async () => {
    const authModule = await import("@/lib/auth");
    state.authError = new authModule.UnauthenticatedOwnerError();
    const unauthenticated = await route.POST(request(), context());
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: "Authentication required" });
    expect(state.release).not.toHaveBeenCalled();

    state.authError = null;
    const projectModule = await import("@/lib/projects/provider");
    state.projectError = new projectModule.ProjectStoreUnavailableError();
    const unavailable = await route.POST(request(), context());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "project store unavailable" });
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("maps the hard deadline to a fixed private 504 and releases admission", async () => {
    vi.useFakeTimers();
    state.runner.mockImplementation(async (_raw, options: { signal: AbortSignal }) =>
      new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true })),
    );
    const pending = route.POST(request(), context());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "test timed out" });
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("bounds a stuck owner-flow read by the same hard deadline", async () => {
    vi.useFakeTimers();
    state.getOwnedFlow.mockImplementation(() => new Promise(() => undefined));
    const pending = route.POST(request(), context());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "test timed out" });
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled authentication before admission", async () => {
    vi.useFakeTimers();
    state.resolveOwnerId.mockImplementation(() => new Promise(() => undefined));
    const pending = route.POST(request(), context());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "test timed out" });
    expect(state.tryAcquire).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });

  it("returns 408 for a pre-aborted request without auth or admission", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await route.POST(request(body(), controller.signal), context());
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "request cancelled" });
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect(state.tryAcquire).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });

  it("bounds and releases a stalled request body by the same hard deadline", async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const stalledRequest = new Request("https://agents.suedeai.ai/api/v2/flows/flow-1/test", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agents.suedeai.ai" },
      body: stalled,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = route.POST(stalledRequest, context());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "test timed out" });
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it("maps client cancellation to a fixed private 408", async () => {
    const controller = new AbortController();
    state.runner.mockImplementation(async (_raw, options: { signal: AbortSignal }) => {
      if (options.signal.aborted) return { status: "cancelled" };
      return new Promise((resolve) =>
        options.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }),
      );
    });
    const pending = route.POST(request(body(), controller.signal), context());
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "request cancelled" });
  });
});

describe("test route method contract", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const)(
    "returns strict private 405 for %s",
    async (method) => {
      const response = await route[method]();
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );
});
