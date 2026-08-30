import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-4b1-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-4b1.mjs");

const REQUIRED_PHASE4B1_FOCUSED_TARGETS = Object.freeze([
  "tests/flow",
  "tests/projects",
  "tests/connectors",
  "tests/audit",
  "tests/connections",
  "tests/runtime",
  "tests/components",
  "tests/manifest",
  "tests/compat",
  "tests/api-deployments-v2.test.ts",
  "tests/api-launch-webhook.test.ts",
  "tests/api-gateway.test.ts",
  "tests/api-public-agent-graph-gating.test.ts",
  "tests/api-connectors-v2.test.ts",
  "tests/api-connector-readiness.test.ts",
  "tests/api-operation-simulation.test.ts",
  "tests/api-flow-api-operation-admission.test.ts",
  "tests/integration/connector-lab-journey.test.tsx",
  "tests/db/audit-migration.test.ts",
  "tests/db/connector-migration.test.ts",
  "tests/db/connector-portability-migration.test.ts",
  "tests/scripts/verify-phase4b1.test.ts",
]);

type VerificationStep =
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "remove"; readonly path: string };

interface IsolatedEnvironment {
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-4b1-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE4B1_FOCUSED_TARGETS: readonly string[];
    PHASE4B1_STEPS: readonly VerificationStep[];
    createPhase4b1IsolatedEnvironment(base?: NodeJS.ProcessEnv, root?: string): IsolatedEnvironment;
    runPhase4b1Verification(options?: Record<string, unknown>): void;
    installPhase4b1SignalCleanup(input: Record<string, unknown>): {
      remove(): void;
      release(): void;
    };
  }>;
}

function printableSteps(steps: readonly VerificationStep[]): readonly string[] {
  return steps.map((step) =>
    step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
  );
}

const evidence = () => ({ commit: "commit-4b1", tree: "tree-4b1", dirty: false });

