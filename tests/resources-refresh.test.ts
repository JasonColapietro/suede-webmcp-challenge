import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { ResourcePublishService } from "@/lib/resources/publish-service";
import { ResourceRepositoryConflictError, type ResourceRepository } from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { ResourceFoundryService } from "@/lib/resources/service";
import { RESOURCE_TEST_NOW, resourcePack } from "./resources/fixture";

const crawlSiteMock = vi.hoisted(() => vi.fn());
const routeControl = vi.hoisted(() => ({ ownerId: "refresh-owner", repository: null as ResourceRepository | null }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  resolveOwnerId: async () => routeControl.ownerId,
}));
vi.mock("@/lib/resources/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resources/provider")>()),
  getResourceRepository: async () => routeControl.repository,
}));
vi.mock("@/lib/site/crawl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/site/crawl")>()),
  crawlSite: crawlSiteMock,
}));
vi.mock("@/lib/resources/flags", () => ({ RESOURCE_FOUNDRY_ENABLED: true }));

const OWNER = "refresh-owner";
let repository: ResourceRepository;
let service: ResourceFoundryService;
let db: Database.Database;
let flowRepository: SqliteRepo;
let projectRepository: SqliteProjectRepo;
let currentNow: Date;

async function approvedResource(
  deadline = "2026-08-12T12:00:00.000Z",
  publishLive = false,
) {
  const product = await repository.createProduct({
    ownerId: OWNER, name: "Reviewed pricing", slug: "reviewed-pricing",
    executionAccess: "paid", discoveryAccess: "public",
  });
  await repository.createSourceSnapshot({
    id: "snapshot-old", ownerId: OWNER, resourceProductId: product.id,
    locator: "manual://pricing", sourceKind: "json_rows",
    capturedAt: "2026-08-01T12:00:00.000Z", contentHash: "a".repeat(64),
    freshnessDeadline: deadline,
  });
  const base = resourcePack();
  const candidate = await repository.replaceCandidate({
    ownerId: OWNER, resourceProductId: product.id,
    expectedCandidatePackVersionId: null, expectedRevision: 0,
    content: {
      ...base,
      records: [
        base.records[0],
        { id: "record-removed", fields: { name: "Legacy", tier: "paid" }, tags: [], evidenceIds: ["evidence-removed"], unknowns: ["legacy-gap"], conflicts: ["old conflict"] },
      ],
      evidence: [
        { ...base.evidence[0], sourceSnapshotId: "snapshot-old" },
        { id: "evidence-removed", sourceSnapshotId: "snapshot-old", locator: "row:legacy", observedAt: "2026-08-01T12:00:00.000Z", conflict: "old conflict" },
      ],
      sourceSnapshotIds: ["snapshot-old"],
    },
    createdBy: OWNER,
  });
  const approved = await repository.approveCandidate({
    ownerId: OWNER, resourceProductId: product.id,
    candidatePackVersionId: candidate.id, expectedRevision: candidate.revision,
    expectedSemanticHash: candidate.semanticHash, approvedBy: OWNER,
  });
  if (!publishLive) return { product, approved, published: null };
  currentNow = new Date("2026-08-10T12:00:00.000Z");
  const published = await new ResourcePublishService({
    resourceRepo: repository,
    flowRepo: flowRepository,
    projectRepo: projectRepository,
    dryRun: async () => ({ measuredCostUsdc: 0 }),
  }).publish(OWNER, product.id, {
    idempotencyKey: "refresh-live-baseline",
    priceUsdc: 0.05,
    payoutAddress: "0x2222222222222222222222222222222222222222",
    representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
  });
  currentNow = RESOURCE_TEST_NOW;
  return { product, approved, published };
}

beforeEach(() => {
  crawlSiteMock.mockReset();
  let id = 0;
  currentNow = RESOURCE_TEST_NOW;
  db = new Database(":memory:");
  runSqliteMigrations(db);
  flowRepository = new SqliteRepo(db);
  projectRepository = new SqliteProjectRepo(db);
  repository = new SqliteResourceRepository(db, {
    now: () => currentNow,
    id: () => `refresh-id-${++id}`,
  });
  routeControl.ownerId = OWNER;
  routeControl.repository = repository;
  service = new ResourceFoundryService(repository, () => currentNow, () => `source-${++id}`);
});

