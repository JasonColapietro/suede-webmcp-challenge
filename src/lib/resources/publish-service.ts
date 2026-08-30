import { createHash } from "node:crypto";
import { z } from "zod";
import { isAddress } from "viem";
import type { AgentRecord, FlowRepo } from "@/lib/db/repo";
import { collectRun, runFlow } from "@/lib/flow/engine";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { getRegistry } from "@/lib/flow/registry";
import { promoteFlowToLive } from "@/lib/launch/promote-live";
import { RunLogger } from "@/lib/log";
import { hashFlowGraph } from "@/lib/projects/hash";
import type { ProjectRepo } from "@/lib/projects/repo";
import { resourceDependencyPinsFromGraph } from "@/lib/projects/resource-dependencies";
import { buildRunContext } from "@/lib/run-context";
import {
  canonicalResourceAgentSlug,
  materializeResourceGraph,
  type MaterializedResourceGraph,
} from "./materialize";
import {
  ResourceAmbiguousFinalCommitError,
  ResourceRepositoryConflictError,
  ResourceRepositoryNotFoundError,
  type ResourceRelease,
  type ResourceRepository,
} from "./repository";
import {
  assertResourceFoundryEnabled,
  ResourceFoundryService,
  ResourceServiceInvalidError,
} from "./service";
import type { ResourcePackBundle, ResourceProduct } from "./types";

const IdText = z.string().trim().min(1).max(128);

export const PublishResourceRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  priceUsdc: z.number().finite().nonnegative().max(1_000_000),
  payoutAddress: z.string().trim().min(1).max(128).optional(),
  representative: z.object({
    input: z.unknown(),
    filters: z.record(z.string(), z.unknown()),
    expectedProperties: z.array(IdText).min(1).max(64).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
}).strict();

export const MaterializeResourceRequestSchema = z.object({}).strict();

export type PublishResourceRequest = z.infer<typeof PublishResourceRequestSchema>;

export class ResourcePublicationRefusedError extends Error {
  constructor() { super("resource publication refused"); this.name = "ResourcePublicationRefusedError"; }
}

interface DryRunResult { readonly measuredCostUsdc: number }
interface DryRunInput {
  readonly ownerId: string;
  readonly product: ResourceProduct;
  readonly pack: ResourcePackBundle;
  readonly graph: MaterializedResourceGraph["graph"];
  readonly graphSemanticHash: string;
  readonly graphFullHash: string;
  readonly representative: PublishResourceRequest["representative"];
}

export interface ResourcePublishDependencies {
  readonly resourceRepo: ResourceRepository;
  readonly flowRepo: FlowRepo;
  readonly projectRepo: ProjectRepo;
  readonly dryRun?: (input: DryRunInput) => Promise<DryRunResult>;
}

export interface MaterializedResourceFlow extends MaterializedResourceGraph {
  readonly flowId: string;
  readonly product: ResourceProduct;
  readonly pack: ResourcePackBundle;
}

export interface PublishedResourceProduct {
  readonly agent: AgentRecord;
  readonly release: ResourceRelease;
  readonly urls: {
    readonly run: string;
    readonly card: string;
    readonly x402: string;
    readonly a2a: string;
    readonly public: string;
  };
}

function exactDependency(version: Awaited<ReturnType<ProjectRepo["getFlowVersion"]>>, pack: ResourcePackBundle): boolean {
  if (!version) return false;
  return version.dependencies.some((dependency) =>
    dependency.kind === "resource" && dependency.resourceId === pack.resourceProductId &&
    dependency.version === pack.packVersionId && dependency.contentHash === pack.semanticHash,
  );
}

function canonicalRequest(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ResourcePublicationRefusedError();
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (!value || typeof value !== "object") throw new ResourcePublicationRefusedError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ResourcePublicationRefusedError();
  return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalRequest(entry)]));
}

function publicationIdentity(input: PublishResourceRequest): {
  readonly publicationKey: string;
  readonly publicationRequestHash: string;
} {
  const canonical = canonicalRequest({
    priceUsdc: input.priceUsdc,
    payoutAddress: input.payoutAddress ?? null,
    representative: input.representative,
  });
  const publicationRequestHash = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8").digest("hex");
  return {
    publicationKey: input.idempotencyKey ?? publicationRequestHash,
    publicationRequestHash,
  };
}

