import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import { ConnectorImportService } from "@/lib/connectors/import-service";
import { SqliteConnectorReadinessBackend } from "@/lib/connectors/readiness-backend";
import {
  checkTestConnectionReadiness,
  isConnectionMetadataCompatible,
  parseConnectorReadinessRequest,
  type ConnectorReadinessOperation,
} from "@/lib/connectors/readiness";
import type {
  TestConnectionMetadata,
  TestConnectionMetadataReader,
} from "@/lib/connections/test-metadata-reader";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const REFERENCE = Object.freeze({
  connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000001",
  operationVersionId: "00000000-0000-4000-8000-000000000002",
  operationId: "createThing",
  connectorProjectionHash: HASH_A,
  operationProjectionHash: HASH_B,
  schemaHash: HASH_C,
  readinessBinding: Object.freeze({
    kind: "connection" as const,
    connectionId: "connection-a",
    capability: "http.headers" as const,
  }),
});

const CONFIGURED: TestConnectionMetadata = Object.freeze({
  kind: "api_key",
  publicHeaderNames: Object.freeze(["x-api-key"]),
  lifecycleRevision: 7,
  testSlotStatus: "configured",
  idSuffix: "a1b2c3d4",
});
const UNAVAILABLE = Object.freeze({
  ok: false as const,
  code: "TEST_CONNECTION_UNAVAILABLE" as const,
  receipt: Object.freeze({
    status: "unavailable" as const,
    message: "Test slot unavailable. Authentication unverified." as const,
    authentication: "unverified" as const,
    observedLifecycleRevision: null,
    connection: null,
    egressCount: 0 as const,
    costUsdc: 0 as const,
  }),
});

function operation(overrides: Partial<ConnectorReadinessOperation> = {}): ConnectorReadinessOperation {
  return Object.freeze({
    reference: REFERENCE,
    authentication: Object.freeze({ kind: "api_key_header" as const, headerName: "x-api-key" }),
    archived: false,
    ...overrides,
  });
}

function reader(values: readonly (TestConnectionMetadata | null)[]): TestConnectionMetadataReader & { readonly calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn();
  let index = 0;
  return Object.freeze({
    calls,
    readTestMetadata(ownerId: string, connectionId: string) {
      calls(ownerId, connectionId);
      const value = values[Math.min(index, values.length - 1)] ?? null;
      index += 1;
      return value;
    },
  });
}

function openApiSource(authentication: boolean, operationId: string): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Source title canary", version: "1" },
    servers: [{ url: "https://api.vendor.com" }],
    ...(authentication ? {
      components: {
        securitySchemes: {
          ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
        },
      },
    } : {}),
    paths: {
      "/things": {
        get: {
          operationId,
          ...(authentication ? { security: [{ ApiKey: [] }] } : {}),
          responses: { "204": { description: "Response description canary" } },
        },
      },
    },
  });
}

function idSequence(): () => string {
  let value = 100;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function localDependencyGraph(entries: readonly string[]): ReadonlyMap<string, string> {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const pending = [...entries];
  const visited = new Map<string, string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    const source = readFileSync(file, "utf8");
    visited.set(file, source);
    const imports = source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu);
    for (const match of imports) {
      const specifier = match[1]!;
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) continue;
      const base = specifier.startsWith("@/")
        ? join(root, "src", specifier.slice(2))
        : resolve(dirname(file), specifier);
      const candidate = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
        .find((path) => existsSync(path));
      if (candidate) pending.push(candidate);
    }
  }
  return visited;
}

