import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const original = { DB_DRIVER: process.env.DB_DRIVER, SQLITE_PATH: process.env.SQLITE_PATH, RUNTIME_IDEMPOTENCY_HMAC_KEY: process.env.RUNTIME_IDEMPOTENCY_HMAC_KEY };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe("durable runtime provider", () => {
  it("requires explicit sqlite, an absolute path, and strong key without touching the default database", async () => {
    const defaultPaths = ["studio.db", "studio.db-wal", "studio.db-shm"].map((name) => join(process.cwd(), name));
    const fingerprint = (path: string): Readonly<{ type: string; bytes: Buffer }> | null => {
      try {
        const stat = lstatSync(path);
        const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
        return { type, bytes: stat.isFile() ? readFileSync(path) : Buffer.alloc(0) };
      } catch { return null; }
    };
    const before = defaultPaths.map(fingerprint);
    delete process.env.DB_DRIVER; delete process.env.SQLITE_PATH; delete process.env.RUNTIME_IDEMPOTENCY_HMAC_KEY;
    const provider = await import("@/lib/runtime/provider");
    await expect(provider.getDurableRuntimeRepository()).rejects.toBeInstanceOf(provider.DurableRuntimeUnavailableError);
    expect(defaultPaths.map(fingerprint)).toEqual(before);

    process.env.DB_DRIVER = "supabase";
    process.env.SQLITE_PATH = join(process.cwd(), "studio.db");
    process.env.RUNTIME_IDEMPOTENCY_HMAC_KEY = "0123456789abcdefZYXWVUTSRQPONMLK";
    await expect(provider.getDurableRuntimeRepository()).rejects.toBeInstanceOf(provider.DurableRuntimeUnavailableError);
    expect(defaultPaths.map(fingerprint)).toEqual(before);
  });

  it("coalesces concurrent initialization and rejects later configuration drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "durable-provider-")); roots.push(root);
    process.env.DB_DRIVER = "sqlite";
    process.env.SQLITE_PATH = join(root, "runtime.sqlite");
    process.env.RUNTIME_IDEMPOTENCY_HMAC_KEY = "0123456789abcdefZYXWVUTSRQPONMLK";
    const provider = await import("@/lib/runtime/provider");
    const [first, second, third] = await Promise.all([
      provider.getDurableRuntimeRepository(), provider.getDurableRuntimeRepository(), provider.getDurableRuntimeRepository(),
    ]);
    expect(second).toBe(first); expect(third).toBe(first);
    process.env.SQLITE_PATH = join(root, "other.sqlite");
    await expect(provider.getDurableRuntimeRepository()).rejects.toBeInstanceOf(provider.DurableRuntimeUnavailableError);
    (first as unknown as { close(): void }).close();
  });
});