afterEach(() => db.close());

describe("reviewed resource refresh", () => {
  it("collects a manual source into a bounded diff without changing the approved pack", async () => {
    const { product, approved, published } = await approvedResource(undefined, true);
    const liveBefore = await repository.getOwnedPortfolioItem(OWNER, product.id);
    const receiptsBefore = await repository.listRunReceipts(OWNER, product.id);
    const refresh = await service.refreshFromSource(OWNER, product.id, {
      base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
      candidate: null,
      replaceSourceSnapshotIds: ["snapshot-old"],
      source: {
        kind: "json_rows", locator: "manual://pricing", freshnessDays: 30,
        rows: [{ name: "Alpha changed", tier: "paid" }, { name: "New", tier: "free" }],
      },
    });

    expect(refresh.collection.status).toBe("collected");
    expect(refresh.candidate).toMatchObject({ status: "candidate", revision: 2 });
    expect(refresh.diff).toMatchObject({
      changedRecordIds: ["record-1"], removedRecordIds: ["record-removed"],
      addedRecordIds: [expect.stringMatching(/^record-/u)], evidenceChanged: true,
      unknowns: { before: 1, candidate: 0, delta: -1 },
      conflicts: { before: 1, candidate: 0, delta: -1 },
      freshness: { before: "stale", candidate: "fresh" },
    });
    expect(refresh.diff!.addedRecordIds).toHaveLength(1);
    expect(refresh.diff!.changedRecordIds.length + refresh.diff!.removedRecordIds.length + refresh.diff!.addedRecordIds.length).toBeLessThanOrEqual(2_000);
    const summary = await repository.getOwnedPortfolioItem(OWNER, product.id);
    expect(summary?.approvedPackVersionId).toBeNull();
    expect(summary?.livePackVersionId).toBe(approved.id);
    expect(summary?.currentCandidate?.packVersionId).toBe(refresh.candidate!.id);
    expect(summary?.currentRelease).toEqual(liveBefore?.currentRelease);
    expect(summary?.currentRelease).toMatchObject({
      flowVersionId: published!.release.flowVersionId,
      agentId: published!.agent.id,
      urls: published!.urls,
    });
    await expect(repository.getPublishedReleaseByAgent(published!.agent.id)).resolves.toEqual(published!.release);
    expect(await repository.listRunReceipts(OWNER, product.id)).toEqual(receiptsBefore);
    await expect(repository.getOwnedPack({ ownerId: OWNER, resourceProductId: product.id, packVersionId: approved.id, semanticHash: approved.semanticHash })).resolves.toMatchObject({ packVersionId: approved.id });
  });

  it("persists a failed URL collection without creating or approving a candidate", async () => {
    const { product, approved } = await approvedResource("2026-08-20T12:00:00.000Z");
    crawlSiteMock.mockRejectedValueOnce(new Error("private network detail"));
    const refresh = await service.refreshFromSource(OWNER, product.id, {
      base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
      candidate: null,
      replaceSourceSnapshotIds: ["snapshot-old"],
      source: { kind: "url", url: "https://failed.example", freshnessDays: 7 },
    });
    expect(refresh).toMatchObject({ collection: { status: "failed", warnings: ["source collection failed"] }, candidate: null, diff: null });
    const summary = await repository.getOwnedPortfolioItem(OWNER, product.id);
    expect(summary?.approvedPackVersionId).toBe(approved.id);
    expect(summary?.currentCandidate).toBeNull();
  });

  it("rejects a candidate as a non-approval decision and leaves the approved pointer unchanged", async () => {
    const { product, approved } = await approvedResource("2026-08-20T12:00:00.000Z");
    const refresh = await service.refreshFromSource(OWNER, product.id, {
      base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
      candidate: null,
      replaceSourceSnapshotIds: ["snapshot-old"],
      source: { kind: "json_rows", locator: "manual://pricing", rows: [{ name: "Replacement", tier: "paid" }], freshnessDays: 30 },
    });
    const rejected = await service.rejectRefreshCandidate(OWNER, product.id, {
      base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
      candidate: { packVersionId: refresh.candidate!.id, revision: refresh.candidate!.revision, semanticHash: refresh.candidate!.semanticHash },
    });
    expect(rejected).toEqual({ decision: "rejected", approved: false, republished: false });
    const summary = await repository.getOwnedPortfolioItem(OWNER, product.id);
    expect(summary?.approvedPackVersionId).toBe(approved.id);
    expect(summary?.livePackVersionId).toBeNull();
    expect(summary?.currentCandidate).toBeNull();
    await expect(repository.getOwnedPack({
      ownerId: OWNER, resourceProductId: product.id,
      packVersionId: refresh.candidate!.id, semanticHash: refresh.candidate!.semanticHash,
    })).resolves.toBeNull();
    await expect(service.approveCandidate(OWNER, product.id, {
      candidatePackVersionId: refresh.candidate!.id,
      expectedRevision: refresh.candidate!.revision,
      expectedSemanticHash: refresh.candidate!.semanticHash,
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
  });

  it("routes exact owner-scoped recollection through the current candidate without dropping unrelated edits", async () => {
    const { product, approved } = await approvedResource("2026-08-20T12:00:00.000Z");
    const base = await repository.getOwnedPack({
      ownerId: OWNER, resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
    });
    const unrelated = await repository.replaceCandidate({
      ownerId: OWNER, resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: approved.revision,
      content: {
        ...base!.content,
        records: [...base!.content.records, {
          id: "unrelated-current-edit", fields: { name: "Keep me", tier: "free" },
          tags: [], evidenceIds: [], unknowns: ["owner review"],
        }],
      },
      createdBy: OWNER,
    });
    const route = await import("@/app/api/v2/resources/[resourceId]/refresh/route");
    const body = {
      action: "recollect",
      base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
      candidate: { packVersionId: unrelated.id, revision: unrelated.revision, semanticHash: unrelated.semanticHash },
      replaceSourceSnapshotIds: ["snapshot-old"],
      source: {
        kind: "json_rows", locator: "manual://pricing", freshnessDays: 30,
        rows: [{ name: "Alpha changed", tier: "paid" }],
      },
    } as const;
    const response = await route.POST(new Request(
      `https://agents.suedeai.ai/api/v2/resources/${product.id}/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ), { params: Promise.resolve({ resourceId: product.id }) });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const refreshed = await response.json() as { candidate: { id: string; semanticHash: string }; diff: { addedRecordIds: string[] } };
    expect(refreshed.diff.addedRecordIds).toContain("unrelated-current-edit");
    const bundle = await repository.getOwnedPack({
      ownerId: OWNER, resourceProductId: product.id,
      packVersionId: refreshed.candidate.id, semanticHash: refreshed.candidate.semanticHash,
    });
    expect(bundle?.content.records.some((record) => record.id === "unrelated-current-edit")).toBe(true);

    const stale = await route.POST(new Request(
      `https://agents.suedeai.ai/api/v2/resources/${product.id}/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        ...body,
        candidate: { ...body.candidate, semanticHash: "f".repeat(64) },
      }) },
    ), { params: Promise.resolve({ resourceId: product.id }) });
    expect(stale.status).toBe(409);
  });

  it("routes exact durable rejection with no approval or republish", async () => {
    const { product, approved } = await approvedResource("2026-08-20T12:00:00.000Z");
    const base = await repository.getOwnedPack({
      ownerId: OWNER, resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
    });
    const candidate = await repository.replaceCandidate({
      ownerId: OWNER, resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: approved.revision,
      content: base!.content, createdBy: OWNER,
    });
    const route = await import("@/app/api/v2/resources/[resourceId]/refresh/route");
    const response = await route.POST(new Request(
      `https://agents.suedeai.ai/api/v2/resources/${product.id}/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "reject",
        base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
        candidate: { packVersionId: candidate.id, revision: candidate.revision, semanticHash: candidate.semanticHash },
      }) },
    ), { params: Promise.resolve({ resourceId: product.id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: "rejected", approved: false, republished: false });
    const summary = await repository.getOwnedPortfolioItem(OWNER, product.id);
    expect(summary).toMatchObject({ approvedPackVersionId: approved.id, livePackVersionId: null, releaseCount: 0 });
  });
});
