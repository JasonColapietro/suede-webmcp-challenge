import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import { validateApiOperationReference } from "@/lib/connectors/operation-closure";
import { SqliteTestConnectionMetadataReader } from "@/lib/connections/test-metadata-reader";
import {
  checkTestConnectionReadiness,
  READINESS_CANCELLED,
  TEST_CONNECTION_UNAVAILABLE_RESULT,
  type ConnectorReadinessRequest,
  type ConnectorReadinessResult,
} from "@/lib/connectors/readiness";

export interface ConnectorReadinessBackend {
  check(ownerId: string, request: ConnectorReadinessRequest, signal?: AbortSignal): ConnectorReadinessResult;
  close(): void;
}

function sqlitePath(): string | null {
  if (process.env.DB_DRIVER !== "sqlite") return null;
  const value = process.env.SQLITE_PATH;
  return typeof value === "string" && value.length > 0 && isAbsolute(value) ? value : null;
}

export class SqliteConnectorReadinessBackend implements ConnectorReadinessBackend {
  readonly #database: Database.Database;
  readonly #repository: SqliteConnectorRepository;
  #closed = false;

  constructor(database: Database.Database) {
    this.#database = database;
    this.#repository = new SqliteConnectorRepository(database);
  }

  check(ownerId: string, request: ConnectorReadinessRequest, signal?: AbortSignal): ConnectorReadinessResult {
    if (this.#closed) return TEST_CONNECTION_UNAVAILABLE_RESULT;
    if (signal?.aborted) return Object.freeze({ ok: false, code: READINESS_CANCELLED });
    try {
      const transaction = this.#database.transaction(() => {
        const closure = this.#repository.getOperationClosure(ownerId, request.reference.operationVersionId);
        if (!closure) return TEST_CONNECTION_UNAVAILABLE_RESULT;
        const snapshot = validateApiOperationReference(request.reference, closure);
        if (signal?.aborted) return Object.freeze({ ok: false as const, code: READINESS_CANCELLED });
        const common = {
          ownerId,
          operation: Object.freeze({
            reference: snapshot.reference,
            authentication: snapshot.authentication,
            archived: snapshot.identity.archivedAt !== null,
          }),
          ...(request.expectedLifecycleRevision === undefined
            ? {}
            : { expectedLifecycleRevision: request.expectedLifecycleRevision }),
          ...(signal === undefined ? {} : { signal }),
        };
        if (snapshot.authentication.kind === "none") {
          return checkTestConnectionReadiness(common);
        }
        const reader = new SqliteTestConnectionMetadataReader(this.#database);
        return checkTestConnectionReadiness({ ...common, reader });
      });
      return transaction.immediate();
    } catch {
      return signal?.aborted
        ? Object.freeze({ ok: false, code: READINESS_CANCELLED })
        : TEST_CONNECTION_UNAVAILABLE_RESULT;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#repository.close(); } catch { /* terminal close continues */ }
    try { this.#database.close(); } catch { /* fixed terminal result */ }
  }
}

export async function getConnectorReadinessBackend(): Promise<ConnectorReadinessBackend> {
  const path = sqlitePath();
  if (!path) throw new Error("Connector readiness unavailable");
  let database: Database.Database | null = null;
  try {
    database = new Database(path);
    runSqliteMigrations(database);
    const backend = new SqliteConnectorReadinessBackend(database);
    database = null;
    return backend;
  } catch {
    try { database?.close(); } catch { /* fixed unavailable result */ }
    throw new Error("Connector readiness unavailable");
  }
}
