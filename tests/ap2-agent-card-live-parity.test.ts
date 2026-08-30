import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activeDeployment: null as null | {
    id: string;
    flowId: string;
    flowVersionId: string;
    environmentId: string;
    status: "live";
    createdAt: number;
  },
  status: "live" as "live" | "draft",
  relayProtocolVersion: null as null | 1 | 2,
  relayLookupFails: false,
  getActiveDeployment: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({
  resolveAgent: vi.fn(async () => ({
    id: "agent-1",
    flowId: "flow-1",
    slug: "published-agent",
    status: state.status,
    priceUsdc: 1,
    createdAt: 1,
    settlementLive: true,
  })),
}));
vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => ({
    getFlow: vi.fn(async () => ({
      id: "flow-1",
      ownerId: "owner-1",
      name: "Published",
      graph: { id: "draft", name: "Draft", nodes: [], edges: [] },
    })),
    getRelayEndpoint: vi.fn(async () => {
      if (state.relayLookupFails) throw new Error("relay store unavailable");
      return state.relayProtocolVersion === null
        ? null
        : { protocolVersion: state.relayProtocolVersion };
    }),
  })),
}));
vi.mock("@/lib/projects/provider", () => ({
  getProjectRepo: vi.fn(async () => ({
    getActiveDeployment: (...args: unknown[]) => state.getActiveDeployment(...args),
  })),
}));
vi.mock("@/lib/projects/public-agent-graph", () => ({
  resolvePublicAgentRelease: vi.fn(async (input: {
    projectRepo: { getActiveDeployment(args: unknown): Promise<unknown> };
  }) => {
    const active = await input.projectRepo.getActiveDeployment({
      flowId: "flow-1",
      ownerId: "owner-1",
      environmentKind: "live",
    });
    return active ? {
      graph: { id: "published", name: "Published", nodes: [], edges: [] },
      resourceDependencies: [],
      release: {
        ownerId: "owner-1",
        flowId: "flow-1",
        deploymentId: "deployment-1",
        environmentId: "environment-live",
        flowVersionId: "version-1",
        semanticHash: "a".repeat(64),
        fullHash: "b".repeat(64),
      },
    } : null;
  }),
}));
vi.mock("@/lib/discovery/agent-card", () => ({
  buildSuedeAgentCard: vi.fn((input: {
    publishedLive: boolean;
    fulfillmentSupportsAp2: boolean;
  }) => ({
    publishedLive: input.publishedLive,
    fulfillmentSupportsAp2: input.fulfillmentSupportsAp2,
  })),
}));
vi.mock("@/lib/rails/ap2/config", () => ({
  publicAp2RuntimeStatus: vi.fn(async () => ({ mode: "optional", ready: true })),
}));
vi.mock("@/lib/rails/ap2-company-eligibility", () => ({
  companyServiceSupportsPublicAp2: vi.fn(async () => true),
}));

const card = await import("@/app/api/agents/[agent]/.well-known/agent-card/route");
const a2a = await import("@/app/api/agents/[agent]/a2a/route");
const request = new Request("https://agents.suedeai.ai/api/agents/published-agent");
const context = { params: Promise.resolve({ agent: "published-agent" }) };
const liveDeployment = () => ({
  id: "deployment-1",
  flowId: "flow-1",
  flowVersionId: "version-1",
  environmentId: "environment-1",
  status: "live" as const,
  createdAt: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.status = "live";
  state.activeDeployment = null;
  state.relayProtocolVersion = null;
  state.relayLookupFails = false;
  state.getActiveDeployment.mockImplementation(async () => state.activeDeployment);
});

describe("per-agent AP2 active-deployment parity", () => {
  it.each([card.GET, a2a.GET])(
    "marks the card Live only when the immutable deployment exists",
    async (route) => {
      const legacy = await route(request, context);
      expect(legacy.status).toBe(404);
      expect(await legacy.json()).toEqual({ error: "agent not found" });

      state.activeDeployment = liveDeployment();
      const active = await route(request, context);
      expect(await active.json()).toEqual({
        publishedLive: true,
        fulfillmentSupportsAp2: true,
      });
      expect(state.getActiveDeployment).toHaveBeenLastCalledWith({
        flowId: "flow-1",
        ownerId: "owner-1",
        environmentKind: "live",
      });
    },
  );

  it.each([card.GET, a2a.GET])(
    "returns 404 for an unpublished agent even if a deployment row remains",
    async (route) => {
      state.status = "draft";
      state.activeDeployment = liveDeployment();
      const response = await route(request, context);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "agent not found" });
      expect(state.getActiveDeployment).not.toHaveBeenCalled();
    },
  );

  it.each([card.GET, a2a.GET])(
    "suppresses AP2 fulfillment support for legacy relays",
    async (route) => {
      state.activeDeployment = liveDeployment();
      state.relayProtocolVersion = 1;
      const legacyRelay = await route(request, context);
      expect(await legacyRelay.json()).toEqual({
        publishedLive: true,
        fulfillmentSupportsAp2: false,
      });

      state.relayProtocolVersion = 2;
      const idempotentRelay = await route(request, context);
      expect(await idempotentRelay.json()).toEqual({
        publishedLive: true,
        fulfillmentSupportsAp2: true,
      });
    },
  );

  it.each([card.GET, a2a.GET])(
    "fails AP2 fulfillment discovery closed when relay state is unavailable",
    async (route) => {
      state.activeDeployment = liveDeployment();
      state.relayLookupFails = true;
      const response = await route(request, context);
      expect(await response.json()).toEqual({
        publishedLive: true,
        fulfillmentSupportsAp2: false,
      });
    },
  );
});
