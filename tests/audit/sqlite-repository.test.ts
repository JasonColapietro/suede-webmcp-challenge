import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import {
  auditCorrelationId,
  createAuditCorrelation,
  type ControlAuditEventInput,
} from "@/lib/audit/repository";
import { SqliteAuditRepository } from "@/lib/audit/sqlite-repository";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CONNECTOR_ID = "00000000-0000-4000-8000-000000000101";
const OPERATION_ID = "00000000-0000-4000-8000-000000000102";
const VERSION_ID = "00000000-0000-4000-8000-000000000103";
const SIMULATION_ID = "00000000-0000-4000-8000-000000000104";

function validInput(): ControlAuditEventInput {
  return {
    correlation: createAuditCorrelation("owner-a", "actor-a"),
    action: "connector.import",
    resource: {
      kind: "connector_definition",
      id: CONNECTOR_ID,
      versionId: VERSION_ID,
      projectionHash: HASH_A,
      schemaHash: null,
    },
    outcome: "completed",
    errorCode: null,
    connection: null,
    durationMs: 12,
  };
}

describe("SqliteAuditRepository", () => {
  it("appends one frozen terminal event with server-owned correlation and zero cost", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db, {
      id: () => "00000000-0000-4000-8000-000000000010",
      now: () => 123,
    });
    const input = validInput();

    const event = repository.append(input);

    expect(event).toEqual({
      id: "00000000-0000-4000-8000-000000000010",
      schemaVersion: 1,
      ownerId: "owner-a",
      actorId: "actor-a",
      correlationId: auditCorrelationId(input.correlation),
      action: "connector.import",
      resource: input.resource,
      outcome: "completed",
      errorCode: null,
      effect: "write",
      connection: null,
      durationMs: 12,
      egressCount: 0,
      costUsdc: 0,
      at: 123,
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.resource)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_audit_events").get())
      .toEqual({ count: 1 });
  });

  it("participates in a caller-owned transaction", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const appendThenFail = db.transaction(() => {
      repository.append(validInput());
      throw new Error("caller rollback");
    });

    expect(() => appendThenFail()).toThrow("caller rollback");
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_audit_events").get())
      .toEqual({ count: 0 });
  });

  it("allows exactly one terminal event per owner, correlation, and action", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    let sequence = 20;
    const repository = new SqliteAuditRepository(db, {
      id: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    });
    const input = validInput();

    repository.append(input);
    expect(() => repository.append(input)).toThrow(/unique/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_audit_events").get())
      .toEqual({ count: 1 });

    repository.append({
      ...input,
      action: "connector.operation.create",
      resource: {
        kind: "operation_version",
        id: OPERATION_ID,
        versionId: VERSION_ID,
        projectionHash: HASH_A,
        schemaHash: HASH_B,
      },
      connection: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_audit_events").get())
      .toEqual({ count: 2 });
  });

  it("records fixed refusal codes and bounded public connection metadata", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const input = validInput();

    const event = repository.append({
      ...input,
      action: "connector.simulation",
      resource: {
        kind: "simulation",
        id: SIMULATION_ID,
        versionId: VERSION_ID,
        projectionHash: HASH_A,
        schemaHash: HASH_B,
      },
      outcome: "refused",
      errorCode: "POLICY_REFUSED",
      connection: {
        kind: "custom_headers",
        idSuffix: "a1b2c3d4",
        testSlotStatus: "configured",
      },
    });

    expect(event.outcome).toBe("refused");
    expect(event.errorCode).toBe("POLICY_REFUSED");
    expect(event.connection).toEqual({
      kind: "custom_headers",
      idSuffix: "a1b2c3d4",
      testSlotStatus: "configured",
    });
  });

  it("rejects forged correlation handles and invalid outcome/error combinations", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const input = validInput();

    expect(() => repository.append({
      ...input,
      correlation: Object.freeze({ correlationId: auditCorrelationId(input.correlation) }),
    } as unknown as ControlAuditEventInput)).toThrow("Invalid audit correlation");
    expect(() => repository.append({
      ...input,
      outcome: "completed",
      errorCode: "POLICY_REFUSED",
    } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");
    expect(() => repository.append({
      ...input,
      outcome: "refused",
      errorCode: null,
    } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");
  });

  it("rejects an action mislabeled with another action's resource kind", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const input = validInput();

    expect(() => repository.append({
      ...input,
      resource: { ...input.resource, kind: "operation_version" },
    } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");
  });

  it.each(["connector.operation.create", "connector.simulation"] as const)(
    "requires complete pinned evidence for completed %s events",
    (action) => {
      const db = new Database(":memory:");
      runSqliteMigrations(db);
      const repository = new SqliteAuditRepository(db);
      const kind = action === "connector.operation.create" ? "operation_version" : "simulation";
      const id = action === "connector.operation.create" ? OPERATION_ID : SIMULATION_ID;
      const complete = {
        ...validInput(),
        action,
        resource: {
          kind,
          id,
          versionId: VERSION_ID,
          projectionHash: HASH_A,
          schemaHash: HASH_B,
        },
        connection: null,
      };

      for (const field of ["versionId", "projectionHash", "schemaHash"] as const) {
        expect(() => repository.append({
          ...complete,
          resource: { ...complete.resource, [field]: null },
        } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM control_audit_events").get())
        .toEqual({ count: 0 });
    },
  );

  it("requires connector version and projection evidence without a schema hash for completed imports", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const complete = validInput();

    for (const resource of [
      { ...complete.resource, versionId: null },
      { ...complete.resource, projectionHash: null },
      { ...complete.resource, schemaHash: HASH_B },
    ]) {
      expect(() => repository.append({
        ...complete,
        resource,
      } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_audit_events").get())
      .toEqual({ count: 0 });
  });

  it.each(["connector.import", "connector.operation.create"] as const)(
    "rejects connection metadata for the %s action",
    (action) => {
      const db = new Database(":memory:");
      runSqliteMigrations(db);
      const repository = new SqliteAuditRepository(db);
      const input = validInput();
      const resource = action === "connector.import" ? input.resource : {
        kind: "operation_version" as const,
        id: OPERATION_ID,
        versionId: VERSION_ID,
        projectionHash: HASH_A,
        schemaHash: HASH_B,
      };

      expect(() => repository.append({
        ...input,
        action,
        resource,
        connection: { kind: "bearer", idSuffix: "a1b2c3d4", testSlotStatus: "configured" },
      } as unknown as ControlAuditEventInput)).toThrow("Invalid control audit event");
    },
  );

  it("allows refused operation evidence to remain partial", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteAuditRepository(db);
    const event = repository.append({
      ...validInput(),
      action: "connector.operation.create",
      resource: {
        kind: "operation_version",
        id: OPERATION_ID,
        versionId: null,
        projectionHash: null,
        schemaHash: null,
      },
      outcome: "refused",
      errorCode: "PROJECTION_REFUSED",
      connection: null,
    });

    expect(event.resource.versionId).toBeNull();
  });
});
