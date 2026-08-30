import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { resourcePack } from "./resources/fixture";

describe("anonymous owner Resource Foundry adoption", () => {
  it("moves flows, products, releases, and receipts in the existing single atomic transaction", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const workspace = new SqliteRepo(db);
    const resources = new SqliteResourceRepository(db, {
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
    db.prepare("INSERT INTO flows (id,owner_id,name,graph,updated_at) VALUES (?,?,?,?,?)")
      .run("flow-adopt", "anonymous-owner", "Flow", "{}", 1);
    const product = await resources.createProduct({
      ownerId: "anonymous-owner", name: "Resource", slug: "resource",
      executionAccess: "paid", discoveryAccess: "public",
    });
    await resources.createSourceSnapshot({
      id: "snapshot-contract", ownerId: "anonymous-owner", resourceProductId: product.id,
      locator: "manual://one", sourceKind: "manual",
      capturedAt: "2026-08-13T12:00:00.000Z", contentHash: "a".repeat(64),
      freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const candidate = await resources.replaceCandidate({
      ownerId: "anonymous-owner", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "anonymous-owner",
    });
    await resources.approveCandidate({
      ownerId: "anonymous-owner", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "anonymous-owner",
    });
    db.prepare("INSERT INTO agents(id,flow_id,slug,status,price_usdc,created_at,settlement_live) VALUES(?,?,?,?,?,?,0)")
      .run("agent-adopt", "flow-adopt", "resource-adopt", "draft", 0.05, 1);
    db.prepare("INSERT INTO organizations(id,personal_owner_id,name,kind,created_at) VALUES(?,?,?,?,?)")
      .run("org-adopt", "anonymous-owner", "Personal", "personal", 1);
    db.prepare("INSERT INTO workspaces(id,organization_id,name,slug,created_at) VALUES(?,?,?,?,?)")
      .run("workspace-adopt", "org-adopt", "Personal", "workspace-adopt", 1);
    db.prepare("INSERT INTO projects(id,workspace_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("project-adopt", "workspace-adopt", "Project", "project-adopt", 1, 1);
    db.prepare("INSERT INTO environments(id,project_id,name,slug,kind,created_at) VALUES(?,?,?,?,?,?)")
      .run("environment-adopt", "project-adopt", "Live", "live", "live", 1);
    db.prepare(`INSERT INTO flow_versions(id,flow_id,version_number,schema_version,graph,semantic_hash,full_hash,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run("version-adopt", "flow-adopt", 1, 1, "{}", "b".repeat(64), "c".repeat(64), "anonymous-owner", 1);
    db.prepare("INSERT INTO dependency_pins(id,flow_version_id,kind,resource_id,version,content_hash,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("pin-adopt", "version-adopt", "resource", product.id, candidate.id, candidate.semanticHash, 1);
    db.prepare("INSERT INTO deployments(id,flow_id,flow_version_id,environment_id,status,created_at,retired_at) VALUES(?,?,?,?,?,?,NULL)")
      .run("deployment-adopt", "flow-adopt", "version-adopt", "environment-adopt", "live", 1);
    await resources.createRelease({
      ownerId: "anonymous-owner", resourceProductId: product.id,
      packVersionId: candidate.id, semanticHash: candidate.semanticHash,
      agentId: "agent-adopt", flowId: "flow-adopt", flowVersionId: "version-adopt",
      deploymentId: "deployment-adopt", environmentId: "environment-adopt",
      publicationKey: "publication-adopt", publicationRequestHash: "d".repeat(64),
      graphSemanticHash: "b".repeat(64), graphFullHash: "c".repeat(64),
      priceUsdc: 0.05, executionAccess: "paid", discoveryAccess: "public",
    });
    await resources.recordRunReceipt({
      ownerId: "anonymous-owner", resourceProductId: product.id,
      packVersionId: candidate.id, runId: "run-adopt",
      agentId: "agent-adopt", paymentId: "payment-adopt", paymentState: "settled", priceUsdc: 0.05,
      flowVersionId: "version-adopt", deploymentId: "deployment-adopt",
      receipt: {
        resourceProductId: product.id, resourceVersion: candidate.id,
        semanticHash: candidate.semanticHash, freshness: "fresh",
        evidence: resourcePack().evidence, unknowns: [], conflicts: [], outputSchemaValid: true,
      },
    });

    await workspace.adoptOwner("anonymous-owner", "sb:user");
    await workspace.adoptOwner("anonymous-owner", "sb:user");
    expect(db.prepare("SELECT owner_id FROM flows WHERE id='flow-adopt'").get())
      .toEqual({ owner_id: "sb:user" });
    expect(await resources.getOwnedProduct("sb:user", product.id)).toMatchObject({ ownerId: "sb:user" });
    expect(await resources.listRunReceipts("sb:user", product.id)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM resource_releases").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM resource_run_receipts").get()).toEqual({ count: 1 });
    db.close();
  });

  it("rolls back the whole workspace when any resource owner update fails", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const workspace = new SqliteRepo(db);
    const resources = new SqliteResourceRepository(db);
    db.prepare("INSERT INTO flows (id,owner_id,name,graph,updated_at) VALUES (?,?,?,?,?)")
      .run("flow-rollback", "anonymous-owner", "Flow", "{}", 1);
    const product = await resources.createProduct({
      ownerId: "anonymous-owner", name: "Resource", slug: "resource",
      executionAccess: "private", discoveryAccess: "unlisted",
    });
    db.exec(`CREATE TRIGGER force_resource_adoption_failure
      BEFORE UPDATE OF owner_id ON resource_products
      BEGIN SELECT RAISE(ABORT, 'forced resource adoption failure'); END`);

    await expect(workspace.adoptOwner("anonymous-owner", "sb:user"))
      .rejects.toThrow("forced resource adoption failure");
    expect(db.prepare("SELECT owner_id FROM flows WHERE id='flow-rollback'").get())
      .toEqual({ owner_id: "anonymous-owner" });
    expect(await resources.getOwnedProduct("anonymous-owner", product.id)).toBeTruthy();
    expect(await resources.getOwnedProduct("sb:user", product.id)).toBeNull();
    db.close();
  });
});
