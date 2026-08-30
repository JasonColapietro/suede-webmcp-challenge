import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "@/lib/catalog";

const state = vi.hoisted(() => ({
  placement: "direct" as "direct" | "nested",
  createCredit: vi.fn(),
  getResourceRepository: vi.fn(),
  disposePrepared: vi.fn(),
  runPrepared: vi.fn(),
  bindResourceSnapshot: vi.fn(),
}));

const entry: CatalogEntry = {
  id: "agent-markerless",
  slug: "markerless-resource",
  name: "Markerless resource",
  summary: "Resource query",
  description: "Queries one immutable Resource Pack.",
  priceUsdc: 0.25,
  calls: 0,
  settledCalls: 0,
  lastCallAt: null,
  createdAt: 1,
  settlementLive: true,
  acceptsPayment: true,
  paymentState: "payment-enabled",
  previewAvailable: false,
  payTo: "0x1111111111111111111111111111111111111111",
  schedule: null,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  publishedLive: true,
  urls: {
    public: "/a/markerless-resource",
    run: "/api/agents/markerless-resource/run",
    x402: "/api/agents/markerless-resource/.well-known/x402",
    agentCard: "/api/agents/markerless-resource/.well-known/agent-card.json",
    a2a: "/api/agents/markerless-resource/a2a",
  },
};

const repo = {
  getAgent: vi.fn(async () => ({
    id: entry.id,
    flowId: "flow-markerless",
    slug: entry.slug,
    status: "live",
    priceUsdc: entry.priceUsdc,
    createdAt: 1,
    settlementLive: true,
  })),
  getFlow: vi.fn(async () => ({
    id: "flow-markerless",
    ownerId: "creator-markerless",
    name: entry.name,
    graph: { id: "draft", name: "Draft", nodes: [], edges: [] },
    updatedAt: 1,
  })),
  getEmployeeByAgent: vi.fn(async () => null),
  getRelayEndpoint: vi.fn(async () => null),
  getCreditBalance: vi.fn(async () => 1),
  createCredit: (...args: unknown[]) => state.createCredit(...args),
};

vi.mock("@/lib/catalog", () => ({
  buildCatalog: vi.fn(async () => [entry]),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => repo),
}));

vi.mock("@/lib/resources/provider", () => ({
  getResourceRepository: (...args: unknown[]) => state.getResourceRepository(...args),
}));

vi.mock("@/lib/run-service", () => ({
  preparePublishedLiveExecution: vi.fn(async () => ({
    graph: {
      id: "live-markerless",
      name: "Markerless Resource",
      nodes: state.placement === "direct"
        ? [{ id: "resource-query", type: "resource.query", params: {}, position: { x: 0, y: 0 } }]
        : [{ id: "nested-resource", type: "subflow", params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    },
    resourceDependencies: [{
      resourceProductId: "resource-hidden",
      packVersionId: "pack-hidden",
      contentHash: "a".repeat(64),
    }],
    release: {
      ownerId: "creator-markerless",
      flowId: "flow-markerless",
      deploymentId: "deployment-live",
      environmentId: "environment-live",
      flowVersionId: "version-live",
      semanticHash: "b".repeat(64),
      fullHash: "c".repeat(64),
    },
    agent: null,
    relay: false,
  })),
  disposePreparedPublishedLiveExecution: (...args: unknown[]) => state.disposePrepared(...args),
  runPreparedPublishedLiveToCompletion: (...args: unknown[]) => state.runPrepared(...args),
  bindPreparedPublishedLiveResourceSnapshot: (...args: unknown[]) =>
    state.bindResourceSnapshot(...args),
  triggerInputContractViolations: vi.fn(() => []),
}));

const { createMcpDeps } = await import("@/lib/mcp/service");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("production MCP Resource closure gate", () => {
  it.each(["direct", "nested"] as const)(
    "refuses a cached markerless %s Resource closure before provider, credit, execution, or output work",
    async (placement) => {
      state.placement = placement;
      const deps = await createMcpDeps();

      const result = await deps.callTool({
        name: "run_markerless-resource",
        arguments: {},
        workspaceKey: "caller-workspace",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("immutable");
      expect(state.getResourceRepository).not.toHaveBeenCalled();
      expect(state.createCredit).not.toHaveBeenCalled();
      expect(state.runPrepared).not.toHaveBeenCalled();
      expect(state.bindResourceSnapshot).not.toHaveBeenCalled();
      expect(state.disposePrepared).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toBeUndefined();
    },
  );
});
