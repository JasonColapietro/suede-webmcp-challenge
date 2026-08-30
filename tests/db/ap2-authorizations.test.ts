import Database from "better-sqlite3";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { ReserveAp2AuthorizationInput } from "@/lib/db/repo";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SupabaseRepo } from "@/lib/db/supabase-repo";

const AP2_V40_CHECKSUM = "4b99bafc0634f79a489a8d5b5cb2438247a508f624c9cd599b7c1146ecc7ebfa";
const AP2_REPLAY_SCHEMA_ATTESTATION = "ap2-replay-v2";

const AP2_V40_SQL = `
  CREATE TABLE ap2_authorizations (
    id TEXT PRIMARY KEY,
    mandate_reference TEXT NOT NULL UNIQUE,
    payment_nonce_hash TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject_id TEXT,
    checkout_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    network TEXT NOT NULL,
    asset TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    amount_minor_usd INTEGER NOT NULL CHECK (amount_minor_usd >= 0),
    payee_id TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'authorized', 'settling', 'settled', 'executing', 'completed',
      'rejected', 'failed', 'pending_reconciliation'
    )),
    decision_code TEXT,
    receipt_json TEXT,
    result_json TEXT,
    expires_at TEXT NOT NULL,
    run_id TEXT,
    tx TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_ap2_authorizations_state_updated
    ON ap2_authorizations (state, updated_at);
  CREATE INDEX idx_ap2_authorizations_agent_created
    ON ap2_authorizations (agent_id, created_at);
  CREATE INDEX idx_ap2_authorizations_run
    ON ap2_authorizations (run_id);
`;

function restoreExactV40Fixture(db: Database.Database): void {
  db.exec(`
    DROP TABLE ap2_authorizations;
    ${AP2_V40_SQL}
    DELETE FROM schema_migrations WHERE version >= 41;
    UPDATE schema_migrations SET checksum = '${AP2_V40_CHECKSUM}' WHERE version = 40;
  `);
}

function legacyAuthorizationValues(): readonly unknown[] {
  return [
    "authorization-legacy",
    "mandate:legacy:001",
    "a".repeat(64),
    "b".repeat(64),
    "https://issuer.example",
    "payer-legacy",
    "c".repeat(64),
    "agent-1",
    "flow-1",
    "deployment-1",
    "eip155:8453",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "250000",
    25,
    "merchant-suede-agent-studio",
    "0x1111111111111111111111111111111111111111",
    "completed",
    "fulfilled",
    JSON.stringify({ checkoutReceipt: "legacy-signed-receipt", dispute: "retain" }),
    JSON.stringify({ httpStatus: 200, body: { output: "legacy-result" } }),
    "2026-08-13T18:00:00.000Z",
    "run-legacy",
    `0x${"d".repeat(64)}`,
    "2026-08-13T17:00:00.000Z",
    "2026-08-13T17:00:00.000Z",
  ];
}

function authorizationInput(
  overrides: Partial<ReserveAp2AuthorizationInput> = {},
): ReserveAp2AuthorizationInput {
  return {
    mandateReference: "mandate:issuer:001",
    paymentNonceHash: "a".repeat(64),
    requestDigest: "b".repeat(64),
    issuer: "https://issuer.example",
    subjectId: "payer-123",
    checkoutHash: "c".repeat(64),
    agentId: "agent-1",
    flowId: "flow-1",
    deploymentId: "deployment-1",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amountAtomic: "250000",
    amountMinorUsd: 25,
    payeeId: "merchant-suede-agent-studio",
    payTo: "0x1111111111111111111111111111111111111111",
    payer: "0x2222222222222222222222222222222222222222",
    expiresAt: "2026-08-13T18:00:00.000Z",
    paymentValidBefore: "2026-08-13T17:59:00.000Z",
    ...overrides,
  };
}

