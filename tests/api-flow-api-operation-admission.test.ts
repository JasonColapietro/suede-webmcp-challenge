import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_CONNECTOR_LAB_ENABLED = "";

const state = vi.hoisted(() => ({
  mutateFlow: vi.fn(),
  getOwnedFlow: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  resolveOwnerId: vi.fn(async () => "owner-1"),
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error {},
}));
vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => ({
    mutateFlow: (...args: unknown[]) => state.mutateFlow(...args),
    getOwnedFlow: (...args: unknown[]) => state.getOwnedFlow(...args),
  })),
}));

const { POST } = await import("@/app/api/flows/route");
const { PUT } = await import("@/app/api/flows/[id]/route");

function apiGraph() {
  return {
    schemaVersion: 2,
    id: "api-graph",
    name: "API graph",
    nodes: [{
      id: "api",
      type: "api.operation",
      params: {
        connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000601",
        operationVersionId: "00000000-0000-4000-8000-000000000602",
        operationId: "createThing",
        connectorProjectionHash: "1".repeat(64),
        operationProjectionHash: "2".repeat(64),
        schemaHash: "3".repeat(64),
      },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function request(url: string): Request {
  return new Request(url, {
    method: url.endsWith("/api/flows") ? "POST" : "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "API graph", graph: apiGraph() }),
  });
}

function legacyRequest(url: string): Request {
  const { schemaVersion: _schemaVersion, variables: _variables, groups: _groups,
    annotations: _annotations, ...legacy } = apiGraph();
  return new Request(url, {
    method: url.endsWith("/api/flows") ? "POST" : "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "API graph", graph: legacy }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.getOwnedFlow.mockResolvedValue({ id: "flow-1", ownerId: "owner-1" });
});

describe("flag-off API operation mutation admission", () => {
  it("refuses authenticated POST and PUT before the mutation boundary", async () => {
    const post = await POST(request("https://agents.suedeai.ai/api/flows"));
    const put = await PUT(
      request("https://agents.suedeai.ai/api/flows/flow-1"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );

    expect(post.status).toBe(400);
    expect(put.status).toBe(400);
    expect(await post.json()).toEqual({ error: "invalid subflow reference" });
    expect(await put.json()).toEqual({ error: "invalid subflow reference" });
    expect(state.mutateFlow).not.toHaveBeenCalled();
  });

  it("maps unversioned API nodes to the fixed v1 refusal before mutation", async () => {
    const post = await POST(legacyRequest("https://agents.suedeai.ai/api/flows"));
    const put = await PUT(
      legacyRequest("https://agents.suedeai.ai/api/flows/flow-1"),
      { params: Promise.resolve({ id: "flow-1" }) },
    );

    expect(post.status).toBe(409);
    expect(put.status).toBe(409);
    expect(await post.json()).toEqual({ error: "API_OPERATION_V1_UNSUPPORTED" });
    expect(await put.json()).toEqual({ error: "API_OPERATION_V1_UNSUPPORTED" });
    expect(state.mutateFlow).not.toHaveBeenCalled();
  });
});
