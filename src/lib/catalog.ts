/**
 * Public catalog of launched agents — the shop window. One query path shared
 * by the /agents directory, /api/catalog feed, the root x402 index, and the
 * sitemap so every surface agrees on what is "live". Calls count EXTERNAL
 * machine calls (trigger "agent") only, so scheduled self-runs never inflate
 * the social proof.
 *
 * Test/demo agents (slugs or names matching common CLI test patterns) are
 * excluded from the public listing so they don't clutter the directory.
 */
import {
  getRepo,
  type AgentRecord,
  type FlowRecord,
  type FlowRepo,
  type ScheduleRecord,
  type SiteVerificationRecord,
  type SiteVerificationRequirement,
  type WalletRecord,
} from "./db/repo";
import type { NodeType, SupportedFlowGraph } from "./flow/types";
import { getNodeMeta } from "./flow/node-meta";
import type { JsonObjectSchema } from "./flow/input-contract";
import { describeCron } from "./cron";
import {
  selectPayout,
  type PayoutInfo,
} from "./payout";
import { getProjectRepo } from "./projects/provider";
import type { ProjectRepo } from "./projects/repo";
import type { DeploymentRecord } from "./projects/types";
import { resolvePublicAgentRelease, type PublicAgentRelease } from "./projects/public-agent-graph";
import {
  SITE_AGENT_TEMPLATE_PREFIX,
  SITE_HOST_META_KEY,
} from "./site/blueprint-meta";
import { getResourceRepository } from "./resources/provider";
import { RESOURCE_FOUNDRY_ENABLED } from "./resources/flags";
import {
  RESOURCE_CONTRACT_EXTENSION_URI,
  publicResourceDependencyContractMatches,
  resolvePublicServiceContractFromRelease,
} from "./public-service-contract";
import {
  projectAp2Discovery,
  type Ap2DiscoveryStatus,
} from "./discovery/agent-card";
import { publicAp2RuntimeStatus } from "./rails/ap2/config";
import { isAp2ServiceEligible } from "./rails/ap2-eligibility";
import { companyServiceSupportsPublicAp2 } from "./rails/ap2-company-eligibility";
import {
  resolvePublicPaymentReadiness,
  type PublicPaymentState,
} from "./public-payment-readiness";

export interface CatalogEntry {
  id: string;
  slug: string;
  name: string;
  summary: string;
  /** Creator-written pitch from graph.meta.description, when one exists. */
  description: string | null;
  priceUsdc: number;
  calls: number;
  /**
   * External calls that actually settled on-chain (settled_at IS NOT NULL).
   * Dry-runs never count here, so this number can never overstate revenue.
   */
  settledCalls: number;
  /** Ms epoch of the most recent external call, or null when never called. */
  lastCallAt: number | null;
  createdAt: number;
  /** Per-agent settlement opt-in, straight from the agent record. */
  settlementLive: boolean;
  /**
   * True only when the complete current paid-call contract is ready: an exact
   * immutable Live execution, agent and platform settlement flags, a positive
   * price, an actual configured payout, and company status, approval, trigger,
   * department, and budget gates.
   */
  acceptsPayment: boolean;
  /** Canonical public call state shared by every discovery projection. */
  paymentState: PublicPaymentState;
  /** True only when an explicit public dry-run request can execute. */
  previewAvailable: boolean;
  /** Where paid calls route — the creator's wallet, or the zero address. */
  payTo: string;
  /** Human cadence ("daily at 09:00 UTC") when the agent runs on its own. */
  schedule: string | null;
  /**
   * JSON Schema for the agent's trigger input, derived from the published
   * graph's input node. Consumed by the MCP tool surface and any other client
   * that has to construct a call without a human reading the canvas.
   */
  inputSchema: JsonObjectSchema;
  /** Typed service result, present for Suede-curated service instances. */
  outputSchema?: JsonObjectSchema;
  /** Safe request/response examples for machine discovery and client generation. */
  exampleInput?: Readonly<Record<string, unknown>>;
  exampleOutput?: Readonly<Record<string, unknown>>;
  /** Semantic search terms for registries, MCP clients, and agent cards. */
  tags?: readonly string[];
  /** Suede's explicit curation claim. Absent for ordinary customer listings. */
  curation?: {
    key: string;
    collection: string;
    operator: string;
    buyerIntent: string;
    reviewPolicy: string;
    dataHandling: string;
  };
  /** Registered namespaced public contracts. Ordinary agents omit this field. */
  extensions?: Readonly<Record<string, unknown>>;
  /**
   * True when an active Live deployment backs this agent, so a paid call can
   * resolve an immutable published version. False also covers "we could not
   * tell" (no project repo, or a failed deployment read), which keeps
   * consumers that gate on it failing closed. `summary`/`inputSchema` may
   * still be derived from the draft graph when this is false.
   */
  publishedLive: boolean;
  /**
   * Present only when AP2 is enabled and every merchant signing, issuer-trust,
   * and durable replay dependency passes the shared runtime readiness check.
   */
  ap2?: NonNullable<ReturnType<typeof projectAp2Discovery>>;
  urls: {
    public: string;
    run: string;
    x402: string;
    agentCard: string;
    a2a: string;
  };
}

