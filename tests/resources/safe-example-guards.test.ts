import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { ResourcePublishService } from "@/lib/resources/publish-service";
import { ResourceFoundryService } from "@/lib/resources/service";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { resourcePack } from "./fixture";

const OWNER = "safe-example-owner";

describe("safe public example mutation guards", () => {
  let db: Database.Database;
  let resourceRepo: SqliteResourceRepository;
  let flowRepo: SqliteRepo;
  let projectRepo: SqliteProjectRepo;

  beforeEach(() => {
    db = new Database(":memory:");
    runSqliteMigrations(db);
    resourceRepo = new SqliteResourceRepository(db, {
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
    flowRepo = new SqliteRepo(db);
    projectRepo = new SqliteProjectRepo(db);
  });

  afterEach(() => db.close());

  async function candidate(suffix: string) {
    const content = resourcePack();
    return resourceRepo.createProductWithCandidate({
      ownerId: OWNER,
      name: `Safe example ${suffix}`,
      slug: `safe-example-${suffix}`,
      executionAccess: "free",
      discoveryAccess: "public",
      content: {
        ...content,
        records: content.records.map((record) => ({ ...record, evidenceIds: [] })),
        evidence: [],
        sourceSnapshotIds: [],
      },
      createdBy: OWNER,
    });
  }

  function corruptSafeExample(packVersionId: string): void {
    const row = db.prepare("SELECT content_json FROM resource_pack_versions WHERE id=?")
      .get(packVersionId) as { content_json: string };
    const content = JSON.parse(row.content_json) as { jobContract: { safeExample: unknown } };
    content.jobContract.safeExample = { name: "Invalid object", tier: "paid" };
    db.prepare("UPDATE resource_pack_versions SET content_json=? WHERE id=?")
      .run(JSON.stringify(content), packVersionId);
  }

  it("refuses an invalid legacy candidate before approval mutates its status", async () => {
    const created = await candidate("approval");
    corruptSafeExample(created.candidate.id);

    await expect(new ResourceFoundryService(resourceRepo).approveCandidate(OWNER, created.product.id, {
      candidatePackVersionId: created.candidate.id,
      expectedRevision: created.candidate.revision,
      expectedSemanticHash: created.candidate.semanticHash,
    })).rejects.toThrow();

    expect(db.prepare("SELECT status FROM resource_pack_versions WHERE id=?").get(created.candidate.id))
      .toEqual({ status: "candidate" });
  });

  it("refuses an invalid legacy approved pack before publication creates public state", async () => {
    const created = await candidate("publication");
    const approved = await resourceRepo.approveCandidate({
      ownerId: OWNER,
      resourceProductId: created.product.id,
      candidatePackVersionId: created.candidate.id,
      expectedRevision: created.candidate.revision,
      expectedSemanticHash: created.candidate.semanticHash,
      approvedBy: OWNER,
    });
    db.exec("DROP TRIGGER resource_pack_versions_immutable_content");
    corruptSafeExample(approved.id);

    await expect(new ResourcePublishService({ resourceRepo, flowRepo, projectRepo }).publish(
      OWNER,
      created.product.id,
      {
        priceUsdc: 0,
        representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
      },
    )).rejects.toThrow();

    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
    expect(await flowRepo.getFlow(created.product.id)).toBeNull();
    expect(await flowRepo.getAgentByFlowId(created.product.id)).toBeNull();
  });
});
