import { describe, expect, it, vi } from "vitest";
import {
  resolvePublicAgentGraph,
  resolvePublicAgentRelease,
} from "@/lib/projects/public-agent-graph";
import type { ProjectRepo } from "@/lib/projects/repo";
import type { DeploymentRecord } from "@/lib/projects/types";
import type { ActiveLiveExecution } from "@/lib/projects/live-execution";
import type { RunSubflowSnapshot } from "@/lib/flow/run-subflow-preflight";
import type { SupportedFlowGraph } from "@/lib/flow/types";

const safeGraph: SupportedFlowGraph = {
  id: "safe",
  name: "Safe",
  nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

const apiGraph: SupportedFlowGraph = {
  schemaVersion: 2,
  id: "api",
  name: "API",
  nodes: [{
    id: "api", type: "api.operation",
    params: {
      connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000601",
      operationVersionId: "00000000-0000-4000-8000-000000000602",
      operationId: "createThing",
      connectorProjectionHash: "1".repeat(64),
      operationProjectionHash: "2".repeat(64),
      schemaHash: "3".repeat(64),
    },
    bindings: {}, position: { x: 0, y: 0 },
  }],
  edges: [], variables: [], groups: [], annotations: [],
};

const legacyCredentialGraph: SupportedFlowGraph = {
  id: "legacy-http",
  name: "Legacy HTTP",
  nodes: [{
    id: "request",
    type: "http",
    params: {
      method: "POST",
      url: "https://example.com/hooks",
      headers: {
        Accept: "application/json",
        "X-Request-Id": "public-request-id",
        Authorization: "Bearer public-graph-bearer-canary",
        "X-Api-Key": "public-graph-api-key-canary",
        "X-Looks-Safe": "sk_public_graph_canary_12345678",
      },
      apiKey: "public-graph-direct-canary",
    },
    position: { x: 0, y: 0 },
  }],
  edges: [],
};

function projectRepo(active: unknown): ProjectRepo {
  return { getActiveDeployment: vi.fn(async () => active) } as unknown as ProjectRepo;
}

function liveDeployment(): DeploymentRecord {
  return {
    id: "deployment-1",
    flowId: "flow-1",
    flowVersionId: "version-1",
    environmentId: "environment-1",
    status: "live",
    createdAt: 1,
  };
}

function flow(graph: SupportedFlowGraph) {
  return { id: "flow-1", ownerId: "owner-1", graph };
}

const emptySubflowSnapshot: RunSubflowSnapshot = Object.freeze({
  loadSubflow: async (flowId: string): Promise<SupportedFlowGraph> => {
    throw new Error(`Subflow ${flowId} was not preflighted`);
  },
  resolveSubflow: async (): Promise<never> => {
    throw new Error("Subflow was not preflighted");
  },
});

function exactRelease(graph: SupportedFlowGraph): ActiveLiveExecution {
  return {
    graph,
    subflowSnapshot: emptySubflowSnapshot,
    usesConnections: false,
    resourceDependencies: [],
    receipt: {
      ownerId: "owner-1",
      flowId: "flow-1",
      deploymentId: "deployment-1",
      environmentId: "environment-1",
      flowVersionId: "version-1",
      semanticHash: "a".repeat(64),
      fullHash: "b".repeat(64),
    },
  };
}

describe("public agent graph truth", () => {
  it("fails closed when the project repository is unavailable", async () => {
    const exact = vi.fn();
    await expect(resolvePublicAgentRelease({
      flow: flow(safeGraph), projectRepo: null, resolveExact: exact,
    })).resolves.toBeNull();
    expect(exact).not.toHaveBeenCalled();
  });

  it("fails closed when fresh bulk state has no active Live deployment", async () => {
    const repoWithNoActive = projectRepo(null);
    await expect(resolvePublicAgentRelease({
      flow: flow(safeGraph),
      projectRepo: repoWithNoActive,
      activeDeployment: null,
    })).resolves.toBeNull();
    expect(repoWithNoActive.getActiveDeployment).not.toHaveBeenCalled();
  });

  it("uses the preloaded deployment and returns one immutable graph plus release identity", async () => {
    const activeDeployment = liveDeployment();
    const repoWithActive = projectRepo(null);
    const exact = vi.fn(async () => exactRelease(safeGraph));
    await expect(resolvePublicAgentRelease({
      flow: flow(safeGraph),
      projectRepo: repoWithActive,
      activeDeployment,
      resolveExact: exact,
    })).resolves.toEqual({
      graph: safeGraph,
      resourceDependencies: [],
      release: {
        ownerId: "owner-1",
        flowId: "flow-1",
        deploymentId: "deployment-1",
        environmentId: "environment-1",
        flowVersionId: "version-1",
        semanticHash: "a".repeat(64),
        fullHash: "b".repeat(64),
      },
    });
    expect(repoWithActive.getActiveDeployment).not.toHaveBeenCalled();
    expect(exact).toHaveBeenCalledOnce();
    expect(exact).toHaveBeenCalledWith(expect.objectContaining({
      initialDeployment: activeDeployment,
    }));
  });

  it("fails closed when the active immutable version is unresolved", async () => {
    await expect(resolvePublicAgentRelease({
      flow: flow(safeGraph),
      projectRepo: projectRepo(liveDeployment()),
      resolveExact: vi.fn(async () => null),
    })).resolves.toBeNull();
  });

  it("advertises the exact safe published graph while hiding a mutable API Draft", async () => {
    const exact = exactRelease(safeGraph);
    await expect(resolvePublicAgentGraph({
      flow: flow(apiGraph),
      projectRepo: projectRepo(liveDeployment()),
      resolveExact: vi.fn(async () => exact),
    })).resolves.toBe(safeGraph);
  });

  it("hides an exact published graph containing the simulation-only node", async () => {
    const exact = exactRelease(apiGraph);
    await expect(resolvePublicAgentGraph({
      flow: flow(safeGraph),
      projectRepo: projectRepo(liveDeployment()),
      resolveExact: vi.fn(async () => exact),
    })).resolves.toBeNull();
  });

  it("redacts immutable Live HTTP credential material while preserving safe public headers", async () => {
    const resolved = await resolvePublicAgentGraph({
      flow: flow(safeGraph),
      projectRepo: projectRepo(liveDeployment()),
      resolveExact: vi.fn(async () => exactRelease(legacyCredentialGraph)),
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.nodes[0]?.params).toEqual({
      method: "POST",
      url: "https://example.com/hooks",
      headers: {
        Accept: "application/json",
        "X-Request-Id": "public-request-id",
      },
    });
    expect(JSON.stringify(resolved)).not.toMatch(
      /public-graph-(?:bearer|api-key|direct)-canary|sk_public_graph_canary/,
    );
    expect(legacyCredentialGraph.nodes[0]?.params).toHaveProperty(
      "headers.Authorization",
      "Bearer public-graph-bearer-canary",
    );
  });

  it("deep-freezes the detached credential-redacted public graph", async () => {
    const release = await resolvePublicAgentRelease({
      flow: flow(safeGraph),
      projectRepo: projectRepo(liveDeployment()),
      resolveExact: vi.fn(async () => exactRelease(legacyCredentialGraph)),
    });

    expect(release).not.toBeNull();
    const publicGraph = release!.graph;
    expect(Object.isFrozen(publicGraph)).toBe(true);
    expect(Object.isFrozen(publicGraph.nodes)).toBe(true);
    expect(Object.isFrozen(publicGraph.nodes[0])).toBe(true);
    expect(Object.isFrozen(publicGraph.nodes[0]!.params)).toBe(true);
    expect(Object.isFrozen(publicGraph.nodes[0]!.params.headers)).toBe(true);
    expect(() => {
      (publicGraph.nodes[0]!.params.headers as Record<string, string>).Accept = "text/plain";
    }).toThrow(TypeError);
  });

  it("fails closed when the exact resolver rejects a mismatched release or promotion race", async () => {
    const deployment = liveDeployment();
    await expect(resolvePublicAgentRelease({
      flow: flow(safeGraph),
      projectRepo: projectRepo(deployment),
      resolveExact: vi.fn(async () => ({
        ...exactRelease(safeGraph),
        receipt: { ...exactRelease(safeGraph).receipt, flowId: "other-flow" },
      })),
    })).resolves.toBeNull();
    await expect(resolvePublicAgentRelease({
      flow: flow(safeGraph),
      projectRepo: projectRepo(deployment),
      resolveExact: vi.fn(async () => null),
    })).resolves.toBeNull();
  });
});
