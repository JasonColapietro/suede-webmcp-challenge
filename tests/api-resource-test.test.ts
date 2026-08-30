import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceRepository } from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { resourcePack, RESOURCE_TEST_NOW } from "./resources/fixture";

const control = vi.hoisted(() => ({ ownerId: "test-owner", repository: null as ResourceRepository | null }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()), resolveOwnerId: async () => control.ownerId,
}));
vi.mock("@/lib/resources/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/provider")>()),
  getResourceRepository: async () => control.repository,
}));
vi.mock("@/lib/resources/flags", () => ({ RESOURCE_FOUNDRY_ENABLED: true }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()), checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
}));

function context(resourceId: string) { return { params: Promise.resolve({ resourceId }) }; }
function post(resourceId: string, body: unknown): Request {
  return new Request(`https://agents.suedeai.ai/api/v2/resources/${resourceId}/test`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
async function approvedPack(): Promise<{ productId: string; packVersionId: string; semanticHash: string }> {
  const product = await control.repository!.createProduct({
    ownerId: control.ownerId, name: "Testable", slug: "testable", executionAccess: "paid", discoveryAccess: "unlisted",
  });
  await control.repository!.createSourceSnapshot({
    id: "snapshot-contract", ownerId: control.ownerId, resourceProductId: product.id,
    locator: "manual://test", sourceKind: "json_rows", capturedAt: RESOURCE_TEST_NOW.toISOString(),
    contentHash: "a".repeat(64), freshnessDeadline: "2026-08-20T12:00:00.000Z",
  });
  const candidate = await control.repository!.replaceCandidate({
    ownerId: control.ownerId, resourceProductId: product.id,
    expectedCandidatePackVersionId: null, expectedRevision: 0,
    content: resourcePack(), createdBy: control.ownerId,
  });
  const approved = await control.repository!.approveCandidate({
    ownerId: control.ownerId, resourceProductId: product.id,
    candidatePackVersionId: candidate.id, expectedRevision: candidate.revision,
    expectedSemanticHash: candidate.semanticHash, approvedBy: control.ownerId,
  });
  return { productId: product.id, packVersionId: approved.id, semanticHash: approved.semanticHash };
}

beforeEach(() => {
  control.ownerId = "test-owner";
  control.repository = new SqliteResourceRepository(":memory:", { now: () => RESOURCE_TEST_NOW });
});

describe("deterministic Resource dry-run", () => {
  it("resolves the exact approved hash, validates schemas, and returns a zero-cost trust receipt", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/test/route");
    const reference = await approvedPack();
    const response = await route.POST(post(reference.productId, {
      packVersionId: reference.packVersionId,
      semanticHash: reference.semanticHash,
      input: { tier: "paid" },
      filters: { tier: "paid" },
      filterFields: ["tier"],
      returnFields: ["name", "tier"],
      expectedProperties: ["name", "tier"],
      limit: 5,
    }), context(reference.productId));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json() as {
      test: {
        packVersionId: string; semanticHash: string;
        inputSchemaValid: boolean; outputSchemaValid: boolean;
        measuredCostUsdc: number; externalCalls: number; settlementAttempted: boolean;
        result: Array<{ name: string; tier: string }>;
        resourceReceipt: { freshness: string; evidence: unknown[]; unknowns: unknown[]; conflicts: unknown[] };
      };
    };
    expect(payload.test).toMatchObject({
      packVersionId: reference.packVersionId,
      semanticHash: reference.semanticHash,
      inputSchemaValid: true,
      outputSchemaValid: true,
      measuredCostUsdc: 0,
      externalCalls: 0,
      settlementAttempted: false,
      result: [{ name: "Alpha", tier: "paid" }],
    });
    expect(payload.test.resourceReceipt).toMatchObject({ freshness: "fresh", unknowns: [], conflicts: [] });
    expect(payload.test.resourceReceipt.evidence).toHaveLength(1);
  });

  it("rejects invalid input before query work and keeps missing/wrong hashes opaque", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/test/route");
    const reference = await approvedPack();
    const invalid = await route.POST(post(reference.productId, {
      ...reference,
      input: { tier: "paid", secret: "not-allowed" },
      filters: {}, filterFields: [], returnFields: ["name"],
    }), context(reference.productId));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid request" });

    const wrongHashBody = {
      packVersionId: reference.packVersionId, semanticHash: "f".repeat(64),
      input: {}, filters: {}, filterFields: [], returnFields: ["name"],
    };
    const wrong = await route.POST(post(reference.productId, wrongHashBody), context(reference.productId));
    const missing = await route.POST(post("missing-resource", wrongHashBody), context("missing-resource"));
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await wrong.text()).toBe(await missing.text());
  });

  it("refuses a representative proof that returns no row", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/test/route");
    const reference = await approvedPack();
    const response = await route.POST(post(reference.productId, {
      packVersionId: reference.packVersionId,
      semanticHash: reference.semanticHash,
      input: { tier: "missing" },
      filters: { tier: "missing" },
      filterFields: ["tier"],
      returnFields: ["name", "tier"],
      expectedProperties: ["name"],
    }), context(reference.productId));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid request" });
  });

  it("refuses a proof whose tested filters differ from live caller input", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/test/route");
    const reference = await approvedPack();
    const response = await route.POST(post(reference.productId, {
      packVersionId: reference.packVersionId,
      semanticHash: reference.semanticHash,
      input: { tier: "missing" },
      filters: { tier: "paid" },
      filterFields: ["tier"],
      returnFields: ["name", "tier"],
      expectedProperties: ["name"],
    }), context(reference.productId));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid request" });
  });

  it("refuses a representative proof that omits an expected property", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/test/route");
    const reference = await approvedPack();
    const response = await route.POST(post(reference.productId, {
      packVersionId: reference.packVersionId,
      semanticHash: reference.semanticHash,
      input: { tier: "paid" },
      filters: { tier: "paid" },
      filterFields: ["tier"],
      returnFields: ["name", "tier"],
      expectedProperties: ["privateSourceBody"],
    }), context(reference.productId));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid request" });
  });

  it("does not treat an unapproved candidate as test authority", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/test/route");
    const product = await control.repository!.createProduct({
      ownerId: control.ownerId, name: "Candidate", slug: "candidate", executionAccess: "private", discoveryAccess: "unlisted",
    });
    await control.repository!.createSourceSnapshot({
      id: "snapshot-contract", ownerId: control.ownerId, resourceProductId: product.id,
      locator: "manual://candidate", sourceKind: "json_rows", capturedAt: RESOURCE_TEST_NOW.toISOString(),
      contentHash: "a".repeat(64), freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const candidate = await control.repository!.replaceCandidate({
      ownerId: control.ownerId, resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: control.ownerId,
    });
    const response = await route.POST(post(product.id, {
      packVersionId: candidate.id, semanticHash: candidate.semanticHash,
      input: {}, filters: {}, filterFields: [], returnFields: ["name"],
    }), context(product.id));
    expect(response.status).toBe(404);
  });
});
