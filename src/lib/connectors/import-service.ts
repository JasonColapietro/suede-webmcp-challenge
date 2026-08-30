import { randomUUID } from "node:crypto";
import {
  auditCorrelationId,
  createAuditCorrelation,
  type ControlAuditEventInput,
} from "@/lib/audit/repository";
import type { AuditErrorCode } from "@/lib/audit/types";
import {
  compileOpenApi310,
  type CompileOpenApi310Options,
  type OpenApiCompileFailureCode,
  type OpenApiCompileResult,
} from "./openapi/compile";
import type {
  CloseableConnectorRepository,
  ConnectorRepository,
  ConnectorRepositoryTransaction,
  ConnectorDriftReceipt,
  DefinitionDisposition,
} from "./repository";
import type {
  ConnectorDefinitionVersionV1,
  OperationVersionV1,
  UnverifiedAuthorAnnotationV1,
} from "./types";

export type ConnectorImportFailureCode =
  | OpenApiCompileFailureCode
  | "INVALID_IMPORT_REQUEST"
  | "RATE_REFUSED"
  | "CONNECTOR_NOT_FOUND"
  | "CONNECTOR_ANNOTATION_CONFLICT"
  | "AUDIT_UNAVAILABLE"
  | "PERSISTENCE_REFUSED";

export interface ConnectorImportSuccess {
  readonly ok: true;
  readonly correlationId: string;
  readonly identity: {
    readonly id: string;
    readonly displayLabel: string;
    readonly archivedAt: number | null;
    readonly lifecycleRevision: number;
    readonly createdAt: number;
    readonly updatedAt: number;
  };
  readonly definition: ConnectorDefinitionVersionV1;
  readonly operation: OperationVersionV1;
  readonly identityDisposition: "created" | "reused";
  readonly definitionDisposition: DefinitionDisposition;
  readonly operationDisposition: "created" | "reused";
  readonly drift: ConnectorDriftReceipt | null;
}

export type ConnectorImportResult = ConnectorImportSuccess | Readonly<{
  ok: false;
  code: ConnectorImportFailureCode;
  correlationId?: string;
}>;

export interface ConnectorImportRequest {
  readonly ownerId: string;
  readonly actorId: string;
  readonly source: string | Uint8Array;
  readonly selectedOperationId: string;
  readonly displayLabel: string;
  readonly connectorId?: string;
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
  readonly signal?: AbortSignal;
}

export interface ConnectorImportReviewRequest {
  readonly ownerId: string;
  readonly actorId: string;
  readonly source: string | Uint8Array;
  readonly displayLabel: string;
  readonly connectorId?: string;
  readonly signal?: AbortSignal;
}

export type ConnectorImportReviewResult =
  | Readonly<{
      ok: true;
      correlationId: string;
      identity: ConnectorImportSuccess["identity"];
      definition: Readonly<{
        id: string;
        connectorId: string;
        versionNumber: number;
        connectorProjectionHash: string;
      }>;
      identityDisposition: "created" | "reused";
      definitionDisposition: DefinitionDisposition;
      drift: ConnectorDriftReceipt | null;
      connectorProjectionHash: string;
      operations: readonly Readonly<{
        operationId: string;
        method: string;
        path: string;
        operationProjectionHash: string;
        schemaHash: string;
      }>[];
      refusedOperations: readonly Readonly<{ operationId: string; method: string; path: string; code: string }>[];
    }>
  | Readonly<{ ok: false; code: ConnectorImportFailureCode; correlationId?: string }>;

export interface StoredOperationRequest {
  readonly ownerId: string;
  readonly actorId: string;
  readonly connectorDefinitionVersionId: string;
  readonly operationId: string;
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
  readonly signal?: AbortSignal;
}

export type StoredOperationResult =
  | Readonly<{
      ok: true;
      correlationId: string;
      operation: OperationVersionV1;
      disposition: "created" | "reused";
    }>
  | Readonly<{
      ok: false;
      code: "INVALID_IMPORT_REQUEST" | "IMPORT_CANCELLED" | "CONNECTOR_NOT_FOUND" |
        "CONNECTOR_ANNOTATION_CONFLICT" | "AUDIT_UNAVAILABLE" | "PERSISTENCE_REFUSED";
      correlationId?: string;
    }>;

interface ConnectorImportServiceOptions {
  readonly id?: () => string;
  readonly now?: () => number;
  readonly compile?: (source: string | Uint8Array, options?: CompileOpenApi310Options) => OpenApiCompileResult;
}

