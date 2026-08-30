import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  AUDIT_ACTIONS,
  AUDIT_CONNECTION_KINDS,
  AUDIT_ERROR_CODES,
  AUDIT_RESOURCE_KINDS,
  type AuditConnectionMetadata,
  type AuditErrorCode,
  type AuditResource,
  type ControlAuditEvent,
} from "./types";
import {
  readAuditCorrelation,
  type AuditRepository,
  type ControlAuditEventInput,
} from "./repository";

const INVALID_EVENT = "Invalid control audit event";
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_SUFFIX = /^[0-9A-Za-z_-]{4,12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_DURATION_MS = 86_400_000;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

interface SqliteAuditRepositoryOptions {
  readonly id?: () => string;
  readonly now?: () => number;
}

function fail(): never {
  throw new TypeError(INVALID_EVENT);
}

function exactDataDescriptors(
  value: unknown,
  keys: readonly string[],
): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    if (Object.getOwnPropertySymbols(value).length !== 0) fail();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail();
  }
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index]) ||
      expected.some((key) => !("value" in descriptors[key]!) || descriptors[key]!.enumerable !== true)) {
    fail();
  }
  return descriptors;
}

function serverId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value;
}

function optionalHash(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !LOWERCASE_SHA256.test(value)) fail();
  return value;
}

function parseResource(value: unknown): AuditResource {
  const descriptors = exactDataDescriptors(
    value,
    ["kind", "id", "versionId", "projectionHash", "schemaHash"],
  );
  const kind = descriptors.kind!.value;
  if (typeof kind !== "string" || !AUDIT_RESOURCE_KINDS.includes(kind as never)) fail();
  const versionValue = descriptors.versionId!.value;
  const versionId = versionValue === null ? null : serverId(versionValue);
  return Object.freeze({
    kind: kind as AuditResource["kind"],
    id: serverId(descriptors.id!.value),
    versionId,
    projectionHash: optionalHash(descriptors.projectionHash!.value),
    schemaHash: optionalHash(descriptors.schemaHash!.value),
  });
}

function parseConnection(value: unknown): AuditConnectionMetadata | null {
  if (value === null) return null;
  const descriptors = exactDataDescriptors(value, ["kind", "idSuffix", "testSlotStatus"]);
  const kind = descriptors.kind!.value;
  const idSuffix = descriptors.idSuffix!.value;
  const testSlotStatus = descriptors.testSlotStatus!.value;
  if (typeof kind !== "string" || !AUDIT_CONNECTION_KINDS.includes(kind as never) ||
      typeof idSuffix !== "string" || !SAFE_SUFFIX.test(idSuffix) ||
      (testSlotStatus !== "configured" && testSlotStatus !== "missing" && testSlotStatus !== "revoked")) {
    fail();
  }
  return Object.freeze({
    kind: kind as AuditConnectionMetadata["kind"],
    idSuffix,
    testSlotStatus,
  });
}

function parseInput(input: unknown): ControlAuditEventInput {
  const descriptors = exactDataDescriptors(
    input,
    ["correlation", "action", "resource", "outcome", "errorCode", "connection", "durationMs"],
  );
  const action = descriptors.action!.value;
  const outcome = descriptors.outcome!.value;
  const errorCode = descriptors.errorCode!.value;
  const durationMs = descriptors.durationMs!.value;
  if (typeof action !== "string" || !AUDIT_ACTIONS.includes(action as never) ||
      (outcome !== "completed" && outcome !== "refused") ||
      (errorCode !== null && (typeof errorCode !== "string" || !AUDIT_ERROR_CODES.includes(errorCode as never))) ||
      (outcome === "completed") !== (errorCode === null) ||
      !Number.isSafeInteger(durationMs) || (durationMs as number) < 0 ||
      (durationMs as number) > MAX_DURATION_MS) {
    fail();
  }
  const resource = parseResource(descriptors.resource!.value);
  const expectedResourceKind = action === "connector.import"
    ? "connector_definition"
    : action === "connector.operation.create"
      ? "operation_version"
      : "simulation";
  if (resource.kind !== expectedResourceKind) fail();
  const connection = parseConnection(descriptors.connection!.value);
  if (action !== "connector.simulation" && connection !== null) fail();
  if (outcome === "completed") {
    if (action === "connector.import") {
      if (resource.versionId === null || resource.projectionHash === null || resource.schemaHash !== null) fail();
    } else if (resource.versionId === null || resource.projectionHash === null || resource.schemaHash === null) {
      fail();
    }
  }
  return Object.freeze({
    correlation: descriptors.correlation!.value as ControlAuditEventInput["correlation"],
    action: action as ControlAuditEventInput["action"],
    resource,
    outcome,
    errorCode: errorCode as AuditErrorCode | null,
    connection,
    durationMs: durationMs as number,
  }) as ControlAuditEventInput;
}

function safeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value;
}

function safeTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_TIMESTAMP) fail();
  return value as number;
}

export class SqliteAuditRepository implements AuditRepository {
  readonly #db: Database.Database;
  readonly #id: () => string;
  readonly #now: () => number;

  constructor(db: Database.Database, options: SqliteAuditRepositoryOptions = {}) {
    this.#db = db;
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  append(rawInput: ControlAuditEventInput): ControlAuditEvent {
    const input = parseInput(rawInput);
    const correlation = readAuditCorrelation(input.correlation);
    const id = safeUuid(this.#id());
    const at = safeTimestamp(this.#now());
    const connection = input.connection;
    this.#db.prepare(`INSERT INTO control_audit_events (
      id, schema_version, owner_id, actor_id, correlation_id, action,
      resource_kind, resource_id, resource_version_id, projection_hash, schema_hash,
      outcome, error_code, effect, connection_kind, connection_suffix,
      test_slot_status, duration_ms, egress_count, cost_micro_usdc, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'write', ?, ?, ?, ?, 0, 0, ?)`)
      .run(
        id,
        correlation.ownerId,
        correlation.actorId,
        correlation.id,
        input.action,
        input.resource.kind,
        input.resource.id,
        input.resource.versionId,
        input.resource.projectionHash,
        input.resource.schemaHash,
        input.outcome,
        input.errorCode,
        connection?.kind ?? null,
        connection?.idSuffix ?? null,
        connection?.testSlotStatus ?? null,
        input.durationMs,
        at,
      );

    return Object.freeze({
      id,
      schemaVersion: 1 as const,
      ownerId: correlation.ownerId,
      actorId: correlation.actorId,
      correlationId: correlation.id,
      action: input.action,
      resource: input.resource,
      outcome: input.outcome,
      errorCode: input.errorCode,
      effect: "write" as const,
      connection,
      durationMs: input.durationMs,
      egressCount: 0 as const,
      costUsdc: 0 as const,
      at,
    }) as ControlAuditEvent;
  }
}
