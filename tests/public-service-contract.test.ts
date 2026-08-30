import { describe, expect, it, vi } from "vitest";
import type { AgentRecord, FlowRecord } from "@/lib/db/repo";
import { canonicalResourceAgentSlug, materializeResourceGraph } from "@/lib/resources/materialize";
import type { ResourceRelease, ResourceRepository } from "@/lib/resources/repository";
import {
  RESOURCE_CONTRACT_EXTENSION_URI,
  resolvePublicServiceContractFromRelease,
} from "@/lib/public-service-contract";
import type { PublicAgentRelease } from "@/lib/projects/public-agent-graph";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import { resourcePack } from "./resources/fixture";

const OWNER = "owner-resource";
const PRODUCT = {
  id: "resource-product-1",
  ownerId: OWNER,
  name: "Pricing signals",
  slug: "pricing-signals",
  status: "live" as const,
  executionAccess: "paid" as const,
  discoveryAccess: "public" as const,
};
const AGENT: AgentRecord = {
  id: "agent-resource",
  flowId: PRODUCT.id,
  slug: canonicalResourceAgentSlug(PRODUCT),
  status: "live",
  priceUsdc: 0.08,
  createdAt: 1,
  settlementLive: false,
};
const PACK_CONTENT = resourcePack();
const PACK = {
  resourceProductId: PRODUCT.id,
  packVersionId: "pack-version-1",
  semanticHash: resourcePackSemanticHash(PACK_CONTENT).semanticHash,
  freshness: "fresh" as const,
  content: PACK_CONTENT,
};
const materialized = materializeResourceGraph({
  product: PRODUCT,
  pack: PACK,
  sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
});
const FLOW: FlowRecord = {
  id: PRODUCT.id,
  ownerId: OWNER,
  name: PRODUCT.name,
  graph: materialized.graph,
  updatedAt: 1,
};
const PUBLIC_RELEASE: PublicAgentRelease = {
  graph: materialized.graph,
  resourceDependencies: [{
    resourceProductId: PRODUCT.id,
    packVersionId: PACK.packVersionId,
    contentHash: PACK.semanticHash,
  }],
  release: {
    ownerId: OWNER,
    flowId: FLOW.id,
    deploymentId: "deployment-live",
    environmentId: "environment-live",
    flowVersionId: "flow-version-live",
    semanticHash: materialized.semanticHash,
    fullHash: materialized.fullHash,
  },
};
const RELEASE: ResourceRelease = {
  id: "resource-release",
  ownerId: OWNER,
  resourceProductId: PRODUCT.id,
  packVersionId: PACK.packVersionId,
  semanticHash: PACK.semanticHash,
  publicationKey: "publication-key",
  publicationRequestHash: "d".repeat(64),
  graphSemanticHash: materialized.semanticHash,
  graphFullHash: materialized.fullHash,
  priceUsdc: AGENT.priceUsdc,
  executionAccess: PRODUCT.executionAccess,
  discoveryAccess: PRODUCT.discoveryAccess,
  agentId: AGENT.id,
  flowId: FLOW.id,
  flowVersionId: PUBLIC_RELEASE.release.flowVersionId,
  deploymentId: PUBLIC_RELEASE.release.deploymentId,
  environmentId: PUBLIC_RELEASE.release.environmentId,
  createdAt: "2026-08-14T12:00:00.000Z",
};

function resourceRepo(release: ResourceRelease | null = RELEASE): ResourceRepository {
  return {
    getPublishedReleaseByAgent: vi.fn(async () => release),
    getOwnedPack: vi.fn(async () => PACK),
  } as unknown as ResourceRepository;
}

