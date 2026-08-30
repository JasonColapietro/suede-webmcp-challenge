import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Barrier {
  readonly promise: Promise<void>;
  release(): void;
}

function barrier(): Barrier {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => {
  vi.doUnmock("@/lib/projects/sqlite-project-repo");
  vi.doUnmock("@/lib/projects/supabase-project-repo");
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getProjectRepo initialization cache", () => {
  it("initializes the Supabase project repository for the production driver", async () => {
    const constructed: string[] = [];
    vi.stubEnv("DB_DRIVER", "supabase");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "public-key");
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", "server-secret");
    vi.doMock("@/lib/projects/supabase-project-repo", () => ({
      SupabaseProjectRepo: class {
        constructor() {
          constructed.push("supabase");
        }
      },
    }));

    const { getProjectRepo } = await import("@/lib/projects/provider");
    const first = await getProjectRepo();
    const second = await getProjectRepo();

    expect(first).toBe(second);
    expect(constructed).toEqual(["supabase"]);
  });

  it("coalesces simultaneous first callers into one repository and connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "suede-provider-same-"));
    const path = join(root, "same.db");
    const importBarrier = barrier();
    const constructed: string[] = [];
    vi.stubEnv("DB_DRIVER", "sqlite");
    vi.stubEnv("SQLITE_PATH", path);
    vi.doMock("@/lib/projects/sqlite-project-repo", async () => {
      await importBarrier.promise;
      return {
        SqliteProjectRepo: class {
          constructor(source: string) {
            constructed.push(source);
            writeFileSync(source, String(constructed.length));
          }
        },
      };
    });
    const { getProjectRepo } = await import("@/lib/projects/provider");

    const first = getProjectRepo();
    const second = getProjectRepo();
    importBarrier.release();
    const [firstRepo, secondRepo] = await Promise.all([first, second]);

    expect(firstRepo).toBe(secondRepo);
    expect(constructed).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("1");
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a different configuration while initialization is pending without opening its path", async () => {
    const root = mkdtempSync(join(tmpdir(), "suede-provider-different-"));
    const firstPath = join(root, "first.db");
    const blockedPath = join(root, "blocked.db");
    const importBarrier = barrier();
    const constructed: string[] = [];
    vi.stubEnv("DB_DRIVER", "sqlite");
    vi.stubEnv("SQLITE_PATH", firstPath);
    vi.doMock("@/lib/projects/sqlite-project-repo", async () => {
      await importBarrier.promise;
      return {
        SqliteProjectRepo: class {
          constructor(source: string) {
            constructed.push(source);
            writeFileSync(source, "opened");
          }
        },
      };
    });
    const provider = await import("@/lib/projects/provider");

    const first = provider.getProjectRepo();
    vi.stubEnv("SQLITE_PATH", blockedPath);
    const blocked = provider.getProjectRepo();
    importBarrier.release();

    await expect(first).resolves.toBeDefined();
    await expect(blocked).rejects.toBeInstanceOf(provider.ProjectStoreUnavailableError);
    expect(constructed).toEqual([firstPath]);
    expect(existsSync(blockedPath)).toBe(false);
    const cachedBlockedPath = join(root, "cached-blocked.db");
    vi.stubEnv("SQLITE_PATH", cachedBlockedPath);
    await expect(provider.getProjectRepo()).rejects.toBeInstanceOf(
      provider.ProjectStoreUnavailableError,
    );
    expect(constructed).toEqual([firstPath]);
    expect(existsSync(cachedBlockedPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("shares an initialization rejection, clears it, and permits one clean retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "suede-provider-retry-"));
    const path = join(root, "retry.db");
    const importBarrier = barrier();
    const constructed: string[] = [];
    vi.stubEnv("DB_DRIVER", "sqlite");
    vi.stubEnv("SQLITE_PATH", path);
    vi.doMock("@/lib/projects/sqlite-project-repo", async () => {
      await importBarrier.promise;
      return {
        SqliteProjectRepo: class {
          constructor(source: string) {
            constructed.push(source);
            if (constructed.length === 1) throw new Error("initialization failed");
            writeFileSync(source, "retried");
          }
        },
      };
    });
    const { getProjectRepo } = await import("@/lib/projects/provider");

    const first = getProjectRepo();
    const second = getProjectRepo();
    importBarrier.release();
    const failed = await Promise.allSettled([first, second]);
    expect(failed.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(constructed).toEqual([path]);

    const retried = await getProjectRepo();
    expect(retried).toBeDefined();
    expect(constructed).toEqual([path, path]);
    expect(readFileSync(path, "utf8")).toBe("retried");
    rmSync(root, { recursive: true, force: true });
  });
});
