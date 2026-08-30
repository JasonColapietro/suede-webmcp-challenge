import type { AgentRecord, FlowRecord } from "./db/repo";
import { curatedBusinessService, type CuratedBusinessServiceContract } from "./curated-business-services";
import { deriveInputSchema, type JsonObjectSchema } from "./flow/input-contract";
import type { SupportedFlowGraph } from "./flow/types";
import { resolvePublicAgentRelease, type PublicAgentRelease } from "./projects/public-agent-graph";
import type { ProjectRepo } from "./projects/repo";
import type { DeploymentRecord } from "./projects/types";
import { getResourceRepository } from "./resources/provider";
import { RESOURCE_FOUNDRY_ENABLED } from "./resources/flags";
import { resourcePackSemanticHash } from "./resources/pack-hash";
import { parsePublicJobContract } from "./resources/public-contract";
import { parseResourcePackBundle } from "./resources/query";
import { resourceRunEnvelopeExample, resourceRunEnvelopeSchema } from "./resources/run-receipt";
import type { ResourceRelease, ResourceRepository } from "./resources/repository";
import type {
  ResourceDiscoveryAccess,
  ResourceExecutionAccess,
  ResourceFreshness,
  ResourceJobContract,
  ResourceJsonSchema,
  ResourceSourceDisclosure,
} from "./resources/types";
import { SITE_URL } from "./site";

export const RESOURCE_CONTRACT_EXTENSION_URI = `${SITE_URL}/extensions/resource/v1`;

export interface PublicResourceContractExtension {
  readonly extensionUri: typeof RESOURCE_CONTRACT_EXTENSION_URI;
  readonly resourceProductId: string;
  readonly resourceVersion: string;
  readonly semanticHash: string;
  readonly freshness: ResourceFreshness;
  readonly evidencePolicy: string;
  readonly reviewBoundary: string;
  readonly access: {
    readonly execution: ResourceExecutionAccess;
    readonly discovery: ResourceDiscoveryAccess;
  };
  readonly sourceDisclosure: ResourceSourceDisclosure;
  readonly jobContract: ResourceJobContract;
}

