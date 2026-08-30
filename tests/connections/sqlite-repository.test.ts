import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteConnectionRepository } from "@/lib/connections/sqlite-repository";
import { ConnectionRepositoryUnavailableError } from "@/lib/connections/repository";
import { scanConnectionReferences } from "@/lib/connections/usage-parser";

const KEY = Buffer.alloc(32, 7);

function fixture(key = KEY): { db: Database.Database; repo: SqliteConnectionRepository } {
  const db = new Database(":memory:");
  runSqliteMigrations(db);
  return { db, repo: new SqliteConnectionRepository(db, key) };
}

function graph(connectionId: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    id: "flow",
    name: "Flow",
    nodes: [{
      id: "node",
      type: "http",
      params: {},
      bindings: connectionId === null ? {} : {
        headers: { kind: "secret", connectionId, field: "headers" },
      },
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    ...extra,
  });
}

async function bearer(repo: SqliteConnectionRepository, owner = "owner-a") {
  return repo.create(owner, { name: "Bearer", kind: "bearer", publicConfig: {} }, 10);
}

describe("SqliteConnectionRepository", () => {
  it("wipes its key, leaves an injected database open, and terminally refuses every operation", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const wipeStates: boolean[] = [];
    const repo = new SqliteConnectionRepository(db, KEY, {
      onKeyWiped: (zeroed) => wipeStates.push(zeroed),
    });

    repo.close();
    expect(wipeStates).toEqual([true]);
    expect(() => repo.close()).not.toThrow();
    expect(() => repo.dispose()).not.toThrow();
    expect(wipeStates).toEqual([true]);
    expect(db.open).toBe(true);
    const unavailable = [
      repo.create("owner", { name: "Name", kind: "bearer", publicConfig: {} }, 1),
      repo.list("owner", { limit: 1 }),
      repo.get("owner", "connection"),
      repo.rename("owner", "connection", 1, "Name", 1),
      repo.configureSlot("owner", "connection", "live", 1, { kind: "bearer", token: "private" }, 1),
      repo.revokeSlot("owner", "connection", "live", 1, 1),
      repo.resolveHeaders("owner", "connection", "live", "headers"),
      repo.usage("owner", "connection", { limit: 1 }),
    ];
    for (const operation of unavailable) {
      await expect(operation).rejects.toBeInstanceOf(ConnectionRepositoryUnavailableError);
      await expect(operation).rejects.toThrow("Connection service unavailable");
    }
    db.close();
  });

  it("retries an owned database close after failure while remaining terminal", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const originalClose = db.close;
    const wipeStates: boolean[] = [];
    Object.defineProperty(db, "close", { configurable: true, value: () => { throw new Error("close-canary"); } });
    const repo = new SqliteConnectionRepository(db, KEY, {
      ownsDatabase: true,
      onKeyWiped: (zeroed) => wipeStates.push(zeroed),
    });

    expect(() => repo.close()).toThrow("Connection service unavailable");
    expect(wipeStates).toEqual([true]);
    await expect(repo.get("owner", "connection")).rejects.toThrow("Connection service unavailable");
    Object.defineProperty(db, "close", { configurable: true, value: originalClose });
    expect(() => repo.dispose()).not.toThrow();
    expect(db.open).toBe(false);
    expect(() => repo.close()).not.toThrow();
    expect(wipeStates).toEqual([true]);
  });

  it("closes an injected database only when explicitly owned", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteConnectionRepository(db, KEY, { ownsDatabase: true });

    repo.dispose();

    expect(db.open).toBe(false);
    expect(() => repo.dispose()).not.toThrow();
  });

  it("creates metadata only and returns exact deeply frozen views", async () => {
    const { db, repo } = fixture();
    const created = await bearer(repo);
    expect(created).toMatchObject({
      name: "Bearer",
      kind: "bearer",
      lifecycleRevision: 1,
      slots: {
        test: { status: "missing", secretVersion: 0 },
        live: { status: "missing", secretVersion: 0 },
      },
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.slots)).toBe(true);
    expect(Object.isFrozen(created.publicConfig)).toBe(true);
    expect(db.prepare("SELECT count(*) count FROM connection_slots").get()).toEqual({ count: 0 });
    expect(JSON.stringify(created)).not.toMatch(/token|ciphertext|nonce|authTag|keyVersion/u);
    expect(await repo.get("owner-b", created.id)).toBeNull();
    expect((await repo.list("owner-a", { limit: 1 })).items).toEqual([created]);
    db.close();
  });

  it("atomically rotates independent slots and rejects same-millisecond stale receipts", async () => {
    const { db, repo } = fixture();
    const created = await bearer(repo);
    const test = await repo.configureSlot("owner-a", created.id, "test", 1, { kind: "bearer", token: "test-private" }, 20);
    expect(test.status).toBe("updated");
    if (test.status !== "updated") throw new Error("expected update");
    expect(test.connection).toMatchObject({ lifecycleRevision: 2, updatedAt: 20 });
    expect(test.connection.slots.test).toMatchObject({ status: "configured", secretVersion: 1 });
    expect(test.connection.slots.live.status).toBe("missing");
    expect(await repo.configureSlot("owner-a", created.id, "live", 1, { kind: "bearer", token: "stale" }, 20))
      .toEqual({ status: "conflict" });

    const before = db.prepare("SELECT hex(ciphertext) ciphertext FROM connection_slots WHERE environment='test'").get();
    const rotated = await repo.configureSlot("owner-a", created.id, "test", 2, { kind: "bearer", token: "new-private" }, 20);
    expect(rotated.status).toBe("updated");
    if (rotated.status !== "updated") throw new Error("expected update");
    expect(rotated.connection).toMatchObject({ lifecycleRevision: 3, updatedAt: 20 });
    expect(rotated.connection.slots.test.secretVersion).toBe(2);
    expect(db.prepare("SELECT count(*) count FROM connection_slots WHERE environment='test'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT hex(ciphertext) ciphertext FROM connection_slots WHERE environment='test'").get()).not.toEqual(before);
    expect(await repo.resolveHeaders("owner-a", created.id, "test", "headers"))
      .toEqual({ Authorization: "Bearer new-private" });
    expect(JSON.stringify([test, rotated])).not.toMatch(/test-private|new-private|ciphertext|nonce|authTag/u);
    db.close();
  });

  it("rolls back ciphertext writes when the lifecycle update fails", async () => {
    const { db, repo } = fixture();
    const created = await bearer(repo);
    db.exec(`CREATE TRIGGER force_connection_failure BEFORE UPDATE ON connections
      BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    await expect(repo.configureSlot("owner-a", created.id, "live", 1, { kind: "bearer", token: "private" }, 20))
      .rejects.toThrow();
    expect(db.prepare("SELECT count(*) count FROM connection_slots").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT lifecycle_revision FROM connections WHERE id=?").get(created.id))
      .toEqual({ lifecycle_revision: 1 });
    db.close();
  });

  it("filters owner, environment, and status before decrypting and nulls revoked material", async () => {
    const { db, repo } = fixture();
    const created = await bearer(repo);
    const configured = await repo.configureSlot("owner-a", created.id, "live", 1, { kind: "bearer", token: "private" }, 20);
    expect(configured.status).toBe("updated");
    const wrongKey = new SqliteConnectionRepository(db, Buffer.alloc(32, 8));
    await expect(wrongKey.resolveHeaders("owner-a", created.id, "live", "headers"))
      .rejects.toThrow("Connection secret unavailable");
    db.prepare("UPDATE connection_slots SET secret_version=secret_version+1, ciphertext=X'00', updated_at=21 WHERE connection_id=?").run(created.id);
    await expect(repo.resolveHeaders("owner-b", created.id, "live", "headers")).resolves.toBeNull();
    await expect(repo.resolveHeaders("owner-a", created.id, "test", "headers")).resolves.toBeNull();
    await expect(repo.resolveHeaders("owner-a", created.id, "live", "headers")).rejects.toThrow("Connection secret unavailable");
    const revoked = await repo.revokeSlot("owner-a", created.id, "live", 2, 30);
    expect(revoked.status).toBe("updated");
    expect(db.prepare(`SELECT status, nonce, ciphertext, auth_tag, key_version, revoked_at
      FROM connection_slots WHERE connection_id=?`).get(created.id)).toEqual({
      status: "revoked", nonce: null, ciphertext: null, auth_tag: null, key_version: null, revoked_at: 30,
    });
    await expect(repo.resolveHeaders("owner-a", created.id, "live", "headers")).resolves.toBeNull();
    db.close();
  });

  it("renames monotonically and paginates owner-scoped metadata", async () => {
    const { db, repo } = fixture();
    const first = await bearer(repo);
    const renamed = await repo.rename("owner-a", first.id, 1, "Renamed", 10);
    expect(renamed.status).toBe("updated");
    expect(await repo.rename("owner-a", first.id, 1, "Stale", 10)).toEqual({ status: "conflict" });
    await repo.create("owner-a", { name: "Second", kind: "basic", publicConfig: {} }, 11);
    await repo.create("owner-b", { name: "Foreign", kind: "basic", publicConfig: {} }, 12);
    const page1 = await repo.list("owner-a", { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await repo.list("owner-a", { limit: 1, cursor: page1.nextCursor ?? undefined });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    db.close();
  });
});

describe("scanConnectionReferences", () => {
  it("accepts only exact semantic bindings and fails closed without echo", () => {
    expect(scanConnectionReferences(graph("connection-a"), "connection-a")).toBe("match");
    expect(scanConnectionReferences(graph("connection-b"), "connection-a")).toBe("no-match");
    expect(scanConnectionReferences("private-not-json", "connection-a")).toBe("malformed");
    expect(scanConnectionReferences(graph("connection-a", { extra: true }), "connection-a")).toBe("malformed");
    expect(scanConnectionReferences(`${" ".repeat(2 * 1024 * 1024)}x`, "connection-a")).toBe("limited");
  });

  it("enforces depth, node, edge, string-count, and string-byte caps", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(scanConnectionReferences(graph(null, { meta: deep }), "connection-a")).toBe("limited");
    const parsed = JSON.parse(graph(null)) as Record<string, unknown>;
    parsed.nodes = Array.from({ length: 1_001 }, (_, index) => ({
      id: `n${index}`, type: "http", params: {}, bindings: {}, position: { x: 0, y: 0 },
    }));
    expect(scanConnectionReferences(JSON.stringify(parsed), "connection-a")).toBe("limited");
    parsed.nodes = [];
    parsed.edges = Array.from({ length: 5_001 }, (_, index) => ({
      id: `e${index}`, source: "a", sourceHandle: "out", target: "b", targetHandle: "in",
    }));
    expect(scanConnectionReferences(JSON.stringify(parsed), "connection-a")).toBe("limited");
    expect(scanConnectionReferences(graph(null, { meta: { value: "x".repeat(65_537) } }), "connection-a")).toBe("limited");
    expect(scanConnectionReferences(graph(null, { meta: Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`k${i}`, "x"])) }), "connection-a"))
      .toBe("limited");
  });
});

describe("connection usage scan", () => {
  function hierarchy(db: Database.Database): void {
    db.exec(`
      INSERT INTO organizations VALUES ('org','owner-a','Org','personal',1);
      INSERT INTO workspaces VALUES ('workspace','org','Workspace','workspace',1);
      INSERT INTO projects VALUES ('project','workspace','Project','project',1,1);
      INSERT INTO workbooks VALUES ('workbook','project','Workbook','workbook',0,1);
      INSERT INTO environments VALUES ('test-env','project','Test','test','test',1);
      INSERT INTO environments VALUES ('live-env','project','Live','live','live',1);
    `);
  }

  it("scans current drafts and active pinned test/live versions only", async () => {
    const { db, repo } = fixture();
    hierarchy(db);
    const connection = await bearer(repo);
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("draft", "owner-a", "Draft", graph(connection.id), 50);
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("foreign", "owner-b", "Foreign", graph(connection.id), 60);
    db.prepare("INSERT INTO flow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("version-active", "draft", 1, 2, null, null, graph(connection.id), "semantic", "full", "owner-a", 40);
    db.prepare("INSERT INTO flow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("version-old", "draft", 2, 2, null, null, graph(connection.id), "semantic-2", "full-2", "owner-a", 41);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-test", "draft", "version-active", "test-env", "test", 45, null);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-retired", "draft", "version-old", "live-env", "live", 46, 47);

    const result = await repo.usage("owner-a", connection.id, { limit: 100 });
    expect(result).toMatchObject({ matchedLowerBound: 2, truncated: false, lifecycleRevision: 1, nextCursor: null });
    expect(result?.items).toEqual([
      { artifactKind: "draft", flowId: "draft", flowName: "Draft", flowVersionId: null, environment: "draft", updatedAt: 50 },
      { artifactKind: "active_deployment", flowId: "draft", flowName: "Draft", flowVersionId: "version-active", environment: "test", updatedAt: 45 },
    ]);
    expect(await repo.usage("owner-b", connection.id, { limit: 100 })).toBeNull();
    db.close();
  });

  it("deduplicates active deployment ids by logical version and environment using the latest timestamp", async () => {
    const { db, repo } = fixture();
    hierarchy(db);
    db.exec(`
      INSERT INTO projects VALUES ('project-2','workspace','Project 2','project-2',1,1);
      INSERT INTO environments VALUES ('test-env-2','project-2','Test','test','test',1);
    `);
    const connection = await bearer(repo);
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("flow", "owner-a", "Flow", graph(null), 60);
    db.prepare("INSERT INTO flow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("version", "flow", 1, 2, null, null, graph(connection.id), "semantic", "full", "owner-a", 40);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-older", "flow", "version", "test-env", "test", 45, null);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-newer", "flow", "version", "test-env-2", "test", 55, null);

    const result = await repo.usage("owner-a", connection.id, { limit: 100 });
    expect(result?.items).toEqual([{
      artifactKind: "active_deployment",
      flowId: "flow",
      flowName: "Flow",
      flowVersionId: "version",
      environment: "test",
      updatedAt: 55,
    }]);
    expect(result).toMatchObject({ matchedLowerBound: 1, truncated: false, nextCursor: null });
    db.close();
  });

  it("paginates same-version same-time Test and Live artifacts exactly once", async () => {
    const { db, repo } = fixture();
    hierarchy(db);
    const connection = await bearer(repo);
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("flow", "owner-a", "Flow", graph(null), 60);
    db.prepare("INSERT INTO flow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("version", "flow", 1, 2, null, null, graph(connection.id), "semantic", "full", "owner-a", 40);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-test", "flow", "version", "test-env", "test", 50, null);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-live", "flow", "version", "live-env", "live", 50, null);

    const first = await repo.usage("owner-a", connection.id, { limit: 1 });
    expect(first).toMatchObject({ matchedLowerBound: 1, truncated: true });
    expect(first?.nextCursor).toBeTruthy();
    expect(JSON.parse(Buffer.from(first?.nextCursor ?? "", "base64url").toString("utf8"))).toEqual({
      artifactKind: "active_deployment",
      sortAt: 50,
      flowId: "flow",
      flowVersionId: "version",
      environment: "live",
    });
    const second = await repo.usage("owner-a", connection.id, { limit: 1, cursor: first?.nextCursor ?? undefined });
    expect(second).toMatchObject({ matchedLowerBound: 1, truncated: false, nextCursor: null });
    expect([...(first?.items ?? []), ...(second?.items ?? [])].map((item) => item.environment).sort())
      .toEqual(["live", "test"]);
    const oldCursor = Buffer.from(JSON.stringify({
      artifactKind: "active_deployment", sortAt: 50, flowId: "flow", flowVersionId: "version",
    })).toString("base64url");
    await expect(repo.usage("owner-a", connection.id, { limit: 1, cursor: oldCursor }))
      .rejects.toThrow("Invalid connection page");
    db.close();
  });

  it("continues canonical Unicode usage cursors above 2 KiB and rejects cursors above 4 KiB", async () => {
    const { db, repo } = fixture();
    hierarchy(db);
    const connection = await bearer(repo);
    const legacyId = "€".repeat(256);
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run(legacyId, "owner-a", "Legacy", graph(null), 60);
    db.prepare("INSERT INTO flow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(legacyId, legacyId, 1, 2, null, null, graph(connection.id), "semantic", "full", "owner-a", 40);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-legacy", legacyId, legacyId, "live-env", "live", 100, null);
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("later-flow", "owner-a", "Later", graph(null), 59);
    db.prepare("INSERT INTO flow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("later-version", "later-flow", 1, 2, null, null, graph(connection.id), "semantic-2", "full-2", "owner-a", 39);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("deployment-later", "later-flow", "later-version", "live-env", "live", 99, null);

    const first = await repo.usage("owner-a", connection.id, { limit: 1 });
    expect(first?.items[0]).toMatchObject({ flowId: legacyId, flowVersionId: legacyId });
    expect(first?.nextCursor?.length).toBeGreaterThan(2_048);
    expect(first?.nextCursor?.length).toBeLessThanOrEqual(4_096);
    const second = await repo.usage("owner-a", connection.id, { limit: 1, cursor: first?.nextCursor ?? undefined });
    expect(second?.items[0]).toMatchObject({ flowId: "later-flow", flowVersionId: "later-version" });

    const oversized = Buffer.from(JSON.stringify({
      artifactKind: "active_deployment",
      sortAt: 100,
      flowId: "€".repeat(600),
      flowVersionId: "€".repeat(600),
      environment: "live",
    }), "utf8").toString("base64url");
    expect(oversized.length).toBeGreaterThan(4_096);
    await expect(repo.usage("owner-a", connection.id, { limit: 1, cursor: oversized }))
      .rejects.toThrow("Invalid connection page");
    db.close();
  });

  it("marks malformed, artifact-count, byte, and match caps as truncated lower bounds", async () => {
    const malformed = fixture();
    const connection = await bearer(malformed.repo);
    malformed.db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("bad", "owner-a", "Bad", "not-json", 1);
    expect(await malformed.repo.usage("owner-a", connection.id, { limit: 100 }))
      .toMatchObject({ matchedLowerBound: 0, truncated: true });
    malformed.db.close();

    const counted = fixture();
    const countedConnection = await bearer(counted.repo);
    const insert = counted.db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)");
    for (let index = 0; index < 501; index += 1) insert.run(`flow-${index}`, "owner-a", `Flow ${index}`, graph(null), 1_000 - index);
    expect(await counted.repo.usage("owner-a", countedConnection.id, { limit: 100 }))
      .toMatchObject({ matchedLowerBound: 0, truncated: true });
    counted.db.close();

    const matched = fixture();
    const matchedConnection = await bearer(matched.repo);
    const matchInsert = matched.db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)");
    for (let index = 0; index < 101; index += 1) matchInsert.run(`match-${index}`, "owner-a", `Match ${index}`, graph(matchedConnection.id), 1_000 - index);
    const capped = await matched.repo.usage("owner-a", matchedConnection.id, { limit: 100 });
    expect(capped).toMatchObject({ matchedLowerBound: 100, truncated: true });
    expect(capped?.items).toHaveLength(100);
    expect(capped?.nextCursor).toBeTruthy();
    matched.db.close();

    const bytes = fixture();
    const bytesConnection = await bearer(bytes.repo);
    const byteInsert = bytes.db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)");
    const chunks = Array.from({ length: 40 }, () => "x".repeat(50_000));
    const aggregateGraph = graph(null, { meta: { chunks } });
    expect(Buffer.byteLength(aggregateGraph, "utf8")).toBeLessThan(2 * 1024 * 1024);
    expect(scanConnectionReferences(aggregateGraph, bytesConnection.id)).toBe("no-match");
    for (let index = 0; index < 9; index += 1) byteInsert.run(`byte-${index}`, "owner-a", `Byte ${index}`, aggregateGraph, 100 - index);
    const byteLimited = await bytes.repo.usage("owner-a", bytesConnection.id, { limit: 100 });
    expect(byteLimited).toMatchObject({ matchedLowerBound: 0, truncated: true });
    expect(byteLimited?.nextCursor).toBeTruthy();
    bytes.db.close();
  });
});