class ImportCancelled extends Error {}
class AuditUnavailable extends Error {}

const CONTROL = /[\u0000-\u001f\u007f]/u;

function descriptors(value: unknown): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("Invalid import request");
  const result = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(result)) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Invalid import request");
  }
  return result;
}

function boundedText(value: unknown, bytes: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || CONTROL.test(value) ||
      Buffer.byteLength(value, "utf8") > bytes) throw new TypeError("Invalid import request");
  return value;
}

function parseRequest(value: unknown): ConnectorImportRequest {
  const source = descriptors(value);
  const allowed = new Set([
    "ownerId", "actorId", "source", "selectedOperationId", "displayLabel",
    "connectorId", "authorAnnotation", "signal",
  ]);
  const required = ["ownerId", "actorId", "source", "selectedOperationId", "displayLabel"];
  if (required.some((key) => !Object.hasOwn(source, key)) || Object.keys(source).some((key) => !allowed.has(key))) {
    throw new TypeError("Invalid import request");
  }
  const rawSource = source.source!.value;
  if (typeof rawSource !== "string" && !(rawSource instanceof Uint8Array)) throw new TypeError("Invalid import request");
  const connectorId = source.connectorId?.value;
  if (connectorId !== undefined) boundedText(connectorId, 512);
  const signal = source.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid import request");
  return Object.freeze({
    ownerId: boundedText(source.ownerId!.value, 512),
    actorId: boundedText(source.actorId!.value, 512),
    source: rawSource,
    selectedOperationId: boundedText(source.selectedOperationId!.value, 512),
    displayLabel: boundedText(source.displayLabel!.value, 120),
    ...(connectorId === undefined ? {} : { connectorId }),
    ...(source.authorAnnotation === undefined ? {} : { authorAnnotation: source.authorAnnotation.value as UnverifiedAuthorAnnotationV1 }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function parseReviewRequest(value: unknown): ConnectorImportReviewRequest {
  const source = descriptors(value);
  const allowed = new Set(["ownerId", "actorId", "source", "displayLabel", "connectorId", "signal"]);
  if (["ownerId", "actorId", "source", "displayLabel"].some((key) => !Object.hasOwn(source, key)) ||
      Object.keys(source).some((key) => !allowed.has(key))) {
    throw new TypeError("Invalid import request");
  }
  const rawSource = source.source!.value;
  const signal = source.signal?.value;
  if ((typeof rawSource !== "string" && !(rawSource instanceof Uint8Array)) ||
      (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError("Invalid import request");
  const connectorId = source.connectorId?.value;
  return Object.freeze({
    ownerId: boundedText(source.ownerId!.value, 512),
    actorId: boundedText(source.actorId!.value, 512),
    source: rawSource,
    displayLabel: boundedText(source.displayLabel!.value, 120),
    ...(connectorId === undefined ? {} : { connectorId: boundedText(connectorId, 512) }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function recoverAuditIdentity(value: unknown): { ownerId: string; actorId: string; signal?: AbortSignal } | null {
  try {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
    const owner = Object.getOwnPropertyDescriptor(value, "ownerId");
    const actor = Object.getOwnPropertyDescriptor(value, "actorId");
    if (!owner || !("value" in owner) || !owner.enumerable ||
        !actor || !("value" in actor) || !actor.enumerable) return null;
    const signalDescriptor = Object.getOwnPropertyDescriptor(value, "signal");
    const signalValue = signalDescriptor && "value" in signalDescriptor
      ? signalDescriptor.value
      : undefined;
    const signal = signalValue instanceof AbortSignal ? signalValue : undefined;
    return {
      ownerId: boundedText(owner.value, 512),
      actorId: boundedText(actor.value, 512),
      ...(signal === undefined ? {} : { signal }),
    };
  } catch {
    return null;
  }
}

function parseStoredOperationRequest(value: unknown): StoredOperationRequest {
  const source = descriptors(value);
  const allowed = new Set([
    "ownerId", "actorId", "connectorDefinitionVersionId", "operationId", "authorAnnotation", "signal",
  ]);
  const required = ["ownerId", "actorId", "connectorDefinitionVersionId", "operationId"];
  if (required.some((key) => !Object.hasOwn(source, key)) || Object.keys(source).some((key) => !allowed.has(key))) {
    throw new TypeError("Invalid import request");
  }
  const signal = source.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid import request");
  return Object.freeze({
    ownerId: boundedText(source.ownerId!.value, 512),
    actorId: boundedText(source.actorId!.value, 512),
    connectorDefinitionVersionId: boundedText(source.connectorDefinitionVersionId!.value, 512),
    operationId: boundedText(source.operationId!.value, 512),
    ...(source.authorAnnotation === undefined ? {} : { authorAnnotation: source.authorAnnotation.value as UnverifiedAuthorAnnotationV1 }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function auditCode(code: OpenApiCompileFailureCode): AuditErrorCode {
  if (code === "COMPILER_DEADLINE") return "TIMEOUT_REFUSED";
  if (code === "INVALID_JSON" || code === "DUPLICATE_JSON_KEY" || code === "INPUT_BYTES_LIMIT" ||
      code === "JSON_DEPTH_LIMIT" || code === "JSON_ENTRY_LIMIT" || code === "INSPECTED_VALUE_LIMIT") {
    return "PARSE_REFUSED";
  }
  return "PROJECTION_REFUSED";
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportCancelled();
}

export class ConnectorImportService {
  readonly #repository: ConnectorRepository;
  readonly #id: () => string;
  readonly #now: () => number;
  readonly #compile: (source: string | Uint8Array, options?: CompileOpenApi310Options) => OpenApiCompileResult;

  constructor(repository: ConnectorRepository, options: ConnectorImportServiceOptions = {}) {
    this.#repository = repository;
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#compile = options.compile ?? compileOpenApi310;
  }

  #append(transaction: ConnectorRepositoryTransaction, input: ControlAuditEventInput): void {
    try {
      transaction.appendAudit(input);
    } catch {
      throw new AuditUnavailable();
    }
  }

  reviewOpenApi(rawRequest: unknown): ConnectorImportReviewResult {
    let request: ConnectorImportReviewRequest;
    try { request = parseReviewRequest(rawRequest); } catch {
      const recovered = recoverAuditIdentity(rawRequest);
      if (!recovered) return Object.freeze({ ok: false, code: "INVALID_IMPORT_REQUEST" });
      if (recovered.signal?.aborted) return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
      const correlation = createAuditCorrelation(recovered.ownerId, recovered.actorId);
      const correlationId = auditCorrelationId(correlation);
      try {
        this.#repository.immediate((transaction) => this.#append(transaction, {
          correlation, action: "connector.import",
          resource: { kind: "connector_definition", id: this.#id(), versionId: null, projectionHash: null, schemaHash: null },
          outcome: "refused", errorCode: "POLICY_REFUSED", connection: null, durationMs: 0,
        }));
      } catch { return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" }); }
      return Object.freeze({ ok: false, code: "INVALID_IMPORT_REQUEST", correlationId });
    }
    if (request.signal?.aborted) return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
    const correlation = createAuditCorrelation(request.ownerId, request.actorId);
    const correlationId = auditCorrelationId(correlation);
    const startedAt = this.#now();
    const duration = (): number => Math.max(0, this.#now() - startedAt);
    const connectorId = request.connectorId ?? this.#id();
    try {
      return this.#repository.immediate((transaction): ConnectorImportReviewResult => {
        abortIfNeeded(request.signal);
        if (!transaction.reserveImport({ id: this.#id(), ownerId: request.ownerId, correlationId, now: startedAt })) {
          this.#append(transaction, { correlation, action: "connector.import",
            resource: { kind: "connector_definition", id: connectorId, versionId: null, projectionHash: null, schemaHash: null },
            outcome: "refused", errorCode: "RATE_REFUSED", connection: null, durationMs: duration() });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code: "RATE_REFUSED", correlationId });
        }
        const compiled = this.#compile(request.source, { signal: request.signal });
        abortIfNeeded(request.signal);
        if (!compiled.ok) {
          if (compiled.code === "IMPORT_CANCELLED") throw new ImportCancelled();
          this.#append(transaction, { correlation, action: "connector.import",
            resource: { kind: "connector_definition", id: connectorId, versionId: null, projectionHash: null, schemaHash: null },
            outcome: "refused", errorCode: auditCode(compiled.code), connection: null, durationMs: duration() });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code: compiled.code, correlationId });
        }
        const persisted = transaction.persistCompiledDefinition({
          ownerId: request.ownerId, connectorId: request.connectorId ?? null,
          newConnectorId: request.connectorId === undefined ? connectorId : this.#id(), definitionVersionId: this.#id(),
          displayLabel: request.displayLabel, connectorProjection: compiled.connectorProjection,
          connectorProjectionHash: compiled.connectorProjectionHash, now: startedAt,
        });
        if (persisted.status !== "ok") {
          this.#append(transaction, { correlation, action: "connector.import",
            resource: { kind: "connector_definition", id: connectorId, versionId: null, projectionHash: null, schemaHash: null },
            outcome: "refused", errorCode: "PERSISTENCE_REFUSED", connection: null, durationMs: duration() });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code: "CONNECTOR_NOT_FOUND", correlationId });
        }
        this.#append(transaction, { correlation, action: "connector.import",
          resource: { kind: "connector_definition", id: persisted.identity.id, versionId: persisted.definition.id,
            projectionHash: persisted.definition.connectorProjectionHash, schemaHash: null },
          outcome: "completed", errorCode: null, connection: null, durationMs: duration() });
        abortIfNeeded(request.signal);
        return Object.freeze({ ok: true, correlationId, identity: persisted.identity, definition: Object.freeze({
          id: persisted.definition.id, connectorId: persisted.definition.connectorId,
          versionNumber: persisted.definition.versionNumber,
          connectorProjectionHash: persisted.definition.connectorProjectionHash,
        }),
          identityDisposition: persisted.identityDisposition, definitionDisposition: persisted.definitionDisposition,
          drift: persisted.drift, connectorProjectionHash: compiled.connectorProjectionHash,
          operations: Object.freeze(compiled.operations.map((operation) => Object.freeze({ operationId: operation.operationId,
            method: operation.projection.method, path: operation.projection.path,
            operationProjectionHash: operation.operationProjectionHash, schemaHash: operation.schemaHash }))),
          refusedOperations: Object.freeze(compiled.refusedOperations.map((operation) => Object.freeze({ ...operation }))) });
      });
    } catch (error) {
      if (error instanceof ImportCancelled || request.signal?.aborted) return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
      if (error instanceof AuditUnavailable) return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" });
      try {
        this.#repository.immediate((transaction) => this.#append(transaction, {
          correlation, action: "connector.import",
          resource: { kind: "connector_definition", id: connectorId, versionId: null, projectionHash: null, schemaHash: null },
          outcome: "refused", errorCode: "PERSISTENCE_REFUSED", connection: null, durationMs: duration(),
        }));
      } catch { return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" }); }
      return Object.freeze({ ok: false, code: "PERSISTENCE_REFUSED", correlationId });
    }
  }

  importOpenApi(rawRequest: unknown): ConnectorImportResult {
    let request: ConnectorImportRequest;
    try { request = parseRequest(rawRequest); } catch {
      const recovered = recoverAuditIdentity(rawRequest);
      if (!recovered) return Object.freeze({ ok: false, code: "INVALID_IMPORT_REQUEST" });
      if (recovered.signal?.aborted) return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
      const correlation = createAuditCorrelation(recovered.ownerId, recovered.actorId);
      const correlationId = auditCorrelationId(correlation);
      const resourceId = this.#id();
      try {
        this.#repository.immediate((transaction) => this.#append(transaction, {
          correlation,
          action: "connector.import",
          resource: { kind: "connector_definition", id: resourceId, versionId: null, projectionHash: null, schemaHash: null },
          outcome: "refused",
          errorCode: "POLICY_REFUSED",
          connection: null,
          durationMs: 0,
        }));
      } catch {
        return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" });
      }
      return Object.freeze({ ok: false, code: "INVALID_IMPORT_REQUEST", correlationId });
    }
    if (request.signal?.aborted) return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });

    const correlation = createAuditCorrelation(request.ownerId, request.actorId);
    const correlationId = auditCorrelationId(correlation);
    const startedAt = this.#now();
    const connectorId = request.connectorId ?? this.#id();
    const newConnectorId = request.connectorId === undefined ? connectorId : this.#id();
    const definitionVersionId = this.#id();
    const operationVersionId = this.#id();
    const reservationId = this.#id();
    const duration = (): number => Math.max(0, this.#now() - startedAt);

    try {
      return this.#repository.immediate((transaction): ConnectorImportResult => {
        abortIfNeeded(request.signal);
        const reserved = transaction.reserveImport({
          id: reservationId,
          ownerId: request.ownerId,
          correlationId,
          now: startedAt,
        });
        if (!reserved) {
          this.#append(transaction, {
            correlation,
            action: "connector.import",
            resource: {
              kind: "connector_definition",
              id: connectorId,
              versionId: null,
              projectionHash: null,
              schemaHash: null,
            },
            outcome: "refused",
            errorCode: "RATE_REFUSED",
            connection: null,
            durationMs: duration(),
          });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code: "RATE_REFUSED", correlationId });
        }

        const compiled = this.#compile(request.source, { signal: request.signal });
        abortIfNeeded(request.signal);
        if (!compiled.ok) {
          if (compiled.code === "IMPORT_CANCELLED") throw new ImportCancelled();
          this.#append(transaction, {
            correlation,
            action: "connector.import",
            resource: {
              kind: "connector_definition",
              id: connectorId,
              versionId: null,
              projectionHash: null,
              schemaHash: null,
            },
            outcome: "refused",
            errorCode: auditCode(compiled.code),
            connection: null,
            durationMs: duration(),
          });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code: compiled.code, correlationId });
        }
        const operation = compiled.operations.find((candidate) => candidate.operationId === request.selectedOperationId);
        if (!operation) {
          this.#append(transaction, {
            correlation,
            action: "connector.import",
            resource: { kind: "connector_definition", id: connectorId, versionId: null, projectionHash: null, schemaHash: null },
            outcome: "refused",
            errorCode: "PROJECTION_REFUSED",
            connection: null,
            durationMs: duration(),
          });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code: "MISSING_OPERATION_ID", correlationId });
        }
        const persisted = transaction.persistCompiledImport({
          ownerId: request.ownerId,
          connectorId: request.connectorId ?? null,
          newConnectorId,
          definitionVersionId,
          operationVersionId,
          displayLabel: request.displayLabel,
          connectorProjection: compiled.connectorProjection,
          connectorProjectionHash: compiled.connectorProjectionHash,
          operation,
          ...(request.authorAnnotation === undefined ? {} : { authorAnnotation: request.authorAnnotation }),
          now: startedAt,
        });
        if (persisted.status !== "ok") {
          const code = persisted.status === "not-found" ? "CONNECTOR_NOT_FOUND" : "CONNECTOR_ANNOTATION_CONFLICT";
          this.#append(transaction, {
            correlation,
            action: "connector.import",
            resource: { kind: "connector_definition", id: connectorId, versionId: null, projectionHash: null, schemaHash: null },
            outcome: "refused",
            errorCode: persisted.status === "not-found" ? "PERSISTENCE_REFUSED" : "DRIFT_REFUSED",
            connection: null,
            durationMs: duration(),
          });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code, correlationId });
        }
        this.#append(transaction, {
          correlation,
          action: "connector.import",
          resource: {
            kind: "connector_definition",
            id: persisted.identity.id,
            versionId: persisted.definition.id,
            projectionHash: persisted.definition.connectorProjectionHash,
            schemaHash: null,
          },
          outcome: "completed",
          errorCode: null,
          connection: null,
          durationMs: duration(),
        });
        this.#append(transaction, {
          correlation,
          action: "connector.operation.create",
          resource: {
            kind: "operation_version",
            id: persisted.operation.id,
            versionId: persisted.operation.id,
            projectionHash: persisted.operation.operationProjectionHash,
            schemaHash: persisted.operation.schemaHash,
          },
          outcome: "completed",
          errorCode: null,
          connection: null,
          durationMs: duration(),
        });
        abortIfNeeded(request.signal);
        return Object.freeze({
          ok: true,
          correlationId,
          identity: persisted.identity,
          definition: persisted.definition,
          operation: persisted.operation,
          identityDisposition: persisted.identityDisposition,
          definitionDisposition: persisted.definitionDisposition,
          operationDisposition: persisted.operationDisposition,
          drift: persisted.drift,
        });
      });
    } catch (error) {
      if (error instanceof ImportCancelled || request.signal?.aborted) {
        return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
      }
      if (error instanceof AuditUnavailable) return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" });
      try {
        this.#repository.immediate((transaction) => {
          this.#append(transaction, {
            correlation,
            action: "connector.import",
            resource: { kind: "connector_definition", id: connectorId, versionId: null, projectionHash: null, schemaHash: null },
            outcome: "refused",
            errorCode: "PERSISTENCE_REFUSED",
            connection: null,
            durationMs: duration(),
          });
        });
      } catch {
        return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" });
      }
      return Object.freeze({ ok: false, code: "PERSISTENCE_REFUSED", correlationId });
    }
  }

  addStoredOperation(rawRequest: unknown): StoredOperationResult {
    let request: StoredOperationRequest;
    try { request = parseStoredOperationRequest(rawRequest); } catch {
      const recovered = recoverAuditIdentity(rawRequest);
      if (!recovered) return Object.freeze({ ok: false, code: "INVALID_IMPORT_REQUEST" });
      if (recovered.signal?.aborted) return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
      const correlation = createAuditCorrelation(recovered.ownerId, recovered.actorId);
      const correlationId = auditCorrelationId(correlation);
      const operationVersionId = this.#id();
      try {
        this.#repository.immediate((transaction) => this.#append(transaction, {
          correlation,
          action: "connector.operation.create",
          resource: {
            kind: "operation_version",
            id: operationVersionId,
            versionId: null,
            projectionHash: null,
            schemaHash: null,
          },
          outcome: "refused",
          errorCode: "POLICY_REFUSED",
          connection: null,
          durationMs: 0,
        }));
      } catch {
        return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" });
      }
      return Object.freeze({ ok: false, code: "INVALID_IMPORT_REQUEST", correlationId });
    }
    if (request.signal?.aborted) return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
    const correlation = createAuditCorrelation(request.ownerId, request.actorId);
    const correlationId = auditCorrelationId(correlation);
    const operationVersionId = this.#id();
    const startedAt = this.#now();
    const duration = (): number => Math.max(0, this.#now() - startedAt);
    try {
      return this.#repository.immediate((transaction): StoredOperationResult => {
        abortIfNeeded(request.signal);
        const materialized = transaction.materializeStoredOperation({
          ownerId: request.ownerId,
          connectorDefinitionVersionId: request.connectorDefinitionVersionId,
          operationId: request.operationId,
          operationVersionId,
          ...(request.authorAnnotation === undefined ? {} : { authorAnnotation: request.authorAnnotation }),
          now: startedAt,
        });
        if (materialized.status !== "ok") {
          const code = materialized.status === "not-found" ? "CONNECTOR_NOT_FOUND" : "CONNECTOR_ANNOTATION_CONFLICT";
          this.#append(transaction, {
            correlation,
            action: "connector.operation.create",
            resource: { kind: "operation_version", id: operationVersionId, versionId: null, projectionHash: null, schemaHash: null },
            outcome: "refused",
            errorCode: materialized.status === "not-found" ? "PERSISTENCE_REFUSED" : "DRIFT_REFUSED",
            connection: null,
            durationMs: duration(),
          });
          abortIfNeeded(request.signal);
          return Object.freeze({ ok: false, code, correlationId });
        }
        this.#append(transaction, {
          correlation,
          action: "connector.operation.create",
          resource: {
            kind: "operation_version",
            id: materialized.operation.id,
            versionId: materialized.operation.id,
            projectionHash: materialized.operation.operationProjectionHash,
            schemaHash: materialized.operation.schemaHash,
          },
          outcome: "completed",
          errorCode: null,
          connection: null,
          durationMs: duration(),
        });
        abortIfNeeded(request.signal);
        return Object.freeze({
          ok: true,
          correlationId,
          operation: materialized.operation,
          disposition: materialized.disposition,
        });
      });
    } catch (error) {
      if (error instanceof ImportCancelled || request.signal?.aborted) {
        return Object.freeze({ ok: false, code: "IMPORT_CANCELLED" });
      }
      if (error instanceof AuditUnavailable) return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" });
      try {
        this.#repository.immediate((transaction) => this.#append(transaction, {
          correlation,
          action: "connector.operation.create",
          resource: { kind: "operation_version", id: operationVersionId, versionId: null, projectionHash: null, schemaHash: null },
          outcome: "refused",
          errorCode: "PERSISTENCE_REFUSED",
          connection: null,
          durationMs: duration(),
        }));
      } catch {
        return Object.freeze({ ok: false, code: "AUDIT_UNAVAILABLE" });
      }
      return Object.freeze({ ok: false, code: "PERSISTENCE_REFUSED", correlationId });
    }
  }

  close(): void {
    const closeable = this.#repository as Partial<CloseableConnectorRepository>;
    closeable.close?.();
  }

  dispose(): void { this.close(); }
}
