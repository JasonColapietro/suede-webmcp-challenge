import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import {
  createPhase4aIsolatedEnvironment,
  PHASE4A_STEPS,
} from "./verify-phase-4a-lib.mjs";
import {
  acquirePhase1VerificationLock,
  assertDefaultDatabaseUnchanged,
  PHASE1_STEPS,
  runPhase1Verification,
  snapshotDefaultDatabase,
} from "./verify-phase-1-lib.mjs";
import {
  assertGitEvidenceUnchanged,
  requireCleanGitEvidence,
} from "./git-evidence.mjs";
import { PHASE2A_STEPS } from "./verify-phase-2a-lib.mjs";
import { PHASE2B_STEPS } from "./verify-phase-2b-lib.mjs";
import { PHASE2C_STEPS } from "./verify-phase-2c-lib.mjs";
import { PHASE2D_STEPS } from "./verify-phase-2d-lib.mjs";
import { PHASE2D_SUBFLOW_STEPS } from "./verify-phase-2d-subflows-lib.mjs";
import { PHASE2E_STEPS } from "./verify-phase-2e-lib.mjs";
import { PHASE2F_STEPS } from "./verify-phase-2f-lib.mjs";
import { PHASE3A_STEPS } from "./verify-phase-3a-lib.mjs";

const PHASE4B1_TARGETS = Object.freeze([
  "tests/connectors",
  "tests/audit",
  "tests/db/audit-migration.test.ts",
  "tests/db/connector-migration.test.ts",
  "tests/db/connector-portability-migration.test.ts",
  "tests/db/migrations.test.ts",
  "tests/api-connectors-v2.test.ts",
  "tests/api-connector-readiness.test.ts",
  "tests/api-operation-simulation.test.ts",
  "tests/api-flow-api-operation-admission.test.ts",
  "tests/api-deployments-v2.test.ts",
  "tests/api-launch-webhook.test.ts",
  "tests/api-gateway.test.ts",
  "tests/api-public-agent-graph-gating.test.ts",
  "tests/api-versions-v2.test.ts",
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
  "tests/flow/connection-secret-runtime.test.ts",
  "tests/flow/http-node.test.ts",
  "tests/flow/engine-v2.test.ts",
  "tests/flow",
  "tests/projects/connector-dependencies.test.ts",
  "tests/projects/deployment-service.test.ts",
  "tests/projects/live-execution.test.ts",
  "tests/projects/version-closure.test.ts",
  "tests/projects",
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
]);

const PRIOR_PHASE_STEPS = Object.freeze([
  PHASE1_STEPS,
  PHASE2A_STEPS,
  PHASE2B_STEPS,
  PHASE2C_STEPS,
  PHASE2D_STEPS,
  PHASE2D_SUBFLOW_STEPS,
  PHASE2E_STEPS,
  PHASE2F_STEPS,
  PHASE3A_STEPS,
  PHASE4A_STEPS,
]);

function testTargets(steps) {
  const command = steps.find((step) => step.kind === "command" && step.args[0] === "test");
  if (!command) return [];
  const separator = command.args.indexOf("--minWorkers=1");
  return separator < 0 ? [] : command.args.slice(separator + 1);
}

export const PHASE4B1_FOCUSED_TARGETS = Object.freeze([
  ...new Set([
    ...PRIOR_PHASE_STEPS.flatMap(testTargets),
    ...PHASE4B1_TARGETS,
  ]),
]);

function commandStep(args) {
  return Object.freeze({ kind: "command", command: "npm", args: Object.freeze(args) });
}

export const PHASE4B1_STEPS = Object.freeze([
  commandStep([
    "test", "--", "--testTimeout=20000", "--maxWorkers=1", "--minWorkers=1",
    ...PHASE4B1_FOCUSED_TARGETS,
  ]),
  commandStep(["test", "--", "--testTimeout=20000", "--maxWorkers=1", "--minWorkers=1"]),
  commandStep(["run", "build", "--workspace=@suedeai/agents"]),
  Object.freeze({ kind: "remove", path: ".next" }),
  commandStep(["run", "build"]),
]);

