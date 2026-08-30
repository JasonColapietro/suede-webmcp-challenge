import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalConnectionPublicConfig,
  encryptConnectionSecret,
} from "@/lib/connections/crypto";
import { SqliteConnectionRepository } from "@/lib/connections/sqlite-repository";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { removePostV16MigrationFixture } from "../helpers/sqlite-migration-fixture";

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function insertConnection(db: Database.Database, id = "conn-1"): void {
  if (columns(db, "connections").includes("crypto_owner_id")) {
    db.prepare(`INSERT INTO connections
      (id, owner_id, crypto_owner_id, name, kind, public_config, schema_version, lifecycle_revision, created_at, updated_at)
      VALUES (?, 'owner-1', 'owner-1', 'Primary', 'bearer', '{}', 1, 1, 10, 10)`).run(id);
  } else {
    db.prepare(`INSERT INTO connections
      (id, owner_id, name, kind, public_config, schema_version, lifecycle_revision, created_at, updated_at)
      VALUES (?, 'owner-1', 'Primary', 'bearer', '{}', 1, 1, 10, 10)`).run(id);
  }
}

function insertConfiguredSlot(db: Database.Database, environment: "test" | "live" = "live"): void {
  db.prepare(`INSERT INTO connection_slots
    (connection_id, environment, status, secret_version, key_version, nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at)
    VALUES ('conn-1', ?, 'configured', 1, 1, ?, ?, ?, 10, 10, NULL)`)
    .run(environment, Buffer.alloc(12, 1), Buffer.from("ciphertext"), Buffer.alloc(16, 2));
}

const HARDENING_TRIGGERS = [
  "connections_public_config_insert",
  "connections_public_config_update",
  "connections_revision_update",
  "connections_identity_update",
  "connection_slots_transition_update",
  "connection_slots_key_version_insert",
  "connection_slots_key_version_update",
  "connection_slots_delete",
  "connections_delete",
] as const;

const REPLACEMENT_GUARD_TRIGGERS = [
  "connections_insert_conflict",
  "connection_slots_insert_conflict",
] as const;

function restoreExactV15Fixture(db: Database.Database): void {
  removePostV16MigrationFixture(db);
  for (const trigger of REPLACEMENT_GUARD_TRIGGERS) db.exec(`DROP TRIGGER ${trigger}`);
  db.exec("DELETE FROM schema_migrations WHERE version = 16");
}

function restoreExactV14Fixture(db: Database.Database): void {
  restoreExactV15Fixture(db);
  for (const trigger of HARDENING_TRIGGERS) db.exec(`DROP TRIGGER ${trigger}`);
  db.exec("DELETE FROM schema_migrations WHERE version = 15");
}

function restoreExactV27Fixture(db: Database.Database): void {
  db.exec(`
    DROP TABLE resource_run_receipts;
    DROP TABLE resource_releases;
    DROP TABLE resource_evidence_refs;
    DROP TABLE resource_records;
    DROP TABLE resource_pack_versions;
    DROP TABLE resource_source_snapshots;
    DROP TABLE resource_source_assets;
    DROP TABLE resource_products;
    DROP TABLE ap2_authorizations;
    DROP INDEX idx_ceo_messages_company;
    DROP TABLE company_ceo_messages;
    DROP INDEX idx_health_checks_checked_at;
    DROP TABLE health_checks;
    DROP INDEX idx_agent_listings_agent;
    DROP TABLE agent_listings;
    DROP TRIGGER connections_crypto_owner_update;
    DROP TRIGGER connections_crypto_owner_insert;
    ALTER TABLE connections DROP COLUMN crypto_owner_id;
    DROP TABLE prospect_recipient_suppressions;
    DROP TABLE prospect_records;
    DELETE FROM schema_migrations WHERE version IN (28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45);
  `);
}

