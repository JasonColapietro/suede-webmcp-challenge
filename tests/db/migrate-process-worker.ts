import Database from "better-sqlite3";
import { existsSync, writeFileSync } from "node:fs";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";

const path = process.env.MIGRATE_DB;
const workerId = process.env.MIGRATE_WORKER_ID;
const readyPath = process.env.MIGRATE_READY_PATH;
const releasePath = process.env.MIGRATE_RELEASE_PATH;
if (!path || !workerId || !readyPath || !releasePath) throw new Error("Missing migration worker input");

/*
 * Opens the connection exactly the way SqliteRepo does — WAL, and no explicit
 * busy_timeout, which means better-sqlite3's default 5000ms — because that is
 * the caller Next's prerender reaches through /api/gateway/topup, and the one
 * whose second concurrent build failed.
 *
 * Readiness is signalled BEFORE migrating, unlike the claim worker, so the
 * barrier releases both processes into runSqliteMigrations together. Migrating
 * first would serialise the two and test nothing.
 */
const db = new Database(path);
db.pragma("journal_mode = WAL");
/*
 * How long this caller is willing to wait for the write lock, which selects
 * which half of the race it can survive:
 *   unset -> every repository's real shape: a 5000ms wait, explicit in
 *            SqliteProjectRepo / SqliteDurableRuntimeRepository and inherited
 *            from better-sqlite3's default in SqliteRepo. Serialising the
 *            migrator is enough here, because the loser waits, re-reads the
 *            ledger and applies nothing. Without that serialisation it replayed
 *            a version: "UNIQUE constraint failed: schema_migrations.version".
 *   0     -> a caller unwilling to wait at all. Serialising alone does NOT save
 *            it: the loser is refused instantly with SQLITE_BUSY unless
 *            runSqliteMigrations raises the timeout for the duration. This is
 *            the shape that pins that behaviour down.
 * Set after journal_mode so the pre-barrier WAL write still gets to wait.
 */
const busyTimeoutMs = process.env.MIGRATE_BUSY_TIMEOUT_MS;
if (busyTimeoutMs !== undefined) db.pragma(`busy_timeout = ${Number(busyTimeoutMs)}`);
writeFileSync(readyPath, workerId, "utf8");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);

runSqliteMigrations(db);

const ledger = db
  .prepare("SELECT COUNT(*) AS applied, COUNT(DISTINCT version) AS distinctVersions FROM schema_migrations")
  .get() as { applied: number; distinctVersions: number };
db.close();
process.stdout.write(JSON.stringify({ workerId, ...ledger }));
