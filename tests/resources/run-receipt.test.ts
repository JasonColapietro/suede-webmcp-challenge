import { describe, expect, it, vi } from "vitest";
import { materializeResourceGraph } from "@/lib/resources/materialize";
import type { ResourceRepository, ResourceRunReceipt } from "@/lib/resources/repository";
import {
  buildAndPersistResourceRunEnvelope,
  type ResourcePaymentFact,
} from "@/lib/resources/run-receipt";
import type { PublicServiceContract } from "@/lib/public-service-contract";
import { resourcePack } from "./fixture";

const PRODUCT = {
  id: "resource-product-1", ownerId: "owner-a", name: "Pricing signals",
  slug: "pricing-signals", status: "live" as const,
  executionAccess: "paid" as const, discoveryAccess: "public" as const,
};
const PACK = {
  resourceProductId: PRODUCT.id, packVersionId: "pack-version-1",
  semanticHash: "a".repeat(64), freshness: "fresh" as const,
  content: resourcePack(),
};
const graph = materializeResourceGraph({
  product: PRODUCT, pack: PACK,
  sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
}).graph;
const service = {
  kind: "resource",
  id: "agent-resource",
  slug: PRODUCT.slug,
  name: PRODUCT.name,
  description: PACK.content.jobContract.jobStatement,
  priceUsdc: 0.08,
  graph,
  release: {
    ownerId: PRODUCT.ownerId, flowId: PRODUCT.id, deploymentId: "deployment-live",
    environmentId: "environment-live", flowVersionId: "flow-version-live",
    semanticHash: "b".repeat(64), fullHash: "c".repeat(64),
  },
  inputSchema: PACK.content.jobContract.inputSchema,
  outputSchema: PACK.content.jobContract.outputSchema,
  exampleInput: { tier: "" },
  tags: ["resource"],
  urls: {
    public: "https://agents.suedeai.ai/a/pricing-signals",
    run: "https://agents.suedeai.ai/api/agents/pricing-signals/run",
    x402: "https://agents.suedeai.ai/api/agents/pricing-signals/.well-known/x402",
    agentCard: "https://agents.suedeai.ai/api/agents/pricing-signals/.well-known/agent-card.json",
    a2a: "https://agents.suedeai.ai/api/agents/pricing-signals/a2a",
  },
  resource: {
    extensionUri: "https://agents.suedeai.ai/extensions/resource/v1",
    resourceProductId: PRODUCT.id,
    resourceVersion: PACK.packVersionId,
    semanticHash: PACK.semanticHash,
    freshness: "fresh",
    evidencePolicy: PACK.content.jobContract.evidenceRequirement,
    reviewBoundary: PACK.content.jobContract.reviewBoundary,
    access: { execution: "paid", discovery: "public" },
    sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
    jobContract: PACK.content.jobContract,
  },
} as const satisfies PublicServiceContract;
const queryOutput = {
  result: [{ name: "Alpha", tier: "paid" }],
  resourceReceipt: {
    resourceProductId: PRODUCT.id,
    resourceVersion: PACK.packVersionId,
    semanticHash: PACK.semanticHash,
    freshness: "fresh" as const,
    evidence: PACK.content.evidence,
    unknowns: [], conflicts: [], outputSchemaValid: true,
  },
};

function persisted(payment: ResourcePaymentFact): ResourceRunReceipt {
  return {
    id: "resource-run-receipt-1",
    ownerId: PRODUCT.ownerId,
    packVersionId: PACK.packVersionId,
    agentId: service.id,
    runId: "run-1",
    flowVersionId: service.release.flowVersionId,
    deploymentId: service.release.deploymentId,
    paymentId: payment.paymentId,
    paymentState: payment.state,
    priceUsdc: payment.priceUsdc,
    ...queryOutput.resourceReceipt,
    createdAt: "2026-08-14T12:00:00.000Z",
  };
}

describe("resource run receipt envelopes", () => {
  it.each([
    ["free", null],
    ["challenged", null],
    ["credited", "credit-1"],
    ["settled", "0xsettled"],
    ["refunded", "credit-1"],
    ["failed", null],
  ] as const)("preserves the exact %s payment fact", async (state, paymentId) => {
    const payment = { priceUsdc: state === "free" ? 0 : 0.08, state, paymentId } as const;
    const repository = {
      recordRunReceipt: vi.fn(async () => persisted(payment)),
    } as unknown as ResourceRepository;
    const envelope = await buildAndPersistResourceRunEnvelope({
      service,
      summary: {
        runId: "run-1", status: "done", totalCostUsdc: 0,
        outputs: { "resource-query": queryOutput },
      },
      payment,
      repository,
    });
    expect(envelope).toEqual({
      result: queryOutput.result,
      resourceReceipt: queryOutput.resourceReceipt,
      payment: { priceUsdc: payment.priceUsdc, state, receiptId: "resource-run-receipt-1" },
    });
    expect(repository.recordRunReceipt).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: PRODUCT.ownerId,
      resourceProductId: PRODUCT.id,
      packVersionId: PACK.packVersionId,
      agentId: service.id,
      runId: "run-1",
      flowVersionId: service.release.flowVersionId,
      deploymentId: service.release.deploymentId,
      paymentId,
      paymentState: state,
      priceUsdc: payment.priceUsdc,
    }));
  });

  it("rejects mismatched receipts and source-text injection before persistence", async () => {
    const repository = { recordRunReceipt: vi.fn() } as unknown as ResourceRepository;
    await expect(buildAndPersistResourceRunEnvelope({
      service,
      summary: {
        runId: "run-1", status: "done", totalCostUsdc: 0,
        outputs: {
          "resource-query": {
            ...queryOutput,
            resourceReceipt: {
              ...queryOutput.resourceReceipt,
              semanticHash: "e".repeat(64),
              sourceText: "PRIVATE SOURCE BODY",
            },
          },
        },
      },
      payment: { priceUsdc: 0.08, state: "settled", paymentId: "0xsettled" },
      repository,
    })).rejects.toThrow("Invalid resource run receipt");
    expect(repository.recordRunReceipt).not.toHaveBeenCalled();
  });
});
