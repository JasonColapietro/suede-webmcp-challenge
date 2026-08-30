import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceRepository } from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { SiteCrawlError } from "@/lib/site/crawl";
import { resourcePack } from "./resources/fixture";

const control = vi.hoisted(() => ({
  ownerId: "source-owner",
  repository: null as ResourceRepository | null,
  crawl: vi.fn(),
  rateKeys: [] as string[],
  blockedRateKey: null as string | null,
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  resolveOwnerId: async () => control.ownerId,
  resolveReadOnlyOwnerId: async () => control.ownerId,
}));
vi.mock("@/lib/resources/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/provider")>()),
  getResourceRepository: async () => control.repository,
}));
vi.mock("@/lib/resources/flags", () => ({ RESOURCE_FOUNDRY_ENABLED: true }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: (key: string) => {
    control.rateKeys.push(key);
    return { allowed: key !== control.blockedRateKey, retryAfterSec: 19 };
  },
}));
vi.mock("@/lib/site/crawl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/site/crawl")>()),
  crawlSite: control.crawl,
}));

function context(resourceId: string) {
  return { params: Promise.resolve({ resourceId }) };
}
function post(resourceId: string, body: unknown): Request {
  return new Request(`https://agents.suedeai.ai/api/v2/resources/${resourceId}/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function product(ownerId = control.ownerId): Promise<string> {
  const created = await control.repository!.createProduct({
    ownerId, name: "Sources", slug: `sources-${ownerId}`,
    executionAccess: "private", discoveryAccess: "unlisted",
  });
  return created.id;
}

beforeEach(() => {
  control.ownerId = "source-owner";
  control.repository = new SqliteResourceRepository(":memory:");
  control.rateKeys = [];
  control.blockedRateKey = null;
  control.crawl.mockReset().mockResolvedValue({
    homeUrl: "https://example.com/",
    origin: "https://example.com",
    host: "example.com",
    pages: [{
      url: "https://example.com/", title: "Example", description: "A bounded page",
      siteName: "Example", ogTitle: null, ogDescription: null, canonical: null,
      text: "A sufficiently long source record that was collected through the hardened website crawler boundary.",
      headings: ["Example"],
    }],
    skippedByRobots: [],
    truncated: false,
  });
});

describe("private Resource source intake", () => {
  it("collects a source and replaces the exact candidate through one atomic route", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/sources/collect/route");
    const base = resourcePack();
    const created = await control.repository!.createProductWithCandidate({
      ownerId: control.ownerId, name: "Atomic", slug: "atomic",
      executionAccess: "private", discoveryAccess: "unlisted",
      content: { ...base, records: [], evidence: [], sourceSnapshotIds: [] },
      createdBy: control.ownerId,
    });
    const response = await route.POST(post(created.product.id, {
      source: {
        kind: "json_rows", locator: "manual://atomic", rows: [{ name: "Atomic", tier: "paid" }], freshnessDays: 14,
      },
      candidate: {
        packVersionId: created.candidate.id,
        revision: created.candidate.revision,
        semanticHash: created.candidate.semanticHash,
      },
    }), context(created.product.id));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      snapshot: { locator: "manual://atomic" },
      collection: { status: "collected", records: [{ fields: { name: "Atomic", tier: "paid" } }] },
      candidate: { revision: 2, status: "candidate" },
    });
    const [summary] = await control.repository!.listOwnedProducts(control.ownerId);
    expect(summary?.candidateRevision).toBe(2);
  });

  it("creates immutable manual text and JSON-row snapshots without requiring provenance", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/sources/route");
    const id = await product();
    const textResponse = await route.POST(post(id, {
      kind: "manual_text", locator: "manual://notes", text: "One private reviewed note.", freshnessDays: 14,
    }), context(id));
    expect(textResponse.status).toBe(201);
    expect(textResponse.headers.get("cache-control")).toBe("private, no-store");
    const textPayload = await textResponse.json() as {
      snapshot: { sourceKind: string; provenance?: string; contentHash: string };
      collection: { status: string; records: unknown[]; evidence: unknown[]; warnings: string[] };
    };
    expect(textPayload.snapshot).toMatchObject({ sourceKind: "manual_text" });
    expect(textPayload.snapshot.provenance).toBeUndefined();
    expect(textPayload.snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(textPayload.collection).toMatchObject({ status: "collected", warnings: [] });
    expect(textPayload.collection.records).toHaveLength(1);
    expect(textPayload.collection.evidence).toHaveLength(1);

    const rowsResponse = await route.POST(post(id, {
      kind: "json_rows",
      locator: "manual://rows",
      freshnessDays: 30,
      rows: [{ name: "Alpha", tier: "paid" }, { name: "Beta", tier: "free" }],
      provenance: "mine",
    }), context(id));
    const rowsPayload = await rowsResponse.json() as {
      snapshot: { provenance?: string };
      collection: { records: Array<{ fields: Record<string, unknown> }> };
    };
    expect(rowsResponse.status).toBe(201);
    expect(rowsPayload.snapshot.provenance).toBe("mine");
    expect(rowsPayload.collection.records.map(({ fields }) => fields.name)).toEqual(["Alpha", "Beta"]);
  });

  it("namespaces collected record and evidence IDs so two sources merge into one candidate", async () => {
    const sources = await import("@/app/api/v2/resources/[resourceId]/sources/route");
    const records = await import("@/app/api/v2/resources/[resourceId]/records/route");
    const id = await product();
    const collected = [] as Array<{
      snapshot: { id: string };
      collection: { records: unknown[]; evidence: unknown[] };
    }>;
    for (const [locator, name] of [["manual://alpha", "Alpha"], ["manual://beta", "Beta"]] as const) {
      const response = await sources.POST(post(id, {
        kind: "json_rows", locator, freshnessDays: 30, rows: [{ name, tier: "paid" }],
      }), context(id));
      collected.push(await response.json() as typeof collected[number]);
    }

    const recordIds = collected.flatMap(({ collection }) => collection.records)
      .map((record) => (record as { id: string }).id);
    const evidenceIds = collected.flatMap(({ collection }) => collection.evidence)
      .map((evidence) => (evidence as { id: string }).id);
    expect(new Set(recordIds).size).toBe(2);
    expect(new Set(evidenceIds).size).toBe(2);

    const candidate = await records.POST(post(id, {
      expectedCandidatePackVersionId: null,
      expectedRevision: 0,
      content: {
        recordSchema: {
          type: "object", properties: { name: { type: "string" }, tier: { type: "string" } },
          required: ["name"], additionalProperties: false,
        },
        filterFields: ["tier"], returnFields: ["name", "tier"], taxonomy: [],
        records: collected.flatMap(({ collection }) => collection.records),
        evidence: collected.flatMap(({ collection }) => collection.evidence),
        sourceSnapshotIds: collected.map(({ snapshot }) => snapshot.id),
        jobContract: {
          jobStatement: "Return reviewed records.", buyerIntent: "Compare sources.",
          inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
          outputSchema: {
            type: "array",
            items: {
              type: "object", properties: { name: { type: "string" }, tier: { type: "string" } },
              required: ["name"], additionalProperties: false,
            },
          },
          unsupportedRequest: "Return unknown.", evidenceRequirement: "Return evidence.",
          safeExample: [], reviewBoundary: "Reviewed records only.",
          dataHandlingDisclosure: "Private inputs remain private.",
        },
      },
    }), context(id));
    expect(candidate.status).toBe(201);
    await expect(candidate.json()).resolves.toMatchObject({ candidate: { revision: 1, status: "candidate" } });
  });

  it("rejects mismatched safe examples on both candidate replacement and refresh", async () => {
    const records = await import("@/app/api/v2/resources/[resourceId]/records/route");
    const refresh = await import("@/app/api/v2/resources/[resourceId]/refresh/route");
    const base = resourcePack();
    const content = {
      ...base,
      records: base.records.map((record) => ({ ...record, evidenceIds: [] })),
      evidence: [],
      sourceSnapshotIds: [],
    };
    const created = await control.repository!.createProductWithCandidate({
      ownerId: control.ownerId,
      name: "Safe example boundary",
      slug: "safe-example-boundary",
      executionAccess: "free",
      discoveryAccess: "public",
      content,
      createdBy: control.ownerId,
    });
    const invalidContent = {
      ...content,
      jobContract: {
        ...content.jobContract,
        safeExample: { name: "Invalid object", tier: "paid" },
      },
    };

    const replacement = await records.POST(post(created.product.id, {
      expectedCandidatePackVersionId: created.candidate.id,
      expectedRevision: created.candidate.revision,
      content: invalidContent,
    }), context(created.product.id));
    expect(replacement.status).toBe(400);
    await expect(replacement.json()).resolves.toEqual({ error: "invalid request" });
    expect((await control.repository!.getOwnedPortfolioItem(control.ownerId, created.product.id))?.currentCandidate)
      .toMatchObject({ packVersionId: created.candidate.id, revision: created.candidate.revision });

    const approved = await control.repository!.approveCandidate({
      ownerId: control.ownerId,
      resourceProductId: created.product.id,
      candidatePackVersionId: created.candidate.id,
      expectedRevision: created.candidate.revision,
      expectedSemanticHash: created.candidate.semanticHash,
      approvedBy: control.ownerId,
    });
    const refreshed = await refresh.POST(post(created.product.id, {
      base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
      expectedCandidatePackVersionId: null,
      expectedRevision: approved.revision,
      content: invalidContent,
    }), context(created.product.id));
    expect(refreshed.status).toBe(400);
    await expect(refreshed.json()).resolves.toEqual({ error: "invalid request" });
    const summary = await control.repository!.getOwnedPortfolioItem(control.ownerId, created.product.id);
    expect(summary?.currentCandidate).toBeNull();
    expect(summary?.approvedPackVersionId).toBe(approved.id);
  });

  it("uses the existing hardened crawl boundary for URL collection", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/sources/route");
    const id = await product();
    const response = await route.POST(post(id, {
      kind: "url", url: "example.com", freshnessDays: 7,
    }), context(id));
    expect(response.status).toBe(201);
    expect(control.crawl).toHaveBeenCalledWith("example.com");
    const payload = await response.json() as {
      snapshot: { locator: string; sourceKind: string };
      collection: {
        status: string;
        records: Array<{ fields: { text: string } }>;
        evidence: Array<{ locator: string }>;
      };
    };
    expect(payload.snapshot).toMatchObject({ locator: "https://example.com/", sourceKind: "url" });
    expect(payload.collection.status).toBe("collected");
    expect(payload.collection.records[0]!.fields.text).toContain("hardened website crawler");
    expect(payload.collection.evidence[0]?.locator).toBe("page:1");
  });

  it("rejects credentialed or secret-query source URLs before collection", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/sources/route");
    const id = await product();
    for (const url of [
      "https://user:password@example.com/private",
      "https://example.com/data?api_key=SECRET-CANARY",
    ]) {
      const response = await route.POST(post(id, { kind: "url", url, freshnessDays: 7 }), context(id));
      expect(response.status).toBe(400);
    }
    expect(control.crawl).not.toHaveBeenCalled();
  });

  it("persists blocked/failed attempts as explicit snapshots with fixed warnings", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/sources/route");
    const id = await product();
    control.crawl.mockRejectedValueOnce(new SiteCrawlError("robots-blocked", "private target detail canary"));
    const blocked = await route.POST(post(id, { kind: "url", url: "blocked.example", freshnessDays: 7 }), context(id));
    expect(blocked.status).toBe(201);
    const blockedText = await blocked.text();
    expect(blockedText).not.toContain("private target detail canary");
    expect(JSON.parse(blockedText)).toMatchObject({
      snapshot: { sourceKind: "url_blocked_robots" },
      collection: { status: "blocked", warnings: ["source collection blocked by robots policy"] },
    });

    control.crawl.mockRejectedValueOnce(new Error("private socket canary"));
    const failed = await route.POST(post(id, { kind: "url", url: "failed.example", freshnessDays: 7 }), context(id));
    expect(failed.status).toBe(201);
    const failedText = await failed.text();
    expect(failedText).not.toContain("private socket canary");
    expect(JSON.parse(failedText)).toMatchObject({
      snapshot: { sourceKind: "url_failed" },
      collection: { status: "failed", warnings: ["source collection failed"] },
    });
  });

  it("owner-checks before outbound work and makes foreign/missing products opaque", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/sources/route");
    const foreignId = await product("different-source-owner");
    const foreign = await route.POST(post(foreignId, { kind: "url", url: "private.example", freshnessDays: 7 }), context(foreignId));
    const missing = await route.POST(post("missing-resource", { kind: "url", url: "private.example", freshnessDays: 7 }), context("missing-resource"));
    expect(await foreign.text()).toBe(JSON.stringify({ error: "not found" }));
    expect(await missing.text()).toBe(JSON.stringify({ error: "not found" }));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(control.crawl).not.toHaveBeenCalled();
  });

  it("keeps one server-derived URL bucket when an anonymous caller rotates owner headers", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/sources/route");
    const firstId = await product();
    const first = post(firstId, { kind: "url", url: "first.example", freshnessDays: 7 });
    first.headers.set("x-real-ip", "198.51.100.20");
    expect((await route.POST(first, context(firstId))).status).toBe(201);

    control.ownerId = "rotated-source-owner";
    const secondId = await product();
    control.blockedRateKey = "resource-source-url-ip:198.51.100.20";
    const rotated = post(secondId, { kind: "url", url: "second.example", freshnessDays: 7 });
    rotated.headers.set("x-real-ip", "198.51.100.20");
    const response = await route.POST(rotated, context(secondId));
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "rate limit exceeded", retryAfterSec: 19 });
    expect(control.rateKeys.filter((key) => key === "resource-source-url-ip:198.51.100.20")).toHaveLength(2);
    expect(control.crawl).toHaveBeenCalledTimes(1);
  });
});
