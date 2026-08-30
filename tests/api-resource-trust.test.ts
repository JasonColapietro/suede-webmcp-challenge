import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceRepository } from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { aggregateResourceTrust } from "@/lib/resources/analytics";
import { resourcePack, RESOURCE_TEST_NOW } from "./resources/fixture";

const control = vi.hoisted(() => ({ ownerId: "trust-owner", repository: null as ResourceRepository | null }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()), resolveReadOnlyOwnerId: async () => control.ownerId,
}));
vi.mock("@/lib/resources/provider", () => ({ getResourceRepository: async () => control.repository }));
vi.mock("@/lib/resources/flags", () => ({ RESOURCE_FOUNDRY_ENABLED: true }));

function context(resourceId: string) { return { params: Promise.resolve({ resourceId }) }; }

async function seededReceipt(): Promise<string> {
  const repo = control.repository!;
  const product = await repo.createProduct({
    ownerId: control.ownerId, name: "Trust", slug: "trust", executionAccess: "paid", discoveryAccess: "public",
  });
  await repo.createSourceSnapshot({
    id: "snapshot-contract", ownerId: control.ownerId, resourceProductId: product.id,
    locator: "manual://trust", sourceKind: "json_rows", capturedAt: RESOURCE_TEST_NOW.toISOString(),
    contentHash: "a".repeat(64), freshnessDeadline: "2026-08-20T12:00:00.000Z",
  });
  const candidate = await repo.replaceCandidate({
    ownerId: control.ownerId, resourceProductId: product.id,
    expectedCandidatePackVersionId: null, expectedRevision: 0, content: resourcePack(), createdBy: control.ownerId,
  });
  const approved = await repo.approveCandidate({
    ownerId: control.ownerId, resourceProductId: product.id,
    candidatePackVersionId: candidate.id, expectedRevision: 1,
    expectedSemanticHash: candidate.semanticHash, approvedBy: control.ownerId,
  });
  vi.spyOn(repo, "listRunReceipts").mockImplementation(async (ownerId, productId) =>
    ownerId === control.ownerId && productId === product.id ? [{
      id: "receipt-trust", ownerId: control.ownerId, resourceProductId: product.id,
      packVersionId: approved.id, agentId: "agent-trust", runId: "run-trust",
      flowVersionId: "flow-version-trust", deploymentId: "deployment-trust",
      paymentId: "payment-trust", paymentState: "settled", priceUsdc: 0.05,
      resourceVersion: approved.id, semanticHash: approved.semanticHash,
      freshness: "fresh", evidence: resourcePack().evidence, unknowns: [], conflicts: [],
      outputSchemaValid: true, createdAt: RESOURCE_TEST_NOW.toISOString(),
    }] : []);
  return product.id;
}

beforeEach(() => {
  control.ownerId = "trust-owner";
  control.repository = new SqliteResourceRepository(":memory:", { now: () => RESOURCE_TEST_NOW });
});

describe("Resource trust facts", () => {
  it("reports receipt-backed execution quality while leaving unavailable payment facts unknown", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/trust/route");
    const productId = await seededReceipt();
    const response = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/resources/${productId}/trust`),
      context(productId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json() as {
      trust: {
        facts: Record<string, { count: number | null; amountUsdc?: number | null; basis: string }>;
        quality: Record<string, number>;
        demand: { status: string; value: null };
        revenue: { status: string; amountUsdc: null };
      };
    };
    expect(payload.trust.facts).toEqual({
      attempted: { count: null, basis: "not_recorded" },
      free: { count: 0, basis: "resource_run_receipts" },
      challenged: { count: null, basis: "not_recorded" },
      executed: { count: 1, basis: "resource_run_receipts" },
      credited: { count: 0, amountUsdc: 0, basis: "resource_run_receipts" },
      settled: { count: 1, amountUsdc: 0.05, basis: "resource_run_receipts" },
      refunded: { count: null, amountUsdc: null, basis: "not_recorded" },
      failed: { count: null, basis: "not_recorded" },
    });
    expect(payload.trust.quality).toMatchObject({
      schemaValidExecutions: 1, evidenceBackedExecutions: 1, freshExecutions: 1,
      unknownCount: 0, conflictCount: 0,
    });
    expect(payload.trust.demand).toEqual({ status: "not_measured", value: null });
    expect(payload.trust.revenue).toEqual({ status: "not_measured", amountUsdc: null });
  });

  it("does not infer demand or revenue from a public catalog setting without receipts", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/trust/route");
    const product = await control.repository!.createProduct({
      ownerId: control.ownerId, name: "Listed only", slug: "listed-only", executionAccess: "paid", discoveryAccess: "public",
    });
    const response = await route.GET(new Request("https://agents.suedeai.ai/trust"), context(product.id));
    const trust = (await response.json() as { trust: { facts: Record<string, { count: number | null }>; demand: unknown; revenue: unknown } }).trust;
    expect(trust.facts.executed!.count).toBe(0);
    expect(trust.facts.attempted!.count).toBeNull();
    expect(trust.facts.challenged!.count).toBeNull();
    expect(trust.demand).toEqual({ status: "not_measured", value: null });
    expect(trust.revenue).toEqual({ status: "not_measured", amountUsdc: null });
  });

  it("keeps every recorded payment state distinct without inferring demand or revenue", () => {
    const states = ["free", "challenged", "credited", "settled", "refunded", "failed"] as const;
    const receipts = states.map((paymentState, index) => ({
      id: `receipt-${paymentState}`,
      ownerId: "trust-owner",
      resourceProductId: "resource-product",
      packVersionId: "pack-version",
      agentId: "agent",
      runId: `run-${paymentState}`,
      flowVersionId: "flow-version",
      deploymentId: "deployment",
      paymentId: paymentState === "free" || paymentState === "challenged" || paymentState === "failed"
        ? null
        : `payment-${paymentState}`,
      paymentState,
      priceUsdc: index / 100,
      resourceVersion: "pack-version",
      semanticHash: "a".repeat(64),
      freshness: "fresh" as const,
      evidence: resourcePack().evidence,
      unknowns: [`unknown-${paymentState}`],
      conflicts: [`conflict-${paymentState}`],
      outputSchemaValid: true,
      createdAt: RESOURCE_TEST_NOW.toISOString(),
    }));
    const trust = aggregateResourceTrust(receipts);
    expect(trust.facts).toMatchObject({
      attempted: { count: null, basis: "not_recorded" },
      free: { count: 1 },
      challenged: { count: null, basis: "not_recorded" },
      executed: { count: 4 },
      credited: { count: 1, amountUsdc: 0.02 },
      settled: { count: 1, amountUsdc: 0.03 },
      refunded: { count: null, amountUsdc: null, basis: "not_recorded" },
      failed: { count: null, basis: "not_recorded" },
    });
    expect(trust.quality).toEqual({
      schemaValidExecutions: 4,
      evidenceBackedExecutions: 4,
      freshExecutions: 4,
      staleExecutions: 0,
      mixedExecutions: 0,
      unknownCount: 4,
      conflictCount: 4,
    });
    expect(trust.revenue).toEqual({ status: "not_measured", amountUsdc: null });
    expect(trust.demand).toEqual({ status: "not_measured", value: null });
  });

  it("makes foreign and missing trust IDs byte-identical", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/trust/route");
    const productId = await seededReceipt();
    control.ownerId = "foreign-trust-owner";
    const foreign = await route.GET(new Request("https://agents.suedeai.ai/trust"), context(productId));
    const missing = await route.GET(new Request("https://agents.suedeai.ai/trust"), context("missing-resource"));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });
});