export interface CatalogBuildTiming {
  name: string;
  durationMs: number;
}

export interface CatalogBuildOptions {
  onTiming?(timing: CatalogBuildTiming): void;
}

interface CatalogBase {
  flows: Array<FlowRecord | null>;
  counts: Record<string, number>;
  /** Settled external calls per agent; missing key means zero settled. */
  settledCounts: Record<string, number>;
  /** Ms epoch of each agent's most recent external call. */
  lastCalls: Record<string, number>;
  schedules: ScheduleRecord[];
  wallets: Array<WalletRecord | null>;
}

interface CatalogBaseCacheEntry {
  expiresAt: number;
  promise: Promise<CatalogBase>;
}

const CATALOG_BASE_TTL_MS = 30_000;
const CATALOG_BASE_MAX_KEYS = 4;
const catalogBaseCaches = new WeakMap<
  FlowRepo,
  Map<string, CatalogBaseCacheEntry>
>();

interface CatalogPublishedGraphCacheEntry {
  expiresAt: number;
  promise: Promise<PublicAgentRelease | null>;
}

// Published versions are immutable, and the deployment identity that keys this
// cache is re-read fresh on every invocation. Five minutes spans the two-minute
// directory/home refresh window without caching Live status or price.
const CATALOG_PUBLISHED_GRAPH_TTL_MS = 5 * 60_000;
const CATALOG_PUBLISHED_GRAPH_MAX_KEYS = 64;
const catalogPublishedGraphCaches = new WeakMap<
  ProjectRepo,
  Map<string, CatalogPublishedGraphCacheEntry>
>();

function catalogBaseKey(agents: readonly AgentRecord[]): string {
  return JSON.stringify(
    agents.map(({ id, flowId, createdAt }) => [id, flowId, createdAt]),
  );
}

function cacheForRepo(repo: FlowRepo): Map<string, CatalogBaseCacheEntry> {
  const existing = catalogBaseCaches.get(repo);
  if (existing) return existing;
  const created = new Map<string, CatalogBaseCacheEntry>();
  catalogBaseCaches.set(repo, created);
  return created;
}