describe("AP2 authorization ledger", () => {
  it("preserves the immutable AP2 initial migration checksum at version 40", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    expect(db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = 40",
    ).get()).toEqual({
      version: 40,
      name: "ap2-authorizations",
      checksum: AP2_V40_CHECKSUM,
    });
  });

  it("upgrades an empty exact-v40 ledger through replay-hardening migration 42", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV40Fixture(db);

    expect(() => runSqliteMigrations(db)).not.toThrow();
    expect(db.prepare(
      "SELECT version, name FROM schema_migrations WHERE version = 42",
    ).get()).toEqual({ version: 42, name: "ap2-replay-hardening" });
    expect((db.prepare("PRAGMA table_info(ap2_authorizations)").all() as Array<{
      name: string;
      notnull: number;
    }>)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "payer", notnull: 1 }),
      expect.objectContaining({ name: "payment_valid_before", notnull: 1 }),
    ]));
    expect(await new SqliteRepo(db).checkAp2ReplayStoreReady()).toBe(true);
  });

  it("dark-starts a populated AP2 v40 ledger without transforming or deleting evidence", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV40Fixture(db);
    db.prepare(`INSERT INTO ap2_authorizations VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`).run(...legacyAuthorizationValues());

    const before = db.prepare("SELECT * FROM ap2_authorizations ORDER BY id").all();
    const beforeSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ap2_authorizations'",
    ).get();

    expect(() => runSqliteMigrations(db)).not.toThrow();
    expect(() => runSqliteMigrations(db)).not.toThrow();
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 42").get())
      .toBeUndefined();
    expect(await new SqliteRepo(db).checkAp2ReplayStoreReady()).toBe(false);
    expect(db.prepare("SELECT * FROM ap2_authorizations ORDER BY id").all()).toEqual(before);
    expect(db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ap2_authorizations'",
    ).get()).toEqual(beforeSchema);
    expect((db.prepare("PRAGMA table_info(ap2_authorizations)").all() as Array<{ name: string }>))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "payer" }),
        expect.objectContaining({ name: "payment_valid_before" }),
      ]));
    expect(db.prepare("SELECT state, decision_code, receipt_json, result_json, run_id, tx FROM ap2_authorizations").get())
      .toEqual({
        state: "completed",
        decision_code: "fulfilled",
        receipt_json: JSON.stringify({ checkoutReceipt: "legacy-signed-receipt", dispute: "retain" }),
        result_json: JSON.stringify({ httpStatus: 200, body: { output: "legacy-result" } }),
        run_id: "run-legacy",
        tx: `0x${"d".repeat(64)}`,
      });
  });

  it("dark-starts a populated AP2 v40 prefix before the Resource suffix exists", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    restoreExactV40Fixture(db);
    db.exec(`
      DROP TABLE resource_run_receipts;
      DROP TABLE resource_releases;
      DROP TABLE resource_evidence_refs;
      DROP TABLE resource_records;
      DROP TABLE resource_source_snapshots;
      DROP TABLE resource_source_assets;
      DROP TABLE resource_pack_versions;
      DROP TABLE resource_products;
    `);
    db.prepare(`INSERT INTO ap2_authorizations VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`).run(...legacyAuthorizationValues());

    expect(() => runSqliteMigrations(db)).not.toThrow();
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 42").get())
      .toBeUndefined();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='resource_products'",
    ).get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM ap2_authorizations").get())
      .toEqual({ count: 1 });
  });

  it("reserves once and returns the prior record for exact retries", async () => {
    const repo = new SqliteRepo(":memory:");
    const input = authorizationInput();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => repo.reserveAp2Authorization(input)),
    );

    expect(results.filter((result) => result.status === "reserved")).toHaveLength(1);
    expect(results.filter((result) => result.status === "exact-retry")).toHaveLength(49);
    expect(new Set(results.map((result) => result.authorization?.id))).toHaveLength(1);
    expect(await repo.getAp2AuthorizationByMandateReference(input.mandateReference))
      .toMatchObject({
        mandateReference: input.mandateReference,
        paymentNonceHash: input.paymentNonceHash,
        requestDigest: input.requestDigest,
        state: "authorized",
      });
  });

  it("conflicts on changed-request reuse and on payment-nonce reuse", async () => {
    const repo = new SqliteRepo(":memory:");
    const input = authorizationInput();
    await repo.reserveAp2Authorization(input);

    const changedRequest = await repo.reserveAp2Authorization({
      ...input,
      requestDigest: "d".repeat(64),
    });
    expect(changedRequest.status).toBe("conflict");
    expect(changedRequest.authorization?.requestDigest).toBe(input.requestDigest);

    const reusedNonce = await repo.reserveAp2Authorization({
      ...input,
      mandateReference: "mandate:issuer:002",
      requestDigest: "e".repeat(64),
    });
    expect(reusedNonce).toEqual({ status: "conflict", authorization: null });
    expect(await repo.getAp2AuthorizationByMandateReference("mandate:issuer:002"))
      .toBeNull();
  });

  it("consumes each merchant checkout exactly once across distinct payment mandates", async () => {
    const repo = new SqliteRepo(":memory:");
    const attempts = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      repo.reserveAp2Authorization(authorizationInput({
        mandateReference: `mandate:issuer:${String(index).padStart(3, "0")}`,
        paymentNonceHash: index.toString(16).padStart(64, "0"),
      }))));

    expect(attempts.filter((result) => result.status === "reserved")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "conflict")).toHaveLength(49);
  });

  it("compare-and-sets only allowed states and persists sanitized terminal JSON", async () => {
    const repo = new SqliteRepo(":memory:");
    const reserved = await repo.reserveAp2Authorization(authorizationInput());
    if (reserved.status !== "reserved") throw new Error("expected fresh reservation");

    const settling = await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "authorized",
      toState: "settling",
      decisionCode: "authorized",
    });
    expect(settling?.state).toBe("settling");
    expect(await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "authorized",
      toState: "settling",
    })).toBeNull();

    const settled = await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "settling",
      toState: "settled",
      tx: "0xabc",
      receiptJson: { status: "accepted", receiptHash: "f".repeat(64) },
    });
    expect(settled).toMatchObject({ state: "settled", tx: "0xabc" });

    const executing = await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "settled",
      toState: "executing",
      runId: "run-1",
    });
    expect(executing?.runId).toBe("run-1");

    const completed = await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "executing",
      toState: "completed",
      resultJson: { status: 200, bodyHash: "0".repeat(64) },
    });
    expect(completed).toMatchObject({
      state: "completed",
      receiptJson: { status: "accepted", receiptHash: "f".repeat(64) },
      resultJson: { status: 200, bodyHash: "0".repeat(64) },
    });

    await expect(repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "completed",
      toState: "settling",
    })).rejects.toThrow(/invalid ap2 authorization transition/i);
  });

  it("routes ambiguous engine exceptions from executing to reconciliation", async () => {
    const repo = new SqliteRepo(":memory:");
    const reserved = await repo.reserveAp2Authorization(authorizationInput());
    if (reserved.status !== "reserved") throw new Error("expected fresh reservation");

    await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "authorized",
      toState: "settling",
    });
    await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "settling",
      toState: "settled",
      tx: "0xabc",
    });
    await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "settled",
      toState: "executing",
      runId: "run-ambiguous",
    });

    const pending = await repo.transitionAp2Authorization({
      id: reserved.authorization.id,
      fromState: "executing",
      toState: "pending_reconciliation",
      decisionCode: "execution_ambiguous",
      resultJson: { status: "unknown" },
    });

    expect(pending).toMatchObject({
      state: "pending_reconciliation",
      runId: "run-ambiguous",
      tx: "0xabc",
      decisionCode: "execution_ambiguous",
      resultJson: { status: "unknown" },
    });
  });

  it("fails closed when replay storage is unavailable", async () => {
    const repo = new SqliteRepo(new Database(":memory:"));
    await expect(repo.reserveAp2Authorization(authorizationInput()))
      .rejects.toThrow(/ap2_authorizations/i);
    await expect(repo.getAp2AuthorizationByMandateReference("mandate:issuer:001"))
      .rejects.toThrow(/ap2_authorizations/i);
  });

  it("migrates only the bounded AP2 projection with unique replay identities", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);

    const columns = (db.prepare("PRAGMA table_info(ap2_authorizations)").all() as Array<{
      name: string;
    }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      "mandate_reference",
      "payment_nonce_hash",
      "request_digest",
      "receipt_json",
      "result_json",
      "expires_at",
      "payer",
      "payment_valid_before",
    ]));
    expect(columns).not.toEqual(expect.arrayContaining([
      "mandate",
      "disclosures",
      "checkout_jwt",
      "payment_signature",
      "authorization_header",
      "request_body",
    ]));

    const uniqueIndexes = db
      .prepare("PRAGMA index_list(ap2_authorizations)")
      .all() as Array<{ name: string; unique: number }>;
    const uniqueColumns = uniqueIndexes
      .filter((index) => index.unique === 1)
      .flatMap((index) => (
        db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>
      ).map((column) => column.name));
    expect(uniqueColumns).toEqual(expect.arrayContaining([
      "mandate_reference",
      "payment_nonce_hash",
      "checkout_hash",
    ]));
  });

  it("rejects readiness when columns exist without the attested unique identities", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations VALUES (42, 'ap2-replay-hardening', 'fixture', 1);
      CREATE TABLE ap2_authorizations (
        mandate_reference TEXT NOT NULL,
        checkout_hash TEXT NOT NULL,
        payment_nonce_hash TEXT NOT NULL,
        payer TEXT NOT NULL,
        payment_valid_before TEXT NOT NULL,
        state TEXT NOT NULL
      );
    `);

    await expect(new SqliteRepo(db).checkAp2ReplayStoreReady()).resolves.toBe(false);
  });
});

describe("Supabase AP2 replay readiness", () => {
  it("accepts only the exact database constraint attestation revision", async () => {
    const rpc = async (name: string): Promise<{ data: unknown; error: unknown }> =>
      name === "agent_studio_ap2_replay_store_attestation"
        ? { data: AP2_REPLAY_SCHEMA_ATTESTATION, error: null }
        : { data: null, error: { message: "unknown function" } };
    const repo = new SupabaseRepo({ rpc } as unknown as SupabaseClient);

    await expect(repo.checkAp2ReplayStoreReady()).resolves.toBe(true);
  });

  it.each([
    { data: "ap2-replay-v1", error: null },
    { data: null, error: null },
    { data: null, error: { message: "permission denied" } },
  ])("fails closed for a missing, stale, or denied attestation", async (result) => {
    const repo = new SupabaseRepo({
      rpc: async () => result,
    } as unknown as SupabaseClient);

    await expect(repo.checkAp2ReplayStoreReady()).resolves.toBe(false);
  });

  it("ships the attestation RPC with service-role-only deploy privileges", () => {
    const schema = readFileSync("src/lib/db/schema.deploy.sql", "utf8")
      .replace(/\s+/gu, " ")
      .toLowerCase();
    expect(schema).toContain(
      "create or replace function public.agent_studio_ap2_replay_store_attestation() returns text",
    );
    expect(schema).toContain(
      "revoke execute on function public.agent_studio_ap2_replay_store_attestation() from public, anon, authenticated;",
    );
    expect(schema).toContain(
      "grant execute on function public.agent_studio_ap2_replay_store_attestation() to service_role;",
    );
  });
});
