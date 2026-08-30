import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRecord,
  FlowRecord,
  FlowRepo,
  SiteVerificationRecord,
  WalletRecord,
} from "@/lib/db/repo";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { ProjectRepo } from "@/lib/projects/repo";
import type { DeploymentRecord } from "@/lib/projects/types";
import {
  SITE_AGENT_TEMPLATE_PREFIX,
  SITE_HOST_META_KEY,
} from "@/lib/site/blueprint-meta";

interface CatalogReadHarness {
  readonly repo: FlowRepo;
  readonly projectRepo: ProjectRepo;
  readonly listLiveAgentsWithFlows: ReturnType<typeof vi.fn>;
  readonly listLiveAgents: ReturnType<typeof vi.fn>;
  readonly listFlowsByIds: ReturnType<typeof vi.fn>;
  readonly getFlow: ReturnType<typeof vi.fn>;
  readonly listWalletsByOwners: ReturnType<typeof vi.fn>;
  readonly getWallet: ReturnType<typeof vi.fn>;
  readonly countRunsByAgent: ReturnType<typeof vi.fn>;
  readonly listSchedulesByAgents: ReturnType<typeof vi.fn>;
  readonly listActiveDeploymentsForFlows: ReturnType<typeof vi.fn>;
  readonly getActiveDeployment: ReturnType<typeof vi.fn>;
  readonly listSiteVerificationsByOwnersAndHosts: ReturnType<typeof vi.fn>;
  readonly getSiteVerification: ReturnType<typeof vi.fn>;
  setAgents(agents: readonly AgentRecord[]): void;
  setActiveDeployments(deployments: readonly DeploymentRecord[]): void;
}

const state = vi.hoisted(() => ({
  harness: null as CatalogReadHarness | null,
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => {
    if (!state.harness) throw new Error("catalog harness is not configured");
    return state.harness.repo;
  }),
}));

vi.mock("@/lib/projects/provider", () => ({
  getProjectRepo: vi.fn(async () => {
    if (!state.harness) throw new Error("catalog harness is not configured");
    return state.harness.projectRepo;
  }),
}));

vi.mock("@/lib/projects/public-agent-graph", () => ({
  resolvePublicAgentRelease: vi.fn(async (
    input: Readonly<{ flow: FlowRecord; activeDeployment: DeploymentRecord }>,
  ) => ({ graph: input.flow.graph, resourceDependencies: [], release: {
    ownerId: input.flow.ownerId, flowId: input.flow.id,
    deploymentId: input.activeDeployment.id, environmentId: input.activeDeployment.environmentId,
    flowVersionId: input.activeDeployment.flowVersionId,
    semanticHash: "b".repeat(64), fullHash: "c".repeat(64),
  } })),
}));

const { resolvePublicAgentRelease } = await import(
  "@/lib/projects/public-agent-graph"
);
const { buildCatalog } = await import("@/lib/catalog");

const OWNER_ID = "catalog-owner";
const WALLET: WalletRecord = {
  ownerId: OWNER_ID,
  address: "0x1111111111111111111111111111111111111111",
  network: "base-mainnet",
  label: null,
};