async function buildCatalogBase(
  repo: FlowRepo,
  agents: readonly AgentRecord[],
): Promise<CatalogBase> {
  const agentIds = agents.map((agent) => agent.id);
  const flowIds = agents.map((agent) => agent.flowId);
  const flowsPromise = (async (): Promise<Array<FlowRecord | null>> => {
    const bulkFlows = repo.listFlowsByIds
      ? await repo.listFlowsByIds(flowIds).catch(() => null)
      : null;
    const flowById = bulkFlows === null
      ? null
      : new Map(bulkFlows.map((flow) => [flow.id, flow]));
    return flowById
      ? agents.map((agent) => flowById.get(agent.flowId) ?? null)
      : Promise.all(agents.map((agent) => repo.getFlow(agent.flowId)));
  })();
  // Both aggregates fail CLOSED to "nothing settled / never called": a repo
  // without the method or a failed read must never inflate the shelf.
  const settledCountsPromise: Promise<Record<string, number>> =
    typeof repo.countSettledRunsByAgent === "function"
      ? repo.countSettledRunsByAgent(agentIds).catch(() => ({}))
      : Promise.resolve({});
  const lastCallsPromise: Promise<Record<string, number>> =
    typeof repo.lastAgentCallAt === "function"
      ? repo.lastAgentCallAt(agentIds, "agent").catch(() => ({}))
      : Promise.resolve({});
  const [flows, counts, schedules, settledCounts, lastCalls] = await Promise.all([
    flowsPromise,
    repo.countRunsByAgent(agentIds, "agent"),
    repo.listSchedulesByAgents(agentIds),
    settledCountsPromise,
    lastCallsPromise,
  ]);
  const ownerIds = [...new Set(flows.flatMap((flow) =>
    flow ? [flow.ownerId] : []))];
  const bulkWallets = repo.listWalletsByOwners
    ? await repo.listWalletsByOwners(ownerIds).catch(() => null)
    : null;
  const wallets = bulkWallets ??
    await Promise.all(ownerIds.map((ownerId) => repo.getWallet(ownerId)));
  return { flows, counts, settledCounts, lastCalls, schedules, wallets };
}

async function loadCatalogBase(
  repo: FlowRepo,
  agents: readonly AgentRecord[],
): Promise<{ base: CatalogBase; cacheHit: boolean }> {
  const cache = cacheForRepo(repo);
  const key = catalogBaseKey(agents);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return { base: await cached.promise, cacheHit: true };
  }
  if (cached) cache.delete(key);

  const promise = buildCatalogBase(repo, agents);
  cache.set(key, {
    expiresAt: now + CATALOG_BASE_TTL_MS,
    promise,
  });
  while (cache.size > CATALOG_BASE_MAX_KEYS) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    cache.delete(oldestKey);
  }
  try {
    return { base: await promise, cacheHit: false };
  } catch (error) {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  }
}

function publishedGraphKey(
  flow: FlowRecord,
  deployment: DeploymentRecord,
): string {
  return JSON.stringify([
    flow.ownerId,
    deployment.id,
    deployment.flowId,
    deployment.flowVersionId,
    deployment.environmentId,
    deployment.createdAt,
  ]);
}

function publishedGraphCacheForRepo(
  repo: ProjectRepo,
): Map<string, CatalogPublishedGraphCacheEntry> {
  const existing = catalogPublishedGraphCaches.get(repo);
  if (existing) return existing;
  const created = new Map<string, CatalogPublishedGraphCacheEntry>();
  catalogPublishedGraphCaches.set(repo, created);
  return created;
}

async function loadPublishedCatalogGraph(input: {
  flow: FlowRecord;
  projectRepo: ProjectRepo;
  activeDeployment: DeploymentRecord;
}): Promise<{ release: PublicAgentRelease | null; cacheHit: boolean }> {
  const cache = publishedGraphCacheForRepo(input.projectRepo);
  const key = publishedGraphKey(input.flow, input.activeDeployment);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return { release: await cached.promise, cacheHit: true };
  }
  if (cached) cache.delete(key);

  const promise = resolvePublicAgentRelease({
    flow: input.flow,
    projectRepo: input.projectRepo,
    activeDeployment: input.activeDeployment,
  });
  cache.set(key, {
    expiresAt: now + CATALOG_PUBLISHED_GRAPH_TTL_MS,
    promise,
  });
  while (cache.size > CATALOG_PUBLISHED_GRAPH_MAX_KEYS) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    cache.delete(oldestKey);
  }
  try {
    const release = await promise;
    if (release === null && cache.get(key)?.promise === promise) cache.delete(key);
    return { release, cacheHit: false };
  } catch (error) {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  }
}

