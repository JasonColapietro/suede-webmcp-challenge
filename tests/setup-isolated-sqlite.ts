import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * A test file that does not choose a database must never fall back to the
 * repository's ignored `studio.db`. Give that file a disposable SQLite
 * directory and restore the incoming environment after its suite finishes.
 * Tests that deliberately provide SQLITE_PATH keep full control of it.
 */
const previousDriver = process.env.DB_DRIVER;
const previousSqlitePath = process.env.SQLITE_PATH;
const ownsIsolation = !previousSqlitePath;
const directory = ownsIsolation
  ? mkdtempSync(join(tmpdir(), `suede-vitest-${process.pid}-`))
  : null;

if (directory) {
  process.env.DB_DRIVER = "sqlite";
  process.env.SQLITE_PATH = join(directory, "studio.db");
}

afterAll(() => {
  if (!directory) return;

  if (existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true });
  }

  if (previousDriver === undefined) delete process.env.DB_DRIVER;
  else process.env.DB_DRIVER = previousDriver;

  if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = previousSqlitePath;
});
