import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import { ConnectorImportService } from "@/lib/connectors/import-service";
import type { ConnectorRepositoryTransaction } from "@/lib/connectors/repository";
import {
  getConnectorRepositoryAvailability,
  getConnectorImportService,
  getConnectorRepository,
} from "@/lib/connectors/provider";
import type { OpenApiCompileResult } from "@/lib/connectors/openapi/compile";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function source(description = "RAW_SOURCE_CANARY"): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "STRIPPED_TITLE_CANARY", version: "1", description },
    servers: [{ url: "https://api.vendor.com" }],
    paths: {
      "/things/{id}": {
        get: {
          operationId: "getThing",
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", example: "EXAMPLE_CANARY", default: "DEFAULT_VALUE_CANARY" },
          }],
          responses: { "204": { description: "RESPONSE_CANARY" } },
        },
      },
    },
  });
}

function twoOperationSource(): string {
  const value = JSON.parse(source()) as {
    paths: Record<string, unknown>;
  };
  value.paths["/things"] = {
    get: { operationId: "listThings", responses: { "204": { description: "ok" } } },
  };
  return JSON.stringify(value);
}

function idSequence(start = 100): () => string {
  let value = start;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function setup(options: { compile?: (source: string | Uint8Array, options?: { signal?: AbortSignal }) => OpenApiCompileResult } = {}) {
  const db = new Database(":memory:");
  runSqliteMigrations(db);
  const repository = new SqliteConnectorRepository(db);
  const service = new ConnectorImportService(repository, {
    id: idSequence(),
    now: () => 60_000,
    compile: options.compile,
  });
  return { db, repository, service };
}

function input(extra: Record<string, unknown> = {}) {
  return {
    ownerId: "owner-a",
    actorId: "actor-a",
    source: source(),
    selectedOperationId: "getThing",
    displayLabel: "Vendor API",
    ...extra,
  };
}

describe("ConnectorImportService", () => {
  it("returns bounded sanitized review metadata without operation materialization", () => {
    const { db, service } = setup();
    const result = service.reviewOpenApi({
      ownerId: "owner-a", actorId: "actor-a", displayLabel: "Vendor API", source: source(),
    });
    expect(result).toMatchObject({
      ok: true,
      operations: [{ operationId: "getThing", method: "GET", path: "/things/{id}" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/CANARY|headers|requestSchema|resultSchema/u);
    expect(db.prepare("SELECT count(*) count FROM connector_identities").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM connector_operation_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT outcome FROM control_audit_events").get()).toEqual({ outcome: "completed" });
  });

  it("rolls back cancelled reviews and records persistence refusals in a fresh transaction", () => {
    const controller = new AbortController();
    const cancelled = setup({ compile: () => {
      controller.abort();
      return { ok: false, code: "INVALID_JSON" };
    } });
    expect(cancelled.service.reviewOpenApi({
      ownerId: "owner-a", actorId: "actor-a", displayLabel: "Vendor API", source: source(), signal: controller.signal,
    })).toEqual({ ok: false, code: "IMPORT_CANCELLED" });
    expect(cancelled.db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 0 });

    const refused = setup();
    refused.db.exec(`CREATE TRIGGER fail_review_persistence BEFORE INSERT ON connector_identities
      BEGIN SELECT RAISE(ABORT, 'forced review persistence failure'); END;`);
    expect(refused.service.reviewOpenApi({
      ownerId: "owner-a", actorId: "actor-a", displayLabel: "Vendor API", source: source(),
    })).toMatchObject({ ok: false, code: "PERSISTENCE_REFUSED" });
    expect(refused.db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 0 });
    expect(refused.db.prepare("SELECT outcome, error_code FROM control_audit_events").get())
      .toEqual({ outcome: "refused", error_code: "PERSISTENCE_REFUSED" });
  });
  it("atomically compiles, creates assets, consumes rate, and appends both terminal audits", () => {
    const { db, service } = setup();
    const result = service.importOpenApi(input());

    expect(result).toMatchObject({
      ok: true,
      identityDisposition: "created",
      definitionDisposition: "created",
      operationDisposition: "created",
      drift: null,
    });
    expect(result.ok && result.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(db.prepare("SELECT count(*) count FROM connector_identities").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM connector_definition_versions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM connector_operation_versions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT action, outcome, correlation_id FROM control_audit_events ORDER BY action").all())
      .toEqual([
        { action: "connector.import", outcome: "completed", correlation_id: result.ok ? result.correlationId : "" },
        { action: "connector.operation.create", outcome: "completed", correlation_id: result.ok ? result.correlationId : "" },
      ]);
  });

  it("requires explicit connector identity for idempotent reimport and returns drift dispositions", () => {
    const { db, service } = setup();
    const first = service.importOpenApi(input());
    if (!first.ok) throw new Error(first.code);
    const second = service.importOpenApi(input({ connectorId: first.identity.id }));

    expect(second).toMatchObject({
      ok: true,
      identity: { id: first.identity.id },
      identityDisposition: "reused",
      definition: { id: first.definition.id },
      operation: { id: first.operation.id },
      definitionDisposition: "reused-current",
      operationDisposition: "reused",
    });
    expect(db.prepare("SELECT count(*) count FROM connector_definition_versions").get()).toEqual({ count: 1 });
  });

  it("never infers a connector identity from matching label or origin", () => {
    const { db, service } = setup();

    const first = service.importOpenApi(input());
    const second = service.importOpenApi(input());

    expect(first).toMatchObject({ ok: true, identityDisposition: "created" });
    expect(second).toMatchObject({ ok: true, identityDisposition: "created" });
    expect(first.ok && second.ok && second.identity.id).not.toBe(first.ok ? first.identity.id : "");
    expect(db.prepare("SELECT count(*) count FROM connector_identities").get()).toEqual({ count: 2 });
  });

  it("audits parse/projection/timeout refusals, consumes their reservation, and stores no asset", () => {
    for (const [rawSource, expectedCode, auditCode] of [
      ["{", "INVALID_JSON", "PARSE_REFUSED"],
      [JSON.stringify({ openapi: "3.0.0" }), "OPENAPI_VERSION_REFUSED", "PROJECTION_REFUSED"],
    ] as const) {
      const { db, service } = setup();
      const result = service.importOpenApi(input({ source: rawSource }));
      expect(result).toMatchObject({ ok: false, code: expectedCode });
      expect(db.prepare("SELECT count(*) count FROM connector_identities").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT outcome, error_code FROM control_audit_events").get())
        .toEqual({ outcome: "refused", error_code: auditCode });
    }

    const { db, service } = setup({ compile: () => ({ ok: false, code: "COMPILER_DEADLINE" }) });
    expect(service.importOpenApi(input())).toMatchObject({ ok: false, code: "COMPILER_DEADLINE" });
    expect(db.prepare("SELECT error_code FROM control_audit_events").get()).toEqual({ error_code: "TIMEOUT_REFUSED" });
  });

  it("rate-refuses attempt eleven before compiler traversal, without leaking a reservation", () => {
    const compile = vi.fn((): OpenApiCompileResult => ({ ok: false, code: "INVALID_JSON" }));
    const { db, repository } = setup();
    for (let index = 0; index < 10; index += 1) {
      repository.immediate((transaction) => transaction.reserveImport({
        id: `00000000-0000-4000-8000-${String(index + 500).padStart(12, "0")}`,
        ownerId: "owner-a",
        correlationId: `00000000-0000-4000-8000-${String(index + 600).padStart(12, "0")}`,
        now: 60_000,
      }));
    }
    const service = new ConnectorImportService(repository, { id: idSequence(700), now: () => 60_001, compile });

    expect(service.importOpenApi(input())).toMatchObject({ ok: false, code: "RATE_REFUSED" });
    expect(compile).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 10 });
    expect(db.prepare("SELECT error_code FROM control_audit_events").get()).toEqual({ error_code: "RATE_REFUSED" });
  });

  it("linearizes cancellation before commit and never changes a committed result", () => {
    const before = setup();
    const beforeController = new AbortController();
    beforeController.abort();
    expect(before.service.importOpenApi(input({ signal: beforeController.signal })))
      .toEqual({ ok: false, code: "IMPORT_CANCELLED" });
    expect(before.db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 0 });
    expect(before.db.prepare("SELECT count(*) count FROM control_audit_events").get()).toEqual({ count: 0 });

    const middleController = new AbortController();
    const middle = setup({ compile: (_source, _options) => {
      middleController.abort();
      return { ok: false, code: "INVALID_JSON" };
    } });
    expect(middle.service.importOpenApi(input({ signal: middleController.signal })))
      .toEqual({ ok: false, code: "IMPORT_CANCELLED" });
    expect(middle.db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 0 });
    expect(middle.db.prepare("SELECT count(*) count FROM control_audit_events").get()).toEqual({ count: 0 });

    const after = setup();
    const afterController = new AbortController();
    const originalImmediate = after.repository.immediate.bind(after.repository);
    Object.defineProperty(after.repository, "immediate", {
      configurable: true,
      value: function immediate<T>(work: (transaction: ConnectorRepositoryTransaction) => T): T {
        const committedResult = originalImmediate(work);
        afterController.abort();
        return committedResult;
      },
    });
    const committed = after.service.importOpenApi(input({ signal: afterController.signal }));
    expect(committed.ok).toBe(true);
    expect(afterController.signal.aborted).toBe(true);
    expect(after.db.prepare("SELECT count(*) count FROM connector_operation_versions").get()).toEqual({ count: 1 });
  });

  it("returns AUDIT_UNAVAILABLE and rolls back assets and rate when the first SQLite audit append fails", () => {
    const { db, service } = setup();
    db.exec(`CREATE TRIGGER fail_all_connector_audits BEFORE INSERT ON control_audit_events
      WHEN NEW.action IN ('connector.import', 'connector.operation.create')
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;`);

    expect(service.importOpenApi(input())).toEqual({ ok: false, code: "AUDIT_UNAVAILABLE" });
    for (const table of [
      "connector_identities",
      "connector_definition_versions",
      "connector_operation_versions",
      "connector_import_rate_reservations",
      "control_audit_events",
    ]) {
      expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("rolls back the first real audit append when the second append fails", () => {
    const { db, service } = setup();
    db.exec(`CREATE TRIGGER fail_operation_audit BEFORE INSERT ON control_audit_events
      WHEN NEW.action = 'connector.operation.create'
      BEGIN SELECT RAISE(ABORT, 'forced second audit failure'); END;`);

    expect(service.importOpenApi(input())).toEqual({ ok: false, code: "AUDIT_UNAVAILABLE" });
    for (const table of [
      "connector_identities",
      "connector_definition_versions",
      "connector_operation_versions",
      "connector_import_rate_reservations",
      "control_audit_events",
    ]) {
      expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("rejects client correlation fields before opening a transaction", () => {
    const { db, service } = setup();
    const result = service.importOpenApi(input({ correlationId: "client-controlled" }));
    expect(result).toMatchObject({ ok: false, code: "INVALID_IMPORT_REQUEST" });
    expect(result.ok || result.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT error_code FROM control_audit_events").get()).toEqual({ error_code: "POLICY_REFUSED" });
  });

  it("preserves import refusal evidence despite malformed signals, symbols, or non-enumerable extras", () => {
    const malformed = input({ signal: {} });
    const symbolExtra = input();
    Object.defineProperty(symbolExtra, Symbol("extra"), { value: true, enumerable: true });
    const hiddenExtra = input();
    Object.defineProperty(hiddenExtra, "hidden", { value: true, enumerable: false });

    for (const request of [malformed, symbolExtra, hiddenExtra]) {
      const { db, service } = setup();
      const result = service.importOpenApi(request);
      expect(result).toMatchObject({ ok: false, code: "INVALID_IMPORT_REQUEST" });
      expect(result.ok || result.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(db.prepare("SELECT action, outcome, error_code FROM control_audit_events").get()).toEqual({
        action: "connector.import",
        outcome: "refused",
        error_code: "POLICY_REFUSED",
      });
    }
  });

  it("materializes another operation from an exact stored definition without source or another import reservation", () => {
    const { db, service } = setup();
    const imported = service.importOpenApi(input({ source: twoOperationSource() }));
    if (!imported.ok) throw new Error(imported.code);

    const added = service.addStoredOperation({
      ownerId: "owner-a",
      actorId: "actor-a",
      connectorDefinitionVersionId: imported.definition.id,
      operationId: "listThings",
      authorAnnotation: { label: "Unverified", retryNote: "Caller supplied" },
    });
    expect(added).toMatchObject({ ok: true, disposition: "created", operation: { operationId: "listThings" } });
    expect(db.prepare("SELECT count(*) count FROM connector_operation_versions").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT action, outcome FROM control_audit_events ORDER BY created_at, rowid").all())
      .toEqual([
        { action: "connector.import", outcome: "completed" },
        { action: "connector.operation.create", outcome: "completed" },
        { action: "connector.operation.create", outcome: "completed" },
      ]);
  });

  it("audits recoverable stored-operation request refusals and rejects client correlation IDs", () => {
    const { db, service } = setup();
    const result = service.addStoredOperation({
      ownerId: "owner-a",
      actorId: "actor-a",
      connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000901",
      operationId: "getThing",
      correlationId: "client-controlled",
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_IMPORT_REQUEST" });
    expect(result.ok || result.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(db.prepare("SELECT action, outcome, error_code FROM control_audit_events").get()).toEqual({
      action: "connector.operation.create",
      outcome: "refused",
      error_code: "POLICY_REFUSED",
    });
  });

  it("preserves stored-operation refusal evidence despite malformed signals, symbols, or non-enumerable extras", () => {
    const base = () => ({
      ownerId: "owner-a",
      actorId: "actor-a",
      connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000901",
      operationId: "getThing",
    });
    const malformed = { ...base(), signal: {} };
    const symbolExtra = base();
    Object.defineProperty(symbolExtra, Symbol("extra"), { value: true, enumerable: true });
    const hiddenExtra = base();
    Object.defineProperty(hiddenExtra, "hidden", { value: true, enumerable: false });

    for (const request of [malformed, symbolExtra, hiddenExtra]) {
      const { db, service } = setup();
      const result = service.addStoredOperation(request);
      expect(result).toMatchObject({ ok: false, code: "INVALID_IMPORT_REQUEST" });
      expect(result.ok || result.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(db.prepare("SELECT action, outcome, error_code FROM control_audit_events").get()).toEqual({
        action: "connector.operation.create",
        outcome: "refused",
        error_code: "POLICY_REFUSED",
      });
    }
  });

  it("returns AUDIT_UNAVAILABLE when a recoverable stored-operation refusal cannot be recorded", () => {
    const { db, service } = setup();
    db.exec(`CREATE TRIGGER fail_stored_operation_refusal BEFORE INSERT ON control_audit_events
      WHEN NEW.action = 'connector.operation.create'
      BEGIN SELECT RAISE(ABORT, 'forced refusal audit failure'); END;`);

    expect(service.addStoredOperation({
      ownerId: "owner-a",
      actorId: "actor-a",
      connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000901",
      operationId: "getThing",
      correlationId: "client-controlled",
    })).toEqual({ ok: false, code: "AUDIT_UNAVAILABLE" });
  });

  it("rolls back a persistence failure then appends one audit-only refusal when SQLite remains usable", () => {
    const { db, service } = setup();
    db.exec(`CREATE TRIGGER force_connector_persistence_failure BEFORE INSERT ON connector_identities
      BEGIN SELECT RAISE(ABORT, 'forced connector persistence failure'); END;`);

    const result = service.importOpenApi(input());

    expect(result).toMatchObject({ ok: false, code: "PERSISTENCE_REFUSED" });
    expect(db.prepare("SELECT count(*) count FROM connector_identities").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM connector_import_rate_reservations").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT outcome, error_code FROM control_audit_events").get())
      .toEqual({ outcome: "refused", error_code: "PERSISTENCE_REFUSED" });
  });
});

describe("connector provider and on-disk privacy", () => {
  it("requires sqlite plus an explicit absolute path and never creates studio.db", async () => {
    const defaultExisted = existsSync("studio.db");
    delete process.env.DB_DRIVER;
    delete process.env.SQLITE_PATH;
    expect(getConnectorRepositoryAvailability()).toEqual({ available: false });
    await expect(getConnectorImportService()).rejects.toMatchObject({ code: "CONNECTOR_REPOSITORY_UNAVAILABLE" });
    process.env.DB_DRIVER = "sqlite";
    process.env.SQLITE_PATH = "relative.db";
    expect(getConnectorRepositoryAvailability()).toEqual({ available: false });
    expect(existsSync("studio.db")).toBe(defaultExisted);

    const directory = mkdtempSync(join(tmpdir(), "connector-provider-"));
    process.env.SQLITE_PATH = join(directory, "read.sqlite");
    const repository = await getConnectorRepository();
    expect(repository.listConnectorIdentities("owner-a", { limit: 1 })).toEqual({ items: [], nextCursor: null });
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("never writes raw or stripped source canaries to the database, WAL, SHM, or journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "connector-private-"));
    const canaries = [
      "RAW_SOURCE_CANARY",
      "STRIPPED_TITLE_CANARY",
      "EXAMPLE_CANARY",
      "DEFAULT_VALUE_CANARY",
      "RESPONSE_CANARY",
    ];
    const assertPrivate = (candidates: readonly string[]): void => {
      const bytes = candidates
        .filter((candidate) => existsSync(candidate))
        .map((candidate) => readFileSync(candidate).toString("utf8"))
        .join("\n");
      for (const canary of canaries) expect(bytes).not.toContain(canary);
    };

    const walPath = join(directory, "wal.sqlite");
    const walDb = new Database(walPath);
    try {
      expect(walDb.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
      runSqliteMigrations(walDb);
      const repository = new SqliteConnectorRepository(walDb, { ownsDatabase: true });
      const service = new ConnectorImportService(repository);
      const result = service.importOpenApi(input());
      expect(result.ok).toBe(true);

      const candidates = [walPath, `${walPath}-wal`, `${walPath}-shm`];
      expect(candidates.slice(0, 3).every((candidate) => existsSync(candidate))).toBe(true);
      assertPrivate(candidates);
      walDb.pragma("wal_checkpoint(TRUNCATE)");
      service.close();
      assertPrivate(candidates);
    } finally {
      try { walDb.close(); } catch { /* already closed by the owned repository */ }
    }

    const persistPath = join(directory, "persist.sqlite");
    const persistDb = new Database(persistPath);
    try {
      expect(persistDb.pragma("journal_mode = PERSIST", { simple: true })).toBe("persist");
      runSqliteMigrations(persistDb);
      const repository = new SqliteConnectorRepository(persistDb, { ownsDatabase: true });
      const service = new ConnectorImportService(repository);
      expect(service.importOpenApi(input()).ok).toBe(true);

      const candidates = [persistPath, `${persistPath}-journal`];
      expect(candidates.every((candidate) => existsSync(candidate))).toBe(true);
      assertPrivate(candidates);
      service.close();
      expect(existsSync(`${persistPath}-journal`)).toBe(true);
      assertPrivate(candidates);
    } finally {
      try { persistDb.close(); } catch { /* already closed by the owned repository */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