function emitCatalogTiming(
  options: CatalogBuildOptions,
  name: string,
  startedAt: number,
): void {
  options.onTiming?.({
    name,
    durationMs: Math.max(0, performance.now() - startedAt),
  });
}

/**
 * Slugs or name fragments that identify test/CLI agents. These are excluded
 * from the public directory so the listing shows only real, sellable agents.
 *
 * A bare "test" alternative used to sit here too, matching the word anywhere
 * in a slug/name (hyphens count as word boundaries in a `\b` regex, so
 * "Function-to-Test-Cases" — a real template — matched it). No test in this
 * suite ever exercised that case; the only asserted positive
 * ("cli-stable-roundtrip-uf8rm") is already covered by `cli[-_ ]?stable` and
 * `stable[-_ ]?roundtrip` below. `cli[-_ ]?test` stays: it requires the "cli"
 * prefix real CLI-generated fixtures actually use, so it doesn't broadly
 * match ordinary product names the way bare "test" did.
 */
const TEST_PATTERNS =
  /\b(cli[-_ ]?test|cli[-_ ]?stable|stable[-_ ]?roundtrip|roundtrip|hello|echo|demo|ping|sandbox)\b/i;

/** Returns true if an agent slug or flow name looks like a test/demo artifact. */
export function isTestAgent(slug: string, name: string): boolean {
  return TEST_PATTERNS.test(slug) || TEST_PATTERNS.test(name);
}

/** The slice of FlowRepo the listing gate needs; optional so absence fails closed. */
export interface SiteVerificationReader {
  getSiteVerification?(ownerId: string, host: string): Promise<unknown | null>;
  listSiteVerificationsByOwnersAndHosts?(
    requirements: readonly SiteVerificationRequirement[],
  ): Promise<SiteVerificationRecord[]>;
}

function siteVerificationRequirement(
  meta: Readonly<Record<string, unknown>> | undefined,
  ownerId: string,
): SiteVerificationRequirement | null | undefined {
  const template = meta?.template;
  if (typeof template !== "string" || !template.startsWith(SITE_AGENT_TEMPLATE_PREFIX)) {
    return undefined;
  }
  const host = meta?.[SITE_HOST_META_KEY];
  if (typeof host !== "string" || host === "") return null;
  return { ownerId, host };
}

function siteVerificationKey(
  requirement: SiteVerificationRequirement,
): string {
  return JSON.stringify([requirement.ownerId, requirement.host]);
}

/**
 * True when this agent must stay OUT of the public catalog: it was drafted
 * from a website (site-agent template marker) and the owning workspace has
 * not proven it controls that domain. Fails closed on every edge — a
 * missing siteHost marker, a repo without the verification methods/table,
 * and a lookup error all read as unverified.
 */
export async function siteAgentListingBlocked(
  meta: Readonly<Record<string, unknown>> | undefined,
  ownerId: string,
  repo: SiteVerificationReader,
): Promise<boolean> {
  const requirement = siteVerificationRequirement(meta, ownerId);
  if (requirement === undefined) return false;
  if (requirement === null) return true;
  const verification = await repo
    .getSiteVerification?.(requirement.ownerId, requirement.host)
    .catch(() => null);
  return verification == null;
}

/** Human chain like "Input › Generate Song › Register IP › Output". */
export function summarizeGraph<Graph extends { readonly nodes: readonly { readonly type: NodeType }[] }>(graph: Graph): string {
  if (graph.nodes.length === 0) return "Empty flow";
  const labels = graph.nodes
    .slice(0, 6)
    .map((n) => getNodeMeta(n.type)?.label ?? n.type);
  const tail = graph.nodes.length > 6 ? " › …" : "";
  return labels.join(" › ") + tail;
}