describe("connector Test readiness", () => {
  it("parses only an exact pinned reference and optional lifecycle receipt", () => {
    expect(parseConnectorReadinessRequest({ reference: REFERENCE })).toEqual({ reference: REFERENCE });
    expect(parseConnectorReadinessRequest({ reference: REFERENCE, expectedLifecycleRevision: 7 })).toEqual({
      reference: REFERENCE,
      expectedLifecycleRevision: 7,
    });
    for (const value of [
      { reference: REFERENCE, correlationId: "caller" },
      { reference: REFERENCE, expectedLifecycleRevision: 0 },
      { reference: { ...REFERENCE, environment: "live" } },
      { reference: { ...REFERENCE, fixture: { token: "canary" } } },
    ]) expect(parseConnectorReadinessRequest(value)).toBeNull();
  });

  it("returns the exact configured receipt after two stable public reads", () => {
    const metadata = reader([CONFIGURED, CONFIGURED]);
    expect(checkTestConnectionReadiness({
      ownerId: "owner-a",
      operation: operation(),
      expectedLifecycleRevision: 7,
      reader: metadata,
    })).toEqual({
      ok: true,
      receipt: {
        status: "configured",
        message: "Test slot configured. Authentication unverified.",
        authentication: "unverified",
        observedLifecycleRevision: 7,
        connection: {
          kind: "api_key",
          publicHeaderNames: ["x-api-key"],
          testSlotStatus: "configured",
          idSuffix: "a1b2c3d4",
        },
        egressCount: 0,
        costUsdc: 0,
      },
    });
    expect(metadata.calls).toHaveBeenCalledTimes(2);
    expect(metadata.calls).toHaveBeenNthCalledWith(1, "owner-a", "connection-a");
    expect(metadata.calls).toHaveBeenNthCalledWith(2, "owner-a", "connection-a");
  });

  it("keeps no-auth readiness separate and never opens connection metadata", () => {
    const metadata = reader([CONFIGURED]);
    expect(checkTestConnectionReadiness({
      ownerId: "owner-a",
      operation: operation({
        reference: Object.freeze({ ...REFERENCE, readinessBinding: undefined }),
        authentication: Object.freeze({ kind: "none" as const }),
      }),
      reader: metadata,
    })).toEqual({
      ok: true,
      receipt: {
        status: "not_required",
        message: "Authentication not required.",
        authentication: "not_required",
        observedLifecycleRevision: null,
        connection: null,
        egressCount: 0,
        costUsdc: 0,
      },
    });
    expect(metadata.calls).not.toHaveBeenCalled();
  });

  it("collapses missing, foreign, revoked, incompatible, missing-Test, unresolved, and archived cases", () => {
    const cases: readonly { readonly op?: ConnectorReadinessOperation; readonly rows: readonly (TestConnectionMetadata | null)[] }[] = [
      { rows: [null] },
      { rows: [{ ...CONFIGURED, testSlotStatus: "revoked" }] },
      { rows: [{ ...CONFIGURED, testSlotStatus: "missing" }] },
      { rows: [{ ...CONFIGURED, kind: "bearer", publicHeaderNames: ["authorization"] }] },
      { op: operation({ reference: Object.freeze({ ...REFERENCE, readinessBinding: Object.freeze({ kind: "unresolved" as const, requirementKey: "req-a", capability: "http.headers" as const }) }) }), rows: [CONFIGURED] },
      { op: operation({ archived: true }), rows: [CONFIGURED] },
    ];
    cases.forEach((candidate, index) => {
      const metadata = reader(candidate.rows);
      expect(checkTestConnectionReadiness({ ownerId: "owner-a", operation: candidate.op ?? operation(), reader: metadata })).toEqual(UNAVAILABLE);
      if (index === 4 || index === 5) expect(metadata.calls).not.toHaveBeenCalled();
      else expect(metadata.calls).toHaveBeenCalledTimes(1);
    });
  });

  it("invalidates an expected or mid-check lifecycle drift with the same private unavailable result", () => {
    const changed = Object.freeze({ ...CONFIGURED, lifecycleRevision: 8 });
    expect(checkTestConnectionReadiness({
      ownerId: "owner-a", operation: operation(), expectedLifecycleRevision: 6, reader: reader([CONFIGURED]),
    })).toEqual(UNAVAILABLE);
    expect(checkTestConnectionReadiness({
      ownerId: "owner-a", operation: operation(), expectedLifecycleRevision: 7, reader: reader([CONFIGURED, changed]),
    })).toEqual(UNAVAILABLE);
  });

  it("supports only the reviewed public auth/header compatibility matrix", () => {
    expect(isConnectionMetadataCompatible({ kind: "api_key_header", headerName: "X-API-Key" }, CONFIGURED)).toBe(true);
    expect(isConnectionMetadataCompatible({ kind: "api_key_header", headerName: "x-api-key" }, {
      ...CONFIGURED, kind: "custom_headers", publicHeaderNames: ["X-API-KEY"],
    })).toBe(true);
    expect(isConnectionMetadataCompatible({ kind: "api_key_header", headerName: "x-api-key" }, {
      ...CONFIGURED, kind: "custom_headers", publicHeaderNames: ["x-api-key", "x-tenant"],
    })).toBe(false);
    expect(isConnectionMetadataCompatible({ kind: "http_bearer" }, { ...CONFIGURED, kind: "bearer", publicHeaderNames: ["authorization"] })).toBe(true);
    expect(isConnectionMetadataCompatible({ kind: "http_basic" }, { ...CONFIGURED, kind: "basic", publicHeaderNames: ["authorization"] })).toBe(true);
    expect(isConnectionMetadataCompatible({ kind: "http_bearer" }, { ...CONFIGURED, kind: "custom_headers", publicHeaderNames: ["authorization"] })).toBe(false);
    expect(isConnectionMetadataCompatible({ kind: "none" }, CONFIGURED)).toBe(false);
  });

  it("checks cancellation before metadata and before releasing a receipt", () => {
    const before = new AbortController();
    before.abort();
    const never = reader([CONFIGURED]);
    expect(checkTestConnectionReadiness({ ownerId: "owner-a", operation: operation(), reader: never, signal: before.signal }))
      .toEqual({ ok: false, code: "READINESS_CANCELLED" });
    expect(never.calls).not.toHaveBeenCalled();

    const during = new AbortController();
    const aborting: TestConnectionMetadataReader = {
      readTestMetadata() { during.abort(); return CONFIGURED; },
    };
    expect(checkTestConnectionReadiness({ ownerId: "owner-a", operation: operation(), reader: aborting, signal: during.signal }))
      .toEqual({ ok: false, code: "READINESS_CANCELLED" });
  });

  it("has a capability-minimized transitive import graph with no simulation or connection authority", () => {
    const graph = localDependencyGraph([
      new URL("../../src/lib/connectors/readiness.ts", import.meta.url).pathname,
      new URL("../../src/lib/connections/test-metadata-reader.ts", import.meta.url).pathname,
    ]);
    const source = [...graph.values()].join("\n");
    expect([...graph.keys()].join("\n")).not.toMatch(/connections\/(?:types|repository|provider|crypto|runtime-resolver)|connectors\/(?:provider|simulation)/iu);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:provider|repository|runtime-resolver|crypto|simulation|x402|payment|rails)[^"']*["']/iu);
    expect(source).not.toMatch(/\b(?:configureSlot|rotate|revokeSlot|resolveHeaders|decryptConnectionSecret|normalizeConnectionSecret|fetch)\s*\(/u);
    expect(source).not.toContain("environment = 'live'");
  });

  it("runs owner, hash, lifecycle, Test-only, and close laws through a migrated temp SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentix-readiness-"));
    const path = join(directory, "readiness.sqlite");
    const traces: string[] = [];
    const db = new Database(path, { verbose: (sql) => { if (typeof sql === "string") traces.push(sql); } });
    try {
      runSqliteMigrations(db);
      const repository = new SqliteConnectorRepository(db);
      const service = new ConnectorImportService(repository, { id: idSequence(), now: () => 10_000 });
      const authenticated = service.importOpenApi({
        ownerId: "owner-a", actorId: "owner-a", source: openApiSource(true, "authenticatedThing"),
        selectedOperationId: "authenticatedThing", displayLabel: "Authenticated API",
      });
      const noAuthentication = service.importOpenApi({
        ownerId: "owner-a", actorId: "owner-a", source: openApiSource(false, "publicThing"),
        selectedOperationId: "publicThing", displayLabel: "Public API",
      });
      if (!authenticated.ok || !noAuthentication.ok) throw new Error("fixture import failed");

      const addConnection = (id: string, revision: number): void => {
        db.prepare(`INSERT INTO connections (
          id, owner_id, crypto_owner_id, name, kind, public_config, schema_version,
          lifecycle_revision, created_at, updated_at
        ) VALUES (?, 'owner-a', 'owner-a', ?, 'api_key', ?, 1, ?, 1, ?)`)
          .run(id, id, JSON.stringify({ headerName: "X-Api-Key" }), revision, revision);
      };
      addConnection("connection-configured", 7);
      addConnection("connection-live-only", 8);
      addConnection("connection-revoked", 9);
      const configuredSlot = (connectionId: string, environment: "test" | "live", canary: string): void => {
        db.prepare(`INSERT INTO connection_slots (
          connection_id, environment, status, secret_version, key_version,
          nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at
        ) VALUES (?, ?, 'configured', 1, 1, ?, ?, ?, 1, 1, NULL)`)
          .run(connectionId, environment, Buffer.alloc(12, 1), Buffer.from(canary, "utf8"), Buffer.alloc(16, 2));
      };
      configuredSlot("connection-configured", "test", "test-secret-canary");
      configuredSlot("connection-live-only", "live", "live-secret-canary");
      db.prepare(`INSERT INTO connection_slots (
        connection_id, environment, status, secret_version, key_version,
        nonce, ciphertext, auth_tag, configured_at, updated_at, revoked_at
      ) VALUES ('connection-revoked', 'test', 'revoked', 1, NULL, NULL, NULL, NULL, 1, 2, 2)`).run();

      const baseReference = {
        connectorDefinitionVersionId: authenticated.definition.id,
        operationVersionId: authenticated.operation.id,
        operationId: authenticated.operation.operationId,
        connectorProjectionHash: authenticated.definition.connectorProjectionHash,
        operationProjectionHash: authenticated.operation.operationProjectionHash,
        schemaHash: authenticated.operation.schemaHash,
      };
      const requestFor = (connectionId: string, expectedLifecycleRevision?: number) => ({
        reference: {
          ...baseReference,
          readinessBinding: { kind: "connection" as const, connectionId, capability: "http.headers" as const },
        },
        ...(expectedLifecycleRevision === undefined ? {} : { expectedLifecycleRevision }),
      });
      const backend = new SqliteConnectorReadinessBackend(db);
      traces.length = 0;
      const configured = backend.check("owner-a", requestFor("connection-configured", 7));
      expect(configured).toMatchObject({ ok: true, receipt: { status: "configured", observedLifecycleRevision: 7 } });
      expect(JSON.stringify(configured)).not.toMatch(/test-secret-canary|live-secret-canary/u);
      expect(traces.join("\n")).not.toMatch(/nonce|ciphertext|auth_tag|key_version|environment\s*=\s*'live'/iu);

      expect(backend.check("owner-b", requestFor("connection-configured")))
        .toEqual(UNAVAILABLE);
      expect(backend.check("owner-a", {
        ...requestFor("connection-configured"),
        reference: { ...requestFor("connection-configured").reference, schemaHash: "f".repeat(64) },
      })).toEqual(UNAVAILABLE);
      expect(backend.check("owner-a", requestFor("connection-configured", 6)))
        .toEqual(UNAVAILABLE);
      expect(backend.check("owner-a", requestFor("connection-live-only", 8)))
        .toEqual(UNAVAILABLE);
      expect(backend.check("owner-a", requestFor("connection-revoked", 9)))
        .toEqual(UNAVAILABLE);

      traces.length = 0;
      const publicReference = {
        connectorDefinitionVersionId: noAuthentication.definition.id,
        operationVersionId: noAuthentication.operation.id,
        operationId: noAuthentication.operation.operationId,
        connectorProjectionHash: noAuthentication.definition.connectorProjectionHash,
        operationProjectionHash: noAuthentication.operation.operationProjectionHash,
        schemaHash: noAuthentication.operation.schemaHash,
      };
      expect(backend.check("owner-a", { reference: publicReference })).toMatchObject({
        ok: true, receipt: { status: "not_required", observedLifecycleRevision: null },
      });
      expect(traces.join("\n")).not.toMatch(/\bFROM\s+connections\b|\bJOIN\s+connection_slots\b/iu);

      backend.close();
      const inspect = new Database(path, { readonly: true });
      expect(inspect.prepare("SELECT count(*) count FROM connector_operation_versions").get()).toEqual({ count: 2 });
      inspect.close();
    } finally {
      try { if (db.open) db.close(); } catch { /* backend may already own close */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