async function evaluateExactMaterializedGraph(
  repository: ResourceRepository,
  input: DryRunInput,
): Promise<DryRunResult> {
  let graph: MaterializedResourceGraph["graph"];
  try {
    graph = parseSupportedFlowGraph(input.graph) as MaterializedResourceGraph["graph"];
    const dependencies = resourceDependencyPinsFromGraph(graph);
    if (dependencies.length !== 1 || dependencies[0]?.kind !== "resource" ||
        dependencies[0].resourceId !== input.product.id ||
        dependencies[0].version !== input.pack.packVersionId ||
        dependencies[0].contentHash !== input.pack.semanticHash ||
        hashFlowGraph(graph, { semantic: true }, dependencies) !== input.graphSemanticHash ||
        hashFlowGraph(graph, { semantic: false }, dependencies) !== input.graphFullHash) {
      throw new ResourcePublicationRefusedError();
    }
  } catch (error) {
    if (error instanceof ResourceServiceInvalidError) throw new ResourcePublicationRefusedError();
    throw error;
  }

  // Preserve the reviewed representative input/schema validation, then run
  // the exact hashed graph through the native engine and registry. The only
  // runtime authority is this exact already-approved pack, so no graph field
  // can redirect the evaluator to a caller-selected dependency.
  let direct: Awaited<ReturnType<ResourceFoundryService["dryRun"]>>;
  try {
    direct = await new ResourceFoundryService(repository).dryRun(
      input.ownerId,
      input.product.id,
      {
        packVersionId: input.pack.packVersionId,
        semanticHash: input.pack.semanticHash,
        input: input.representative.input,
        filters: input.representative.filters,
        filterFields: [...input.pack.content.filterFields],
        returnFields: [...input.pack.content.returnFields],
        ...(input.representative.expectedProperties === undefined
          ? {}
          : { expectedProperties: input.representative.expectedProperties }),
        ...(input.representative.limit === undefined ? {} : { limit: input.representative.limit }),
      },
    );
  } catch {
    throw new ResourcePublicationRefusedError();
  }
  if (direct.measuredCostUsdc !== 0) throw new ResourcePublicationRefusedError();
  try {
    const logger = new RunLogger();
    const registry = getRegistry();
    const context = {
      ...buildRunContext({
        runId: "resource-publication-representative",
        logger,
        dryRun: true,
        ownerId: input.ownerId,
        rootFlowId: input.product.id,
      }),
      registry,
      resolveResourcePack: async (reference: {
        readonly resourceProductId: string;
        readonly packVersionId: string;
        readonly contentHash: string;
      }) => reference.resourceProductId === input.product.id &&
        reference.packVersionId === input.pack.packVersionId &&
        reference.contentHash === input.pack.semanticHash
        ? Object.freeze({ status: "approved" as const, bundle: input.pack })
        : null,
    };
    const summary = await collectRun(runFlow(graph, context, registry, input.representative.filters));
    const query = summary.outputs["resource-query"];
    const receipt = query?.resourceReceipt;
    if (summary.status !== "done" || !query ||
        receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
        Reflect.get(receipt, "resourceProductId") !== input.product.id ||
        Reflect.get(receipt, "resourceVersion") !== input.pack.packVersionId ||
        Reflect.get(receipt, "semanticHash") !== input.pack.semanticHash ||
        Reflect.get(receipt, "outputSchemaValid") !== true ||
        summary.totalCostUsdc !== 0) {
      throw new ResourcePublicationRefusedError();
    }
    return Object.freeze({ measuredCostUsdc: 0 });
  } catch (error) {
    if (error instanceof ResourcePublicationRefusedError) throw error;
    throw new ResourcePublicationRefusedError();
  }
}

export class ResourcePublishService {
  private readonly resourceRepo: ResourceRepository;
  private readonly flowRepo: FlowRepo;
  private readonly projectRepo: ProjectRepo;
  private readonly evaluate: (input: DryRunInput) => Promise<DryRunResult>;

  constructor(dependencies: ResourcePublishDependencies) {
    this.resourceRepo = dependencies.resourceRepo;
    this.flowRepo = dependencies.flowRepo;
    this.projectRepo = dependencies.projectRepo;
    this.evaluate = dependencies.dryRun ?? ((input) =>
      evaluateExactMaterializedGraph(this.resourceRepo, input));
  }

  private async current(ownerId: string, resourceProductId: string): Promise<{
    readonly product: ResourceProduct;
    readonly pack: ResourcePackBundle;
    readonly sourceDisclosure: NonNullable<Awaited<ReturnType<ResourceRepository["getOwnedSourceDisclosure"]>>>;
  }> {
    assertResourceFoundryEnabled();
    IdText.parse(resourceProductId);
    const [product, pack] = await Promise.all([
      this.resourceRepo.getOwnedProduct(ownerId, resourceProductId),
      this.resourceRepo.getOwnedApprovedPack(ownerId, resourceProductId),
    ]);
    if (!product || !pack) throw new ResourceRepositoryNotFoundError();
    if (product.status === "retired") throw new ResourceRepositoryNotFoundError();
    const sourceDisclosure = await this.resourceRepo.getOwnedSourceDisclosure({
      ownerId, resourceProductId, packVersionId: pack.packVersionId, semanticHash: pack.semanticHash,
    });
    if (!sourceDisclosure) throw new ResourceRepositoryNotFoundError();
    return { product, pack, sourceDisclosure };
  }