describe("SQLite connection migrations v14 through v28", () => {
  it("creates additive logical metadata and one active slot schema", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    expect(db.prepare("SELECT version, name, checksum FROM schema_migrations WHERE version = 14").get())
      .toMatchObject({ version: 14, name: "logical-connections" });
    expect((db.prepare("SELECT checksum FROM schema_migrations WHERE version = 14").get() as { checksum: string }).checksum)
      .toBe("d9b1eb588376e05408a1ae22e04ae767acf1b3b6c49e9dc6c1885cec136f4863");
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 15").get())
      .toEqual({ version: 15, name: "logical-connection-hardening" });
    expect((db.prepare("SELECT checksum FROM schema_migrations WHERE version = 15").get() as { checksum: string }).checksum)
      .toBe("164b14649152a2eef80421af0ef7e2e7fc1e1234e2ddf75df03f7e31049bf1da");
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 16").get())
      .toEqual({ version: 16, name: "logical-connection-replacement-guards" });
    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version = 28").get())
      .toEqual({ version: 28, name: "logical-connection-crypto-owner" });
    expect((db.prepare("SELECT checksum FROM schema_migrations WHERE version = 28").get() as { checksum: string }).checksum)
      .toBe("56713770587945a5653edd3db71c4ae6f05fd9e853bfed518a9d3ff7e860199b");
    expect(columns(db, "connections")).toEqual([
      "id", "owner_id", "name", "kind", "public_config", "schema_version",
      "lifecycle_revision", "created_at", "updated_at", "crypto_owner_id",
    ]);
    expect(columns(db, "connection_slots")).toEqual([
      "connection_id", "environment", "status", "secret_version", "key_version",
      "nonce", "ciphertext", "auth_tag", "configured_at", "updated_at", "revoked_at",
    ]);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      "idx_connections_owner_updated",
      "idx_connections_owner_name",
      "idx_connection_slots_status_environment",
    ]));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'connection_secret%'").all()).toEqual([]);
    const allColumns = columns(db, "connections").concat(columns(db, "connection_slots"));
    for (const forbidden of ["plaintext", "secret_value", "password", "token", "api_key"]) {
      expect(allColumns).not.toContain(forbidden);
    }
    db.close();
  });

  it("enforces metadata enums, JSON, monotonic revisions, and timestamps", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertConnection(db);

    for (const sql of [
      "INSERT INTO connections VALUES ('bad-kind','o','n','oauth','{}',1,1,1,1,'o')",
      "INSERT INTO connections VALUES ('bad-json','o','n','bearer','no',1,1,1,1,'o')",
      "INSERT INTO connections VALUES ('bad-schema','o','n','bearer','{}',2,1,1,1,'o')",
      "INSERT INTO connections VALUES ('bad-revision','o','n','bearer','{}',1,0,1,1,'o')",
      "INSERT INTO connections VALUES ('bad-time','o','n','bearer','{}',1,1,2,1,'o')",
      "INSERT INTO connections VALUES ('real-revision','o','n','bearer','{}',1,1.5,1,1,'o')",
    ]) expect(() => db.exec(sql)).toThrow();
    db.close();
  });

  it("requires a creation-time crypto anchor and makes it physically immutable", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const cryptoColumn = (db.prepare("PRAGMA table_info(connections)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((column) => column.name === "crypto_owner_id");
    expect(cryptoColumn).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "''" });
    expect(() => db.exec(`INSERT INTO connections
      (id, owner_id, name, kind, public_config, schema_version, lifecycle_revision, created_at, updated_at)
      VALUES ('missing-anchor','owner','Name','bearer','{}',1,1,1,1)`))
      .toThrow(/cryptographic owner/i);
    expect(() => db.exec(`INSERT INTO connections
      (id, owner_id, crypto_owner_id, name, kind, public_config, schema_version, lifecycle_revision, created_at, updated_at)
      VALUES ('wrong-anchor','owner','other','Name','bearer','{}',1,1,1,1)`))
      .toThrow(/cryptographic owner/i);
    insertConnection(db);
    expect(() => db.exec(`UPDATE connections
      SET crypto_owner_id='other', lifecycle_revision=2 WHERE id='conn-1'`))
      .toThrow(/immutable/i);
    expect(db.prepare("SELECT owner_id, crypto_owner_id, lifecycle_revision FROM connections WHERE id='conn-1'").get())
      .toEqual({ owner_id: "owner-1", crypto_owner_id: "owner-1", lifecycle_revision: 1 });
    db.close();
  });

  it("accepts only kind-exact public metadata and refuses secret or unsafe header fields", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const insert = db.prepare(`INSERT INTO connections
      (id, owner_id, crypto_owner_id, name, kind, public_config, schema_version, lifecycle_revision, created_at, updated_at)
      VALUES (?, 'owner', 'owner', 'Name', ?, ?, 1, 1, 1, 1)`);
    const valid = [
      ["bearer", "{}"],
      ["basic", "{}"],
      ["api_key", '{"headerName":"X-Api-Key"}'],
      ["custom_headers", '{"headerNames":["X-One","x-Two"]}'],
    ] as const;
    for (const [index, row] of valid.entries()) expect(() => insert.run(`valid-${index}`, ...row)).not.toThrow();

    const invalid = [
      ["bearer", '{"token":"secret"}'],
      ["basic", '{"username":"secret","password":"secret"}'],
      ["api_key", '{"headerName":"X-Key","apiKey":"secret"}'],
      ["api_key", '{"apiKey":"secret"}'],
      ["api_key", '{"headerName":"Host"}'],
      ["api_key", '{"headerName":"proxy-authorization"}'],
      ["api_key", '{"headerName":"bad header"}'],
      ["api_key", '{"headerName":"X-Key"} '],
      ["custom_headers", '{"headerNames":["X-Key","x-key"]}'],
      ["custom_headers", '{"headerNames":["X-Zeta","X-Alpha"]}'],
      ["custom_headers", '{"headerNames":["X-Key",7]}'],
      ["custom_headers", '{"headerNames":["Cookie"]}'],
      ["custom_headers", '{"headerNames":[]}'],
      ["custom_headers", '{"headerNames":["X-Key"],"values":{"X-Key":"secret"}}'],
      ["custom_headers", '{"values":{"X-Key":"secret"}}'],
      ["bearer", '{"extra":true}'],
    ] as const;
    for (const [index, row] of invalid.entries()) expect(() => insert.run(`invalid-${index}`, ...row)).toThrow();
    db.close();
  });

  it("enforces monotonic connection and slot lifecycle transitions on update", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertConnection(db);
    insertConfiguredSlot(db);

    expect(() => db.exec("UPDATE connections SET name='No revision' WHERE id='conn-1'")).toThrow();
    expect(() => db.exec("UPDATE connections SET lifecycle_revision=3 WHERE id='conn-1'")).toThrow();
    expect(() => db.exec("UPDATE connections SET lifecycle_revision=2, name='Renamed' WHERE id='conn-1'")).not.toThrow();
    expect(() => db.exec("UPDATE connections SET lifecycle_revision=1 WHERE id='conn-1'")).toThrow();
    expect(() => db.exec(`UPDATE connections SET lifecycle_revision=3, kind='api_key',
      public_config='{"headerName":"X-Key"}' WHERE id='conn-1'`)).toThrow();

    expect(() => db.exec("UPDATE connection_slots SET secret_version=3 WHERE connection_id='conn-1'")).toThrow();
    expect(() => db.exec(`UPDATE connection_slots SET secret_version=2, nonce=zeroblob(12),
      ciphertext=X'01', auth_tag=zeroblob(16), updated_at=11 WHERE connection_id='conn-1'`)).not.toThrow();
    expect(() => db.exec(`UPDATE connection_slots SET status='revoked', secret_version=3,
      key_version=NULL, nonce=NULL, ciphertext=NULL, auth_tag=NULL, updated_at=12, revoked_at=12
      WHERE connection_id='conn-1'`)).toThrow();
    expect(() => db.exec(`UPDATE connection_slots SET status='revoked',
      key_version=NULL, nonce=NULL, ciphertext=NULL, auth_tag=NULL, updated_at=12, revoked_at=12
      WHERE connection_id='conn-1'`)).not.toThrow();
    expect(() => db.exec(`UPDATE connection_slots SET status='configured', secret_version=2,
      key_version=1, nonce=zeroblob(12), ciphertext=X'01', auth_tag=zeroblob(16), updated_at=13, revoked_at=NULL
      WHERE connection_id='conn-1'`)).toThrow();
    expect(() => db.exec(`UPDATE connection_slots SET status='configured', secret_version=3,
      key_version=1, nonce=zeroblob(12), ciphertext=X'01', auth_tag=zeroblob(16), configured_at=13, updated_at=13, revoked_at=NULL
      WHERE connection_id='conn-1'`)).not.toThrow();
    expect(() => db.exec("DELETE FROM connections WHERE id='conn-1'")).toThrow();
    expect(() => db.exec("DELETE FROM connection_slots WHERE connection_id='conn-1'")).toThrow();
    insertConnection(db, "conn-2");
    expect(() => db.exec("DELETE FROM connections WHERE id='conn-2'")).toThrow();
    expect(() => db.exec(`INSERT INTO connections VALUES
      ('conn-2','owner-1','Reset','bearer','{}',1,1,11,11,'owner-1')`)).toThrow();
    db.close();
  });

  it("enforces configured and revoked slot data-minimization states", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertConnection(db);
    insertConfiguredSlot(db);
    const configuredInsert = db.prepare(`INSERT INTO connection_slots
      (connection_id, environment, status, secret_version, key_version, nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at)
      VALUES ('conn-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
    for (const row of [
      ["production", "configured", 1, 1, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), 10, 10],
      ["test", "missing", 1, 1, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), 10, 10],
      ["test", "configured", 0, 1, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), 10, 10],
      ["test", "configured", 1, 1.5, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), 10, 10],
      ["test", "configured", 1, 2, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), 10, 10],
      ["test", "configured", 1, 1, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), 10, 9],
    ] as const) expect(() => configuredInsert.run(...row)).toThrow();
    db.prepare(`UPDATE connection_slots SET status='revoked', key_version=NULL, nonce=NULL,
      ciphertext=NULL, auth_tag=NULL, updated_at=11, revoked_at=11
      WHERE connection_id='conn-1' AND environment='live'`).run();
    expect(db.prepare("SELECT status, nonce, ciphertext, auth_tag FROM connection_slots").get())
      .toEqual({ status: "revoked", nonce: null, ciphertext: null, auth_tag: null });

    const invalidRows = [
      ["configured", 1, Buffer.alloc(11), Buffer.from("x"), Buffer.alloc(16), 10, null],
      ["configured", 1, Buffer.alloc(12), null, Buffer.alloc(16), 10, null],
      ["configured", 1, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(15), 10, null],
      ["configured", 1, Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16), 10, 10],
      ["revoked", null, Buffer.alloc(12), null, null, 10, 10],
      ["revoked", null, null, Buffer.from("old"), null, 10, 10],
      ["revoked", null, null, null, null, 10, null],
    ] as const;
    const insert = db.prepare(`INSERT INTO connection_slots
      (connection_id, environment, status, secret_version, key_version, nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at)
      VALUES ('conn-1', 'test', ?, 2, ?, ?, ?, ?, 10, ?, ?)`);
    for (const row of invalidRows) expect(() => insert.run(...row)).toThrow();
    db.close();
  });

  it("enforces one row per environment and a real connection foreign key", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertConnection(db);
    insertConfiguredSlot(db, "test");
    expect(() => insertConfiguredSlot(db, "test")).toThrow();
    expect(() => db.prepare(`INSERT INTO connection_slots
      (connection_id, environment, status, secret_version, key_version, nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at)
      VALUES ('missing', 'live', 'configured', 1, 1, ?, ?, ?, 1, 1, NULL)`)
      .run(Buffer.alloc(12), Buffer.from("x"), Buffer.alloc(16))).toThrow();
    db.close();
  });

  it("blocks INSERT OR REPLACE resets with recursive triggers disabled", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);

    insertConnection(db);
    insertConfiguredSlot(db);
    const configured = db.prepare("SELECT * FROM connection_slots WHERE connection_id='conn-1'").get();
    expect(() => db.exec(`INSERT OR REPLACE INTO connection_slots VALUES
      ('conn-1','live','configured',1,1,zeroblob(12),X'7265736574',zeroblob(16),20,20,NULL)`)).toThrow();
    expect(db.prepare("SELECT * FROM connection_slots WHERE connection_id='conn-1'").get()).toEqual(configured);

    db.exec(`UPDATE connection_slots SET status='revoked', key_version=NULL, nonce=NULL,
      ciphertext=NULL, auth_tag=NULL, updated_at=11, revoked_at=11 WHERE connection_id='conn-1'`);
    const revoked = db.prepare("SELECT * FROM connection_slots WHERE connection_id='conn-1'").get();
    expect(() => db.exec(`INSERT OR REPLACE INTO connection_slots VALUES
      ('conn-1','live','revoked',1,NULL,NULL,NULL,NULL,20,20,20)`)).toThrow();
    expect(db.prepare("SELECT * FROM connection_slots WHERE connection_id='conn-1'").get()).toEqual(revoked);

    insertConnection(db, "empty-connection");
    const emptyConnection = db.prepare("SELECT * FROM connections WHERE id='empty-connection'").get();
    expect(() => db.exec(`INSERT OR REPLACE INTO connections VALUES
      ('empty-connection','owner-1','Reset','bearer','{}',1,1,20,20,'owner-1')`)).toThrow();
    expect(db.prepare("SELECT * FROM connections WHERE id='empty-connection'").get()).toEqual(emptyConnection);
    db.close();
  });

  it("upgrades a v13 prefix without changing legacy rows or checksums", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const graph = '{"raw":"legacy\\u0000bytes","order":[3,2,1]}';
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES ('legacy','owner','Legacy',?,1)").run(graph);
    const prefix = db.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version <= 13 ORDER BY version").all();
    const before = db.prepare("SELECT hex(graph) AS graph FROM flows WHERE id='legacy'").get();
    restoreExactV14Fixture(db);
    db.exec("DROP INDEX idx_connection_slots_status_environment; DROP INDEX idx_connections_owner_name; DROP INDEX idx_connections_owner_updated; DROP TABLE connection_slots; DROP TABLE connections; DELETE FROM schema_migrations WHERE version = 14");

    runSqliteMigrations(db);
    expect(db.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version <= 13 ORDER BY version").all()).toEqual(prefix);
    expect(db.prepare("SELECT hex(graph) AS graph FROM flows WHERE id='legacy'").get()).toEqual(before);
    expect(db.prepare("SELECT version,name FROM schema_migrations WHERE version=14").get())
      .toEqual({ version: 14, name: "logical-connections" });
    expect(db.prepare("SELECT version,name FROM schema_migrations WHERE version=15").get())
      .toEqual({ version: 15, name: "logical-connection-hardening" });
    db.close();
  });

  it("upgrades an exact checksummed v14 database to v15 without row drift", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV14Fixture(db);
    insertConnection(db);
    insertConfiguredSlot(db);
    const checksum = db.prepare("SELECT checksum FROM schema_migrations WHERE version=14").get();
    expect(checksum).toEqual({ checksum: "d9b1eb588376e05408a1ae22e04ae767acf1b3b6c49e9dc6c1885cec136f4863" });
    const before = db.prepare(`SELECT hex(CAST(id AS BLOB)) id, hex(CAST(public_config AS BLOB)) public_config
      FROM connections`).all();
    const slotsBefore = db.prepare(`SELECT connection_id, environment, status, secret_version, key_version,
      hex(nonce) nonce, hex(ciphertext) ciphertext, hex(auth_tag) auth_tag FROM connection_slots`).all();

    runSqliteMigrations(db);

    expect(db.prepare("SELECT version,name FROM schema_migrations WHERE version=15").get())
      .toEqual({ version: 15, name: "logical-connection-hardening" });
    expect(db.prepare(`SELECT hex(CAST(id AS BLOB)) id, hex(CAST(public_config AS BLOB)) public_config
      FROM connections`).all()).toEqual(before);
    expect(db.prepare(`SELECT connection_id, environment, status, secret_version, key_version,
      hex(nonce) nonce, hex(ciphertext) ciphertext, hex(auth_tag) auth_tag FROM connection_slots`).all()).toEqual(slotsBefore);
    db.close();
  });

  it("upgrades an exact checksummed v15 database through v28 without legacy row drift", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV15Fixture(db);
    insertConnection(db);
    insertConfiguredSlot(db);
    expect(db.prepare("SELECT checksum FROM schema_migrations WHERE version=15").get())
      .toEqual({ checksum: "164b14649152a2eef80421af0ef7e2e7fc1e1234e2ddf75df03f7e31049bf1da" });
    const before = db.prepare(`SELECT id, owner_id, name, kind, public_config, schema_version,
      lifecycle_revision, created_at, updated_at FROM connections`).all();
    const slotsBefore = db.prepare("SELECT * FROM connection_slots").all();

    runSqliteMigrations(db);

    expect(db.prepare("SELECT version,name FROM schema_migrations WHERE version=16").get())
      .toEqual({ version: 16, name: "logical-connection-replacement-guards" });
    expect(db.prepare(`SELECT id, owner_id, name, kind, public_config, schema_version,
      lifecycle_revision, created_at, updated_at FROM connections`).all()).toEqual(before);
    expect(db.prepare("SELECT crypto_owner_id FROM connections").all())
      .toEqual([{ crypto_owner_id: "owner-1" }]);
    expect(db.prepare("SELECT * FROM connection_slots").all()).toEqual(slotsBefore);
    db.close();
  });

  it("migrates configured v27 ciphertext, adopts access ownership, and keeps the crypto anchor through rotation", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV27Fixture(db);
    insertConnection(db);
    insertConnection(db, "conn-empty");
    const canonical = canonicalConnectionPublicConfig("bearer", {});
    const envelope = encryptConnectionSecret({
      key: Buffer.alloc(32, 7),
      ownerId: "owner-1",
      connectionId: "conn-1",
      kind: "bearer",
      environment: "live",
      schemaVersion: 1,
      secretVersion: 1,
      publicConfigSha256: canonical.sha256,
      plaintext: Buffer.from(JSON.stringify({ kind: "bearer", token: "legacy-private" }), "utf8"),
    });
    db.prepare(`INSERT INTO connection_slots
      (connection_id, environment, status, secret_version, key_version, nonce, ciphertext, auth_tag,
       configured_at, updated_at, revoked_at)
      VALUES ('conn-1', 'live', 'configured', 1, 1, ?, ?, ?, 10, 10, NULL)`)
      .run(envelope.nonce, envelope.ciphertext, envelope.authTag);
    const metadataBefore = db.prepare(`SELECT id, owner_id, name, kind, public_config, schema_version,
      lifecycle_revision, created_at, updated_at FROM connections WHERE id='conn-1'`).get();
    const slotBefore = db.prepare(`SELECT secret_version, hex(nonce) nonce, hex(ciphertext) ciphertext,
      hex(auth_tag) auth_tag, configured_at, updated_at, revoked_at FROM connection_slots
      WHERE connection_id='conn-1' AND environment='live'`).get();

    runSqliteMigrations(db);

    expect(db.prepare("SELECT version, name FROM schema_migrations WHERE version=28").get())
      .toEqual({ version: 28, name: "logical-connection-crypto-owner" });
    expect(db.prepare(`SELECT id, owner_id, name, kind, public_config, schema_version,
      lifecycle_revision, created_at, updated_at FROM connections WHERE id='conn-1'`).get())
      .toEqual(metadataBefore);
    expect(db.prepare("SELECT crypto_owner_id FROM connections WHERE id='conn-1'").get())
      .toEqual({ crypto_owner_id: "owner-1" });
    expect(db.prepare(`SELECT secret_version, hex(nonce) nonce, hex(ciphertext) ciphertext,
      hex(auth_tag) auth_tag, configured_at, updated_at, revoked_at FROM connection_slots
      WHERE connection_id='conn-1' AND environment='live'`).get()).toEqual(slotBefore);

    const app = new SqliteRepo(db);
    const connections = new SqliteConnectionRepository(db, Buffer.alloc(32, 7));
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    try {
      await app.adoptOwner("owner-1", "sb:user");
      expect(await connections.get("owner-1", "conn-1")).toBeNull();
      expect(await connections.get("owner-1", "conn-empty")).toBeNull();
      expect(await connections.get("sb:user", "conn-empty")).toMatchObject({
        id: "conn-empty",
        lifecycleRevision: 2,
        slots: { test: { status: "missing" }, live: { status: "missing" } },
      });
      expect(await connections.resolveHeaders("owner-1", "conn-1", "live", "headers")).toBeNull();
      expect(await connections.resolveHeaders("sb:user", "conn-1", "live", "headers"))
        .toEqual({ Authorization: "Bearer legacy-private" });
      const adopted = db.prepare(`SELECT owner_id, crypto_owner_id, lifecycle_revision, updated_at,
        hex((SELECT ciphertext FROM connection_slots WHERE connection_id=connections.id AND environment='live')) ciphertext
        FROM connections WHERE id='conn-1'`).get();
      expect(adopted).toEqual({
        owner_id: "sb:user",
        crypto_owner_id: "owner-1",
        lifecycle_revision: 2,
        updated_at: 100,
        ciphertext: (slotBefore as { ciphertext: string }).ciphertext,
      });
      expect(db.prepare(`SELECT owner_id, crypto_owner_id, lifecycle_revision, updated_at
        FROM connections WHERE id='conn-empty'`).get()).toEqual({
        owner_id: "sb:user",
        crypto_owner_id: "owner-1",
        lifecycle_revision: 2,
        updated_at: 100,
      });

      await app.adoptOwner("owner-1", "sb:user");
      await app.adoptOwner("sb:user", "sb:user");
      expect(db.prepare("SELECT owner_id, crypto_owner_id, lifecycle_revision, updated_at FROM connections WHERE id='conn-1'").get())
        .toEqual({ owner_id: "sb:user", crypto_owner_id: "owner-1", lifecycle_revision: 2, updated_at: 100 });
      expect(db.prepare("SELECT owner_id, crypto_owner_id, lifecycle_revision, updated_at FROM connections WHERE id='conn-empty'").get())
        .toEqual({ owner_id: "sb:user", crypto_owner_id: "owner-1", lifecycle_revision: 2, updated_at: 100 });

      const rotated = await connections.configureSlot(
        "sb:user",
        "conn-1",
        "live",
        2,
        { kind: "bearer", token: "rotated-private" },
        101,
      );
      expect(rotated.status).toBe("updated");
      expect(await connections.resolveHeaders("sb:user", "conn-1", "live", "headers"))
        .toEqual({ Authorization: "Bearer rotated-private" });
      expect(db.prepare("SELECT crypto_owner_id FROM connections WHERE id='conn-1'").get())
        .toEqual({ crypto_owner_id: "owner-1" });
      expect(db.prepare("SELECT hex(ciphertext) ciphertext FROM connection_slots WHERE connection_id='conn-1'").get())
        .not.toEqual({ ciphertext: (slotBefore as { ciphertext: string }).ciphertext });
    } finally {
      now.mockRestore();
      db.close();
    }
  });

  it("rolls back every generic ownership move when connection adoption fails", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertConnection(db);
    db.exec(`
      INSERT INTO flows (id, owner_id, name, graph, updated_at)
        VALUES ('flow-adopt', 'owner-1', 'Flow', '{}', 10);
      INSERT INTO usage (id, owner_id, kind, units, cost_usdc, created_at)
        VALUES ('usage-adopt', 'owner-1', 'run', 1, 0, '10');
      INSERT INTO credits (id, owner_id, delta_usdc, reason, tx, created_at)
        VALUES ('credit-adopt', 'owner-1', 1, 'test', NULL, '10');
      CREATE TRIGGER force_connection_adopt_failure
        BEFORE UPDATE OF owner_id ON connections
        BEGIN SELECT RAISE(ABORT, 'forced connection adoption failure'); END;
    `);
    const app = new SqliteRepo(db);

    await expect(app.adoptOwner("owner-1", "sb:user"))
      .rejects.toThrow("forced connection adoption failure");

    expect(db.prepare("SELECT owner_id FROM flows WHERE id='flow-adopt'").get())
      .toEqual({ owner_id: "owner-1" });
    expect(db.prepare("SELECT owner_id FROM usage WHERE id='usage-adopt'").get())
      .toEqual({ owner_id: "owner-1" });
    expect(db.prepare("SELECT owner_id FROM credits WHERE id='credit-adopt'").get())
      .toEqual({ owner_id: "owner-1" });
    expect(db.prepare("SELECT owner_id, crypto_owner_id, lifecycle_revision, updated_at FROM connections WHERE id='conn-1'").get())
      .toEqual({ owner_id: "owner-1", crypto_owner_id: "owner-1", lifecycle_revision: 1, updated_at: 10 });
    db.close();
  });

  it("reopens cleanly and rejects committed v28 trigger drift", () => {
    const root = mkdtempSync(join(tmpdir(), "suede-connection-v28-"));
    const path = join(root, "studio.db");
    try {
      let db = new Database(path);
      runSqliteMigrations(db);
      insertConnection(db);
      db.close();

      db = new Database(path);
      expect(() => runSqliteMigrations(db)).not.toThrow();
      expect(db.prepare("SELECT owner_id, crypto_owner_id FROM connections WHERE id='conn-1'").get())
        .toEqual({ owner_id: "owner-1", crypto_owner_id: "owner-1" });
      db.exec(`DROP TRIGGER connections_crypto_owner_update;
        CREATE TRIGGER connections_crypto_owner_update BEFORE UPDATE ON connections BEGIN SELECT 1; END;`);
      db.close();

      db = new Database(path);
      expect(() => runSqliteMigrations(db)).toThrow(/logical connection.*definition mismatch/i);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["public config", "INSERT INTO connections VALUES ('bad','owner','Bad','api_key','{\"apiKey\":\"secret\"}',1,1,1,1)"],
    ["key version", `INSERT INTO connection_slots VALUES
      ('conn-1','live','configured',1,2,zeroblob(12),X'01',zeroblob(16),1,1,NULL)`],
  ] as const)("transactionally refuses invalid pre-v15 %s", (_case, insertInvalid) => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV14Fixture(db);
    if (insertInvalid.includes("connection_slots")) insertConnection(db);
    db.exec(insertInvalid);

    expect(() => runSqliteMigrations(db)).toThrow(/Cannot harden invalid connection/);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=15").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(HARDENING_TRIGGERS[0])).toBeUndefined();
    db.close();
  });

  it("is repeatable and refuses checksum drift", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    insertConnection(db);
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('connections','connection_slots') ORDER BY name").all();
    runSqliteMigrations(db);
    expect(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('connections','connection_slots') ORDER BY name").all()).toEqual(schema);
    expect(db.prepare("SELECT count(*) AS count FROM connections").get()).toEqual({ count: 1 });
    const v15Checksum = (db.prepare("SELECT checksum FROM schema_migrations WHERE version=15").get() as { checksum: string }).checksum;
    const v16Checksum = (db.prepare("SELECT checksum FROM schema_migrations WHERE version=16").get() as { checksum: string }).checksum;
    db.prepare("UPDATE schema_migrations SET checksum='drift' WHERE version=16").run();
    expect(() => runSqliteMigrations(db)).toThrow(/migration 16 checksum mismatch/i);
    db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=16").run(v16Checksum);
    db.prepare("UPDATE schema_migrations SET checksum='drift' WHERE version=15").run();
    expect(() => runSqliteMigrations(db)).toThrow(/migration 15 checksum mismatch/i);
    db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=15").run(v15Checksum);
    db.prepare("UPDATE schema_migrations SET checksum='drift' WHERE version=14").run();
    expect(() => runSqliteMigrations(db)).toThrow(/migration 14 checksum mismatch/i);
    db.close();
  });

  it.each([
    ["table", "connections", `PRAGMA foreign_keys=OFF; DROP TABLE connection_slots;
      DROP TABLE connections; CREATE TABLE connections (id TEXT PRIMARY KEY); PRAGMA foreign_keys=ON`],
    ["table", "connection_slots", "DROP TABLE connection_slots; CREATE TABLE connection_slots (connection_id TEXT)"],
    ["index", "idx_connections_owner_updated", "DROP INDEX idx_connections_owner_updated; CREATE INDEX idx_connections_owner_updated ON connections(id)"],
    ["index", "idx_connections_owner_name", "DROP INDEX idx_connections_owner_name; CREATE INDEX idx_connections_owner_name ON connections(id)"],
    ["index", "idx_connection_slots_status_environment", "DROP INDEX idx_connection_slots_status_environment; CREATE INDEX idx_connection_slots_status_environment ON connection_slots(connection_id)"],
    ["trigger", "connections_revision_update", "DROP TRIGGER connections_revision_update; CREATE TRIGGER connections_revision_update BEFORE UPDATE ON connections BEGIN SELECT 1; END"],
    ["trigger", "connections_identity_update", "DROP TRIGGER connections_identity_update; CREATE TRIGGER connections_identity_update BEFORE UPDATE ON connections BEGIN SELECT 1; END"],
    ["trigger", "connections_public_config_insert", "DROP TRIGGER connections_public_config_insert; CREATE TRIGGER connections_public_config_insert BEFORE INSERT ON connections BEGIN SELECT 1; END"],
    ["trigger", "connections_public_config_update", "DROP TRIGGER connections_public_config_update; CREATE TRIGGER connections_public_config_update BEFORE UPDATE ON connections BEGIN SELECT 1; END"],
    ["trigger", "connection_slots_transition_update", "DROP TRIGGER connection_slots_transition_update; CREATE TRIGGER connection_slots_transition_update BEFORE UPDATE ON connection_slots BEGIN SELECT 1; END"],
    ["trigger", "connection_slots_key_version_insert", "DROP TRIGGER connection_slots_key_version_insert; CREATE TRIGGER connection_slots_key_version_insert BEFORE INSERT ON connection_slots BEGIN SELECT 1; END"],
    ["trigger", "connection_slots_key_version_update", "DROP TRIGGER connection_slots_key_version_update; CREATE TRIGGER connection_slots_key_version_update BEFORE UPDATE ON connection_slots BEGIN SELECT 1; END"],
    ["trigger", "connection_slots_delete", "DROP TRIGGER connection_slots_delete; CREATE TRIGGER connection_slots_delete BEFORE DELETE ON connection_slots BEGIN SELECT 1; END"],
    ["trigger", "connections_delete", "DROP TRIGGER connections_delete; CREATE TRIGGER connections_delete BEFORE DELETE ON connections BEGIN SELECT 1; END"],
    ["trigger", "connections_insert_conflict", "DROP TRIGGER connections_insert_conflict; CREATE TRIGGER connections_insert_conflict BEFORE INSERT ON connections BEGIN SELECT 1; END"],
    ["trigger", "connection_slots_insert_conflict", "DROP TRIGGER connection_slots_insert_conflict; CREATE TRIGGER connection_slots_insert_conflict BEFORE INSERT ON connection_slots BEGIN SELECT 1; END"],
    ["trigger", "connections_crypto_owner_insert", "DROP TRIGGER connections_crypto_owner_insert; CREATE TRIGGER connections_crypto_owner_insert BEFORE INSERT ON connections BEGIN SELECT 1; END"],
    ["trigger", "connections_crypto_owner_update", "DROP TRIGGER connections_crypto_owner_update; CREATE TRIGGER connections_crypto_owner_update BEFORE UPDATE ON connections BEGIN SELECT 1; END"],
  ] as const)("rejects committed connection %s drift for %s", (_type, _name, replacement) => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.exec(replacement);
    expect(() => runSqliteMigrations(db)).toThrow(/logical connection.*definition mismatch/i);
    db.close();
  });

  it("rejects a wrong preexisting v14 schema before recording its ledger row", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV14Fixture(db);
    db.exec(`
      DROP TABLE connection_slots;
      DROP TABLE connections;
      DELETE FROM schema_migrations WHERE version=14;
      CREATE TABLE connections (id TEXT PRIMARY KEY)`);
    expect(() => runSqliteMigrations(db)).toThrow();
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=14").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='connection_slots'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'idx_connection%' OR name LIKE 'connections_%'").all()).toEqual([]);
    db.close();
  });
});
