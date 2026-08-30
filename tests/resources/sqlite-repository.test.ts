import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { resourcePack } from "./fixture";

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map(({ name }) => name);
}

describe("SQLite ResourceRepository and migrations v43-v45", () => {
  it("creates every indexed resource table on a blank database", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      "resource_products", "resource_source_assets", "resource_source_snapshots",
      "resource_pack_versions", "resource_records", "resource_evidence_refs",
      "resource_releases", "resource_run_receipts",
    ]));
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version=43").get())
      .toEqual({ version: 43, name: "agent-resource-foundry" });
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version=44").get())
      .toEqual({ version: 44, name: "resource-release-publication-contract" });
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version=45").get())
      .toEqual({ version: 45, name: "resource-run-receipt-payment-facts" });
    expect((db.prepare("PRAGMA index_list(resource_products)").all() as Array<{ name: string }>)
      .map(({ name }) => name)).toContain("idx_resource_products_owner_status");
    db.close();
  });

  it("upgrades an exact v42 prefix and is idempotent", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    for (const table of [
      "resource_run_receipts", "resource_releases", "resource_evidence_refs", "resource_records",
      "resource_pack_versions", "resource_source_snapshots", "resource_source_assets", "resource_products",
    ]) db.exec(`DROP TABLE ${table}`);
    db.prepare("DELETE FROM schema_migrations WHERE version>=43").run();

    runSqliteMigrations(db);
    runSqliteMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=43").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=44").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=45").get())
      .toEqual({ count: 1 });
    expect(tableNames(db)).toContain("resource_products");
    db.close();
  });

  it("fails closed on a drifted unledgered v43 table", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    for (const table of [
      "resource_run_receipts", "resource_releases", "resource_evidence_refs", "resource_records",
      "resource_pack_versions", "resource_source_snapshots", "resource_source_assets", "resource_products",
    ]) db.exec(`DROP TABLE ${table}`);
    db.prepare("DELETE FROM schema_migrations WHERE version>=43").run();
    db.exec("CREATE TABLE resource_products (id TEXT PRIMARY KEY)");

    expect(() => runSqliteMigrations(db)).toThrow(/resource_products.*definition mismatch/i);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=43").get()).toBeUndefined();
    db.close();
  });

  it("fails closed when a committed v43 immutable trigger drifts", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec(`DROP TRIGGER resource_run_receipts_no_delete;
      CREATE TRIGGER resource_run_receipts_no_delete BEFORE DELETE ON resource_run_receipts
      BEGIN SELECT 1; END`);
    expect(() => runSqliteMigrations(db)).toThrow(/resource.*trigger.*definition mismatch/i);
    db.close();
  });

  it("fails closed when the v44 publication-key or access immutability guard drifts", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec(`DROP TRIGGER resource_releases_no_update;
      CREATE TRIGGER resource_releases_no_update BEFORE UPDATE ON resource_releases
      BEGIN SELECT 1; END`);
    expect(() => runSqliteMigrations(db)).toThrow(/resource release publication trigger mismatch/i);
    db.close();
  });

  it("enforces internal foreign keys and immutable snapshot/approved content guards", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteResourceRepository(db, { now: () => new Date("2026-08-13T12:00:00.000Z") });
    const product = await repo.createProduct({
      ownerId: "owner", name: "Resource", slug: "resource",
      executionAccess: "private", discoveryAccess: "unlisted",
    });
    await repo.createSourceSnapshot({
      id: "snapshot-contract", ownerId: "owner", resourceProductId: product.id,
      locator: "manual://one", sourceKind: "manual",
      capturedAt: "2026-08-13T12:00:00.000Z", contentHash: "a".repeat(64),
      freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const candidate = await repo.replaceCandidate({
      ownerId: "owner", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner",
    });
    await repo.approveCandidate({
      ownerId: "owner", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "owner",
    });

    expect(() => db.prepare(
      "INSERT INTO resource_records (pack_version_id,id,fields_json,tags_json,evidence_ids_json) VALUES ('missing','r','{}','[]','[]')",
    ).run()).toThrow(/foreign key/i);
    expect(() => db.prepare(
      "UPDATE resource_source_snapshots SET locator='changed' WHERE id='snapshot-contract'",
    ).run()).toThrow(/append-only/i);
    expect(() => db.prepare(
      "UPDATE resource_pack_versions SET content_json='{}' WHERE id=?",
    ).run(candidate.id)).toThrow(/immutable/i);
    expect(() => db.prepare(
      "UPDATE resource_pack_versions SET status='candidate' WHERE id=?",
    ).run(candidate.id)).toThrow(/immutable|append-only/i);
    expect(() => db.prepare(
      "UPDATE resource_records SET fields_json='{}' WHERE pack_version_id=? AND id='record-1'",
    ).run(candidate.id)).toThrow(/immutable|append-only/i);
    expect(() => db.prepare(
      "DELETE FROM resource_evidence_refs WHERE pack_version_id=? AND id='evidence-1'",
    ).run(candidate.id)).toThrow(/immutable|append-only/i);
    const otherProduct = await repo.createProduct({
      ownerId: "owner", name: "Other", slug: "other",
      executionAccess: "private", discoveryAccess: "unlisted",
    });
    expect(() => db.prepare(`INSERT INTO resource_run_receipts
      (id,owner_id,resource_product_id,pack_version_id,agent_id,run_id,flow_version_id,deployment_id,payment_id,payment_state,price_usdc,semantic_hash,freshness,evidence_json,unknowns_json,conflicts_json,output_schema_valid,created_at)
      VALUES ('receipt-cross-product','owner',?,?,'agent','run-cross-product','flow','deployment',NULL,'free',0,?,'fresh','[]','[]','[]',1,'2026-08-13T12:00:00.000Z')`)
      .run(otherProduct.id, candidate.id, candidate.semanticHash)).toThrow(/foreign key/i);
    expect(() => db.prepare(`INSERT INTO resource_releases
      (id,owner_id,resource_product_id,pack_version_id,semantic_hash,publication_key,publication_request_hash,
        graph_semantic_hash,graph_full_hash,price_usdc,execution_access,discovery_access,agent_id,flow_id,
        flow_version_id,deployment_id,environment_id,created_at)
      VALUES ('release-cross-product','owner',?,?,?,'publication-cross-product',?,?,?,0,'private','unlisted',
        'agent','flow','version','deployment-cross-product','environment','2026-08-13T12:00:00.000Z')`)
      .run(otherProduct.id, candidate.id, candidate.semanticHash, "d".repeat(64), "b".repeat(64), "c".repeat(64)))
      .toThrow(/foreign key/i);
    db.close();
  });

  it("recomputes hashes on readback and fails visibly on persisted drift", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteResourceRepository(db, { now: () => new Date("2026-08-13T12:00:00.000Z") });
    const product = await repo.createProduct({
      ownerId: "owner", name: "Resource", slug: "resource",
      executionAccess: "private", discoveryAccess: "unlisted",
    });
    await repo.createSourceSnapshot({
      id: "snapshot-contract", ownerId: "owner", resourceProductId: product.id,
      locator: "manual://one", sourceKind: "manual",
      capturedAt: "2026-08-13T12:00:00.000Z", contentHash: "a".repeat(64),
      freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const candidate = await repo.replaceCandidate({
      ownerId: "owner", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner",
    });
    // Candidate rows are replaceable, so the DB permits this corruption; readback must not.
    db.prepare("UPDATE resource_pack_versions SET semantic_hash=? WHERE id=?")
      .run("f".repeat(64), candidate.id);
    await expect(repo.getOwnedPack({
      ownerId: "owner", resourceProductId: product.id,
      packVersionId: candidate.id, semanticHash: "f".repeat(64),
    })).rejects.toThrow("Resource persistence integrity check failed");
    db.close();
  });
});
