import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import {
  SqliteTestConnectionMetadataReader,
  TEST_CONNECTION_METADATA_QUERY,
} from "@/lib/connections/test-metadata-reader";

interface FakeRow {
  readonly kind: string;
  readonly public_config: string;
  readonly lifecycle_revision: number;
  readonly test_slot_status: string;
  readonly id_suffix: string;
}

function database(row: FakeRow | undefined, queries: string[]): {
  readonly prepare: (sql: string) => { readonly get: (...params: readonly unknown[]) => FakeRow | undefined };
} {
  return {
    prepare(sql: string) {
      queries.push(sql);
      return {
        get(...params: readonly unknown[]) {
          expect(params).toEqual(["owner-a", "connection-a"]);
          return row;
        },
      };
    },
  };
}

describe("TestConnectionMetadataReader", () => {
  it("uses one owner-scoped Test-only public metadata query", () => {
    const queries: string[] = [];
    const reader = new SqliteTestConnectionMetadataReader(database({
      kind: "api_key",
      public_config: JSON.stringify({ headerName: "X-Api-Key" }),
      lifecycle_revision: 7,
      test_slot_status: "configured",
      id_suffix: "a1b2c3d4",
    }, queries));

    expect(reader.readTestMetadata("owner-a", "connection-a")).toEqual({
      kind: "api_key",
      publicHeaderNames: ["x-api-key"],
      lifecycleRevision: 7,
      testSlotStatus: "configured",
      idSuffix: "a1b2c3d4",
    });
    expect(queries).toEqual([TEST_CONNECTION_METADATA_QUERY]);
    expect(TEST_CONNECTION_METADATA_QUERY).toMatch(/owner_id\s*=\s*\?/u);
    expect(TEST_CONNECTION_METADATA_QUERY).toMatch(/environment\s*=\s*'test'/u);
    expect(TEST_CONNECTION_METADATA_QUERY).not.toMatch(/environment\s*=\s*'live'|nonce|ciphertext|auth_tag|key_version|secret_version/iu);
  });

  it("returns null for missing or foreign rows before parsing metadata", () => {
    const queries: string[] = [];
    const reader = new SqliteTestConnectionMetadataReader(database(undefined, queries));
    expect(reader.readTestMetadata("owner-a", "connection-a")).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it("normalizes only bounded public metadata for every supported connection kind", () => {
    const rows: readonly FakeRow[] = [
      { kind: "bearer", public_config: "{}", lifecycle_revision: 1, test_slot_status: "missing", id_suffix: "00000001" },
      { kind: "basic", public_config: "{}", lifecycle_revision: 2, test_slot_status: "revoked", id_suffix: "00000002" },
      { kind: "custom_headers", public_config: JSON.stringify({ headerNames: ["X-One", "x-two"] }), lifecycle_revision: 3, test_slot_status: "configured", id_suffix: "00000003" },
    ];
    const expected = [
      { kind: "bearer", publicHeaderNames: ["authorization"], lifecycleRevision: 1, testSlotStatus: "missing", idSuffix: "00000001" },
      { kind: "basic", publicHeaderNames: ["authorization"], lifecycleRevision: 2, testSlotStatus: "revoked", idSuffix: "00000002" },
      { kind: "custom_headers", publicHeaderNames: ["x-one", "x-two"], lifecycleRevision: 3, testSlotStatus: "configured", idSuffix: "00000003" },
    ];
    rows.forEach((row, index) => {
      const reader = new SqliteTestConnectionMetadataReader(database(row, []));
      const metadata = reader.readTestMetadata("owner-a", "connection-a");
      expect(metadata).toEqual(expected[index]);
      expect(Object.isFrozen(metadata)).toBe(true);
      expect(Object.isFrozen(metadata?.publicHeaderNames)).toBe(true);
    });
  });

  it("fails closed on malformed, excessive, protected, or secret-shaped rows", () => {
    const rows: readonly FakeRow[] = [
      { kind: "api_key", public_config: JSON.stringify({ headerName: "X", secret: "canary" }), lifecycle_revision: 1, test_slot_status: "configured", id_suffix: "00000001" },
      { kind: "custom_headers", public_config: JSON.stringify({ headerNames: Array.from({ length: 17 }, (_, index) => `X-${index}`) }), lifecycle_revision: 1, test_slot_status: "configured", id_suffix: "00000001" },
      { kind: "custom_headers", public_config: JSON.stringify({ headerNames: ["X-A", "x-a"] }), lifecycle_revision: 1, test_slot_status: "configured", id_suffix: "00000001" },
      { kind: "custom_headers", public_config: JSON.stringify({ headerNames: ["Authorization"] }), lifecycle_revision: 1, test_slot_status: "configured", id_suffix: "00000001" },
      { kind: "api_key", public_config: JSON.stringify({ headerName: "X-Forwarded-For" }), lifecycle_revision: 1, test_slot_status: "configured", id_suffix: "00000001" },
      { kind: "bearer", public_config: "{}", lifecycle_revision: 0, test_slot_status: "configured", id_suffix: "00000001" },
      { kind: "bearer", public_config: "{}", lifecycle_revision: 1, test_slot_status: "live", id_suffix: "00000001" },
      { kind: "bearer", public_config: "{}", lifecycle_revision: 1, test_slot_status: "configured", id_suffix: "bad suffix" },
    ];
    for (const row of rows) {
      const reader = new SqliteTestConnectionMetadataReader(database(row, []));
      expect(reader.readTestMetadata("owner-a", "connection-a")).toBeNull();
    }
  });

  it("refuses unbounded identities before preparing SQLite", () => {
    const queries: string[] = [];
    const reader = new SqliteTestConnectionMetadataReader(database(undefined, queries));
    expect(reader.readTestMetadata("", "connection-a")).toBeNull();
    expect(reader.readTestMetadata("owner-a", "x".repeat(257))).toBeNull();
    expect(reader.readTestMetadata("owner\ncanary", "connection-a")).toBeNull();
    expect(queries).toEqual([]);
  });

  it("projects a missing Test slot when only a hostile Live row exists", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    db.prepare(`INSERT INTO connections (
      id, owner_id, crypto_owner_id, name, kind, public_config, schema_version,
      lifecycle_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`).run(
      "connection-a", "owner-a", "owner-a", "Bearer", "bearer", "{}",
    );
    db.prepare(`INSERT INTO connection_slots (
      connection_id, environment, status, secret_version, key_version,
      nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at
    ) VALUES (?, 'live', 'configured', 1, 1, ?, ?, ?, 1, 1, NULL)`).run(
      "connection-a",
      Buffer.alloc(12, 1),
      Buffer.from("live-secret-canary", "utf8"),
      Buffer.alloc(16, 2),
    );

    const reader = new SqliteTestConnectionMetadataReader(db);
    expect(reader.readTestMetadata("owner-a", "connection-a")).toEqual({
      kind: "bearer",
      publicHeaderNames: ["authorization"],
      lifecycleRevision: 1,
      testSlotStatus: "missing",
      idSuffix: "6f6e2d61",
    });
    db.close();
  });
});