export async function buildCatalog(
  options: CatalogBuildOptions = {},
): Promise<CatalogEntry[]> {
  const totalStartedAt = performance.now();
  const repoStartedAt = performance.now();
  const repo = await getRepo();
  emitCatalogTiming(options, "catalog_repo", repoStartedAt);
  const projectRepoPromise = getProjectRepo().catch(() => null);
  const sourceStartedAt = performance.now();
  // This read is deliberately never cached: it is the source of truth for
  // public Live membership and price on every catalog invocation.
  const agents = await repo.listLiveAgents();
  emitCatalogTiming(options, "catalog_source_fresh", sourceStartedAt);
  if (agents.length === 0) {
    emitCatalogTiming(options, "catalog_total", totalStartedAt);
    return [];
  }
  const baseStartedAt = performance.now();
  const [{ base, cacheHit }, projectRepo, ap2Status] = await Promise.all([
    loadCatalogBase(repo, agents),
    projectRepoPromise,
    publicAp2RuntimeStatus(),
  ]);
  const ap2 = projectAp2Discovery(ap2Status satisfies Ap2DiscoveryStatus);
  const { flows, counts, settledCounts, lastCalls, schedules, wallets } = base;
  // Same platform-live conjunction the run route enforces; read fresh per
  // build so a settlement flip never serves from a stale closure.
  const globalSettlementLive = process.env.X402_SKIP_SETTLEMENT === "false";
  emitCatalogTiming(
    options,
    cacheHit ? "catalog_base_hit" : "catalog_base_miss",
    baseStartedAt,
  );
  const scheduleByAgent = new Map(schedules.filter((s) => s.enabled).map((s) => [s.agentId, s]));

  // Flow/call/schedule/wallet enrichment is stable enough for a tiny bounded
  // process cache. Active deployments are intentionally excluded and checked
  // below on every invocation, so promotion/retirement remains fresh too.
  const ownerIds = [...new Set(flows.flatMap((f) => (f ? [f.ownerId] : [])))];
  let activeDeploymentFallback = false;
  const enrichmentStartedAt = performance.now();
  const activeDeployments = projectRepo?.listActiveDeploymentsForFlows
    ? await projectRepo.listActiveDeploymentsForFlows({
        flows: flows.flatMap((flow) =>
          flow ? [{ flowId: flow.id, ownerId: flow.ownerId }] : []),
        environmentKind: "live",
      }).catch(() => {
        activeDeploymentFallback = true;
        return null;
      })
    : null;
  emitCatalogTiming(
    options,
    activeDeploymentFallback
      ? "catalog_enrichment_fallback"
      : "catalog_enrichment",
    enrichmentStartedAt,
  );
  const walletAddressByOwner = new Map<string, string>();
  for (const wallet of wallets) {
    if (wallet) walletAddressByOwner.set(wallet.ownerId, wallet.address);
  }
  const payoutByOwner = new Map<string, PayoutInfo>(
    ownerIds.map((ownerId) => [
      ownerId,
      selectPayout([
        { payTo: walletAddressByOwner.get(ownerId), source: "creator" },
        { payTo: process.env.X402_SELLER_WALLET_ADDRESS, source: "platform" },
      ]),
    ]),
  );
  const activeDeploymentByFlow = activeDeployments === null
    ? null
    : new Map(activeDeployments.map((deployment) => [deployment.flowId, deployment]));

  const resolutionStartedAt = performance.now();
  const graphResolutionStartedAt = performance.now();
  let graphCacheHits = 0;
  let graphCacheMisses = 0;
  const resolvedGraphs = await Promise.all(
    agents.map(async (agent, i) => {
      const flow = flows[i];
      if (!flow) return null;
      const activeDeployment = activeDeploymentByFlow?.get(flow.id) ?? null;
      if (!projectRepo || !activeDeploymentByFlow || !activeDeployment) return null;
      const loaded = await loadPublishedCatalogGraph({
        flow,
        projectRepo,
        activeDeployment,
      });
      if (projectRepo && activeDeploymentByFlow && activeDeployment) {
        if (loaded.cacheHit) graphCacheHits += 1;
        else graphCacheMisses += 1;
      }
      const publicRelease = loaded.release;
      if (!publicRelease) return null;
      const publicGraph = publicRelease.graph as SupportedFlowGraph;
      // Skip test/CLI demo agents so they don't pollute the public directory.
      if (isTestAgent(agent.slug, flow.name)) return null;
      return { agent, flow, publicGraph, publicRelease };
    }),
  );
  emitCatalogTiming(
    options,
    graphCacheHits > 0 && graphCacheMisses === 0
      ? "catalog_graph_cache_hit"
      : graphCacheHits > 0
        ? "catalog_graph_cache_mixed"
        : "catalog_graph_resolve",
    graphResolutionStartedAt,
  );

  const candidates = resolvedGraphs
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .filter(({ publicRelease }) => publicResourceDependencyContractMatches(publicRelease));
  const resourceAgentIds = RESOURCE_FOUNDRY_ENABLED
    ? candidates.flatMap(({ agent, publicGraph }) =>
        publicGraph.meta?.resourceProduct === undefined ? [] : [agent.id])
    : [];
  const resourceRepository = resourceAgentIds.length === 0
    ? null
    : await getResourceRepository().catch(() => null);
  const resourceReleases = resourceRepository
    ? await resourceRepository.listPublishedReleasesByAgentIds(resourceAgentIds).catch(() => null)
    : null;
  const resourceReleaseByAgent = new Map(
    (resourceReleases ?? []).map((release) => [release.agentId, release]),
  );
  const siteVerificationStartedAt = performance.now();
  const siteRequirements = candidates.flatMap(({ flow, publicGraph }) => {
    const requirement = siteVerificationRequirement(publicGraph.meta, flow.ownerId);
    return requirement ? [requirement] : [];
  });
  const bulkSiteVerifications =
    repo.listSiteVerificationsByOwnersAndHosts && siteRequirements.length > 0
      ? await repo
          .listSiteVerificationsByOwnersAndHosts(siteRequirements)
          .catch(() => [])
      : null;
  const verifiedSiteKeys = bulkSiteVerifications === null
    ? null
    : new Set(bulkSiteVerifications.map(siteVerificationKey));

  const resolved = await Promise.all(
    candidates.map(async ({ agent, flow, publicGraph, publicRelease }) => {
      const hasResourceMarker = publicGraph.meta?.resourceProduct !== undefined;
      const service = await resolvePublicServiceContractFromRelease({
        agent,
        flow,
        publicRelease,
        resourceRepository: hasResourceMarker ? resourceRepository : null,
        ...(hasResourceMarker
          ? { resourceRelease: resourceReleaseByAgent.get(agent.id) ?? null }
          : {}),
      });
      if (!service || service.resource?.access.execution === "private" ||
          service.resource?.access.discovery === "unlisted") return null;
      // Site-drafted agents speak for a real business, so they stay UNLISTED
      // until the owning workspace has proven it controls that domain
      // (lib/site/verification.ts).
      const siteRequirement = siteVerificationRequirement(publicGraph.meta, flow.ownerId);
      const siteBlocked = siteRequirement === null ||
        (siteRequirement !== undefined &&
          (verifiedSiteKeys
            ? !verifiedSiteKeys.has(siteVerificationKey(siteRequirement))
            : await siteAgentListingBlocked(publicGraph.meta, flow.ownerId, repo)));
      if (siteBlocked) return null;
      const schedule = scheduleByAgent.get(agent.id);
      const curated = service.curated;
      const readiness = await resolvePublicPaymentReadiness({
        agent,
        flow,
        repo,
        publishedGraph: publicGraph,
        liveExecutionReady: true,
        fallbackPayout: payoutByOwner.get(flow.ownerId) ?? selectPayout([]),
        platformSettlementLive: globalSettlementLive,
      });
      const [relay, companySupportsAp2] = ap2
        ? await Promise.all([
            repo.getRelayEndpoint(agent.id).catch(() => undefined),
            companyServiceSupportsPublicAp2({
              repo,
              agentId: agent.id,
              graph: publicGraph,
            }),
          ])
        : [null, true] as const;
      const fulfillmentSupportsAp2 = relay !== undefined
        && (relay === null || relay.protocolVersion === 2)
        && companySupportsAp2;
      const entry: CatalogEntry = {
        id: agent.id,
        slug: agent.slug,
        name: service.name,
        summary: summarizeGraph(publicGraph),
        description: curated?.description ?? (() => {
          const d = publicGraph.meta?.description;
          return typeof d === "string" && d.trim() !== "" ? d.trim().slice(0, 140) : null;
        })(),
        priceUsdc: agent.priceUsdc,
        calls: counts[agent.id] ?? 0,
        settledCalls: settledCounts[agent.id] ?? 0,
        lastCallAt: lastCalls[agent.id] ?? null,
        createdAt: agent.createdAt,
        settlementLive: agent.settlementLive,
        acceptsPayment: readiness.acceptsPayment,
        paymentState: readiness.state,
        previewAvailable: readiness.previewAvailable,
        payTo: readiness.payout.payTo,
        schedule: schedule ? describeCron(schedule.cron) : null,
        inputSchema: service.inputSchema as JsonObjectSchema,
        ...(curated
          ? {
              outputSchema: curated.outputSchema,
              exampleInput: curated.exampleInput,
              exampleOutput: curated.exampleOutput,
              tags: curated.tags,
              curation: {
                key: curated.key,
                collection: curated.collection,
                operator: curated.operator,
                buyerIntent: curated.buyerIntent,
                reviewPolicy: curated.reviewPolicy,
                dataHandling: curated.dataHandling,
              },
            }
          : {}),
        ...(service.resource
          ? {
              outputSchema: (service.responseSchema ?? service.outputSchema) as JsonObjectSchema,
              exampleInput: service.exampleInput,
              ...(service.responseExample ? { exampleOutput: service.responseExample } : {}),
              tags: service.tags,
              extensions: { [RESOURCE_CONTRACT_EXTENSION_URI]: service.resource },
            }
          : {}),
        publishedLive: readiness.publishedLive,
        ...(ap2 && isAp2ServiceEligible({
          priceUsdc: agent.priceUsdc,
          acceptsPayment: readiness.acceptsPayment,
          publishedLive: readiness.publishedLive,
          fulfillmentSupportsAp2,
        }) ? { ap2 } : {}),
        urls: service.kind === "resource" ? service.urls : {
          public: `/a/${agent.slug}`,
          // A readable slug is the canonical resource identity. Coinbase
          // Bazaar intentionally consolidates UUID path segments; a slug keeps
          // each service independently indexable while the route still accepts
          // the legacy id form for compatibility.
          run: `/api/agents/${agent.slug}/run`,
          x402: `/api/agents/${agent.slug}/.well-known/x402`,
          agentCard: `/api/agents/${agent.slug}/.well-known/agent-card.json`,
          a2a: `/api/agents/${agent.slug}/a2a`,
        },
      };
      return entry;
    }),
  );
  const entries = resolved.filter((entry): entry is CatalogEntry => entry !== null);
  emitCatalogTiming(options, "catalog_site_verification", siteVerificationStartedAt);
  emitCatalogTiming(options, "catalog_resolve", resolutionStartedAt);
  emitCatalogTiming(options, "catalog_total", totalStartedAt);
  return entries;
}