describe("Phase 4B1 portable operation kernel release verifier", () => {
  it("ships an import-safe library, tiny wrapper, package command, and honest docs", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
    const wrapper = readFileSync(wrapperFile, "utf8");
    expect(wrapper).toContain("runPhase4b1Verification");
    expect(wrapper).not.toMatch(/spawn|worker|vercel|https?:/iu);

    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["verify:phase4b1"]).toBe("node scripts/verify-phase-4b1.mjs");
    for (const path of [
      "README.md",
      "docs/architecture/portable-operation-kernel.md",
      "docs/superpowers/specs/2026-07-10-open-core-parity-design.md",
      "src/app/docs/page.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).toContain("npm run verify:phase4b1");
      expect(source, path).toMatch(/simulation.only/iu);
    }
    const guide = readFileSync(resolve(process.cwd(), "docs/architecture/portable-operation-kernel.md"), "utf8");
    for (const claim of [
      "OpenAPI 3.1.0 JSON",
      "Prototype: simulation only",
      "Simulated locally. No request sent.",
      "Test slot configured. Authentication unverified.",
      "API_OPERATION_LIVE_UNAVAILABLE",
      "process-level",
      "OS-level",
      "no required paid service",
    ]) expect(guide).toContain(claim);
    for (const forbiddenClaim of [
      "authentication verified",
      "provider tested",
      "OpenAPI parity",
      "Live ready",
      "OS-certified zero egress",
    ]) expect(guide).not.toContain(forbiddenClaim);
  });

  it("freezes the complete serial Phase 4B1, prior-law, full-suite, SDK, cleanup, and Next gate", async () => {
    const { PHASE4B1_FOCUSED_TARGETS, PHASE4B1_STEPS } = await loadLibrary();
    const printable = printableSteps(PHASE4B1_STEPS);
    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(/^npm test -- --testTimeout=20000 --maxWorkers=1 --minWorkers=1 /u);
    expect(Object.isFrozen(REQUIRED_PHASE4B1_FOCUSED_TARGETS)).toBe(true);
    for (const target of REQUIRED_PHASE4B1_FOCUSED_TARGETS) {
      expect(PHASE4B1_FOCUSED_TARGETS, `required ${target}`).toContain(target);
    }
    expect(new Set(PHASE4B1_FOCUSED_TARGETS).size).toBe(PHASE4B1_FOCUSED_TARGETS.length);
    for (const target of [
      "tests/connectors",
      "tests/audit",
      "tests/db/audit-migration.test.ts",
      "tests/db/connector-migration.test.ts",
      "tests/db/connector-portability-migration.test.ts",
      "tests/api-connectors-v2.test.ts",
      "tests/api-connector-readiness.test.ts",
      "tests/api-operation-simulation.test.ts",
      "tests/api-flow-api-operation-admission.test.ts",
      "tests/integration/connector-lab-journey.test.tsx",
      "tests/flow/api-operation-contract.test.ts",
      "tests/flow/api-operation-enumeration.test.ts",
      "tests/flow/api-operation-preflight.test.ts",
      "tests/flow/api-operation-v1-boundaries.test.ts",
      "tests/flow/api-operation-visibility.test.tsx",
      "tests/components/api-operation-inspector.test.tsx",
      "tests/flow/api-operation-callable-interface.test.tsx",
      "tests/flow/api-operation-canvas-ports.test.tsx",
      "tests/flow/api-operation-run-dock.test.tsx",
      "tests/flow/api-operation-studio-authoring.test.ts",
      "tests/flow/api-operation-studio-source-contract.test.ts",
      "tests/flow/dryrun-enumeration.test.ts",
      "tests/projects/connector-dependencies.test.ts",
      "tests/projects/deployment-service.test.ts",
      "tests/projects/live-execution.test.ts",
      "tests/manifest",
      "tests/compat",
      "tests/connections",
      "tests/runtime",
      "tests/components",
      "tests/scripts/verification-env.test.ts",
      "tests/scripts/vitest-sqlite-isolation.test.ts",
      "tests/scripts/verify-phase1.test.ts",
      "tests/scripts/verify-phase2a.test.ts",
      "tests/scripts/verify-phase2b.test.ts",
      "tests/scripts/verify-phase2c.test.ts",
      "tests/scripts/verify-phase2d.test.ts",
      "tests/scripts/verify-phase2d-subflows.test.ts",
      "tests/scripts/verify-phase2e.test.ts",
      "tests/scripts/verify-phase2f.test.ts",
      "tests/scripts/verify-phase3a.test.ts",
      "tests/scripts/verify-phase4a.test.ts",
      "tests/scripts/verify-phase4b1.test.ts",
    ]) {
      expect(PHASE4B1_FOCUSED_TARGETS, target).toContain(target);
      expect(printable[0], target).toContain(target);
    }
    expect(printable[1]).toBe("npm test -- --testTimeout=20000 --maxWorkers=1 --minWorkers=1");
    expect(printable[2]).toBe("npm run build --workspace=@suedeai/agents");
    expect(printable[3]).toBe("remove:.next");
    expect(printable[4]).toBe("npm run build");
    expect(PHASE4B1_STEPS.every((step) => Object.isFrozen(step))).toBe(true);
    expect(PHASE4B1_STEPS.every((step) => step.kind === "remove" || Object.isFrozen(step.args))).toBe(true);
  });

  it("strips inherited provider, payment, deploy, remote database, connector, and browser authority and installs fresh sentinels", async () => {
    const { createPhase4b1IsolatedEnvironment } = await loadLibrary();
    const poison = {
      CONNECTOR_LAB_ENABLED: "production",
      CONNECTION_ENCRYPTION_KEY: "production-connection",
      DATABASE_URL: "postgres://production",
      OPENAI_API_KEY: "paid-provider",
      PROVIDER_FUTURE_AUTH: "provider",
      PAYMENT_FUTURE_AUTH: "payment",
      DEPLOY_FUTURE_AUTH: "deploy",
      DATABASE_FUTURE_URL: "remote-db",
      REMOTE_DB_FUTURE_URL: "remote-db",
      BROWSER_FUTURE_PATH: "/production/browser",
      STRIPE_SECRET_KEY: "paid",
      VERCEL_TOKEN: "deploy",
      PLAYWRIGHT_BROWSERS_PATH: "/production/browser",
      CHROME_PATH: "/production/chrome",
      FIREFOX_PATH: "/production/firefox",
      MOZ_HEADLESS: "1",
      EDGE_PATH: "/production/edge",
      GOOGLE_CHROME_BIN: "/production/google-chrome",
      SELENIUM_REMOTE_URL: "https://browser.invalid",
      X402_PRIVATE_KEY: "wallet",
      NODE_OPTIONS: "--require=/poison/provider.cjs",
    } as unknown as NodeJS.ProcessEnv;
    const first = createPhase4b1IsolatedEnvironment(poison);
    const second = createPhase4b1IsolatedEnvironment(poison);
    try {
      for (const isolated of [first, second]) {
        expect(isolated.environment).toMatchObject({
          DB_DRIVER: "sqlite",
          CONNECTOR_LAB_ENABLED: "1",
          DATABASE_URL: "",
          OPENAI_API_KEY: "",
          PROVIDER_FUTURE_AUTH: "",
          PAYMENT_FUTURE_AUTH: "",
          DEPLOY_FUTURE_AUTH: "",
          DATABASE_FUTURE_URL: "",
          REMOTE_DB_FUTURE_URL: "",
          BROWSER_FUTURE_PATH: "",
          STRIPE_SECRET_KEY: "",
          VERCEL_TOKEN: "",
          PLAYWRIGHT_BROWSERS_PATH: "",
          CHROME_PATH: "",
          FIREFOX_PATH: "",
          MOZ_HEADLESS: "",
          EDGE_PATH: "",
          GOOGLE_CHROME_BIN: "",
          SELENIUM_REMOTE_URL: "",
          X402_PRIVATE_KEY: "",
          SUEDE_PHASE4B1_NETWORK_SENTINEL: "throw-non-loopback",
          SUEDE_PHASE4B1_PROVIDER_SENTINEL: "throw",
          SUEDE_PHASE4B1_PAYMENT_SENTINEL: "throw",
          SUEDE_PHASE4B1_DEPLOY_SENTINEL: "throw",
          SUEDE_PHASE4B1_BROWSER_SENTINEL: "throw",
        });
        expect(isolated.environment.NEXT_PUBLIC_CONNECTOR_LAB_ENABLED).toBe("1");
        expect(isolated.environment.SQLITE_PATH).toContain(isolated.directory);
        expect(isolated.environment.NODE_OPTIONS).toContain("--import=");
        expect(isolated.environment.NODE_OPTIONS).toContain(isolated.directory);
        expect(isolated.environment.NODE_OPTIONS).not.toContain("/poison/provider.cjs");
        expect(isolated.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY).toMatch(/^[0-9a-f]{64}$/u);
        expect(isolated.environment.CONNECTION_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/u);
        expect(isolated.environment.CRON_SECRET).toMatch(/^[0-9a-f]{64}$/u);
      }
      expect(first.environment.NODE_OPTIONS).not.toBe(second.environment.NODE_OPTIONS);

      const networkProbe = spawnSync(process.execPath, ["-e", [
        "try {",
        "  fetch('https:' + '//' + 'example.com');",
        "  process.exit(91);",
        "} catch (error) {",
        "  process.stdout.write(String(error));",
        "}",
      ].join("\n")], { env: first.environment, encoding: "utf8" });
      expect(networkProbe.status).toBe(0);
      expect(networkProbe.stdout).toContain("Phase 4B1 verifier blocked external authority");
      expect(networkProbe.stdout).toContain("non-loopback network");

      const commandProbe = spawnSync(process.execPath, ["-e", [
        "const { spawnSync } = require('node:child_process');",
        "for (const command of ['vercel', 'firefox', 'psql']) {",
        "  try { spawnSync(command, ['probe']); process.stdout.write('miss:' + command + '\\n'); }",
        "  catch (error) { process.stdout.write(command + ':' + String(error) + '\\n'); }",
        "}",
      ].join("\n")], { env: first.environment, encoding: "utf8" });
      expect(commandProbe.status).toBe(0);
      expect(commandProbe.stdout).toContain("Phase 4B1 verifier blocked external authority");
      expect(commandProbe.stdout).toContain("deploy/browser/network command");
      expect(commandProbe.stdout).toContain("vercel:");
      expect(commandProbe.stdout).toContain("firefox:");
      expect(commandProbe.stdout).toContain("psql:");

      const seamProbe = spawnSync(process.execPath, ["--input-type=module", "-e", [
        "import dns from 'node:dns/promises';",
        "import http2 from 'node:http2';",
        "import dgram from 'node:dgram';",
        "for (const [name, run] of [",
        "  ['dns-promises', () => dns.resolve('example.com')],",
        "  ['http2', () => http2.connect('https:' + '//' + 'example.com')],",
        "  ['dgram', () => { const socket = dgram.createSocket('udp4'); try { socket.send('x', 53, '8.8.8.8'); } finally { socket.close(); } }],",
        "]) { try { await run(); process.stdout.write('miss:' + name + '\\n'); } catch (error) { process.stdout.write(name + ':' + String(error) + '\\n'); } }",
      ].join("\n")], { env: first.environment, encoding: "utf8", timeout: 5_000 });
      expect(seamProbe.status).toBe(0);
      expect(seamProbe.stdout).toContain("dns-promises:Error: Phase 4B1 verifier blocked external authority");
      expect(seamProbe.stdout).toContain("http2:Error: Phase 4B1 verifier blocked external authority");
      expect(seamProbe.stdout).toContain("dgram:Error: Phase 4B1 verifier blocked external authority");

      const overrideProbe = spawnSync(process.execPath, ["-e", [
        "const { spawnSync } = require('node:child_process');",
        "const code = `try { fetch('https:' + '//' + 'example.com'); process.exit(93); } catch (error) { process.stdout.write(String(error)); }`;",
        "const child = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' });",
        "process.stdout.write(child.stdout || child.stderr || String(child.status));",
      ].join("\n")], { env: first.environment, encoding: "utf8" });
      expect(overrideProbe.status).toBe(0);
      expect(overrideProbe.stdout).toContain("Phase 4B1 verifier blocked external authority");

      const forkProbe = spawnSync(process.execPath, ["-e", [
        "const { fork } = require('node:child_process');",
        "const { join } = require('node:path');",
        "const { writeFileSync } = require('node:fs');",
        "const file = join(process.env.TMPDIR, 'phase4b1-fork-probe.cjs');",
        "writeFileSync(file, `try { fetch('https:' + '//' + 'example.com'); process.send('miss'); } catch (error) { process.send(String(error)); }`);",
        "const child = fork(file, [], { env: { NODE_OPTIONS: '' }, silent: true });",
        "child.once('message', (value) => { process.stdout.write(String(value)); child.kill(); });",
        "setTimeout(() => { process.stdout.write('timeout'); child.kill(); }, 3000).unref();",
      ].join("\n")], { env: first.environment, encoding: "utf8", timeout: 5_000 });
      expect(forkProbe.status).toBe(0);
      expect(forkProbe.stdout).toContain("Phase 4B1 verifier blocked external authority");

      const surface = readFileSync(libraryFile, "utf8");
      for (const seam of ["node:dns/promises", "node:http2", "node:dgram", "undici", '"fork"']) {
        expect(surface).toContain(seam);
      }
    } finally {
      first.cleanup();
      second.cleanup();
    }

    const dotenvRoot = mkdtempSync(join(tmpdir(), "phase4b1-dotenv-"));
    writeFileSync(join(dotenvRoot, ".env.local"), [
      "PAYMENT_FUTURE_TOKEN=payment",
      "DEPLOY_FUTURE_TOKEN=deploy",
      "DATABASE_FUTURE_URL=remote",
      "REMOTE_DB_FUTURE_URL=remote",
      "BROWSER_FUTURE_PATH=/browser",
      "NEXT_PUBLIC_PROVIDER_FUTURE_TOKEN=provider",
      "FIREFOX_FUTURE_PATH=/firefox",
      "SELENIUM_FUTURE_URL=https://browser.invalid",
      "SAFE_LOCAL_LABEL=preserve",
    ].join("\n"));
    const dotenv = createPhase4b1IsolatedEnvironment({ NODE_ENV: "test", SAFE_LOCAL_LABEL: "preserve" }, dotenvRoot);
    try {
      for (const key of [
        "PAYMENT_FUTURE_TOKEN", "DEPLOY_FUTURE_TOKEN", "DATABASE_FUTURE_URL",
        "REMOTE_DB_FUTURE_URL", "BROWSER_FUTURE_PATH", "NEXT_PUBLIC_PROVIDER_FUTURE_TOKEN",
        "FIREFOX_FUTURE_PATH", "SELENIUM_FUTURE_URL",
      ]) expect(dotenv.environment[key], key).toBe("");
      expect(dotenv.environment.SAFE_LOCAL_LABEL).toBe("preserve");
    } finally {
      dotenv.cleanup();
      rmSync(dotenvRoot, { recursive: true, force: true });
    }
  });

  it("cleans the real runner temp environment and lock on a terminal signal", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "phase4b1-signal-root-"));
    const readyFile = join(projectRoot, "ready.json");
    const libraryUrl = pathToFileURL(libraryFile).href;
    const childSource = [
      `import { runPhase4b1Verification } from ${JSON.stringify(libraryUrl)};`,
      "const root = process.argv[1];",
      "const ready = process.argv[2];",
      "const worker = `const { writeFileSync } = require('node:fs'); const { dirname } = require('node:path'); writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, directory: dirname(process.env.SQLITE_PATH) })); setInterval(() => {}, 1000);`;",
      "await runPhase4b1Verification({",
      "  projectRoot: root,",
      "  baseEnvironment: {},",
      "  requireEvidence: () => ({ commit: 'signal', tree: 'signal', dirty: false }),",
      "  assertEvidence: () => undefined,",
      "  steps: [{ kind: 'command', command: process.execPath, args: ['-e', worker, ready] }],",
      "  stdout: { write: () => undefined },",
      "});",
    ].join("\n");
    const verifier = spawn(process.execPath, ["--input-type=module", "-e", childSource, projectRoot, readyFile], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let worker: { pid: number; directory: string } | null = null;
    try {
      worker = await new Promise<{ pid: number; directory: string }>((resolveReady, reject) => {
        const deadline = setTimeout(() => reject(new Error("signal runner did not become ready")), 10_000);
        const poll = setInterval(() => {
          if (!existsSync(readyFile)) return;
          clearInterval(poll);
          clearTimeout(deadline);
          resolveReady(JSON.parse(readFileSync(readyFile, "utf8")) as { pid: number; directory: string });
        }, 25);
        verifier.once("error", (error) => { clearInterval(poll); clearTimeout(deadline); reject(error); });
        verifier.once("exit", (code, signal) => {
          if (!existsSync(readyFile)) {
            clearInterval(poll);
            clearTimeout(deadline);
            reject(new Error(`signal runner exited early: ${String(code)}/${String(signal)}`));
          }
        });
      });
      const exited = new Promise<void>((resolveExit, reject) => {
        const deadline = setTimeout(() => reject(new Error("signal runner did not exit")), 10_000);
        verifier.once("exit", () => { clearTimeout(deadline); resolveExit(); });
      });
      verifier.kill("SIGTERM");
      await exited;
      expect(existsSync(worker.directory)).toBe(false);
      expect(() => process.kill(worker!.pid, 0)).toThrow();
      const phase1 = await import(/* @vite-ignore */ `../../scripts/verify-phase-1-lib.mjs?signal=${Date.now()}`) as {
        acquirePhase1VerificationLock(root: string): { release(): void };
      };
      const recovered = phase1.acquirePhase1VerificationLock(projectRoot);
      recovered.release();
    } finally {
      if (worker) {
        try { process.kill(worker.pid, "SIGTERM"); } catch { /* already gone */ }
      }
      try { verifier.kill("SIGKILL"); } catch { /* already gone */ }
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("inherits exact clean evidence, one lock, default database fingerprints, ordered execution, and aggregate cleanup", async () => {
    const { installPhase4b1SignalCleanup, runPhase4b1Verification } = await loadLibrary();
    const signalCleanup = installPhase4b1SignalCleanup({
      isolated: { cleanup: () => { throw new Error("signal env cleanup failed"); } },
      lock: { release: () => { throw new Error("signal lock cleanup failed"); } },
    });
    let signalFailure: unknown;
    try { signalCleanup.release(); } catch (error) { signalFailure = error; }
    finally { signalCleanup.remove(); }
    expect(signalFailure).toBeInstanceOf(AggregateError);
    expect((signalFailure as AggregateError).errors.map(String).join("\n"))
      .toMatch(/signal env cleanup failed[\s\S]*signal lock cleanup failed/u);
    const events: string[] = [];
    const output: string[] = [];
    runPhase4b1Verification({
      requireEvidence: () => { events.push("git:before"); return evidence(); },
      acquireLock: () => { events.push("lock:acquire"); return { release: () => events.push("lock:release") }; },
      assertEvidence: () => events.push("git:after"),
      snapshotDefaultDatabase: () => { events.push("db:before"); return { files: [] }; },
      assertDefaultDatabaseUnchanged: () => events.push("db:after"),
      createEnvironment: () => ({ environment: {}, cleanup: () => events.push("cleanup") }),
      spawn: (command: string, args: readonly string[]) => {
        events.push([command, ...args].join(" "));
        return { status: 0 };
      },
      removeNext: () => events.push("remove:.next"),
      stdout: { write: (value: string) => { output.push(value); } },
      npmCommand: "npm",
    });
    expect(events).toEqual([
      "git:before", "lock:acquire", "db:before",
      expect.stringMatching(/^npm test -- --testTimeout=20000 --maxWorkers=1 --minWorkers=1 /u),
      "npm test -- --testTimeout=20000 --maxWorkers=1 --minWorkers=1",
      "npm run build --workspace=@suedeai/agents", "remove:.next", "npm run build",
      "db:after", "git:after", "cleanup", "lock:release",
    ]);
    expect(output.join("")).toContain("Phase 4B1 portable operation kernel verification commit: commit-4b1");
    expect(output.join("")).toContain("Phase 4B1 portable operation kernel verification tree: tree-4b1");

    let thrown: unknown;
    try {
      runPhase4b1Verification({
        requireEvidence: evidence,
        acquireLock: () => ({ release: () => { throw new Error("lock cleanup failed"); } }),
        assertEvidence: () => { throw new Error("tree changed"); },
        snapshotDefaultDatabase: () => ({ files: [] }),
        assertDefaultDatabaseUnchanged: () => { throw new Error("default db changed"); },
        createEnvironment: () => ({ environment: {}, cleanup: () => { throw new Error("cleanup failed"); } }),
        spawn: () => ({ status: 37 }),
        stdout: { write: vi.fn() },
        npmCommand: "npm",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const failures = (thrown as AggregateError).errors.map(String).join("\n");
    expect(failures).toContain("exited 37");
    expect(failures).toContain("tree changed");
    expect(failures).toContain("default db changed");
    expect(failures).toContain("cleanup failed");
    expect(failures).toContain("lock cleanup failed");
  });

  it("contains no recursion or direct worker, provider, payment, deploy, browser, remote database, or non-loopback command", async () => {
    const { PHASE4B1_STEPS } = await loadLibrary();
    const commands = PHASE4B1_STEPS.filter((step) => step.kind === "command");
    expect(commands.every((step) => step.command === "npm")).toBe(true);
    expect(commands.some((step) => step.args[0] === "run" && /^verify:phase/u.test(step.args[1] ?? ""))).toBe(false);
    const executable = commands.map((step) => [step.command, ...step.args].join(" ")).join("\n");
    expect(executable).not.toMatch(/npm run (?:worker|deploy)|run-runtime-worker\.mjs|https?:/iu);
    expect(executable).not.toMatch(/(?:^|\s)(?:vercel|playwright|puppeteer|chrome|chromium|firefox|safari|msedge|edge|curl|wget|ssh|nc|netcat|telnet|psql|supabase)(?:\s|$)/imu);
  });
});
