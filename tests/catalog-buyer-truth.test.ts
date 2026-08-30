/**
 * Buyer-shelf truth fields on CatalogEntry (lane: catalog fields + directory).
 *
 * What a buyer sees must be exactly what they can buy:
 * - settledCalls counts only runs with settled_at set (dry-runs never inflate it)
 * - lastCallAt is the most recent EXTERNAL call (trigger "agent")
 * - acceptsPayment is the same platform-AND-agent conjunction the run route
 *   settles on; the platform default (dry-run) reads as false
 * - publishedLive and the aggregates all fail CLOSED when a read is missing
 *   or fails: the catalog understates, never overstates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord, FlowRecord, FlowRepo } from "@/lib/db/repo";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { ProjectRepo } from "@/lib/projects/repo";
import type { DeploymentRecord } from "@/lib/projects/types";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import { canonicalResourceAgentSlug, materializeResourceGraph } from "@/lib/resources/materialize";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import type { ResourceRelease, ResourceRepository } from "@/lib/resources/repository";
import { resourcePack } from "./resources/fixture";

const state = vi.hoisted(() => ({
  repo: null as FlowRepo | null,
  projectRepo: null as ProjectRepo | null,
  resourceRepo: null as ResourceRepository | null,
  releaseHashes: {} as Record<string, { semanticHash: string; fullHash: string }>,
  resourceDependencies: {} as Record<string, readonly Readonly<{
    resourceProductId: string;
    packVersionId: string;
    contentHash: string;
  }>[]>,
  getResourceRepository: vi.fn(),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => {
    if (!state.repo) throw new Error("buyer-truth harness is not configured");
    return state.repo;
  }),
}));

vi.mock("@/lib/projects/provider", () => ({
  getProjectRepo: vi.fn(async () => state.projectRepo),
}));

vi.mock("@/lib/resources/provider", () => ({
  getResourceRepository: (...args: unknown[]) => state.getResourceRepository(...args),
}));

function resolveResourceRepository() {
    if (!state.resourceRepo) throw new Error("resource repository unavailable");
    return state.resourceRepo;
}

vi.mock("@/lib/projects/public-agent-graph", () => ({
  resolvePublicAgentRelease: vi.fn(async (
    input: Readonly<{ flow: FlowRecord; activeDeployment: DeploymentRecord }>,
  ) => ({
    graph: input.flow.graph,
    resourceDependencies: state.resourceDependencies[input.flow.id] ?? [],
    release: {
      ownerId: input.flow.ownerId, flowId: input.flow.id,
      deploymentId: input.activeDeployment.id,
      environmentId: input.activeDeployment.environmentId,
      flowVersionId: input.activeDeployment.flowVersionId,
      semanticHash: state.releaseHashes[input.flow.id]?.semanticHash ?? "b".repeat(64),
      fullHash: state.releaseHashes[input.flow.id]?.fullHash ?? "c".repeat(64),
    },
  })),
}));

const { buildCatalog } = await import("@/lib/catalog");

const OWNER_ID = "buyer-truth-owner";
const OWNER_PAYOUT = "0x1111111111111111111111111111111111111111";
const RESOURCE_CONTENT = resourcePack();
const RESOURCE_SEMANTIC_HASH = resourcePackSemanticHash(RESOURCE_CONTENT).semanticHash;

function graph(id: string): SupportedFlowGraph {
  return {
    id,
    name: id,
    nodes: [{ id: "in", type: "input", params: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
}

function agent(id: string, settlementLive: boolean): AgentRecord {
  return {
    id: `agent-${id}`,
    flowId: `flow-${id}`,
    slug: `invoice-chaser-${id}`,
    status: "live",
    priceUsdc: 0.05,
    createdAt: 100,
    settlementLive,
  };
}

function flow(id: string): FlowRecord {
  return {
    id: `flow-${id}`,
    ownerId: OWNER_ID,
    name: `Invoice Chaser ${id}`,
    graph: graph(`flow-${id}`),
    updatedAt: 1,
  };
}

function deployment(id: string): DeploymentRecord {
  return {
    id: `deployment-${id}`,
    flowId: `flow-${id}`,
    flowVersionId: `version-${id}`,
    environmentId: `environment-${id}`,
    status: "live",
    createdAt: 100,
  };
}

function exactResourceFlow(discoveryAccess: "public" | "unlisted"): FlowRecord {
  const ordinaryAgent = agent("a", true);
  const currentAgent = {
    ...ordinaryAgent,
    slug: canonicalResourceAgentSlug({ id: ordinaryAgent.flowId, slug: ordinaryAgent.slug }),
  };
  vi.mocked(state.repo!.listLiveAgents).mockResolvedValue([currentAgent, agent("b", false)]);
  const content = RESOURCE_CONTENT;
  const packVersionId = "pack-version-catalog";
  const semanticHash = RESOURCE_SEMANTIC_HASH;
  const product = {
    id: currentAgent.flowId,
    ownerId: OWNER_ID,
    name: "Pricing Signals",
    slug: ordinaryAgent.slug,
    status: "live" as const,
    executionAccess: "paid" as const,
    discoveryAccess,
  };
  const materialized = materializeResourceGraph({
    product,
    pack: {
      resourceProductId: product.id,
      packVersionId,
      semanticHash,
      freshness: "fresh",
      content,
    },
    sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
  });
  state.releaseHashes[product.id] = {
    semanticHash: materialized.semanticHash,
    fullHash: materialized.fullHash,
  };
  state.resourceDependencies[product.id] = [{
    resourceProductId: product.id,
    packVersionId,
    contentHash: semanticHash,
  }];
  const release: ResourceRelease = {
    id: "release-catalog", ownerId: OWNER_ID, resourceProductId: product.id,
    packVersionId, semanticHash, publicationKey: "publication-catalog",
    publicationRequestHash: "d".repeat(64), graphSemanticHash: materialized.semanticHash,
    graphFullHash: materialized.fullHash, priceUsdc: currentAgent.priceUsdc,
    executionAccess: "paid", discoveryAccess, agentId: currentAgent.id, flowId: product.id,
    flowVersionId: "version-a", deploymentId: "deployment-a", environmentId: "environment-a",
    createdAt: "2026-08-14T12:00:00.000Z",
  };
  const listPublishedReleasesByAgentIds = vi.fn(async (ids: readonly string[]) =>
    ids.includes(currentAgent.id) ? [release] : []);
  state.resourceRepo = {
    getPublishedReleaseByAgent: vi.fn(async (id: string) => id === currentAgent.id ? release : null),
    getOwnedPack: vi.fn(async () => ({
      resourceProductId: product.id,
      packVersionId,
      semanticHash,
      freshness: "fresh" as const,
      content,
    })),
    listPublishedReleasesByAgentIds,
  } as unknown as ResourceRepository;
  return {
    id: product.id, ownerId: OWNER_ID, name: product.name,
    graph: materialized.graph, updatedAt: 1,
  };
}

interface HarnessOptions {
  readonly withAggregates?: boolean;
  readonly aggregatesReject?: boolean;
}

interface Harness {
  readonly countSettledRunsByAgent: ReturnType<typeof vi.fn>;
  readonly lastAgentCallAt: ReturnType<typeof vi.fn>;
}

const LAST_CALL_MS = Date.parse("2026-08-08T12:00:00.000Z");

function configure(options: HarnessOptions = {}): Harness {
  const withAggregates = options.withAggregates ?? true;
  const countSettledRunsByAgent = vi.fn(async (): Promise<Record<string, number>> => {
    if (options.aggregatesReject) throw new Error("settled read down");
    return { "agent-a": 3 };
  });
  const lastAgentCallAt = vi.fn(async (): Promise<Record<string, number>> => {
    if (options.aggregatesReject) throw new Error("recency read down");
    return { "agent-a": LAST_CALL_MS };
  });
  const flows = [flow("a"), flow("b")];
  state.repo = {
    listLiveAgents: vi.fn(async () => [agent("a", true), agent("b", false)]),
    listFlowsByIds: vi.fn(async () => flows),
    getFlow: vi.fn(async () => null),
    countRunsByAgent: vi.fn(async () => ({ "agent-a": 7, "agent-b": 2 })),
    listSchedulesByAgents: vi.fn(async () => []),
    listWalletsByOwners: vi.fn(async () => [{
      ownerId: OWNER_ID,
      address: OWNER_PAYOUT,
    }]),
    getWallet: vi.fn(async () => ({
      ownerId: OWNER_ID,
      address: OWNER_PAYOUT,
    })),
    ...(withAggregates ? { countSettledRunsByAgent, lastAgentCallAt } : {}),
  } as unknown as FlowRepo;
  state.projectRepo = {
    // Only flow-a carries an active Live deployment; flow-b must read as
    // not publishable-callable.
    listActiveDeploymentsForFlows: vi.fn(async () => [deployment("a")]),
    getActiveDeployment: vi.fn(async () => null),
  } as unknown as ProjectRepo;
  return { countSettledRunsByAgent, lastAgentCallAt };
}

beforeEach(() => {
  state.repo = null;
  state.projectRepo = null;
  state.resourceRepo = null;
  state.releaseHashes = {};
  state.resourceDependencies = {};
  state.getResourceRepository.mockReset().mockImplementation(async () => resolveResourceRepository());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("catalog buyer-truth fields", () => {
  it("exposes honest settled counts, recency, payability, and publication per entry", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    const harness = configure();

    const entries = await buildCatalog();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "agent-a",
      calls: 7,
      settledCalls: 3,
      lastCallAt: LAST_CALL_MS,
      settlementLive: true,
      acceptsPayment: true,
      publishedLive: true,
    });
    expect(entries[0]?.urls).toEqual({
      public: "/a/invoice-chaser-a",
      run: "/api/agents/invoice-chaser-a/run",
      x402: "/api/agents/invoice-chaser-a/.well-known/x402",
      agentCard: "/api/agents/invoice-chaser-a/.well-known/agent-card.json",
      a2a: "/api/agents/invoice-chaser-a/a2a",
    });
    expect(entries[0]).not.toHaveProperty("outputSchema");
    expect(entries[0]).not.toHaveProperty("extensions");
    expect(harness.countSettledRunsByAgent).toHaveBeenCalledWith(["agent-a", "agent-b"]);
    // Recency counts EXTERNAL calls only, so scheduled self-runs never
    // fake buyer activity.
    expect(harness.lastAgentCallAt).toHaveBeenCalledWith(["agent-a", "agent-b"], "agent");
  });

  it("never claims acceptsPayment while the platform default keeps settlement off", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "true");
    configure();

    const entries = await buildCatalog();

    expect(entries[0]).toMatchObject({ settlementLive: true, acceptsPayment: false });
  });

  it("omits an immutable unlisted Resource Product from every catalog projection", async () => {
    configure();
    const unlisted = exactResourceFlow("unlisted");
    vi.mocked(state.repo!.listFlowsByIds!).mockResolvedValue([unlisted, flow("b")]);

    await expect(buildCatalog()).resolves.toEqual([]);
  });

  it.each(["direct", "nested"] as const)(
    "omits a markerless %s resource.query closure without opening the Resource catalog provider",
    async (placement) => {
      configure();
      const published = flow("a");
      published.graph = {
        ...published.graph,
        nodes: (placement === "direct"
          ? [{ id: "resource-query", type: "resource.query", params: {}, position: { x: 0, y: 0 } }]
          : [{ id: "nested-resource", type: "subflow", params: {}, position: { x: 0, y: 0 } }]) as never,
      };
      state.resourceDependencies[published.id] = [{
        resourceProductId: published.id,
        packVersionId: "pack-version-markerless",
        contentHash: "d".repeat(64),
      }];
      vi.mocked(state.repo!.listFlowsByIds!).mockResolvedValue([published, flow("b")]);

      await expect(buildCatalog()).resolves.toEqual([]);
      expect(state.getResourceRepository).not.toHaveBeenCalled();
    },
  );

  it("projects an exact public Resource Product with absolute canonical URLs and one namespaced contract", async () => {
    configure();
    const published = exactResourceFlow("public");
    vi.mocked(state.repo!.listFlowsByIds!).mockResolvedValue([published, flow("b")]);

    const entries = await buildCatalog();

    expect(entries).toHaveLength(1);
    const resourceSlug = canonicalResourceAgentSlug({ id: "flow-a", slug: "invoice-chaser-a" });
    expect(entries[0]?.urls).toEqual({
      public: `https://agents.suedeai.ai/a/${resourceSlug}`,
      run: `https://agents.suedeai.ai/api/agents/${resourceSlug}/run`,
      x402: `https://agents.suedeai.ai/api/agents/${resourceSlug}/.well-known/x402`,
      agentCard: `https://agents.suedeai.ai/api/agents/${resourceSlug}/.well-known/agent-card.json`,
      a2a: `https://agents.suedeai.ai/api/agents/${resourceSlug}/a2a`,
    });
    expect(entries[0]?.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI]).toMatchObject({
      resourceProductId: "flow-a",
      resourceVersion: "pack-version-catalog",
      semanticHash: RESOURCE_SEMANTIC_HASH,
      access: { execution: "paid", discovery: "public" },
      sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
    });
    expect(state.resourceRepo?.listPublishedReleasesByAgentIds).toHaveBeenCalledOnce();
    expect(state.resourceRepo?.getPublishedReleaseByAgent).not.toHaveBeenCalled();
  });

  it("fails closed to zero settled and no recency when a repo lacks the aggregates", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    configure({ withAggregates: false });

    const entries = await buildCatalog();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ settledCalls: 0, lastCallAt: null });
  });

  it("fails closed to zero settled and no recency when the aggregate reads fail", async () => {
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    configure({ aggregatesReject: true });

    const entries = await buildCatalog();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ settledCalls: 0, lastCallAt: null });
  });
});
