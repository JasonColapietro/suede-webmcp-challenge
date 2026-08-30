/**
 * Production wiring for the MCP endpoint: real catalog, real engine, real
 * credit ledger. The pure layers (protocol, server, tools, call) take these
 * as injected dependencies so they stay testable without any of it.
 *
 * Server-only — pulls the engine and the database. Never import from a client
 * component (see AGENTS.md on the client/server split).
 */
import { buildCatalog, type CatalogEntry } from "@/lib/catalog";
import { getRepo, type FlowRepo } from "@/lib/db/repo";
import {
  bindPreparedPublishedLiveResourceSnapshot,
  disposePreparedPublishedLiveExecution,
  preparePublishedLiveExecution,
  runPreparedPublishedLiveToCompletion,
} from "@/lib/run-service";
import {
  callAgentTool,
  type McpAgentRunner,
  type McpPreparedAgentRun,
} from "./call";
import type { McpServerDeps } from "./server";
import { catalogToTools, mcpEligibility } from "./tools";
import {
  curatedBusinessService,
  extractCuratedServiceResult,
} from "@/lib/curated-business-services";
import {
  publicResourceDependencyContractMatches,
  resolvePublicServiceContractFromRelease,
  type PublicServiceContract,
} from "@/lib/public-service-contract";
import { getResourceRepository } from "@/lib/resources/provider";
import { RESOURCE_FOUNDRY_ENABLED } from "@/lib/resources/flags";
import { loadExactFreshResourcePackSnapshot } from "@/lib/projects/resource-dependencies";

/**
 * Live agents this endpoint is willing to expose.
 *
 * Company employees and relay-backed agents are filtered out here and refused
 * again inside callAgentTool — see mcpEligibility for why. The per-agent
 * lookups are N queries over the live catalog, which is small; if the
 * directory grows past a few hundred agents this wants a bulk read.
 */
async function eligibleEntries(
  repo: FlowRepo,
  entries: readonly CatalogEntry[],
): Promise<CatalogEntry[]> {
  const verdicts = await Promise.all(
    entries.map(async (entry) => {
      const [employee, relay] = await Promise.all([
        typeof repo.getEmployeeByAgent === "function"
          ? repo.getEmployeeByAgent(entry.id).catch(() => null)
          : Promise.resolve(null),
        repo.getRelayEndpoint(entry.id).catch(() => null),
      ]);
      return mcpEligibility({
        isCompanyEmployee: employee !== null,
        hasRelay: relay !== null,
        hasPublishedDeployment: entry.publishedLive,
      }).eligible;
    }),
  );
  return entries.filter((_, i) => verdicts[i]);
}

/**
 * Execute a published agent's live deployment, the same path the x402 run
 * route takes. Only immutable published versions run here — a draft edit on
 * the creator's canvas must never change what a paying caller gets.
 */
const preparePublishedAgent = async ({
  entry, flowId, ownerId, input,
}: Parameters<McpAgentRunner>[0]): Promise<McpPreparedAgentRun> => {
  const prepared = await preparePublishedLiveExecution({ flowId, ownerId });
  if (!prepared) {
    throw new Error(`no published live deployment for flow ${flowId}`);
  }
  try {
    const hasResourceMarker = prepared.graph.meta?.resourceProduct !== undefined;
    const hasResourceDependencies = prepared.resourceDependencies.length > 0;
    if (!publicResourceDependencyContractMatches({
          graph: prepared.graph,
          resourceDependencies: prepared.resourceDependencies,
          release: prepared.release,
        }) || hasResourceMarker !== hasResourceDependencies) {
      throw new Error(`published resource contract unavailable for flow ${flowId}`);
    }
    let resourceService: PublicServiceContract | null = null;
    if (hasResourceDependencies) {
      if (!RESOURCE_FOUNDRY_ENABLED) {
        throw new Error(`published resource contract unavailable for flow ${flowId}`);
      }
      const repo = await getRepo();
      const [agent, flow, resourceRepository] = await Promise.all([
        repo.getAgent(entry.id),
        repo.getFlow(flowId),
        getResourceRepository().catch(() => null),
      ]);
      resourceService = agent && flow
        ? await resolvePublicServiceContractFromRelease({
            agent, flow,
            publicRelease: {
              graph: prepared.graph,
              resourceDependencies: prepared.resourceDependencies,
              release: prepared.release,
            },
            resourceRepository,
          })
        : null;
      if (resourceService?.kind !== "resource") {
        throw new Error(`published resource contract unavailable for flow ${flowId}`);
      }
      const freshSnapshot = resourceRepository
        ? await loadExactFreshResourcePackSnapshot(
            ownerId,
            resourceRepository,
            prepared.resourceDependencies,
          )
        : null;
      if (!freshSnapshot ||
          !bindPreparedPublishedLiveResourceSnapshot(prepared, freshSnapshot)) {
        throw new Error(`published resource contract unavailable for flow ${flowId}`);
      }
    }
    let executed = false;
    let disposed = false;
    return {
      resourceService,
      execute: async () => {
        if (executed) throw new Error(`published run already executed for flow ${flowId}`);
        executed = true;
        const summary = await runPreparedPublishedLiveToCompletion(prepared, {
          flowId,
          ownerId,
          trigger: "agent",
          agentId: entry.id,
          triggerInput: input,
        });
        if (!summary) throw new Error(`published run unavailable for flow ${flowId}`);
        const result = extractCuratedServiceResult(
          curatedBusinessService(entry.slug, prepared.graph),
          prepared.graph,
          summary.outputs,
        );
        return {
          runId: summary.runId,
          status: summary.status,
          outputs: summary.outputs,
          totalCostUsdc: summary.totalCostUsdc,
          result,
        };
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        disposePreparedPublishedLiveExecution(prepared);
      },
    };
  } catch (error) {
    disposePreparedPublishedLiveExecution(prepared);
    throw error;
  }
};

const runPublishedAgent = Object.assign(
  async (input: Parameters<McpAgentRunner>[0]) => {
    const prepared = await preparePublishedAgent(input);
    try { return await prepared.execute(); } finally { prepared.dispose(); }
  },
  { prepare: preparePublishedAgent },
) satisfies McpAgentRunner;

/** Build the dependency set the MCP dispatcher runs against in production. */
export async function createMcpDeps(): Promise<McpServerDeps> {
  const repo = await getRepo();
  const loadCatalog = async (): Promise<CatalogEntry[]> =>
    eligibleEntries(repo, await buildCatalog());

  return {
    listTools: async () => catalogToTools(await loadCatalog()),
    callTool: (input) =>
      callAgentTool(input, {
        repo,
        loadCatalog,
        runAgent: runPublishedAgent,
        ...(RESOURCE_FOUNDRY_ENABLED ? {
          resolveResourceRepository: () => getResourceRepository().catch(() => null),
        } : {}),
      }),
  };
}