function graph(index: number): SupportedFlowGraph {
  return {
    id: `graph-${index}`,
    name: `Catalog Agent ${index}`,
    nodes: [{
      id: `input-${index}`,
      type: "input",
      params: {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
    meta: {
      template: `${SITE_AGENT_TEMPLATE_PREFIX}catalog`,
      [SITE_HOST_META_KEY]: `catalog-${index}.example.com`,
    },
  };
}

function agentsAtScale(count = 29): AgentRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${index}`,
    flowId: `flow-${index}`,
    slug: `catalog-agent-${index}`,
    status: "live" as const,
    priceUsdc: (index + 1) / 100,
    createdAt: 1_000 - index,
    settlementLive: false,
  }));
}

function deployment(index: number): DeploymentRecord {
  return {
    id: `deployment-${index}`,
    flowId: `flow-${index}`,
    flowVersionId: `version-${index}`,
    environmentId: `environment-${index}`,
    status: "live",
    createdAt: 1_000 - index,
  };
}

function makeHarness(): CatalogReadHarness {
  let liveAgents = agentsAtScale();
  let activeDeployments = liveAgents.map((_, index) => deployment(index));
  const flows = new Map<string, FlowRecord>(
    liveAgents.map((agent, index) => [
      agent.flowId,
      {
        id: agent.flowId,
        ownerId: OWNER_ID,
        name: `Catalog Agent ${index}`,
        graph: graph(index),
        updatedAt: index,
      },
    ]),
  );

  const listLiveAgents = vi.fn(async () => [...liveAgents]);
  const listLiveAgentsWithFlows = vi.fn(async () =>
    liveAgents.flatMap((agent) => {
      const flow = flows.get(agent.flowId);
      return flow ? [{ agent, flow }] : [];
    }));
  const listFlowsByIds = vi.fn(async (flowIds: readonly string[]) =>
    flowIds.flatMap((flowId) => {
      const flow = flows.get(flowId);
      return flow ? [flow] : [];
    }));
  const getFlow = vi.fn(async (flowId: string) => flows.get(flowId) ?? null);
  const listWalletsByOwners = vi.fn(async (ownerIds: readonly string[]) =>
    ownerIds.includes(OWNER_ID) ? [WALLET] : []);
  const getWallet = vi.fn(async (ownerId: string) =>
    ownerId === OWNER_ID ? WALLET : null);
  const countRunsByAgent = vi.fn(async (agentIds: readonly string[]) =>
    Object.fromEntries(agentIds.map((id) => [id, 0])));
  const listSchedulesByAgents = vi.fn(async () => []);
  const listActiveDeploymentsForFlows = vi.fn(async (
    input: Readonly<{
      flows: readonly Readonly<{ flowId: string; ownerId: string }>[];
    }>,
  ) => {
    const requestedFlowIds = new Set(input.flows.map(({ flowId }) => flowId));
    return activeDeployments.filter(({ flowId }) => requestedFlowIds.has(flowId));
  });
  const getActiveDeployment = vi.fn(async () => null);
  const listSiteVerificationsByOwnersAndHosts = vi.fn(
    async (
      requirements: readonly Readonly<{ ownerId: string; host: string }>[],
    ): Promise<SiteVerificationRecord[]> =>
      requirements.map(({ ownerId, host }) => ({
        ownerId,
        host,
        method: "file",
        verifiedAt: "2026-07-27T20:00:00.000Z",
      })),
  );
  const getSiteVerification = vi.fn(async (
    ownerId: string,
    host: string,
  ): Promise<SiteVerificationRecord> => ({
    ownerId,
    host,
    method: "file",
    verifiedAt: "2026-07-27T20:00:00.000Z",
  }));

  const repo = {
    listLiveAgentsWithFlows,
    listLiveAgents,
    countRunsByAgent,
    listSchedulesByAgents,
    listFlowsByIds,
    getFlow,
    listWalletsByOwners,
    getWallet,
    listSiteVerificationsByOwnersAndHosts,
    getSiteVerification,
  } as unknown as FlowRepo;
  const projectRepo = {
    listActiveDeploymentsForFlows,
    getActiveDeployment,
  } as unknown as ProjectRepo;

  return {
    repo,
    projectRepo,
    listLiveAgentsWithFlows,
    listLiveAgents,
    listFlowsByIds,
    getFlow,
    listWalletsByOwners,
    getWallet,
    countRunsByAgent,
    listSchedulesByAgents,
    listActiveDeploymentsForFlows,
    getActiveDeployment,
    listSiteVerificationsByOwnersAndHosts,
    getSiteVerification,
    setAgents(agents: readonly AgentRecord[]): void {
      liveAgents = [...agents];
    },
    setActiveDeployments(deployments: readonly DeploymentRecord[]): void {
      activeDeployments = [...deployments];
    },
  };
}

beforeEach(() => {
  vi.mocked(resolvePublicAgentRelease).mockClear();
  state.harness = makeHarness();
});

describe("public catalog query budget", () => {
  it("builds the current 29-agent catalog with bounded bulk reads", async () => {
    const entries = await buildCatalog();
    const harness = state.harness;
    if (!harness) throw new Error("catalog harness is not configured");

    expect(entries).toHaveLength(29);
    expect(harness.listLiveAgentsWithFlows).not.toHaveBeenCalled();
    expect(harness.listLiveAgents).toHaveBeenCalledTimes(1);
    expect(harness.listFlowsByIds).toHaveBeenCalledTimes(1);
    expect(harness.listWalletsByOwners).toHaveBeenCalledTimes(1);
    expect(harness.countRunsByAgent).toHaveBeenCalledTimes(1);
    expect(harness.listSchedulesByAgents).toHaveBeenCalledTimes(1);
    expect(harness.listActiveDeploymentsForFlows).toHaveBeenCalledTimes(1);
    expect(harness.getFlow).not.toHaveBeenCalled();
    expect(harness.getWallet).not.toHaveBeenCalled();
    expect(harness.getActiveDeployment).not.toHaveBeenCalled();
    expect(harness.listSiteVerificationsByOwnersAndHosts).toHaveBeenCalledTimes(1);
    expect(harness.getSiteVerification).not.toHaveBeenCalled();
    expect(resolvePublicAgentRelease).toHaveBeenCalledTimes(29);
  });

  it("reads live membership and price again on every catalog build", async () => {
    const timingNames: string[][] = [[], [], []];
    const first = await buildCatalog({
      onTiming: ({ name }) => timingNames[0]?.push(name),
    });
    const harness = state.harness;
    if (!harness) throw new Error("catalog harness is not configured");
    const repriced = agentsAtScale(29).map((agent, index) =>
      index === 0 ? { ...agent, priceUsdc: 9.99 } : agent);
    harness.setAgents(repriced);

    const second = await buildCatalog({
      onTiming: ({ name }) => timingNames[1]?.push(name),
    });
    harness.setAgents(repriced.slice(0, 28));
    const third = await buildCatalog({
      onTiming: ({ name }) => timingNames[2]?.push(name),
    });

    expect(first).toHaveLength(29);
    expect(second).toHaveLength(29);
    expect(second[0]?.priceUsdc).toBe(9.99);
    expect(third).toHaveLength(28);
    expect(harness.listLiveAgentsWithFlows).not.toHaveBeenCalled();
    expect(harness.listLiveAgents).toHaveBeenCalledTimes(3);
    expect(harness.listFlowsByIds).toHaveBeenCalledTimes(2);
    expect(harness.listWalletsByOwners).toHaveBeenCalledTimes(2);
    expect(harness.countRunsByAgent).toHaveBeenCalledTimes(2);
    expect(harness.listSchedulesByAgents).toHaveBeenCalledTimes(2);
    expect(harness.listActiveDeploymentsForFlows).toHaveBeenCalledTimes(3);
    expect(harness.listSiteVerificationsByOwnersAndHosts).toHaveBeenCalledTimes(3);
    expect(harness.getSiteVerification).not.toHaveBeenCalled();
    expect(resolvePublicAgentRelease).toHaveBeenCalledTimes(29);
    expect(timingNames[0]).toContain("catalog_base_miss");
    expect(timingNames[1]).toContain("catalog_base_hit");
    expect(timingNames[1]).toContain("catalog_graph_cache_hit");
    expect(timingNames[2]).toContain("catalog_base_miss");
  });

  it("invalidates the published graph cache when the fresh deployment identity changes", async () => {
    const harness = state.harness;
    if (!harness) throw new Error("catalog harness is not configured");
    await buildCatalog();
    harness.setActiveDeployments([
      {
        ...deployment(0),
        id: "deployment-0-promoted",
        flowVersionId: "version-0-promoted",
      },
      ...agentsAtScale().slice(1).map((_, index) => deployment(index + 1)),
    ]);

    await buildCatalog();

    expect(harness.listActiveDeploymentsForFlows).toHaveBeenCalledTimes(2);
    expect(resolvePublicAgentRelease).toHaveBeenCalledTimes(30);
    expect(resolvePublicAgentRelease).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeDeployment: expect.objectContaining({
          id: "deployment-0-promoted",
          flowVersionId: "version-0-promoted",
        }),
      }),
    );
  });

  it("fails closed without falling back to per-agent reads when the bulk proof read fails", async () => {
    const harness = state.harness;
    if (!harness) throw new Error("catalog harness is not configured");
    harness.listSiteVerificationsByOwnersAndHosts.mockRejectedValueOnce(
      new Error("site verification table unavailable"),
    );

    await expect(buildCatalog()).resolves.toEqual([]);
    expect(harness.listSiteVerificationsByOwnersAndHosts).toHaveBeenCalledTimes(1);
    expect(harness.getSiteVerification).not.toHaveBeenCalled();
  });
});
