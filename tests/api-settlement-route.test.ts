/**
 * Auth regressions for POST /api/agents/[agent]/settlement: same-origin
 * signed-in callers resolve through resolveOwnerId, anonymous workspace
 * Bearer callers retain compatibility, and owner scoping fails closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

const state = vi.hoisted(() => {
  class UnauthenticatedOwnerError extends Error {
    status = 401;
    constructor() {
      super("Authentication required");
      this.name = "UnauthenticatedOwnerError";
    }
  }
  return {
    authorization: null as string | null,
    resolveOwnerId: vi.fn(),
    getRepo: vi.fn(),
    UnauthenticatedOwnerError,
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers(
    state.authorization ? { Authorization: state.authorization } : undefined,
  )),
}));
vi.mock("@/lib/auth", () => ({
  resolveOwnerId: (...args: unknown[]) => state.resolveOwnerId(...args),
  SUEDE_OWNER_PREFIX: "sb:",
  UnauthenticatedOwnerError: state.UnauthenticatedOwnerError,
}));
vi.mock("@/lib/db/repo", () => ({
  getRepo: (...args: unknown[]) => state.getRepo(...args),
}));

let repo: SqliteRepo;

async function seedAgent(ownerId: string): Promise<{ agentId: string; slug: string }> {
  const flow = await repo.saveFlow({
    ownerId,
    name: "Settlement route flow",
    graph: { id: `g-${Math.random()}`, name: "test", nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: `settlement-route-${Math.random().toString(36).slice(2, 7)}`,
    status: "live",
    priceUsdc: 0.25,
  });
  return { agentId: agent.id, slug: agent.slug };
}

const SESSION_HEADERS = {
  "content-type": "application/json",
  origin: "https://agents.suedeai.ai",
  "sec-fetch-site": "same-origin",
} as const;

function request(live: boolean, headers: HeadersInit = SESSION_HEADERS): Request {
  return new Request("https://agents.suedeai.ai/api/agents/test/settlement", {
    method: "POST",
    headers,
    body: JSON.stringify({ live }),
  });
}

function context(agent: string) {
  return { params: Promise.resolve({ agent }) };
}

async function route() {
  return import("@/app/api/agents/[agent]/settlement/route");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.authorization = null;
  repo = new SqliteRepo(":memory:");
  state.getRepo.mockImplementation(async () => repo);
});

describe("POST /api/agents/[agent]/settlement auth", () => {
  it("accepts a verified same-origin owner without a browser-supplied bearer", async () => {
    const owner = "sb:verified-user";
    const { agentId, slug } = await seedAgent(owner);
    state.resolveOwnerId.mockResolvedValue(owner);
    const { POST } = await route();

    const response = await POST(request(true), context(slug));

    expect(response.status).toBe(200);
    expect((await repo.getAgent(agentId))?.settlementLive).toBe(true);
    expect(state.resolveOwnerId).toHaveBeenCalledTimes(1);
  });

  it("preserves anonymous workspace Bearer compatibility", async () => {
    const owner = "workspace-owner-token";
    const { agentId, slug } = await seedAgent(owner);
    state.authorization = `Bearer ${owner}`;
    const { POST } = await route();

    // Programmatic Bearer requests do not need browser Origin or Fetch
    // Metadata headers; preserve that public API contract.
    const response = await POST(
      request(true, { "content-type": "application/json" }),
      context(slug),
    );

    expect(response.status).toBe(200);
    expect((await repo.getAgent(agentId))?.settlementLive).toBe(true);
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and forged sb bearer callers", async () => {
    state.resolveOwnerId.mockRejectedValueOnce(new state.UnauthenticatedOwnerError());
    const { POST } = await route();

    const unauthenticated = await POST(request(false), context("missing"));
    expect(unauthenticated.status).toBe(401);

    state.authorization = "Bearer sb:public-user-id";
    const forged = await POST(request(false), context("missing"));
    expect(forged.status).toBe(401);
  });

  it("returns 404 and leaves state unchanged for a verified cross-owner caller", async () => {
    const { agentId, slug } = await seedAgent("sb:owner-a");
    state.resolveOwnerId.mockResolvedValue("sb:owner-b");
    const { POST } = await route();

    const response = await POST(request(true), context(slug));

    expect(response.status).toBe(404);
    expect((await repo.getAgent(agentId))?.settlementLive).toBe(false);
  });

  it("rejects sibling Suede origins and cross-site Fetch Metadata before auth or mutation", async () => {
    const owner = "sb:verified-user";
    const { agentId, slug } = await seedAgent(owner);
    state.resolveOwnerId.mockResolvedValue(owner);
    const { POST } = await route();

    const siblingOrigin = await POST(
      request(true, { ...SESSION_HEADERS, origin: "https://suedeai.ai" }),
      context(slug),
    );
    expect(siblingOrigin.status).toBe(403);

    const crossSite = await POST(
      request(true, { ...SESSION_HEADERS, "sec-fetch-site": "cross-site" }),
      context(slug),
    );
    expect(crossSite.status).toBe(403);
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect((await repo.getAgent(agentId))?.settlementLive).toBe(false);
  });

  it("rejects text/plain session-cookie mutations before auth or mutation", async () => {
    const owner = "sb:verified-user";
    const { agentId, slug } = await seedAgent(owner);
    state.resolveOwnerId.mockResolvedValue(owner);
    const { POST } = await route();

    const response = await POST(
      request(true, { ...SESSION_HEADERS, "content-type": "text/plain" }),
      context(slug),
    );

    expect(response.status).toBe(415);
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect((await repo.getAgent(agentId))?.settlementLive).toBe(false);
  });
});
