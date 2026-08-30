import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { ResourceRepository } from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { resourcePack, RESOURCE_TEST_NOW } from "./resources/fixture";

const control = vi.hoisted(() => ({
  ownerId: "records-owner",
  repository: null as ResourceRepository | null,
  db: null as Database.Database | null,
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  resolveOwnerId: async () => control.ownerId,
  resolveReadOnlyOwnerId: async () => control.ownerId,
}));
vi.mock("@/lib/resources/provider", () => ({ getResourceRepository: async () => control.repository }));
vi.mock("@/lib/resources/flags", () => ({ RESOURCE_FOUNDRY_ENABLED: true }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()), checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
}));

function context(resourceId: string) { return { params: Promise.resolve({ resourceId }) }; }
function json(method: string, path: string, body: unknown): Request {
  return new Request(`https://agents.suedeai.ai${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
async function seed(): Promise<{ productId: string }> {
  const product = await control.repository!.createProduct({
    ownerId: control.ownerId, name: "Records", slug: "records",
    executionAccess: "paid", discoveryAccess: "unlisted",
  });
  await control.repository!.createSourceSnapshot({
    id: "snapshot-contract", ownerId: control.ownerId, resourceProductId: product.id,
    locator: "manual://records", sourceKind: "json_rows", capturedAt: RESOURCE_TEST_NOW.toISOString(),
    contentHash: "a".repeat(64), freshnessDeadline: "2026-08-20T12:00:00.000Z",
  });
  return { productId: product.id };
}

beforeEach(() => {
  control.ownerId = "records-owner";
  control.db = new Database(":memory:");
  runSqliteMigrations(control.db);
  control.repository = new SqliteResourceRepository(control.db, { now: () => RESOURCE_TEST_NOW });
});

afterEach(() => control.db?.close());

function seedPublicationIdentity(productId: string, packVersionId: string, semanticHash: string): void {
  const db = control.db!;
  db.prepare("INSERT INTO flows(id,owner_id,name,graph,updated_at) VALUES(?,?,?,?,?)")
    .run("flow-live", control.ownerId, "Resource", "{}", RESOURCE_TEST_NOW.getTime());
  db.prepare("INSERT INTO agents(id,flow_id,slug,status,price_usdc,created_at,settlement_live) VALUES(?,?,?,?,?,?,0)")
    .run("agent-live", "flow-live", "resource-live", "draft", 0.05, RESOURCE_TEST_NOW.getTime());
  db.prepare("INSERT INTO organizations(id,personal_owner_id,name,kind,created_at) VALUES(?,?,?,?,?)")
    .run("org-live", control.ownerId, "Personal", "personal", RESOURCE_TEST_NOW.getTime());
  db.prepare("INSERT INTO workspaces(id,organization_id,name,slug,created_at) VALUES(?,?,?,?,?)")
    .run("workspace-live", "org-live", "Personal", "workspace-live", RESOURCE_TEST_NOW.getTime());
  db.prepare("INSERT INTO projects(id,workspace_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("project-live", "workspace-live", "Project", "project-live", RESOURCE_TEST_NOW.getTime(), RESOURCE_TEST_NOW.getTime());
  db.prepare("INSERT INTO environments(id,project_id,name,slug,kind,created_at) VALUES(?,?,?,?,?,?)")
    .run("environment-live", "project-live", "Live", "live", "live", RESOURCE_TEST_NOW.getTime());
  db.prepare(`INSERT INTO flow_versions(id,flow_id,version_number,schema_version,graph,semantic_hash,full_hash,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("flow-version-live", "flow-live", 1, 1, "{}", "b".repeat(64), "c".repeat(64), control.ownerId, RESOURCE_TEST_NOW.getTime());
  db.prepare("INSERT INTO dependency_pins(id,flow_version_id,kind,resource_id,version,content_hash,created_at) VALUES(?,?,?,?,?,?,?)")
    .run("pin-live", "flow-version-live", "resource", productId, packVersionId, semanticHash, RESOURCE_TEST_NOW.getTime());
  db.prepare("INSERT INTO deployments(id,flow_id,flow_version_id,environment_id,status,created_at,retired_at) VALUES(?,?,?,?,?,?,NULL)")
    .run("deployment-live", "flow-live", "flow-version-live", "environment-live", "live", RESOURCE_TEST_NOW.getTime());
}

describe("candidate records, approval, and refresh", () => {
  it("replaces only the optimistic current candidate and deletes no immutable snapshot", async () => {
    const route = await import("@/app/api/v2/resources/[resourceId]/records/route");
    const { productId } = await seed();
    const first = await route.POST(json("POST", `/api/v2/resources/${productId}/records`, {
      expectedCandidatePackVersionId: null, expectedRevision: 0, content: resourcePack(),
    }), context(productId));
    expect(first.status).toBe(201);
    const candidate = (await first.json() as { candidate: { id: string; revision: number; semanticHash: string } }).candidate;
    const changedContent = resourcePack("Beta");
    const second = await route.POST(json("POST", `/api/v2/resources/${productId}/records`, {
      expectedCandidatePackVersionId: candidate.id,
      expectedRevision: candidate.revision,
      content: changedContent,
    }), context(productId));
    expect(second.status).toBe(201);
    const replacement = (await second.json() as { candidate: { id: string; revision: number } }).candidate;
    expect(replacement).toMatchObject({ revision: 2 });
    expect(replacement.id).not.toBe(candidate.id);
    expect(await control.repository!.getOwnedPack({
      ownerId: control.ownerId, resourceProductId: productId,
      packVersionId: candidate.id, semanticHash: candidate.semanticHash,
    })).toBeNull();
  });

  it("approves the exact candidate and refuses mutation of the approved pack", async () => {
    const records = await import("@/app/api/v2/resources/[resourceId]/records/route");
    const packs = await import("@/app/api/v2/resources/[resourceId]/packs/route");
    const { productId } = await seed();
    const candidateResponse = await records.POST(json("POST", `/api/v2/resources/${productId}/records`, {
      expectedCandidatePackVersionId: null, expectedRevision: 0, content: resourcePack(),
    }), context(productId));
    const candidate = (await candidateResponse.json() as { candidate: { id: string; revision: number; semanticHash: string } }).candidate;
    const approvedResponse = await packs.POST(json("POST", `/api/v2/resources/${productId}/packs`, {
      candidatePackVersionId: candidate.id,
      expectedRevision: candidate.revision,
      expectedSemanticHash: candidate.semanticHash,
    }), context(productId));
    expect(approvedResponse.status).toBe(200);
    await expect(approvedResponse.json()).resolves.toMatchObject({ pack: { id: candidate.id, status: "approved" } });

    const mutation = await records.POST(json("POST", `/api/v2/resources/${productId}/records`, {
      expectedCandidatePackVersionId: candidate.id,
      expectedRevision: candidate.revision,
      content: resourcePack("Mutated"),
    }), context(productId));
    expect(mutation.status).toBe(409);
    await expect(mutation.json()).resolves.toEqual({ error: "resource conflict" });

    const exact = await packs.GET(new Request(
      `https://agents.suedeai.ai/api/v2/resources/${productId}/packs?packVersionId=${candidate.id}&semanticHash=${candidate.semanticHash}`,
    ), context(productId));
    await expect(exact.json()).resolves.toMatchObject({ pack: { packVersionId: candidate.id, content: resourcePack() } });
  });

  it("refreshes a Live product into a diff candidate without changing the Live pack", async () => {
    const records = await import("@/app/api/v2/resources/[resourceId]/records/route");
    const packs = await import("@/app/api/v2/resources/[resourceId]/packs/route");
    const refresh = await import("@/app/api/v2/resources/[resourceId]/refresh/route");
    const { productId } = await seed();
    const candidateResponse = await records.POST(json("POST", `/api/v2/resources/${productId}/records`, {
      expectedCandidatePackVersionId: null, expectedRevision: 0, content: resourcePack(),
    }), context(productId));
    const candidate = (await candidateResponse.json() as { candidate: { id: string; revision: number; semanticHash: string } }).candidate;
    const approvedResponse = await packs.POST(json("POST", `/api/v2/resources/${productId}/packs`, {
      candidatePackVersionId: candidate.id, expectedRevision: 1, expectedSemanticHash: candidate.semanticHash,
    }), context(productId));
    const approved = (await approvedResponse.json() as { pack: { id: string; semanticHash: string } }).pack;
    seedPublicationIdentity(productId, approved.id, approved.semanticHash);
    await control.repository!.createRelease({
      ownerId: control.ownerId, resourceProductId: productId,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
      agentId: "agent-live", flowId: "flow-live", flowVersionId: "flow-version-live",
      deploymentId: "deployment-live", environmentId: "environment-live",
      publicationKey: "publication-live", publicationRequestHash: "d".repeat(64),
      graphSemanticHash: "b".repeat(64), graphFullHash: "c".repeat(64),
      priceUsdc: 0.05, executionAccess: "paid", discoveryAccess: "unlisted",
    });

    const response = await refresh.POST(json("POST", `/api/v2/resources/${productId}/refresh`, {
      base: { packVersionId: approved.id, semanticHash: approved.semanticHash },
      expectedCandidatePackVersionId: null,
      expectedRevision: 1,
      content: resourcePack("Refreshed"),
    }), context(productId));
    expect(response.status).toBe(201);
    const payload = await response.json() as {
      candidate: { status: string; revision: number };
      diff: { changedRecordIds: string[] };
    };
    expect(payload.candidate).toMatchObject({ status: "candidate", revision: 2 });
    expect(payload.diff.changedRecordIds).toEqual(["record-1"]);
    const portfolio = (await control.repository!.listOwnedProducts(control.ownerId))[0]!;
    expect(portfolio).toMatchObject({ status: "live", livePackVersionId: approved.id, candidateRevision: 2 });
    expect(await control.repository!.getOwnedPack({
      ownerId: control.ownerId, resourceProductId: productId,
      packVersionId: approved.id, semanticHash: approved.semanticHash,
    })).not.toBeNull();
  });

  it("keeps pack reads opaque across foreign and missing identities", async () => {
    const packs = await import("@/app/api/v2/resources/[resourceId]/packs/route");
    const { productId } = await seed();
    control.ownerId = "foreign-records-owner";
    const query = "?packVersionId=missing&semanticHash=" + "f".repeat(64);
    const foreign = await packs.GET(new Request(`https://agents.suedeai.ai/api/v2/resources/${productId}/packs${query}`), context(productId));
    const missing = await packs.GET(new Request(`https://agents.suedeai.ai/api/v2/resources/missing/packs${query}`), context("missing"));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });
});