  async materialize(ownerId: string, resourceProductId: string): Promise<MaterializedResourceFlow> {
    const { product, pack, sourceDisclosure } = await this.current(ownerId, resourceProductId);
    const existing = await this.flowRepo.getFlow(product.id);
    if (existing && existing.ownerId !== ownerId) throw new ResourceRepositoryNotFoundError();
    const graph = materializeResourceGraph({
      product, pack, sourceDisclosure,
      ...(existing?.graph.meta === undefined ? {} : { existingMeta: existing.graph.meta }),
    });
    const flow = await this.flowRepo.saveFlow({
      id: product.id, ownerId, name: product.name, graph: graph.graph,
    });
    return Object.freeze({ ...graph, flowId: flow.id, product, pack });
  }

  private async resultFromRelease(
    release: ResourceRelease,
    expectedRequestHash: string,
  ): Promise<PublishedResourceProduct> {
    if (release.publicationRequestHash !== expectedRequestHash) {
      throw new ResourceRepositoryConflictError();
    }
    const agent = await this.flowRepo.getAgent(release.agentId);
    if (!agent || agent.flowId !== release.flowId || agent.status !== "live" ||
        agent.settlementLive || agent.priceUsdc !== release.priceUsdc) {
      throw new ResourceRepositoryConflictError();
    }
    return this.publishedResult(agent, release);
  }

  private publishedResult(agent: AgentRecord, release: ResourceRelease): PublishedResourceProduct {
    return Object.freeze({
      agent, release,
      urls: Object.freeze({
        run: `/api/agents/${agent.slug}/run`,
        card: `/api/agents/${agent.slug}/.well-known/agent-card.json`,
        x402: `/api/agents/${agent.slug}/.well-known/x402`,
        a2a: `/api/agents/${agent.slug}/a2a`,
        public: `/a/${agent.slug}`,
      }),
    });
  }