describe("public service contract resolver", () => {
  it("projects one immutable Resource Product contract without private source rows", async () => {
    const contract = await resolvePublicServiceContractFromRelease({
      agent: AGENT,
      flow: FLOW,
      publicRelease: PUBLIC_RELEASE,
      resourceRepository: resourceRepo(),
    });

    expect(contract).toMatchObject({
      kind: "resource",
      slug: AGENT.slug,
      name: PRODUCT.name,
      priceUsdc: 0.08,
      inputSchema: PACK.content.jobContract.inputSchema,
      outputSchema: PACK.content.jobContract.outputSchema,
      exampleInput: { tier: "" },
      urls: {
        public: `https://agents.suedeai.ai/a/${AGENT.slug}`,
        run: `https://agents.suedeai.ai/api/agents/${AGENT.slug}/run`,
        x402: `https://agents.suedeai.ai/api/agents/${AGENT.slug}/.well-known/x402`,
        agentCard: `https://agents.suedeai.ai/api/agents/${AGENT.slug}/.well-known/agent-card.json`,
        a2a: `https://agents.suedeai.ai/api/agents/${AGENT.slug}/a2a`,
      },
      resource: {
        extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
        resourceProductId: PRODUCT.id,
        resourceVersion: PACK.packVersionId,
        semanticHash: PACK.semanticHash,
        freshness: "fresh",
        access: { execution: "paid", discovery: "public" },
        sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
        jobContract: PACK.content.jobContract,
      },
    });
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toContain("snapshot-contract");
    expect(serialized).not.toContain("manual://");
    expect(serialized).not.toContain("provenance");
    expect(serialized).not.toContain("record-1");
  });

  it.each([
    ["missing release", null],
    ["wrong pack", { ...RELEASE, packVersionId: "other-pack" }],
    ["wrong graph", { ...RELEASE, graphFullHash: "e".repeat(64) }],
    ["wrong price", { ...RELEASE, priceUsdc: 0.09 }],
  ] as const)("fails closed for a resource marker with %s", async (_label, release) => {
    await expect(resolvePublicServiceContractFromRelease({
      agent: AGENT,
      flow: FLOW,
      publicRelease: PUBLIC_RELEASE,
      resourceRepository: resourceRepo(release),
    })).resolves.toBeNull();
  });

  it("uses the immutable resource name despite a mutable Draft flow rename", async () => {
    await expect(resolvePublicServiceContractFromRelease({
      agent: AGENT,
      flow: { ...FLOW, name: "Mutable draft rename" },
      publicRelease: PUBLIC_RELEASE,
      resourceRepository: resourceRepo(),
    })).resolves.toMatchObject({ name: PRODUCT.name });
  });

  it("fails closed when the immutable graph name disagrees with its resource marker", async () => {
    await expect(resolvePublicServiceContractFromRelease({
      agent: AGENT,
      flow: FLOW,
      publicRelease: {
        ...PUBLIC_RELEASE,
        graph: { ...PUBLIC_RELEASE.graph, name: "Tampered immutable name" },
      },
      resourceRepository: resourceRepo(),
    })).resolves.toBeNull();
  });

  it("fails closed instead of treating a malformed resource marker as ordinary", async () => {
    await expect(resolvePublicServiceContractFromRelease({
      agent: AGENT,
      flow: FLOW,
      publicRelease: {
        ...PUBLIC_RELEASE,
        graph: { ...PUBLIC_RELEASE.graph, meta: { resourceProduct: "malformed" } },
      },
      resourceRepository: resourceRepo(),
    })).resolves.toBeNull();
  });

  it("fails closed before Resource reads when one public marker hides a second pack dependency", async () => {
    const repository = resourceRepo();
    await expect(resolvePublicServiceContractFromRelease({
      agent: AGENT,
      flow: FLOW,
      publicRelease: {
        ...PUBLIC_RELEASE,
        resourceDependencies: [
          ...PUBLIC_RELEASE.resourceDependencies,
          {
            resourceProductId: "private-hidden-product",
            packVersionId: "private-hidden-pack",
            contentHash: "f".repeat(64),
          },
        ],
      },
      resourceRepository: repository,
    })).resolves.toBeNull();
    expect(repository.getPublishedReleaseByAgent).not.toHaveBeenCalled();
    expect(repository.getOwnedPack).not.toHaveBeenCalled();
  });

  it("keeps an ordinary agent graph-derived and free of resource extensions", async () => {
    const ordinaryFlow: FlowRecord = {
      id: "ordinary-flow",
      ownerId: OWNER,
      name: "Ordinary agent",
      updatedAt: 1,
      graph: {
        id: "ordinary-graph",
        name: "Ordinary agent",
        nodes: [{ id: "input", type: "input", params: { fields: { prompt: "" } }, position: { x: 0, y: 0 } }],
        edges: [],
      },
    };
    const ordinaryAgent = { ...AGENT, id: "ordinary-agent", flowId: ordinaryFlow.id, slug: "ordinary-agent", priceUsdc: 0 };
    const contract = await resolvePublicServiceContractFromRelease({
      agent: ordinaryAgent,
      flow: ordinaryFlow,
      publicRelease: {
        graph: ordinaryFlow.graph,
        resourceDependencies: [],
        release: { ...PUBLIC_RELEASE.release, flowId: ordinaryFlow.id },
      },
      resourceRepository: null,
    });
    expect(contract).toMatchObject({ kind: "ordinary", inputSchema: { type: "object" } });
    expect(contract).not.toHaveProperty("resource");
  });
});
