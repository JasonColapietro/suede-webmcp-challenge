import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import {
  ResourcePersistenceError,
  ResourceRepositoryConflictError,
  ResourceRepositoryNotFoundError,
  type ResourceRepository,
} from "@/lib/resources/repository";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { RESOURCE_TEST_NOW as NOW, resourcePack } from "./fixture";

async function seedProduct(repo: ResourceRepository, ownerId = "owner-a") {
  const product = await repo.createProduct({
    ownerId,
    name: "Pricing signals",
    slug: "pricing-signals",
    executionAccess: "paid",
    discoveryAccess: "public",
  });
  const snapshot = await repo.createSourceSnapshot({
    id: "snapshot-contract",
    ownerId,
    resourceProductId: product.id,
    locator: "manual://pricing",
    sourceKind: "manual",
    capturedAt: NOW.toISOString(),
    contentHash: "a".repeat(64),
    freshnessDeadline: "2026-08-20T12:00:00.000Z",
  });
  return { product, snapshot };
}

function seedPublicationIdentity(db: Database.Database, input: {
  readonly ownerId: string;
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
  readonly agentId: string;
  readonly flowId: string;
  readonly flowVersionId: string;
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly priceUsdc: number;
}): void {
  const suffix = input.deploymentId;
  db.prepare("INSERT INTO flows(id,owner_id,name,graph,updated_at) VALUES(?,?,?,?,?)")
    .run(input.flowId, input.ownerId, "Resource flow", JSON.stringify({ id: `graph-${suffix}`, name: "Resource", nodes: [], edges: [] }), NOW.getTime());
  db.prepare("INSERT INTO agents(id,flow_id,slug,status,price_usdc,created_at,settlement_live) VALUES(?,?,?,?,?,?,0)")
    .run(input.agentId, input.flowId, `slug-${suffix}`, "draft", input.priceUsdc, NOW.getTime());
  db.prepare("INSERT INTO organizations(id,personal_owner_id,name,kind,created_at) VALUES(?,?,?,?,?)")
    .run(`org-${suffix}`, input.ownerId, "Personal", "personal", NOW.getTime());
  db.prepare("INSERT INTO workspaces(id,organization_id,name,slug,created_at) VALUES(?,?,?,?,?)")
    .run(`workspace-${suffix}`, `org-${suffix}`, "Personal", `workspace-${suffix}`, NOW.getTime());
  db.prepare("INSERT INTO projects(id,workspace_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(`project-${suffix}`, `workspace-${suffix}`, "Project", `project-${suffix}`, NOW.getTime(), NOW.getTime());
  db.prepare("INSERT INTO environments(id,project_id,name,slug,kind,created_at) VALUES(?,?,?,?,?,?)")
    .run(input.environmentId, `project-${suffix}`, "Live", `live-${suffix}`, "live", NOW.getTime());
  db.prepare(`INSERT INTO flow_versions(id,flow_id,version_number,schema_version,graph,semantic_hash,full_hash,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(input.flowVersionId, input.flowId, 1, 1, JSON.stringify({ id: `graph-${suffix}`, name: "Resource", nodes: [], edges: [] }), "b".repeat(64), "c".repeat(64), input.ownerId, NOW.getTime());
  db.prepare("INSERT INTO dependency_pins(id,flow_version_id,kind,resource_id,version,content_hash,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(`pin-${suffix}`, input.flowVersionId, "resource", input.resourceProductId, input.packVersionId, input.semanticHash, NOW.getTime());
  db.prepare("INSERT INTO deployments(id,flow_id,flow_version_id,environment_id,status,created_at,retired_at) VALUES(?,?,?,?,?,?,NULL)")
    .run(input.deploymentId, input.flowId, input.flowVersionId, input.environmentId, "live", NOW.getTime());
}

function publicationFields(deploymentId: string) {
  return {
    publicationKey: `publication-${deploymentId}`,
    publicationRequestHash: "d".repeat(64),
    graphSemanticHash: "b".repeat(64),
    graphFullHash: "c".repeat(64),
    priceUsdc: 0.05,
    executionAccess: "paid" as const,
    discoveryAccess: "public" as const,
  };
}

describe("ResourceRepository contract", () => {
  let db: Database.Database;
  let repo: ResourceRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runSqliteMigrations(db);
    repo = new SqliteResourceRepository(db, { now: () => NOW });
  });

  afterEach(() => db.close());

  it("isolates owners and makes missing and foreign products equally opaque", async () => {
    const { product } = await seedProduct(repo);
    expect(await repo.getOwnedProduct("owner-a", product.id)).toEqual(product);
    expect(await repo.getOwnedProduct("owner-b", product.id)).toBeNull();
    expect(await repo.getOwnedProduct("owner-b", "missing")).toBeNull();
    expect(await repo.listOwnedProducts("owner-b")).toEqual([]);

    const foreign = repo.updateOwnedDraft({
      ownerId: "owner-b",
      resourceProductId: product.id,
      expectedStatus: "draft",
      name: "Leaked",
    });
    const missing = repo.updateOwnedDraft({
      ownerId: "owner-b",
      resourceProductId: "missing",
      expectedStatus: "draft",
      name: "Leaked",
    });
    await expect(foreign).rejects.toBeInstanceOf(ResourceRepositoryNotFoundError);
    await expect(missing).rejects.toBeInstanceOf(ResourceRepositoryNotFoundError);
  });

  it("creates a product and initial candidate atomically when candidate persistence fails", async () => {
    const faultDb = new Database(":memory:");
    runSqliteMigrations(faultDb);
    const ids = ["atomic-product-one", "shared-candidate", "atomic-product-rollback", "shared-candidate"];
    const faultRepo = new SqliteResourceRepository(faultDb, { now: () => NOW, id: () => ids.shift() ?? "unexpected-id" });
    const base = resourcePack();
    const content = { ...base, records: [], evidence: [], sourceSnapshotIds: [] };

    await expect(faultRepo.createProductWithCandidate({
      ownerId: "atomic-owner", name: "First", slug: "first",
      executionAccess: "private", discoveryAccess: "unlisted",
      content, createdBy: "atomic-owner",
    })).resolves.toMatchObject({
      product: { id: "atomic-product-one" },
      candidate: { id: "shared-candidate", revision: 1, status: "candidate" },
    });
    await expect(faultRepo.createProductWithCandidate({
      ownerId: "atomic-owner", name: "Rollback", slug: "rollback",
      executionAccess: "private", discoveryAccess: "unlisted",
      content, createdBy: "atomic-owner",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    await expect(faultRepo.getOwnedProduct("atomic-owner", "atomic-product-rollback")).resolves.toBeNull();
    expect(faultDb.prepare("SELECT COUNT(*) AS count FROM resource_products").get()).toEqual({ count: 1 });
    expect(faultDb.prepare("SELECT COUNT(*) AS count FROM resource_pack_versions").get()).toEqual({ count: 1 });
    faultDb.close();
  });

  it("returns only bounded server-current pack references for owner workspace reloads", async () => {
    const content = { ...resourcePack(), records: [], evidence: [], sourceSnapshotIds: [] };
    const created = await repo.createProductWithCandidate({
      ownerId: "owner-a", name: "Reloadable", slug: "reloadable",
      executionAccess: "private", discoveryAccess: "unlisted",
      content, createdBy: "owner-a",
    });
    const [item] = await repo.listOwnedProducts("owner-a");
    expect(item?.currentCandidate).toEqual({
      packVersionId: created.candidate.id,
      revision: created.candidate.revision,
      semanticHash: created.candidate.semanticHash,
    });
    expect(item?.approvedPack).toBeNull();
    expect(item?.livePack).toBeNull();
    expect(item).toMatchObject({
      portfolioFreshness: "fresh",
      portfolioPayments: {
        attempted: null, free: 0, challenged: null, executed: 0,
        credited: { count: 0, amountUsdc: 0 },
        settled: { count: 0, amountUsdc: 0 },
        refunded: { count: null, amountUsdc: null },
        failed: null,
      },
      currentRelease: null,
    });
    expect(JSON.stringify(item)).not.toContain("content");
    expect(await repo.listOwnedProducts("owner-b")).toEqual([]);
  });

  it("atomically appends one source snapshot and replaces the exact candidate", async () => {
    const base = resourcePack();
    const empty = { ...base, records: [], evidence: [], sourceSnapshotIds: [] };
    const created = await repo.createProductWithCandidate({
      ownerId: "owner-a", name: "Atomic source", slug: "atomic-source",
      executionAccess: "private", discoveryAccess: "unlisted",
      content: empty, createdBy: "owner-a",
    });
    const content = {
      ...base,
      evidence: base.evidence.map((item) => ({ ...item, sourceSnapshotId: "snapshot-atomic" })),
      sourceSnapshotIds: ["snapshot-atomic"],
    };
    const input = {
      snapshot: {
        id: "snapshot-atomic", ownerId: "owner-a", resourceProductId: created.product.id,
        locator: "manual://atomic", sourceKind: "manual_text",
        capturedAt: NOW.toISOString(), contentHash: "e".repeat(64),
        freshnessDeadline: "2026-08-20T12:00:00.000Z",
      },
      candidate: {
        ownerId: "owner-a", resourceProductId: created.product.id,
        expectedCandidatePackVersionId: "stale-candidate", expectedRevision: 1,
        content, createdBy: "owner-a",
      },
    };
    const atomic = repo as ResourceRepository & {
      createSourceSnapshotAndReplaceCandidate(value: typeof input): Promise<unknown>;
    };
    await expect(atomic.createSourceSnapshotAndReplaceCandidate(input))
      .rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_source_snapshots WHERE resource_product_id=?")
      .get(created.product.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT id,revision FROM resource_pack_versions WHERE resource_product_id=?")
      .all(created.product.id)).toEqual([{ id: created.candidate.id, revision: 1 }]);

    await expect(atomic.createSourceSnapshotAndReplaceCandidate({
      ...input,
      candidate: { ...input.candidate, expectedCandidatePackVersionId: created.candidate.id },
    })).resolves.toMatchObject({
      snapshot: { id: "snapshot-atomic" },
      candidate: { revision: 2, status: "candidate" },
    });
    expect(db.prepare("SELECT COUNT(*) count FROM resource_source_snapshots WHERE resource_product_id=?")
      .get(created.product.id)).toEqual({ count: 1 });
  });

  it("appends immutable snapshots while retaining optional provenance as context only", async () => {
    const { product, snapshot } = await seedProduct(repo);
    const second = await repo.createSourceSnapshot({
      ownerId: "owner-a",
      resourceProductId: product.id,
      locator: snapshot.locator,
      sourceKind: snapshot.sourceKind,
      capturedAt: "2026-08-14T12:00:00.000Z",
      sourcePublishedAt: "2026-08-14T11:00:00.000Z",
      contentHash: "b".repeat(64),
      freshnessDeadline: "2026-08-21T12:00:00.000Z",
      provenance: "public_source",
      provenanceNote: "Owner-supplied context.",
    });
    expect(second.id).not.toBe(snapshot.id);
    expect(snapshot.provenance).toBeUndefined();
    expect(second.provenance).toBe("public_source");
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM resource_source_snapshots WHERE resource_product_id = ?",
    ).get(product.id)).toEqual({ count: 2 });
  });

  it("replaces only the current candidate with an optimistic revision", async () => {
    const { product } = await seedProduct(repo);
    const first = await repo.replaceCandidate({
      ownerId: "owner-a",
      resourceProductId: product.id,
      expectedCandidatePackVersionId: null,
      expectedRevision: 0,
      content: resourcePack(),
      createdBy: "owner-a",
    });
    expect(first).toMatchObject({ revision: 1, status: "candidate" });

    await expect(repo.replaceCandidate({
      ownerId: "owner-a",
      resourceProductId: product.id,
      expectedCandidatePackVersionId: null,
      expectedRevision: 0,
      content: resourcePack("Stale writer"),
      createdBy: "owner-a",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    const second = await repo.replaceCandidate({
      ownerId: "owner-a",
      resourceProductId: product.id,
      expectedCandidatePackVersionId: first.id,
      expectedRevision: 1,
      content: resourcePack("Beta"),
      createdBy: "owner-a",
    });
    expect(second).toMatchObject({ revision: 2, status: "candidate" });
    expect(second.id).not.toBe(first.id);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM resource_pack_versions WHERE resource_product_id = ? AND status = 'candidate'",
    ).get(product.id)).toEqual({ count: 1 });
  });

  it("makes approved and live pack content immutable and verifies the exact hash on readback", async () => {
    const { product } = await seedProduct(repo);
    const candidate = await repo.replaceCandidate({
      ownerId: "owner-a",
      resourceProductId: product.id,
      expectedCandidatePackVersionId: null,
      expectedRevision: 0,
      content: resourcePack(),
      createdBy: "owner-a",
    });
    const approved = await repo.approveCandidate({
      ownerId: "owner-a",
      resourceProductId: product.id,
      candidatePackVersionId: candidate.id,
      expectedRevision: candidate.revision,
      expectedSemanticHash: candidate.semanticHash,
      approvedBy: "owner-a",
    });
    expect(approved).toMatchObject({ id: candidate.id, status: "approved" });

    const exact = await repo.getOwnedPack({
      ownerId: "owner-a",
      resourceProductId: product.id,
      packVersionId: approved.id,
      semanticHash: approved.semanticHash,
    });
    expect(exact?.semanticHash).toBe(resourcePackSemanticHash(resourcePack()).semanticHash);
    expect(exact?.content.records[0]?.fields.name).toBe("Alpha");
    expect(await repo.getOwnedPack({
      ownerId: "owner-b",
      resourceProductId: product.id,
      packVersionId: approved.id,
      semanticHash: approved.semanticHash,
    })).toBeNull();

    const refreshed = await repo.replaceCandidate({
      ownerId: "owner-a",
      resourceProductId: product.id,
      expectedCandidatePackVersionId: null,
      expectedRevision: approved.revision,
      content: resourcePack("Refresh"),
      createdBy: "owner-a",
    });
    expect(refreshed.revision).toBe(2);
    expect((await repo.getOwnedPack({
      ownerId: "owner-a",
      resourceProductId: product.id,
      packVersionId: approved.id,
      semanticHash: approved.semanticHash,
    }))?.content.records[0]?.fields.name).toBe("Alpha");
  });

  it("resolves only the owner's newest approved pointer after supersession", async () => {
    const { product } = await seedProduct(repo);
    const firstCandidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner-a",
    });
    const first = await repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: firstCandidate.id, expectedRevision: 1,
      expectedSemanticHash: firstCandidate.semanticHash, approvedBy: "owner-a",
    });
    db.prepare("UPDATE resource_pack_versions SET status='live' WHERE id=?").run(first.id);
    const nextCandidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 1,
      content: resourcePack("Superseding"), createdBy: "owner-a",
    });
    const next = await repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: nextCandidate.id, expectedRevision: 2,
      expectedSemanticHash: nextCandidate.semanticHash, approvedBy: "owner-a",
    });

    await expect(repo.getOwnedApprovedPack("owner-a", product.id)).resolves.toMatchObject({
      packVersionId: next.id, semanticHash: next.semanticHash,
    });
    await expect(repo.getOwnedApprovedPack("owner-b", product.id)).resolves.toBeNull();
  });

  it("hydrates freshness from every declared snapshot even when evidence is empty", async () => {
    const { product } = await seedProduct(repo);
    await repo.createSourceSnapshot({
      id: "snapshot-unreferenced", ownerId: "owner-a", resourceProductId: product.id,
      locator: "manual://unreferenced", sourceKind: "manual",
      capturedAt: "2026-08-12T12:00:00.000Z", contentHash: "b".repeat(64),
      freshnessDeadline: "2026-08-12T12:00:00.000Z",
    });
    const base = resourcePack();
    const candidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: {
        ...base,
        records: base.records.map((record) => ({ ...record, evidenceIds: [] })),
        evidence: [],
        sourceSnapshotIds: ["snapshot-contract", "snapshot-unreferenced"],
      },
      createdBy: "owner-a",
    });

    await expect(repo.getOwnedPack({
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: candidate.id, semanticHash: candidate.semanticHash,
    })).resolves.toMatchObject({ freshness: "mixed", content: { evidence: [] } });
    await expect(repo.getOwnedSourceDisclosure({
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: candidate.id, semanticHash: candidate.semanticHash,
    })).resolves.toEqual({ sourceCount: 2, sourceKinds: ["manual"] });
    await expect(repo.getOwnedSourceDisclosure({
      ownerId: "owner-b", resourceProductId: product.id,
      packVersionId: candidate.id, semanticHash: candidate.semanticHash,
    })).resolves.toBeNull();
  });

  it("refuses receipts whose pack belongs to another product or owner", async () => {
    const { product } = await seedProduct(repo);
    const createForeignPack = async (ownerId: string, suffix: string) => {
      const foreign = await repo.createProduct({
        ownerId, name: `Foreign ${suffix}`, slug: `foreign-${suffix}`,
        executionAccess: "private", discoveryAccess: "unlisted",
      });
      const snapshotId = `snapshot-${suffix}`;
      await repo.createSourceSnapshot({
        id: snapshotId, ownerId, resourceProductId: foreign.id,
        locator: `manual://${suffix}`, sourceKind: "manual",
        capturedAt: NOW.toISOString(), contentHash: "c".repeat(64),
        freshnessDeadline: "2026-08-20T12:00:00.000Z",
      });
      const base = resourcePack();
      const candidate = await repo.replaceCandidate({
        ownerId, resourceProductId: foreign.id,
        expectedCandidatePackVersionId: null, expectedRevision: 0,
        content: {
          ...base,
          records: base.records.map((record) => ({ ...record, evidenceIds: ["evidence-1"] })),
          evidence: base.evidence.map((evidence) => ({ ...evidence, sourceSnapshotId: snapshotId })),
          sourceSnapshotIds: [snapshotId],
        },
        createdBy: ownerId,
      });
      return repo.approveCandidate({
        ownerId, resourceProductId: foreign.id,
        candidatePackVersionId: candidate.id, expectedRevision: candidate.revision,
        expectedSemanticHash: candidate.semanticHash, approvedBy: ownerId,
      });
    };
    const sameOwnerPack = await createForeignPack("owner-a", "same-owner");
    const foreignOwnerPack = await createForeignPack("owner-b", "foreign-owner");
    const receiptFor = (pack: Awaited<ReturnType<typeof createForeignPack>>, runId: string) => repo.recordRunReceipt({
      ownerId: "owner-a", resourceProductId: product.id, packVersionId: pack.id,
      agentId: "agent", paymentId: "payment", paymentState: "settled", priceUsdc: 0.05,
      runId, flowVersionId: "flow-version", deploymentId: "deployment",
      receipt: {
        resourceProductId: product.id, resourceVersion: pack.id,
        semanticHash: pack.semanticHash, freshness: "fresh",
        evidence: [], unknowns: [], conflicts: [], outputSchemaValid: true,
      },
    });

    await expect(receiptFor(sameOwnerPack, "run-cross-product"))
      .rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    await expect(receiptFor(foreignOwnerPack, "run-cross-owner"))
      .rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get())
      .toEqual({ count: 0 });
  });

  it("atomically pauses, resumes, and terminally retires one exact published release", async () => {
    const { product } = await seedProduct(repo);
    const candidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner-a",
    });
    const approved = await repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "owner-a",
    });
    const releaseInput = {
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      agentId: "agent-1", flowId: "flow-1", flowVersionId: "flow-version-1",
      deploymentId: "deployment-1", environmentId: "environment-live",
      ...publicationFields("deployment-1"),
    } as const;
    seedPublicationIdentity(db, releaseInput);
    const release = await repo.createRelease(releaseInput);
    expect(release).toMatchObject(releaseInput);
    expect(await repo.createRelease({
      environmentId: releaseInput.environmentId,
      deploymentId: releaseInput.deploymentId,
      flowVersionId: releaseInput.flowVersionId,
      flowId: releaseInput.flowId,
      agentId: releaseInput.agentId,
      semanticHash: releaseInput.semanticHash,
      packVersionId: releaseInput.packVersionId,
      resourceProductId: releaseInput.resourceProductId,
      ownerId: releaseInput.ownerId,
      publicationKey: releaseInput.publicationKey,
      publicationRequestHash: releaseInput.publicationRequestHash,
      graphSemanticHash: releaseInput.graphSemanticHash,
      graphFullHash: releaseInput.graphFullHash,
      priceUsdc: releaseInput.priceUsdc,
      executionAccess: releaseInput.executionAccess,
      discoveryAccess: releaseInput.discoveryAccess,
    })).toEqual(release);
    expect(await repo.getPublishedReleaseByAgent("agent-1")).toEqual(release);
    expect(await repo.listPublishedReleasesByAgentIds(["agent-1", "missing", "agent-1"]))
      .toEqual([release]);
    expect(await repo.getOwnedPublishedReleaseByPublicationKey(
      "owner-a", product.id, releaseInput.publicationKey,
    )).toEqual(release);
    await expect(repo.createRelease({ ...releaseInput, packVersionId: "other-pack" }))
      .rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    const insertHistory = db.prepare(`INSERT INTO resource_releases
      (id,owner_id,resource_product_id,pack_version_id,semantic_hash,publication_key,
        publication_request_hash,graph_semantic_hash,graph_full_hash,price_usdc,
        execution_access,discovery_access,agent_id,flow_id,flow_version_id,deployment_id,
        environment_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertHistoryDeployment = db.prepare(`INSERT INTO deployments
      (id,flow_id,flow_version_id,environment_id,status,created_at,retired_at)
      VALUES (?,?,?,?,?,?,?)`);
    for (let index = 0; index < 24; index += 1) {
      const createdAt = NOW.getTime() - (index + 1) * 60_000;
      insertHistoryDeployment.run(
        `history-deployment-${index}`, release.flowId, release.flowVersionId,
        release.environmentId, "retired", createdAt, createdAt + 30_000,
      );
      insertHistory.run(
        `history-${index}`, release.ownerId, release.resourceProductId,
        release.packVersionId, release.semanticHash, `history-publication-${index}`,
        release.publicationRequestHash, release.graphSemanticHash, release.graphFullHash,
        release.priceUsdc, release.executionAccess, release.discoveryAccess,
        release.agentId, release.flowId, release.flowVersionId, `history-deployment-${index}`,
        release.environmentId, new Date(createdAt).toISOString(),
      );
    }
    const releaseHistory = await repo.listOwnedReleaseHistory("owner-a", product.id, 20);
    expect(releaseHistory).toHaveLength(20);
    expect(releaseHistory[0]).toMatchObject({
      id: release.id, resourceProductId: product.id, packVersionId: approved.id,
      semanticHash: approved.semanticHash, executionAccess: "paid",
      discoveryAccess: "public", freshness: "fresh",
    });
    expect(releaseHistory[19]?.id).toBe("history-18");
    expect(releaseHistory[0]).toMatchObject({
      agentStatus: "live", deploymentStatus: "live", deploymentRetiredAt: null,
    });
    expect(releaseHistory[1]).toMatchObject({
      id: "history-0", deploymentStatus: "retired",
      deploymentRetiredAt: new Date(NOW.getTime() - 30_000).toISOString(),
    });
    expect(JSON.stringify(releaseHistory)).not.toMatch(/content|sourceSnapshotIds|source body/iu);
    await expect(repo.listOwnedReleaseHistory("owner-b", product.id, 20)).resolves.toEqual([]);
    await expect(repo.listOwnedReleaseHistory("owner-a", "missing", 20)).resolves.toEqual([]);

    const receiptInput = {
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: approved.id, runId: "run-1",
      agentId: "agent-1", paymentId: "payment-1", paymentState: "settled" as const, priceUsdc: releaseInput.priceUsdc,
      flowVersionId: "flow-version-1", deploymentId: "deployment-1",
      receipt: {
        resourceProductId: product.id,
        resourceVersion: approved.id,
        semanticHash: approved.semanticHash,
        freshness: "fresh" as const,
        evidence: resourcePack().evidence,
        unknowns: [], conflicts: [], outputSchemaValid: true,
      },
    };
    const receipt = await repo.recordRunReceipt(receiptInput);
    expect(await repo.recordRunReceipt({
      ...receiptInput,
      receipt: {
        ...receiptInput.receipt,
        evidence: receiptInput.receipt.evidence.map((item) => ({
          observedAt: item.observedAt,
          locator: item.locator,
          sourceSnapshotId: item.sourceSnapshotId,
          id: item.id,
        })),
      },
    })).toEqual(receipt);
    expect(await repo.listRunReceipts("owner-a", product.id)).toEqual([receipt]);
    expect(await repo.listRunReceipts("owner-b", product.id)).toEqual([]);
    const [summary] = await repo.listOwnedProducts("owner-a");
    expect(summary).toMatchObject({
      portfolioFreshness: "fresh",
      portfolioPayments: {
        attempted: null, free: 0, challenged: null, executed: 1,
        credited: { count: 0, amountUsdc: 0 },
        settled: { count: 1, amountUsdc: 0.05 },
        refunded: { count: null, amountUsdc: null },
        failed: null,
      },
      currentRelease: {
        id: release.id, resourceProductId: product.id,
        packVersionId: approved.id, semanticHash: approved.semanticHash,
        priceUsdc: 0.05, executionAccess: "paid", discoveryAccess: "public",
        freshness: "fresh", payoutReady: false, settlementState: "off",
        agentId: "agent-1", agentStatus: "live", flowVersionId: "flow-version-1",
        deploymentId: "deployment-1", deploymentStatus: "live", deploymentRetiredAt: null,
        urls: {
          run: "/api/agents/slug-deployment-1/run",
          card: "/api/agents/slug-deployment-1/.well-known/agent-card.json",
          x402: "/api/agents/slug-deployment-1/.well-known/x402",
          a2a: "/api/agents/slug-deployment-1/a2a",
          public: "/a/slug-deployment-1",
        },
      },
    });

    await expect(repo.updateOwnedDraft({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedStatus: "live", status: "paused",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    const lifecycle = repo as ResourceRepository & {
      transitionReleaseLifecycle(input: {
        readonly ownerId: string;
        readonly resourceProductId: string;
        readonly action: "pause" | "resume" | "retire";
        readonly expectedStatus: "live" | "paused";
        readonly releaseId: string;
        readonly agentId: string;
        readonly deploymentId: string;
      }): Promise<{ readonly product: { readonly status: string } }>;
    };
    const pins = {
      ownerId: "owner-a", resourceProductId: product.id,
      releaseId: release.id, agentId: release.agentId, deploymentId: release.deploymentId,
    } as const;
    await expect(lifecycle.transitionReleaseLifecycle({
      ...pins, releaseId: "stale-release", action: "pause", expectedStatus: "live",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    db.exec(`CREATE TRIGGER fail_resource_lifecycle_agent
      BEFORE UPDATE OF status ON agents
      WHEN OLD.id='agent-1' AND NEW.status='draft'
      BEGIN SELECT RAISE(ABORT, 'forced lifecycle rollback'); END`);
    await expect(lifecycle.transitionReleaseLifecycle({
      ...pins, action: "pause", expectedStatus: "live",
    })).rejects.toThrow("forced lifecycle rollback");
    expect(db.prepare("SELECT status FROM resource_products WHERE id=?").get(product.id)).toEqual({ status: "live" });
    expect(db.prepare("SELECT status FROM agents WHERE id=?").get(release.agentId)).toEqual({ status: "live" });
    expect(db.prepare("SELECT status,retired_at FROM deployments WHERE id=?").get(release.deploymentId))
      .toEqual({ status: "live", retired_at: null });
    db.exec("DROP TRIGGER fail_resource_lifecycle_agent");

    const paused = await lifecycle.transitionReleaseLifecycle({
      ...pins, action: "pause", expectedStatus: "live",
    });
    expect(paused.product.status).toBe("paused");
    expect(db.prepare("SELECT status FROM agents WHERE id=?").get(release.agentId)).toEqual({ status: "draft" });
    expect(db.prepare("SELECT status,retired_at FROM deployments WHERE id=?").get(release.deploymentId))
      .toEqual({ status: "retired", retired_at: NOW.getTime() });
    expect(await repo.getPublishedReleaseByAgent(release.agentId)).toBeNull();
    expect(await repo.listPublishedReleasesByAgentIds([release.agentId])).toEqual([]);
    expect(await repo.getOwnedPublishedReleaseByPublicationKey(
      "owner-a", product.id, release.publicationKey,
    )).toEqual(release);
    const pausedHistory = await repo.listOwnedReleaseHistory("owner-a", product.id, 20);
    expect(pausedHistory).toHaveLength(20);
    expect(pausedHistory[0]).toMatchObject({
      id: release.id, agentStatus: "draft", deploymentStatus: "retired",
      deploymentRetiredAt: NOW.toISOString(),
    });

    db.prepare("INSERT INTO deployments(id,flow_id,flow_version_id,environment_id,status,created_at,retired_at) VALUES(?,?,?,?,?,?,NULL)")
      .run("deployment-competing", release.flowId, release.flowVersionId, release.environmentId, "live", NOW.getTime());
    await expect(lifecycle.transitionReleaseLifecycle({
      ...pins, action: "resume", expectedStatus: "paused",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    expect(db.prepare("SELECT status FROM resource_products WHERE id=?").get(product.id)).toEqual({ status: "paused" });
    expect(db.prepare("SELECT status FROM agents WHERE id=?").get(release.agentId)).toEqual({ status: "draft" });
    expect(db.prepare("SELECT status,retired_at FROM deployments WHERE id=?").get(release.deploymentId))
      .toEqual({ status: "retired", retired_at: NOW.getTime() });
    db.prepare("DELETE FROM deployments WHERE id=?").run("deployment-competing");

    const resumed = await lifecycle.transitionReleaseLifecycle({
      ...pins, action: "resume", expectedStatus: "paused",
    });
    expect(resumed.product.status).toBe("live");
    expect(db.prepare("SELECT status FROM agents WHERE id=?").get(release.agentId)).toEqual({ status: "live" });
    expect(db.prepare("SELECT status,retired_at FROM deployments WHERE id=?").get(release.deploymentId))
      .toEqual({ status: "live", retired_at: null });
    expect(await repo.getPublishedReleaseByAgent(release.agentId)).toEqual(release);

    await lifecycle.transitionReleaseLifecycle({ ...pins, action: "pause", expectedStatus: "live" });
    const retired = await lifecycle.transitionReleaseLifecycle({
      ...pins, action: "retire", expectedStatus: "paused",
    });
    expect(retired.product.status).toBe("retired");
    expect(db.prepare("SELECT status FROM resource_pack_versions WHERE id=?").get(release.packVersionId))
      .toEqual({ status: "retired" });
    expect(await repo.getPublishedReleaseByAgent(release.agentId)).toBeNull();
    expect(await repo.getOwnedPublishedReleaseByPublicationKey(
      "owner-a", product.id, release.publicationKey,
    )).toEqual(release);
    expect(await repo.listRunReceipts("owner-a", product.id)).toEqual([receipt]);
    await expect(lifecycle.transitionReleaseLifecycle({
      ...pins, action: "resume", expectedStatus: "paused",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    await expect(repo.updateOwnedDraft({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedStatus: "retired", status: "live",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    db.prepare("DELETE FROM deployments WHERE id=?").run("history-deployment-0");
    await expect(repo.listOwnedReleaseHistory("owner-a", product.id, 20))
      .rejects.toBeInstanceOf(ResourcePersistenceError);
  });

  it("rolls back the entire final boundary when the immutable resource pin is not exact", async () => {
    const { product } = await seedProduct(repo);
    const candidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner-a",
    });
    const approved = await repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "owner-a",
    });
    const releaseInput = {
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      agentId: "agent-rollback", flowId: "flow-rollback", flowVersionId: "version-rollback",
      deploymentId: "deployment-rollback", environmentId: "environment-rollback",
      ...publicationFields("deployment-rollback"),
    } as const;
    seedPublicationIdentity(db, releaseInput);
    db.prepare("UPDATE dependency_pins SET content_hash=? WHERE flow_version_id=?")
      .run("f".repeat(64), releaseInput.flowVersionId);

    await expect(repo.createRelease(releaseInput)).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM resource_products WHERE id=?").get(product.id)).toEqual({ status: "test" });
    expect(db.prepare("SELECT status FROM resource_pack_versions WHERE id=?").get(approved.id)).toEqual({ status: "approved" });
    expect(db.prepare("SELECT status FROM agents WHERE id=?").get(releaseInput.agentId)).toEqual({ status: "draft" });
  });

  it("atomically verifies exact graph hashes, price, and access before the Live flip", async () => {
    const { product } = await seedProduct(repo);
    const candidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner-a",
    });
    const approved = await repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "owner-a",
    });
    const releaseInput = {
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      agentId: "agent-exact", flowId: "flow-exact", flowVersionId: "version-exact",
      deploymentId: "deployment-exact", environmentId: "environment-exact",
      ...publicationFields("deployment-exact"),
    } as const;
    seedPublicationIdentity(db, releaseInput);

    db.prepare("UPDATE flow_versions SET full_hash=? WHERE id=?")
      .run("f".repeat(64), releaseInput.flowVersionId);
    await expect(repo.createRelease(releaseInput)).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    db.prepare("UPDATE flow_versions SET full_hash=? WHERE id=?")
      .run(releaseInput.graphFullHash, releaseInput.flowVersionId);

    db.prepare("UPDATE agents SET price_usdc=? WHERE id=?").run(0.06, releaseInput.agentId);
    await expect(repo.createRelease(releaseInput)).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    db.prepare("UPDATE agents SET price_usdc=? WHERE id=?").run(releaseInput.priceUsdc, releaseInput.agentId);

    db.prepare("UPDATE resource_products SET discovery_access='unlisted' WHERE id=?").run(product.id);
    await expect(repo.createRelease(releaseInput)).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM resource_pack_versions WHERE id=?").get(approved.id))
      .toEqual({ status: "approved" });
    expect(db.prepare("SELECT status FROM agents WHERE id=?").get(releaseInput.agentId))
      .toEqual({ status: "draft" });
  });

  it("makes concurrent exact release and receipt replays idempotent and conflicting replays fail", async () => {
    const { product } = await seedProduct(repo);
    const candidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner-a",
    });
    const approved = await repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: candidate.revision,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "owner-a",
    });
    const releaseInput = {
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      agentId: "agent-concurrent", flowId: "flow-concurrent", flowVersionId: "version-concurrent",
      deploymentId: "deployment-concurrent", environmentId: "environment-concurrent",
      ...publicationFields("deployment-concurrent"),
    } as const;
    seedPublicationIdentity(db, releaseInput);
    const [firstRelease, secondRelease] = await Promise.all([
      repo.createRelease(releaseInput), repo.createRelease(releaseInput),
    ]);
    expect(secondRelease).toEqual(firstRelease);
    await expect(repo.createRelease({ ...releaseInput, flowVersionId: "conflicting-version" }))
      .rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    const receiptInput = {
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: approved.id, runId: "run-concurrent",
      agentId: "agent-concurrent", paymentId: "payment-concurrent", paymentState: "settled" as const, priceUsdc: releaseInput.priceUsdc,
      flowVersionId: "version-concurrent", deploymentId: "deployment-concurrent",
      receipt: {
        resourceProductId: product.id, resourceVersion: approved.id,
        semanticHash: approved.semanticHash, freshness: "fresh" as const,
        evidence: resourcePack().evidence, unknowns: [], conflicts: [], outputSchemaValid: true,
      },
    };
    const [firstReceipt, secondReceipt] = await Promise.all([
      repo.recordRunReceipt(receiptInput), repo.recordRunReceipt(receiptInput),
    ]);
    expect(secondReceipt).toEqual(firstReceipt);
    await expect(repo.recordRunReceipt({
      ...receiptInput,
      receipt: { ...receiptInput.receipt, freshness: "stale" },
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) count FROM resource_run_receipts").get()).toEqual({ count: 1 });
  });

  it("keeps retirement terminal for mutable fields, candidates, approval, and releases", async () => {
    const { product } = await seedProduct(repo);
    const firstCandidate = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner-a",
    });
    const approved = await repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: firstCandidate.id, expectedRevision: firstCandidate.revision,
      expectedSemanticHash: firstCandidate.semanticHash, approvedBy: "owner-a",
    });
    const pending = await repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: approved.revision,
      content: resourcePack("Pending"), createdBy: "owner-a",
    });
    await repo.updateOwnedDraft({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedStatus: "test", status: "retired",
    });

    await expect(repo.updateOwnedDraft({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedStatus: "retired", name: "Changed",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    await expect(repo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: pending.id, expectedRevision: pending.revision,
      content: resourcePack("Replacement"), createdBy: "owner-a",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    await expect(repo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: pending.id, expectedRevision: pending.revision,
      expectedSemanticHash: pending.semanticHash, approvedBy: "owner-a",
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    await expect(repo.createRelease({
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      agentId: "agent-retired", flowId: "flow-retired", flowVersionId: "version-retired",
      deploymentId: "deployment-retired", environmentId: "environment-retired",
      ...publicationFields("deployment-retired"),
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    expect(await repo.getOwnedProduct("owner-a", product.id)).toMatchObject({
      name: product.name, status: "retired",
    });
    expect(db.prepare("SELECT id,status FROM resource_pack_versions ORDER BY revision").all())
      .toEqual([{ id: approved.id, status: "approved" }, { id: pending.id, status: "candidate" }]);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
  });

  it("adopts the product and every dependent row atomically and idempotently", async () => {
    const { product } = await seedProduct(repo, "anonymous-owner");
    const candidate = await repo.replaceCandidate({
      ownerId: "anonymous-owner", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "anonymous-owner",
    });
    const approved = await repo.approveCandidate({
      ownerId: "anonymous-owner", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "anonymous-owner",
    });
    const releaseInput = {
      ownerId: "anonymous-owner", resourceProductId: product.id,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      agentId: "agent-adopt", flowId: "flow-adopt", flowVersionId: "version-adopt",
      deploymentId: "deployment-adopt", environmentId: "environment-adopt",
      ...publicationFields("deployment-adopt"),
    } as const;
    seedPublicationIdentity(db, releaseInput);
    await repo.createRelease(releaseInput);
    await repo.recordRunReceipt({
      ownerId: "anonymous-owner", resourceProductId: product.id,
      packVersionId: approved.id, runId: "run-adopt",
      agentId: "agent-adopt", paymentId: "payment-adopt", paymentState: "settled", priceUsdc: releaseInput.priceUsdc,
      flowVersionId: "version-adopt", deploymentId: "deployment-adopt",
      receipt: {
        resourceProductId: product.id, resourceVersion: approved.id,
        semanticHash: approved.semanticHash, freshness: "fresh",
        evidence: resourcePack().evidence, unknowns: [], conflicts: [], outputSchemaValid: true,
      },
    });

    await repo.adoptOwner("anonymous-owner", "sb:user");
    await repo.adoptOwner("anonymous-owner", "sb:user");
    expect(await repo.getOwnedProduct("anonymous-owner", product.id)).toBeNull();
    expect(await repo.getOwnedProduct("sb:user", product.id)).toMatchObject({ ownerId: "sb:user" });
    expect(await repo.listRunReceipts("sb:user", product.id)).toHaveLength(1);
    expect(await repo.getPublishedReleaseByAgent("agent-adopt"))
      .toMatchObject({ ownerId: "sb:user", resourceProductId: product.id });
    expect(db.prepare("SELECT owner_id FROM resource_releases").all())
      .toEqual([{ owner_id: "sb:user" }]);
    expect(db.prepare("SELECT owner_id FROM resource_run_receipts").all())
      .toEqual([{ owner_id: "sb:user" }]);
  });
});
