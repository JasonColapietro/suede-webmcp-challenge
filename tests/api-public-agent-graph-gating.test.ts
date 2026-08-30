import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  publicGraph: null as null | Record<string, unknown>,
  resolvePublicAgentGraph: vi.fn(),
}));

const agent = {
  id: "agent-1", flowId: "flow-1", slug: "direct-slug",
  status: "live" as "live" | "draft",
  priceUsdc: 0, createdAt: 1, settlementLive: false,
};
const draftApiGraph = {
  schemaVersion: 2, id: "draft-api", name: "Draft API",
  nodes: [{ id: "api", type: "api.operation", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
  edges: [], variables: [], groups: [], annotations: [],
};
const flow = { id: "flow-1", ownerId: "owner-1", name: "Direct", graph: draftApiGraph, updatedAt: 1 };

vi.mock("@/lib/agents", () => ({ resolveAgent: vi.fn(async () => agent) }));
vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => ({
    getFlow: vi.fn(async () => flow),
    getAgentBySlug: vi.fn(async () => agent),
    countRunsByAgent: vi.fn(async () => ({ "agent-1": 0 })),
    listSchedulesByAgents: vi.fn(async () => []),
    getLastPromoOutput: vi.fn(async () => null),
  })),
}));
vi.mock("@/lib/projects/provider", () => ({ getProjectRepo: vi.fn(async () => ({})) }));
vi.mock("@/lib/projects/public-agent-graph", () => ({
  resolvePublicAgentGraph: (...args: unknown[]) => state.resolvePublicAgentGraph(...args),
  resolvePublicAgentRelease: async () => state.publicGraph === null
    ? null
    : {
        graph: state.publicGraph,
        resourceDependencies: [],
        release: {
          ownerId: flow.ownerId,
          flowId: flow.id,
          deploymentId: "deployment-live",
          environmentId: "environment-live",
          flowVersionId: "version-live",
          semanticHash: "a".repeat(64),
          fullHash: "b".repeat(64),
        },
      },
}));
const card = await import("@/app/api/agents/[agent]/.well-known/agent-card/route");
const x402 = await import("@/app/api/agents/[agent]/.well-known/x402/route");
const a2a = await import("@/app/api/agents/[agent]/a2a/route");
const template = await import("@/app/api/agents/[agent]/template/route");
const page = await import("@/app/a/[slug]/page");

const request = new Request("https://agents.suedeai.ai/api/agents/direct-slug");
const context = { params: Promise.resolve({ agent: "direct-slug" }) };

beforeEach(() => {
  agent.status = "live";
  state.publicGraph = null;
  state.resolvePublicAgentGraph.mockReset().mockImplementation(async () => state.publicGraph);
});

describe("direct public slug exact-version gating", () => {
  it("returns 404 across human and machine surfaces for unpublished drafts", async () => {
    agent.status = "draft";
    state.publicGraph = {
      id: "draft-leak-canary",
      name: "Must remain private",
      nodes: [],
      edges: [],
    };

    for (const route of [card.GET, x402.GET, a2a.GET, template.GET]) {
      expect((await route(request, context)).status).toBe(404);
    }
    expect(await page.generateMetadata({ params: Promise.resolve({ slug: agent.slug }) }))
      .toMatchObject({ robots: { index: false, follow: true } });
    await expect(page.default({ params: Promise.resolve({ slug: agent.slug }) }))
      .rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(state.resolvePublicAgentGraph).not.toHaveBeenCalled();
  });

  it("hides every human and machine claim when active exact truth is unavailable", async () => {
    for (const route of [card.GET, x402.GET, a2a.GET, template.GET]) {
      const response = await route(request, context);
      expect(response.status).toBe(404);
    }
    expect(await page.generateMetadata({ params: Promise.resolve({ slug: agent.slug }) }))
      .toMatchObject({
        title: { absolute: expect.stringContaining("not found") },
        robots: { index: false, follow: true },
      });
    await expect(page.default({ params: Promise.resolve({ slug: agent.slug }) }))
      .rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("exports the safe exact graph and never leaks the mutable API Draft", async () => {
    state.publicGraph = {
      id: "published-safe", name: "Published safe",
      nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    for (const route of [card.GET, x402.GET, a2a.GET]) {
      expect((await route(request, context)).status).toBe(200);
    }
    const response = await template.GET(request, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.flow).toEqual(state.publicGraph);
    expect(JSON.stringify(body)).not.toContain("api.operation");
    const metadata = await page.generateMetadata({ params: Promise.resolve({ slug: agent.slug }) });
    expect(metadata.title).toEqual({
      absolute: "Direct · direct-slug | Suede Agent Studio",
    });
    expect(metadata.description).toContain("/a/direct-slug");
    expect(metadata.robots).not.toEqual(expect.objectContaining({ index: false }));
  });

  it("redacts a hostile legacy HTTP graph again at the downloadable template boundary", async () => {
    state.publicGraph = {
      id: "published-legacy-http", name: "Published legacy HTTP",
      nodes: [{
        id: "request", type: "http", position: { x: 0, y: 0 },
        params: {
          url: "https://example.com",
          headers: {
            Accept: "application/json",
            "X-Request-Id": "safe-request-id",
            Authorization: "Bearer template-route-canary",
            "X-Api-Key": "template-api-key-canary",
          },
          password: "template-direct-password-canary",
        },
      }],
      edges: [],
    };

    const response = await template.GET(request, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.flow.nodes[0].params).toEqual({
      url: "https://example.com",
      headers: { Accept: "application/json", "X-Request-Id": "safe-request-id" },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /template-(?:route|api-key|direct-password)-canary/,
    );
    expect(JSON.parse(body.files["flow.json"])).toEqual(body.flow);
  });
});
