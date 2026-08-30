import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import {
  createSharedSupabaseServerClient,
  resolveSharedSupabaseServerConfiguration,
} from "../db/supabase-server-client";
import { parseConnectionEncryptionKey } from "./crypto";
import { SqliteConnectionRepository } from "./sqlite-repository";
import {
  CONNECTION_REPOSITORY_UNAVAILABLE,
  ConnectionRepositoryUnavailableError,
  type CloseableConnectionRepository,
} from "./repository";
import { runSqliteMigrations } from "../db/migrations/sqlite";

export {
  CONNECTION_REPOSITORY_UNAVAILABLE,
  ConnectionRepositoryUnavailableError,
  type CloseableConnectionRepository,
};

export type ConnectionRepositoryAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false }>;

const AVAILABLE = Object.freeze({ available: true as const });
const UNAVAILABLE = Object.freeze({ available: false as const });

interface SqliteConnectionRepositoryConfiguration {
  readonly driver: "sqlite";
  readonly sqlitePath: string;
  readonly key: Buffer;
}

interface SupabaseConnectionRepositoryConfiguration {
  readonly driver: "supabase";
  readonly key: Buffer;
}

type ConnectionRepositoryConfiguration =
  | SqliteConnectionRepositoryConfiguration
  | SupabaseConnectionRepositoryConfiguration;

function configuration(): ConnectionRepositoryConfiguration | null {
  const driver = process.env.DB_DRIVER;
  try {
    const key = parseConnectionEncryptionKey(process.env.CONNECTION_ENCRYPTION_KEY);
    if (driver === "sqlite") {
      const sqlitePath = process.env.SQLITE_PATH;
      if (typeof sqlitePath !== "string" || sqlitePath.length < 1 || !isAbsolute(sqlitePath)) {
        key.fill(0);
        return null;
      }
      return { driver, sqlitePath, key };
    }
    if (driver === "supabase") {
      try {
        resolveSharedSupabaseServerConfiguration();
      } catch {
        key.fill(0);
        return null;
      }
      return { driver, key };
    }
    key.fill(0);
    return null;
  } catch {
    return null;
  }
}

/** Read-only configuration availability. This never opens or creates a database. */
export function getConnectionRepositoryAvailability(): ConnectionRepositoryAvailability {
  const configured = configuration();
  if (!configured) return UNAVAILABLE;
  configured.key.fill(0);
  return AVAILABLE;
}

/**
 * Open one explicitly configured SQLite or Supabase connection repository.
 *
 * No driver fallback, key generation, or process singleton is used.
 */
export async function getConnectionRepository(): Promise<CloseableConnectionRepository> {
  const configured = configuration();
  if (!configured) throw new ConnectionRepositoryUnavailableError();
  if (configured.driver === "supabase") {
    try {
      const { SupabaseConnectionRepository } = await import("./supabase-repository");
      return new SupabaseConnectionRepository(configured.key, createSharedSupabaseServerClient());
    } catch {
      throw new ConnectionRepositoryUnavailableError();
    } finally {
      configured.key.fill(0);
    }
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(configured.sqlitePath);
    runSqliteMigrations(db);
    return new SqliteConnectionRepository(db, configured.key, { ownsDatabase: true });
  } catch {
    try { db?.close(); } catch { /* fixed unavailable result */ }
    throw new ConnectionRepositoryUnavailableError();
  } finally {
    configured.key.fill(0);
  }
}