export interface PublicServiceContract {
  readonly kind: "resource" | "curated" | "ordinary";
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly priceUsdc: number;
  readonly graph: PublicAgentRelease["graph"];
  readonly release: PublicAgentRelease["release"];
  readonly inputSchema: JsonObjectSchema | ResourceJsonSchema;
  /** Inner deterministic Job Contract result. */
  readonly resultSchema?: JsonObjectSchema | ResourceJsonSchema;
  /** Full protocol response returned by HTTP, A2A, MCP, and x402 execution. */
  readonly responseSchema?: JsonObjectSchema | ResourceJsonSchema;
  /** Compatibility alias for the inner result schema. */
  readonly outputSchema: JsonObjectSchema | ResourceJsonSchema;
  readonly exampleInput: Readonly<Record<string, unknown>>;
  readonly responseExample?: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly urls: {
    readonly public: string;
    readonly run: string;
    readonly x402: string;
    readonly agentCard: string;
    readonly a2a: string;
  };
  readonly curated?: CuratedBusinessServiceContract;
  readonly resource?: PublicResourceContractExtension;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** Pure pre-provider proof that the immutable Resource closure is exactly what its marker attests. */
export function publicResourceDependencyContractMatches(
  publicRelease: PublicAgentRelease,
): boolean {
  const dependencies = publicRelease.resourceDependencies;
  if (!Array.isArray(dependencies)) return false;
  const rawMarker = publicRelease.graph.meta?.resourceProduct;
  if (rawMarker === undefined) return dependencies.length === 0;
  const marker = record(rawMarker);
  const [dependency] = dependencies;
  return dependencies.length === 1 && marker !== null && dependency !== undefined &&
    dependency.resourceProductId === marker.id &&
    dependency.packVersionId === marker.packVersionId &&
    dependency.contentHash === marker.semanticHash;
}

interface PublicServiceIdentityInput {
  readonly agent: AgentRecord;
  readonly flow: FlowRecord;
  readonly publicRelease: PublicAgentRelease;
}

interface AttestedResourceMarker {
  readonly marker: Readonly<Record<string, unknown>>;
  readonly disclosure: Readonly<Record<string, unknown>>;
  readonly jobContract: ResourceJobContract;
}

function publicServiceIdentityMatches(input: PublicServiceIdentityInput): boolean {
  return input.agent.status === "live" && input.agent.flowId === input.flow.id &&
    input.publicRelease.release.ownerId === input.flow.ownerId &&
    input.publicRelease.release.flowId === input.flow.id &&
    publicResourceDependencyContractMatches(input.publicRelease);
}

/** Validate only data already sealed into the immutable Live graph and dependency list. */
function attestedResourceMarker(input: PublicServiceIdentityInput): AttestedResourceMarker | null {
  if (!publicServiceIdentityMatches(input) || !RESOURCE_FOUNDRY_ENABLED) return null;
  const marker = record(input.publicRelease.graph.meta?.resourceProduct);
  if (!marker || marker.id !== input.flow.id || marker.slug !== input.agent.slug ||
      typeof marker.name !== "string" || marker.name.length === 0 || marker.name !== input.publicRelease.graph.name ||
      typeof marker.packVersionId !== "string" || typeof marker.semanticHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(marker.semanticHash) ||
      !["fresh", "stale", "mixed"].includes(marker.freshness as string) ||
      !["free", "paid", "private"].includes(marker.executionAccess as string) ||
      !["public", "unlisted"].includes(marker.discoveryAccess as string)) return null;
  const [resourceDependency] = input.publicRelease.resourceDependencies;
  if (input.publicRelease.resourceDependencies.length !== 1 || !resourceDependency ||
      resourceDependency.resourceProductId !== marker.id ||
      resourceDependency.packVersionId !== marker.packVersionId ||
      resourceDependency.contentHash !== marker.semanticHash) return null;
  const disclosure = record(marker.sourceDisclosure);
  if (!disclosure || disclosure.corpus !== "private" || !Number.isSafeInteger(disclosure.sourceCount) ||
      (disclosure.sourceCount as number) < 0 || !Array.isArray(disclosure.sourceKinds) ||
      disclosure.sourceKinds.some((kind) => typeof kind !== "string" || kind.length === 0) ||
      new Set(disclosure.sourceKinds).size !== disclosure.sourceKinds.length) return null;
  try {
    const jobContract = parsePublicJobContract({
      resourceProductId: marker.id,
      packVersionId: marker.packVersionId,
      semanticHash: marker.semanticHash,
      ...record(marker.jobContract),
    }, {
      resourceProductId: marker.id as string,
      packVersionId: marker.packVersionId,
      semanticHash: marker.semanticHash,
    });
    return Object.freeze({ marker, disclosure, jobContract });
  } catch {
    return null;
  }
}

function exactResourceRelease(
  release: ResourceRelease,
  marker: Readonly<Record<string, unknown>>,
  input: PublicServiceIdentityInput,
): boolean {
  const publicIdentity = input.publicRelease.release;
  return release.ownerId === input.flow.ownerId && release.resourceProductId === input.flow.id &&
    release.packVersionId === marker.packVersionId && release.semanticHash === marker.semanticHash &&
    release.graphSemanticHash === publicIdentity.semanticHash && release.graphFullHash === publicIdentity.fullHash &&
    release.priceUsdc === input.agent.priceUsdc && release.executionAccess === marker.executionAccess &&
    release.discoveryAccess === marker.discoveryAccess && release.agentId === input.agent.id &&
    release.flowId === input.flow.id && release.flowVersionId === publicIdentity.flowVersionId &&
    release.deploymentId === publicIdentity.deploymentId && release.environmentId === publicIdentity.environmentId;
}

function urls(slug: string): PublicServiceContract["urls"] {
  const base = `${SITE_URL}/api/agents/${encodeURIComponent(slug)}`;
  return Object.freeze({
    public: `${SITE_URL}/a/${encodeURIComponent(slug)}`,
    run: `${base}/run`,
    x402: `${base}/.well-known/x402`,
    agentCard: `${base}/.well-known/agent-card.json`,
    a2a: `${base}/a2a`,
  });
}

function ordinaryOutputSchema(): JsonObjectSchema {
  return { type: "object" };
}

function exampleInputForGraph(graph: PublicAgentRelease["graph"]): Readonly<Record<string, unknown>> {
  const fields = graph.nodes.flatMap((node) => {
    if (!["input", "schedule", "webhook"].includes(node.type)) return [];
    const value = record(node.params.fields);
    return value ? Object.entries(value) : [];
  });
  return Object.freeze(Object.fromEntries(fields));
}

function base(
  input: PublicServiceIdentityInput,
  kind: PublicServiceContract["kind"],
  contract?: CuratedBusinessServiceContract,
): Omit<PublicServiceContract, "resource"> {
  const description = contract?.description ??
    (typeof input.publicRelease.graph.meta?.description === "string" ? input.publicRelease.graph.meta.description : input.flow.name);
  return Object.freeze({
    kind,
    id: input.agent.id,
    slug: input.agent.slug,
    name: contract?.name ?? input.flow.name,
    description,
    priceUsdc: input.agent.priceUsdc,
    graph: input.publicRelease.graph,
    release: input.publicRelease.release,
    inputSchema: contract?.inputSchema ?? deriveInputSchema(input.publicRelease.graph as SupportedFlowGraph),
    resultSchema: contract?.outputSchema ?? ordinaryOutputSchema(),
    responseSchema: contract?.outputSchema ?? ordinaryOutputSchema(),
    outputSchema: contract?.outputSchema ?? ordinaryOutputSchema(),
    exampleInput: contract?.exampleInput ?? exampleInputForGraph(input.publicRelease.graph),
    tags: contract?.tags ?? Object.freeze([]),
    urls: urls(input.agent.slug),
    ...(contract ? { curated: contract } : {}),
  });
}

function resourceServiceContract(
  input: PublicServiceIdentityInput,
  attested: AttestedResourceMarker,
  freshness: ResourceFreshness,
): PublicServiceContract {
  const { marker, disclosure, jobContract } = attested;
  const resource = Object.freeze({
    extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
    resourceProductId: marker.id as string,
    resourceVersion: marker.packVersionId as string,
    semanticHash: marker.semanticHash as string,
    freshness,
    evidencePolicy: jobContract.evidenceRequirement,
    reviewBoundary: jobContract.reviewBoundary,
    access: Object.freeze({
      execution: marker.executionAccess as ResourceExecutionAccess,
      discovery: marker.discoveryAccess as ResourceDiscoveryAccess,
    }),
    sourceDisclosure: Object.freeze({
      sourceCount: disclosure.sourceCount as number,
      sourceKinds: Object.freeze([...(disclosure.sourceKinds as string[])].sort((left, right) => left.localeCompare(right))),
    }),
    jobContract,
  });
  const resourceBase = base(input, "resource");
  const responseSchema = resourceRunEnvelopeSchema(jobContract.outputSchema as Readonly<Record<string, unknown>>) as ResourceJsonSchema;
  const responseExample = resourceRunEnvelopeExample({
    resourceProductId: resource.resourceProductId,
    resourceVersion: resource.resourceVersion,
    semanticHash: resource.semanticHash,
    freshness: resource.freshness,
    priceUsdc: input.agent.priceUsdc,
  });
  return Object.freeze({
    ...resourceBase,
    name: marker.name as string,
    description: jobContract.jobStatement,
    inputSchema: jobContract.inputSchema,
    resultSchema: jobContract.outputSchema,
    responseSchema,
    responseExample,
    outputSchema: jobContract.outputSchema,
    tags: Object.freeze(["resource"]),
    resource,
  });
}

/**
 * Pure Resource preview contract from the already prepared immutable release.
 * It deliberately performs no provider or pack read; callers may use it only
 * for synthetic previews that never execute against the private corpus.
 */
export function resolvePublicResourcePreviewContract(
  input: PublicServiceIdentityInput,
): PublicServiceContract | null {
  const attested = attestedResourceMarker(input);
  return attested
    ? resourceServiceContract(input, attested, attested.marker.freshness as ResourceFreshness)
    : null;
}

export interface ResolvePublicServiceContractFromReleaseInput {
  readonly agent: AgentRecord;
  readonly flow: FlowRecord;
  readonly publicRelease: PublicAgentRelease;
  readonly resourceRepository: Pick<
    ResourceRepository,
    "getOwnedPack" | "getPublishedReleaseByAgent"
  > | null;
  /** Optional preloaded exact release used by bounded catalog reads. */
  readonly resourceRelease?: ResourceRelease | null;
}

export async function resolvePublicServiceContract(input: {
  readonly agent: AgentRecord;
  readonly flow: FlowRecord;
  readonly projectRepo: ProjectRepo | null;
  readonly activeDeployment?: DeploymentRecord | null;
}): Promise<PublicServiceContract | null> {
  const publicRelease = await resolvePublicAgentRelease({
    flow: input.flow,
    projectRepo: input.projectRepo,
    ...(Object.hasOwn(input, "activeDeployment") ? { activeDeployment: input.activeDeployment } : {}),
  });
  if (!publicRelease) return null;
  if (!publicResourceDependencyContractMatches(publicRelease)) return null;
  const hasResourceDependencies = publicRelease.resourceDependencies.length > 0;
  if (hasResourceDependencies && !RESOURCE_FOUNDRY_ENABLED) return null;
  const resourceRepository = !hasResourceDependencies
    ? null
    : await getResourceRepository().catch(() => null);
  return resolvePublicServiceContractFromRelease({
    agent: input.agent, flow: input.flow, publicRelease, resourceRepository,
  });
}

/**
 * One fail-closed resolver ordered by authority: immutable resource release,
 * curated business contract, then the ordinary graph-derived shape.
 */
export async function resolvePublicServiceContractFromRelease(
  input: ResolvePublicServiceContractFromReleaseInput,
): Promise<PublicServiceContract | null> {
  if (!publicServiceIdentityMatches(input)) return null;
  const rawResourceMarker = input.publicRelease.graph.meta?.resourceProduct;
  if (rawResourceMarker !== undefined) {
    const attested = attestedResourceMarker(input);
    if (!attested || !input.resourceRepository) return null;
    const { marker } = attested;
    const release = Object.hasOwn(input, "resourceRelease")
      ? input.resourceRelease ?? null
      : await input.resourceRepository?.getPublishedReleaseByAgent(input.agent.id).catch(() => null) ?? null;
    if (!release || !exactResourceRelease(release, marker, input)) return null;
    let currentPack: ReturnType<typeof parseResourcePackBundle>;
    try {
      currentPack = parseResourcePackBundle(await input.resourceRepository.getOwnedPack({
        ownerId: input.flow.ownerId,
        resourceProductId: marker.id as string,
        packVersionId: marker.packVersionId as string,
        semanticHash: marker.semanticHash as string,
      }));
    } catch {
      return null;
    }
    if (currentPack.resourceProductId !== marker.id ||
        currentPack.packVersionId !== marker.packVersionId ||
        currentPack.semanticHash !== marker.semanticHash ||
        resourcePackSemanticHash(currentPack.content).semanticHash !== marker.semanticHash ||
        currentPack.freshness !== "fresh") return null;
    return resourceServiceContract(input, attested, currentPack.freshness);
  }
  const curated = curatedBusinessService(input.agent.slug, input.publicRelease.graph);
  return base(input, curated ? "curated" : "ordinary", curated ?? undefined);
}