const PROCESS_SENTINEL_SOURCE = String.raw`
import childProcess from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createRequire, syncBuiltinESMExports } from "node:module";

const SENTINEL = "Phase 4B1 verifier blocked external authority";
const loopback = (host) => {
  const value = String(host ?? "localhost").replace(/^\[|\]$/gu, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
};
const assertUrl = (value) => {
  let candidate = value;
  if (candidate && typeof candidate === "object" && "url" in candidate) candidate = candidate.url;
  let parsed;
  try { parsed = candidate instanceof URL ? candidate : new URL(String(candidate)); }
  catch { return; }
  if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) && !loopback(parsed.hostname)) {
    throw new Error(SENTINEL + ": non-loopback network");
  }
};
const hostFromArgs = (args) => {
  const first = args[0];
  if (typeof first === "string" && !/^\d+$/u.test(first)) {
    try { return new URL(first).hostname; } catch { return undefined; }
  }
  if (first instanceof URL) return first.hostname;
  if (first && typeof first === "object") return first.hostname ?? first.host;
  return typeof args[1] === "string" ? args[1] : undefined;
};
const guardRequest = (original) => function guardedRequest(...args) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) assertUrl(first);
  else if (first && typeof first === "object" && !loopback(first.hostname ?? first.host)) {
    throw new Error(SENTINEL + ": non-loopback network");
  }
  return Reflect.apply(original, this, args);
};
const guardConnect = (original) => function guardedConnect(...args) {
  const host = hostFromArgs(args);
  if (host !== undefined && !loopback(host)) throw new Error(SENTINEL + ": non-loopback socket");
  return Reflect.apply(original, this, args);
};
const guardDns = (original) => function guardedDns(host, ...args) {
  if (!loopback(host)) throw new Error(SENTINEL + ": DNS");
  return Reflect.apply(original, this, [host, ...args]);
};
const SENTINEL_ENV = Object.freeze(Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key === "NODE_OPTIONS" || key.startsWith("SUEDE_PHASE4B1_"))));
const forcedOptions = (args) => args.map((value, index) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const optionIndex = index === args.length - 1 || Object.hasOwn(value, "env");
  if (!optionIndex) return value;
  return { ...value, env: { ...(value.env ?? process.env), ...SENTINEL_ENV } };
});
const guardCommand = (original) => function guardedCommand(command, ...rawArgs) {
  const args = forcedOptions(rawArgs);
  const text = [command, ...(Array.isArray(args[0]) ? args[0] : [])].join(" ");
  if (/(?:^|[\\/\s])(?:vercel|playwright|puppeteer|chrome|chromium|firefox|safari|msedge|edge|curl|wget|ssh|nc|netcat|telnet|psql|supabase|mysql|mongosh|redis-cli)(?:$|\s)/iu.test(text)) {
    throw new Error(SENTINEL + ": deploy/browser/network command");
  }
  if (/https?:\/\/(?!localhost|127\.|\[?::1\]?)/iu.test(text)) {
    throw new Error(SENTINEL + ": external URL command");
  }
  return Reflect.apply(original, this, [command, ...args]);
};
const guardDgramSend = (original) => function guardedDgramSend(...args) {
  const address = [...args.slice(1)].reverse().find((value) => typeof value === "string");
  if (address !== undefined && !loopback(address)) throw new Error(SENTINEL + ": non-loopback datagram");
  return Reflect.apply(original, this, args);
};

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    assertUrl(input);
    return Reflect.apply(originalFetch, this, [input, init]);
  };
}
if (typeof globalThis.WebSocket === "function") {
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args, newTarget) { assertUrl(args[0]); return Reflect.construct(target, args, newTarget); },
  });
}
for (const module of [http, https]) {
  module.request = guardRequest(module.request);
  module.get = guardRequest(module.get);
}
http2.connect = guardRequest(http2.connect);
net.connect = guardConnect(net.connect);
net.createConnection = guardConnect(net.createConnection);
net.Socket.prototype.connect = guardConnect(net.Socket.prototype.connect);
tls.connect = guardConnect(tls.connect);
for (const key of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  if (typeof dns[key] === "function") dns[key] = guardDns(dns[key]);
  if (typeof dnsPromises[key] === "function") dnsPromises[key] = guardDns(dnsPromises[key]);
}
dgram.Socket.prototype.connect = guardConnect(dgram.Socket.prototype.connect);
dgram.Socket.prototype.send = guardDgramSend(dgram.Socket.prototype.send);
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[key] = guardCommand(childProcess[key]);
}
try {
  const undici = createRequire(process.cwd() + "/package.json")("undici");
  for (const key of ["fetch", "request", "stream", "pipeline", "connect"]) {
    if (typeof undici[key] === "function") undici[key] = guardRequest(undici[key]);
  }
  for (const key of ["Client", "Pool", "Agent", "BalancedPool", "ProxyAgent"]) {
    if (typeof undici[key] !== "function") continue;
    undici[key] = new Proxy(undici[key], {
      construct(target, args, newTarget) { if (args.length > 0) assertUrl(args[0]); return Reflect.construct(target, args, newTarget); },
    });
  }
} catch { /* undici is optional; global fetch is already guarded */ }
syncBuiltinESMExports();
`;

