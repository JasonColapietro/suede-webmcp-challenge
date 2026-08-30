import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { ConnectorImportService } from "./import-service";
import { SqliteConnectorRepository } from "./sqlite-repository";
import type { CloseableConnectorRepository } from "./repository";

export const CONNECTOR_REPOSITORY_UNAVAILABLE = "Connector service unavailable";

export class ConnectorRepositoryUnavailableError extends Error {
  readonly code = "CONNECTOR_REPOSITORY_UNAVAILABLE";
  constructor() {
    super(CONNECTOR_REPOSITORY_UNAVAILABLE);
    this.name = "ConnectorRepositoryUnavailableError";
  }
}

export type ConnectorRepositoryAvailability = Readonly<{ available: true }> | Readonly<{ available: false }>;
const AVAILABLE = Object.freeze({ available: true as const });
const UNAVAILABLE = Object.freeze({ available: false as const });

function sqlitePath(): string | null {
  if (process.env.DB_DRIVER !== "sqlite") return null;
  const value = process.env.SQLITE_PATH;
  return typeof value === "string" && value.length > 0 && isAbsolute(value) ? value : null;
}

/** Read-only configuration check; never opens or creates storage. */
export function getConnectorRepositoryAvailability(): ConnectorRepositoryAvailability {
  return sqlitePath() === null ? UNAVAILABLE : AVAILABLE;
}

/** Opens exactly one explicitly configured SQLite handle shared by connector and audit writes. */
export async function getConnectorRepository(): Promise<CloseableConnectorRepository> {
  const path = sqlitePath();
  if (path === null) throw new ConnectorRepositoryUnavailableError();
  let db: Database.Database | null = null;
  try {
    db = new Database(path);
    runSqliteMigrations(db);
    const repository = new SqliteConnectorRepository(db, { ownsDatabase: true });
    db = null;
    return repository;
  } catch {
    try { db?.close(); } catch { /* fixed unavailable result */ }
    throw new ConnectorRepositoryUnavailableError();
  }
}

export async function getConnectorImportService(): Promise<ConnectorImportService> {
  return new ConnectorImportService(await getConnectorRepository());
}
