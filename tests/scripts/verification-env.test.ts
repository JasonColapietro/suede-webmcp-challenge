import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIsolatedSqliteEnvironment } from "../../scripts/verification-env.mjs";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe("Phase 0 verification environment", () => {
  it("forces an isolated SQLite database and removes remote credentials", () => {
    const isolated = createIsolatedSqliteEnvironment({
      DB_DRIVER: "supabase",
      SQLITE_PATH: "/Users/example/studio.db",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "secret",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      ANTHROPIC_API_KEY: "paid-model-key",
      OPENROUTER_API_KEY: "paid-router-key",
      WALLET_PRIVATE_KEY: "wallet-key",
      X402_PRIVATE_KEY: "settlement-key",
      BASE_RPC_URL: "https://rpc.example",
      PRESERVED_MARKER: "yes",
    } as unknown as NodeJS.ProcessEnv);

    try {
      expect(isolated.environment.DB_DRIVER).toBe("sqlite");
      expect(dirname(isolated.environment.SQLITE_PATH!)).toBe(isolated.directory);
      expect(isolated.environment.PRESERVED_MARKER).toBe("yes");
      expect(isolated.environment.SUPABASE_URL).toBe("");
      expect(isolated.environment.SUPABASE_SERVICE_ROLE_KEY).toBe("");
      expect(isolated.environment.NEXT_PUBLIC_SUPABASE_URL).toBe("");
      expect(isolated.environment.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("");
      expect(isolated.environment.ANTHROPIC_API_KEY).toBe("");
      expect(isolated.environment.OPENROUTER_API_KEY).toBe("");
      expect(isolated.environment.WALLET_PRIVATE_KEY).toBe("");
      expect(isolated.environment.X402_PRIVATE_KEY).toBe("");
      expect(isolated.environment.BASE_RPC_URL).toBe("");
      expect(isolated.environment.X402_SKIP_SETTLEMENT).toBe("true");
      expect(isolated.environment.X402_SELLER_WALLET_ADDRESS).toBe(
        "0x0000000000000000000000000000000000000000",
      );
      const isolatedTemp = join(isolated.directory, "tmp");
      expect(isolated.environment.TMPDIR).toBe(isolatedTemp);
      expect(isolated.environment.TMP).toBe(isolatedTemp);
      expect(isolated.environment.TEMP).toBe(isolatedTemp);
      expect(existsSync(isolatedTemp)).toBe(true);
      expect(existsSync(isolated.directory)).toBe(true);
    } finally {
      isolated.cleanup();
    }

    expect(existsSync(isolated.directory)).toBe(false);
    expect(() => isolated.cleanup()).not.toThrow();
  });

  it("preseeds ignored dotenv secrets so Next cannot reload them", () => {
    const project = mkdtempSync(join(tmpdir(), "suede-env-project-"));
    writeFileSync(
      join(project, ".env.local"),
      [
        "ANTHROPIC_API_KEY=paid-from-dotenv",
        "SUPABASE_SERVICE_ROLE_KEY=remote-from-dotenv",
        "WALLET_PRIVATE_KEY=wallet-from-dotenv",
        "NEXT_PUBLIC_SITE_URL=https://local.example",
      ].join("\n"),
      "utf8",
    );
    const isolated = createIsolatedSqliteEnvironment(EMPTY_ENV, project);
    try {
      const script = `
        const { loadEnvConfig } = require("@next/env");
        loadEnvConfig(process.argv[1], true);
        process.stdout.write(JSON.stringify({
          anthropic: process.env.ANTHROPIC_API_KEY,
          supabase: process.env.SUPABASE_SERVICE_ROLE_KEY,
          wallet: process.env.WALLET_PRIVATE_KEY,
          site: process.env.NEXT_PUBLIC_SITE_URL,
          driver: process.env.DB_DRIVER,
          settlement: process.env.X402_SKIP_SETTLEMENT,
        }));
      `;
      const child = spawnSync(process.execPath, ["-e", script, project], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: isolated.environment,
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        anthropic: "",
        supabase: "",
        wallet: "",
        site: "https://local.example",
        driver: "sqlite",
        settlement: "true",
      });
    } finally {
      isolated.cleanup();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("preseeds future connection and cron dotenv keys before Next loads them without printing secrets", () => {
    const project = mkdtempSync(join(tmpdir(), "suede-env-connection-project-"));
    const connectionPoison = "future-connection-from-dotenv";
    const cronPoison = "production-cron-from-dotenv";
    writeFileSync(
      join(project, ".env.local"),
      [
        `CONNECTION_FUTURE_POISON=${connectionPoison}`,
        `CRON_SECRET=${cronPoison}`,
      ].join("\n"),
      "utf8",
    );
    const isolated = createIsolatedSqliteEnvironment(EMPTY_ENV, project);
    try {
      const script = `
        const { loadEnvConfig } = require("@next/env");
        loadEnvConfig(process.argv[1], true);
        process.stdout.write(JSON.stringify({
          connection: process.env.CONNECTION_FUTURE_POISON,
          cron: process.env.CRON_SECRET,
        }));
      `;
      const child = spawnSync(process.execPath, ["-e", script, project], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: isolated.environment,
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ connection: "", cron: "" });
      expect(child.stdout).not.toContain(connectionPoison);
      expect(child.stdout).not.toContain(cronPoison);
      expect(child.stderr).not.toContain(connectionPoison);
      expect(child.stderr).not.toContain(cronPoison);
    } finally {
      isolated.cleanup();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("does not leak an isolated directory when dotenv inspection fails", () => {
    const project = mkdtempSync(join(tmpdir(), "suede-env-broken-project-"));
    mkdirSync(join(project, ".env.local"));
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("suede-phase0-")).sort();
    try {
      expect(() => createIsolatedSqliteEnvironment(EMPTY_ENV, project)).toThrow();
      const after = readdirSync(tmpdir()).filter((name) => name.startsWith("suede-phase0-")).sort();
      expect(after).toEqual(before);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