const BROWSER_KEYS = Object.freeze([
  "BROWSER",
  "CHROME_BIN",
  "CHROME_PATH",
  "CHROMIUM_PATH",
  "FIREFOX_BIN",
  "FIREFOX_PATH",
  "MOZ_HEADLESS",
  "EDGE_PATH",
  "MSEDGE_PATH",
  "GOOGLE_CHROME_BIN",
  "GOOGLE_CHROME_PATH",
  "SELENIUM_BROWSER",
  "SELENIUM_REMOTE_URL",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
]);

const PHASE4B1_AUTHORITY_PREFIXES = Object.freeze([
  "CONNECTOR_",
  "PROVIDER_",
  "PAYMENT_",
  "DEPLOY_",
  "DATABASE_",
  "REMOTE_DB_",
  "BROWSER_",
  "PLAYWRIGHT_",
  "PUPPETEER_",
  "CHROME_",
  "CHROMIUM_",
  "FIREFOX_",
  "MOZ_",
  "EDGE_",
  "MSEDGE_",
  "GOOGLE_CHROME_",
  "SELENIUM_",
]);

function phase4b1AuthorityKey(key) {
  const normalized = key.startsWith("NEXT_PUBLIC_") ? key.slice("NEXT_PUBLIC_".length) : key;
  return BROWSER_KEYS.includes(normalized) ||
    PHASE4B1_AUTHORITY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function phase4b1DotenvAuthorityKeys(projectRoot) {
  const keys = new Set();
  let names = [];
  try { names = readdirSync(projectRoot).filter((name) => name === ".env" || name.startsWith(".env.")); }
  catch { return keys; }
  for (const name of names) {
    let source;
    try { source = readFileSync(join(projectRoot, name), "utf8"); } catch { continue; }
    for (const line of source.split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
      if (match && phase4b1AuthorityKey(match[1])) keys.add(match[1]);
    }
  }
  return keys;
}

export function createPhase4b1IsolatedEnvironment(
  baseEnvironment = process.env,
  projectRoot = process.cwd(),
) {
  const isolated = createPhase4aIsolatedEnvironment(baseEnvironment, projectRoot);
  try {
    for (const key of Object.keys(isolated.environment)) {
      if (phase4b1AuthorityKey(key)) isolated.environment[key] = "";
    }
    for (const key of phase4b1DotenvAuthorityKeys(projectRoot)) isolated.environment[key] = "";
    for (const key of BROWSER_KEYS) isolated.environment[key] = "";
    isolated.environment.CONNECTOR_LAB_ENABLED = "1";
    isolated.environment.NEXT_PUBLIC_CONNECTOR_LAB_ENABLED = "1";
    isolated.environment.SUEDE_PHASE4B1_NETWORK_SENTINEL = "throw-non-loopback";
    isolated.environment.SUEDE_PHASE4B1_PROVIDER_SENTINEL = "throw";
    isolated.environment.SUEDE_PHASE4B1_PAYMENT_SENTINEL = "throw";
    isolated.environment.SUEDE_PHASE4B1_DEPLOY_SENTINEL = "throw";
    isolated.environment.SUEDE_PHASE4B1_BROWSER_SENTINEL = "throw";
    const sentinelFile = join(isolated.directory, "phase4b1-process-sentinel.mjs");
    writeFileSync(sentinelFile, PROCESS_SENTINEL_SOURCE, { encoding: "utf8", mode: 0o600 });
    isolated.environment.NODE_OPTIONS = `--import=${sentinelFile}`;
    return isolated;
  } catch (error) {
    isolated.cleanup();
    throw error;
  }
}

export function installPhase4b1SignalCleanup(input) {
  const target = input.processTarget ?? process;
  let removed = false;
  let released = false;
  const handlers = new Map();
  const remove = () => {
    if (removed) return;
    removed = true;
    for (const [signal, handler] of handlers) target.removeListener(signal, handler);
  };
  const release = () => {
    if (released) return;
    released = true;
    const errors = [];
    const isolated = input.getIsolated?.() ?? input.isolated;
    if (isolated !== undefined) {
      try { isolated.cleanup(); } catch (error) { errors.push(error); }
    }
    try { input.lock.release(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Phase 4B1 signal cleanup failed");
  };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => {
      remove();
      try { release(); } catch { /* the signal remains terminal */ }
      target.kill(target.pid, signal);
    };
    handlers.set(signal, handler);
    target.once(signal, handler);
  }
  return Object.freeze({ remove, release });
}

function commandFailure(command, args, code, signal) {
  return new Error(`${[command, ...args].join(" ")} exited ${code ?? signal ?? "without a status"}`);
}

async function terminateProcessGroup(active) {
  if (!active || active.exited) return;
  try {
    if (process.platform === "win32") active.child.kill("SIGTERM");
    else process.kill(-active.child.pid, "SIGTERM");
  } catch { /* already gone */ }
  await Promise.race([
    active.done,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (active.exited) return;
  try {
    if (process.platform === "win32") active.child.kill("SIGKILL");
    else process.kill(-active.child.pid, "SIGKILL");
  } catch { /* already gone */ }
  await active.done;
}

async function runManagedPhase4b1Verification(options) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const evidence = (options.requireEvidence ?? requireCleanGitEvidence)();
  const lock = acquirePhase1VerificationLock(projectRoot, { handleSignals: false });
  const snapshotDatabase = options.snapshotDefaultDatabase ?? snapshotDefaultDatabase;
  const assertDatabase = options.assertDefaultDatabaseUnchanged ?? assertDefaultDatabaseUnchanged;
  const assertEvidence = options.assertEvidence ?? assertGitEvidenceUnchanged;
  const steps = options.steps ?? PHASE4B1_STEPS;
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  let databaseEvidence;
  let isolated;
  let active = null;
  let failure;
  let finalized = false;
  let shutdownSignal = null;
  const handlers = new Map();

  const removeHandlers = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  const finalize = async () => {
    if (finalized) return [];
    finalized = true;
    const errors = [];
    await terminateProcessGroup(active);
    if (databaseEvidence !== undefined) {
      try { assertDatabase(databaseEvidence, projectRoot); } catch (error) { errors.push(error); }
    }
    try { assertEvidence(evidence); } catch (error) { errors.push(error); }
    if (isolated !== undefined) {
      try { isolated.cleanup(); } catch (error) { errors.push(error); }
    }
    try { lock.release(); } catch (error) { errors.push(error); }
    return errors;
  };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (shutdownSignal !== null) return;
      shutdownSignal = signal;
      void finalize().finally(() => {
        removeHandlers();
        process.kill(process.pid, signal);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    databaseEvidence = snapshotDatabase(projectRoot);
    isolated = createPhase4b1IsolatedEnvironment(options.baseEnvironment ?? process.env, projectRoot);
    stdout.write(`Phase 4B1 portable operation kernel verification commit: ${evidence.commit}\n`);
    stdout.write(`Phase 4B1 portable operation kernel verification tree: ${evidence.tree}\n`);
    for (const step of steps) {
      if (shutdownSignal !== null) await new Promise(() => undefined);
      if (step.kind === "remove") {
        rmSync(join(projectRoot, step.path), { recursive: true, force: true });
        continue;
      }
      const command = step.command === "npm" ? npmCommand : step.command;
      stdout.write(`\n> ${[command, ...step.args].join(" ")}\n`);
      const child = spawnChild(command, [...step.args], {
        cwd: projectRoot,
        env: isolated.environment,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      let settle;
      const done = new Promise((resolve) => { settle = resolve; });
      active = { child, done, exited: false };
      const result = await new Promise((resolve) => {
        child.once("error", (error) => resolve({ error }));
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      active.exited = true;
      settle();
      if (shutdownSignal !== null) await new Promise(() => undefined);
      if (result.error) throw result.error;
      if (result.code !== 0) throw commandFailure(command, step.args, result.code, result.signal);
      active = null;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (shutdownSignal === null) removeHandlers();
    const errors = await finalize();
    if (errors.length > 0) {
      failure = new AggregateError(failure === undefined ? errors : [failure, ...errors],
        failure instanceof Error ? failure.message : "Phase 4B1 final evidence failed");
    }
  }
  if (failure !== undefined) throw failure;
  stdout.write("\nPhase 4B1 portable operation kernel verification passed.\n");
}

export function runPhase4b1Verification(options = {}) {
  if (options.acquireLock !== undefined || options.createEnvironment !== undefined) {
    return runPhase1Verification({
      ...options,
      phaseLabel: "Phase 4B1 portable operation kernel",
      steps: options.steps ?? PHASE4B1_STEPS,
      createEnvironment: options.createEnvironment ?? ((baseEnvironment, projectRoot) =>
        createPhase4b1IsolatedEnvironment(baseEnvironment, projectRoot)),
    });
  }
  return runManagedPhase4b1Verification(options);
}
