import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import {
  createAuditCorrelation,
  type ControlAuditEventInput,
} from "@/lib/audit/repository";
import { SqliteAuditRepository } from "@/lib/audit/sqlite-repository";

function safeInput(): ControlAuditEventInput {
  return {
    correlation: createAuditCorrelation("owner-a", "actor-a"),
    action: "connector.operation.create",
    resource: {
      kind: "operation_version",
      id: "00000000-0000-4000-8000-000000000201",
      versionId: "00000000-0000-4000-8000-000000000202",
      projectionHash: "a".repeat(64),
      schemaHash: "b".repeat(64),
    },
    outcome: "refused",
    errorCode: "PROJECTION_REFUSED",
    connection: null,
    durationMs: 5,
  };
}

describe("control audit redaction boundary", () => {
  it.each([
    "rawSource",
    "input",
    "output",
    "headers",
    "payload",
    "sentinel",
    "rejectedValue",
    "credential",
    "error",
    "correlationId",
    "ownerId",
    "actorId",
    "costUsdc",
    "egressCount",
  ])("rejects the extra top-level field %s", (field) => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const hostile = { ...safeInput(), [field]: "CANARY-secret-payload" };

    expect(() => repository.append(hostile as unknown as ControlAuditEventInput))
      .toThrow("Invalid control audit event");
    expect(JSON.stringify(db.prepare("SELECT * FROM control_audit_events").all()))
      .not.toContain("CANARY-secret-payload");
  });

  it("rejects nested unknown fields, symbols, accessors, and non-plain prototypes", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const symbolInput = safeInput() as ControlAuditEventInput & Record<symbol, string>;
    symbolInput[Symbol("payload")] = "CANARY-symbol";
    expect(() => repository.append(symbolInput)).toThrow("Invalid control audit event");

    const nested = safeInput();
    const hostileResource = { ...nested.resource, payload: "CANARY-nested" };
    expect(() => repository.append({
      ...nested,
      resource: hostileResource,
    } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");

    let getterCalls = 0;
    const accessor = safeInput() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "action", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "connector.import";
      },
    });
    expect(() => repository.append(accessor as unknown as ControlAuditEventInput))
      .toThrow("Invalid control audit event");
    expect(getterCalls).toBe(0);

    const inherited = Object.assign(Object.create({ payload: "CANARY-prototype" }), safeInput());
    expect(() => repository.append(inherited as ControlAuditEventInput))
      .toThrow("Invalid control audit event");
  });

  it("never invokes caller coercion hooks while rejecting malformed values", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    let calls = 0;
    const hostileDuration = {
      valueOf: () => {
        calls += 1;
        return 1;
      },
      toString: () => {
        calls += 1;
        return "1";
      },
    };

    expect(() => repository.append({
      ...safeInput(),
      durationMs: hostileDuration,
    } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");
    expect(calls).toBe(0);
  });

  it.each(["id", "versionId"] as const)(
    "rejects canary text smuggled through the allowed resource %s field",
    (field) => {
      const db = new Database(":memory:");
      runSqliteMigrations(db);
      const repository = new SqliteAuditRepository(db);
      const input = safeInput();
      const hostile = {
        ...input,
        resource: { ...input.resource, [field]: "CANARY-secret-payload" },
      };

      expect(() => repository.append(hostile as unknown as ControlAuditEventInput))
        .toThrow("Invalid control audit event");
      expect(JSON.stringify(db.prepare("SELECT * FROM control_audit_events").all()))
        .not.toContain("CANARY-secret-payload");
    },
  );
});
