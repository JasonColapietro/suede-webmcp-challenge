import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  ConnectionRepositoryUnavailableError,
  getConnectionRepository,
  getConnectionRepositoryAvailability,
} from "@/lib/connections/provider";

const roots: string[] = [];
const VALID_KEY = "07".repeat(32);

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "connection-provider-"));
  roots.push(root);
  return root;
}

function related(path: string): readonly string[] {
  return [path, `${path}-wal`, `${path}-shm`];
}

function fingerprint(path: string): Readonly<{ type: string; size: number; sha256: string | null }> | null {
  try {
    const stat = lstatSync(path);
    const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
    return Object.freeze({
      type,
      size: stat.size,
      sha256: stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null,
    });
  } catch {
    return null;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("connection repository provider", () => {
  it.each([
    ["missing driver", undefined, "/tmp/connection-provider-missing-driver.sqlite", VALID_KEY],
    ["unsupported postgres", "postgres", "/tmp/connection-provider-postgres.sqlite", VALID_KEY],
    ["missing path", "sqlite", undefined, VALID_KEY],
    ["relative path", "sqlite", "studio.db", VALID_KEY],
    ["missing key", "sqlite", "/tmp/connection-provider-missing-key.sqlite", undefined],
    ["short key", "sqlite", "/tmp/connection-provider-short-key.sqlite", "07"],
    ["uppercase key", "sqlite", "/tmp/connection-provider-uppercase-key.sqlite", "AB".repeat(32)],
    ["zero key", "sqlite", "/tmp/connection-provider-zero-key.sqlite", "00".repeat(32)],
  ] as const)("fails closed for %s without opening SQLite", async (_case, driver, path, key) => {
    const root = temporaryRoot();
    const target = path?.startsWith("/tmp/connection-provider-") ? join(root, "blocked.sqlite") : path;
    vi.stubEnv("DB_DRIVER", driver);
    vi.stubEnv("SQLITE_PATH", path === undefined ? undefined : target);
    vi.stubEnv("CONNECTION_ENCRYPTION_KEY", key);
    const defaultPaths = related(join(process.cwd(), "studio.db"));
    const beforeDefault = defaultPaths.map(fingerprint);
    const blockedPaths = target && target !== "studio.db" ? related(target) : [];
    const availability = getConnectionRepositoryAvailability();
    expect(availability).toEqual({ available: false });
    expect(Object.isFrozen(availability)).toBe(true);
    let failure: unknown;
    try {
      await getConnectionRepository();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConnectionRepositoryUnavailableError);
    expect((failure as Error).message).toBe("Connection service unavailable");
    const serializedFailure = JSON.stringify(failure);
    if (target) expect(serializedFailure).not.toContain(target);
    if (key) expect(serializedFailure).not.toContain(key);
    expect(blockedPaths.every((candidate) => !existsSync(candidate))).toBe(true);
    expect(defaultPaths.map(fingerprint)).toEqual(beforeDefault);
  });

  it.each([
    ["missing remote configuration", VALID_KEY, undefined, undefined, undefined, undefined],
    ["missing encryption key", undefined, "https://supabase.example.test", undefined, "anon-key", "strong-shared-request-secret-0123456789"],
    ["short encryption key", "07", "https://supabase.example.test", undefined, "anon-key", "strong-shared-request-secret-0123456789"],
    ["zero encryption key", "00".repeat(32), "https://supabase.example.test", undefined, "anon-key", "strong-shared-request-secret-0123456789"],
    ["dedicated service-role storage", VALID_KEY, "https://supabase.example.test", "service-role", undefined, undefined],
  ] as const)("fails closed for Supabase with %s", async (_case, key, url, serviceRole, anonKey, requestSecret) => {
    vi.stubEnv("DB_DRIVER", "supabase");
    vi.stubEnv("CONNECTION_ENCRYPTION_KEY", key);
    vi.stubEnv("SUPABASE_URL", url);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRole);
    vi.stubEnv("SUPABASE_ANON_KEY", anonKey);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", undefined);
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", requestSecret);

    expect(getConnectionRepositoryAvailability()).toEqual({ available: false });
    await expect(getConnectionRepository()).rejects.toBeInstanceOf(ConnectionRepositoryUnavailableError);
  });

  it("opens independent Supabase repositories only with the reviewed shared-runtime bridge", async () => {
    vi.stubEnv("DB_DRIVER", "supabase");
    vi.stubEnv("CONNECTION_ENCRYPTION_KEY", VALID_KEY);
    vi.stubEnv("SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "must-not-use-for-connections");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", undefined);
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", "strong-shared-request-secret-0123456789");

    expect(getConnectionRepositoryAvailability()).toEqual({ available: true });
    const first = await getConnectionRepository();
    const second = await getConnectionRepository();
    expect(second).not.toBe(first);
    first.close();
    second.dispose();
    await expect(first.list("owner-a", { limit: 1 })).rejects.toBeInstanceOf(
      ConnectionRepositoryUnavailableError,
    );
    await expect(second.get("owner-a", "connection")).rejects.toBeInstanceOf(
      ConnectionRepositoryUnavailableError,
    );
  });

  it("keeps availability read-only and opens only an explicit disposable SQLite path", async () => {
    const root = temporaryRoot();
    const path = join(root, "connections.sqlite");
    vi.stubEnv("DB_DRIVER", "sqlite");
    vi.stubEnv("SQLITE_PATH", path);
    vi.stubEnv("CONNECTION_ENCRYPTION_KEY", VALID_KEY);
    expect(getConnectionRepositoryAvailability()).toEqual({ available: true });
    expect(related(path).every((candidate) => !existsSync(candidate))).toBe(true);
    const repository = await getConnectionRepository();
    expect(existsSync(path)).toBe(true);
    const created = await repository.create("owner-a", {
      name: "Bearer",
      kind: "bearer",
      publicConfig: {},
    }, 1);
    expect(created.slots.live.status).toBe("missing");
    repository.close();
    repository.close();
    await expect(repository.get("owner-a", created.id)).rejects.toBeInstanceOf(
      ConnectionRepositoryUnavailableError,
    );
  });

  it("retries disposal when closing its owned database initially fails", async () => {
    const root = temporaryRoot();
    const path = join(root, "retry-close.sqlite");
    vi.stubEnv("DB_DRIVER", "sqlite");
    vi.stubEnv("SQLITE_PATH", path);
    vi.stubEnv("CONNECTION_ENCRYPTION_KEY", VALID_KEY);
    const repository = await getConnectionRepository();
    const originalClose = Database.prototype.close;
    let closeCalls = 0;
    const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error("close-canary");
      return originalClose.call(this);
    });

    try {
      expect(() => repository.close()).toThrow("Connection service unavailable");
      await expect(repository.list("owner-a", { limit: 1 })).rejects.toBeInstanceOf(
        ConnectionRepositoryUnavailableError,
      );
      expect(() => repository.dispose()).not.toThrow();
      expect(() => repository.close()).not.toThrow();
      expect(closeCalls).toBe(2);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("opens each explicit configuration independently without a production singleton", async () => {
    const root = temporaryRoot();
    const firstPath = join(root, "first.sqlite");
    const secondPath = join(root, "second.sqlite");
    vi.stubEnv("DB_DRIVER", "sqlite");
    vi.stubEnv("SQLITE_PATH", firstPath);
    vi.stubEnv("CONNECTION_ENCRYPTION_KEY", VALID_KEY);
    const first = await getConnectionRepository();
    const second = await getConnectionRepository();
    expect(second).not.toBe(first);
    const created = await first.create("owner-a", { name: "First", kind: "bearer", publicConfig: {} }, 1);
    expect(await second.get("owner-a", created.id)).not.toBeNull();
    vi.stubEnv("SQLITE_PATH", secondPath);
    const drifted = await getConnectionRepository();
    expect(drifted).not.toBe(first);
    expect(existsSync(secondPath)).toBe(true);
    first.close();
    second.dispose();
    drifted.close();
  });
});