  async publish(ownerId: string, resourceProductId: string, value: PublishResourceRequest): Promise<PublishedResourceProduct> {
    const input = PublishResourceRequestSchema.parse(value);
    assertResourceFoundryEnabled();
    IdText.parse(resourceProductId);
    if (JSON.stringify(canonicalRequest(input.representative.input)) !==
        JSON.stringify(canonicalRequest(input.representative.filters))) {
      throw new ResourcePublicationRefusedError();
    }
    const publication = publicationIdentity(input);
    const committed = await this.resourceRepo.getOwnedPublishedReleaseByPublicationKey(
      ownerId, resourceProductId, publication.publicationKey,
    );
    if (committed) return this.resultFromRelease(committed, publication.publicationRequestHash);

    const current = await this.current(ownerId, resourceProductId);
    if (current.pack.freshness !== "fresh") throw new ResourcePublicationRefusedError();
    if (current.product.executionAccess !== "paid" && input.priceUsdc !== 0) {
      throw new ResourcePublicationRefusedError();
    }

    if (input.payoutAddress !== undefined && !isAddress(input.payoutAddress)) {
      throw new ResourcePublicationRefusedError();
    }
    if (input.payoutAddress !== undefined) {
      await this.flowRepo.saveWallet({ ownerId, address: input.payoutAddress });
    }
    if (current.product.executionAccess === "paid") {
      if (input.priceUsdc <= 0) throw new ResourcePublicationRefusedError();
      const wallet = await this.flowRepo.getWallet(ownerId);
      if (!wallet || !isAddress(wallet.address)) throw new ResourcePublicationRefusedError();
    }

    const materialized = await this.materialize(ownerId, resourceProductId);
    if (materialized.pack.packVersionId !== current.pack.packVersionId ||
        materialized.pack.semanticHash !== current.pack.semanticHash) {
      throw new ResourceRepositoryConflictError();
    }
    const dryRun = await this.evaluate({
      ownerId, product: materialized.product, pack: materialized.pack,
      graph: materialized.graph,
      graphSemanticHash: materialized.semanticHash,
      graphFullHash: materialized.fullHash,
      representative: input.representative,
    });
    if (!Number.isFinite(dryRun.measuredCostUsdc) || dryRun.measuredCostUsdc < 0 ||
        input.priceUsdc < dryRun.measuredCostUsdc) {
      throw new ResourcePublicationRefusedError();
    }

    const prior = await this.flowRepo.getAgentByFlowId(materialized.flowId);
    const agentSlug = canonicalResourceAgentSlug(current.product);
    if (prior && prior.slug !== agentSlug) throw new ResourceRepositoryConflictError();
    const priorLiveDeployment = prior?.status === "live"
      ? await this.projectRepo.getActiveDeployment({
          flowId: materialized.flowId,
          ownerId,
          environmentKind: "live",
        })
      : null;
    let finalWriteAttempted = false;
    let promotedLiveDeploymentId: string | null = null;
    const restorePrior = async (): Promise<void> => {
      if (!prior) return;
      if (priorLiveDeployment && promotedLiveDeploymentId &&
          promotedLiveDeploymentId !== priorLiveDeployment.id) {
        if (!this.projectRepo.restoreActiveDeployment) {
          throw new ResourceRepositoryConflictError();
        }
        const restored = await this.projectRepo.restoreActiveDeployment({
          deploymentId: priorLiveDeployment.id,
          expectedActiveDeploymentId: promotedLiveDeploymentId,
          ownerId,
        });
        if (!restored || restored.id !== priorLiveDeployment.id ||
            restored.flowVersionId !== priorLiveDeployment.flowVersionId ||
            restored.environmentId !== priorLiveDeployment.environmentId ||
            restored.status !== priorLiveDeployment.status) {
          throw new ResourceRepositoryConflictError();
        }
      }
      await this.flowRepo.updateAgent(prior.id, {
        status: prior.status, priceUsdc: prior.priceUsdc, settlementLive: prior.settlementLive,
      });
    };
    try {
      const draft = prior
        ? await this.flowRepo.updateAgent(prior.id, {
            status: "draft", priceUsdc: input.priceUsdc, settlementLive: false,
          })
        : await this.flowRepo.createAgent({
            flowId: materialized.flowId, slug: agentSlug,
            status: "draft", priceUsdc: input.priceUsdc,
          });
      if (!draft || draft.status !== "draft" || draft.settlementLive) {
        throw new ResourcePublicationRefusedError();
      }

      const promotion = await promoteFlowToLive({
        flowId: materialized.flowId, ownerId, projectRepo: this.projectRepo,
        expectedVersion: {
          semanticHash: materialized.semanticHash,
          fullHash: materialized.fullHash,
        },
      });
      if (promotion.status !== "promoted") throw new ResourceRepositoryConflictError();
      promotedLiveDeploymentId = promotion.liveDeployment.id;
      const version = await this.projectRepo.getFlowVersion({
        ownerId, flowId: materialized.flowId, versionId: promotion.versionId,
      });
      if (!exactDependency(version, current.pack)) throw new ResourceRepositoryConflictError();

      finalWriteAttempted = true;
      const release = await this.resourceRepo.createRelease({
        ownerId, resourceProductId,
        packVersionId: current.pack.packVersionId,
        semanticHash: current.pack.semanticHash,
        publicationKey: publication.publicationKey,
        publicationRequestHash: publication.publicationRequestHash,
        graphSemanticHash: materialized.semanticHash,
        graphFullHash: materialized.fullHash,
        priceUsdc: input.priceUsdc,
        executionAccess: current.product.executionAccess,
        discoveryAccess: current.product.discoveryAccess,
        agentId: draft.id,
        flowId: materialized.flowId,
        flowVersionId: promotion.versionId,
        deploymentId: promotion.liveDeployment.id,
        environmentId: promotion.liveDeployment.environmentId,
      });
      // createRelease is the final atomic boundary: it verified this exact
      // draft agent and flipped it Live with the pack/product. Do no further
      // fallible reads or writes after it returns.
      const agent: AgentRecord = Object.freeze({ ...draft, status: "live", settlementLive: false });
      return this.publishedResult(agent, release);
    } catch (error: unknown) {
      if (!finalWriteAttempted || !(error instanceof ResourceAmbiguousFinalCommitError)) {
        await restorePrior();
        throw error;
      }
      let reconciled: ResourceRelease | null;
      try {
        reconciled = await this.resourceRepo.getOwnedPublishedReleaseByPublicationKey(
          ownerId, resourceProductId, publication.publicationKey,
        );
      } catch {
        // The final write may have committed even when its response was lost.
        // Never compensate while the authoritative reconciliation is unknown.
        throw error;
      }
      if (reconciled) {
        return this.resultFromRelease(reconciled, publication.publicationRequestHash);
      }
      await restorePrior();
      throw error;
    }
  }
}
