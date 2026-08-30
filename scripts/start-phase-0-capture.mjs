import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createIsolatedSqliteEnvironment } from "./verification-env.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? process.argv[portIndex + 1] : "3210";
if (!/^\d+$/.test(port ?? "")) {
  process.stderr.write("Usage: npm run capture:phase0:server -- --port 3210\n");
  process.exit(1);
}

const isolated = createIsolatedSqliteEnvironment();
const session = randomUUID();
isolated.environment.PHASE0_CAPTURE_SESSION = session;
const testChild = process.env.NODE_ENV === "test" && process.argv.includes("--test-child");

process.stdout.write("Starting an isolated Phase 0 capture server.\n");
process.stdout.write(`Base URL: http://127.0.0.1:${port}\n`);
process.stdout.write(`Session token: ${session}\n`);
if (testChild) process.stdout.write(`Runtime directory: ${isolated.directory}\n`);
process.stdout.write("Stop this command when capture is complete; its database is deleted on exit.\n\n");

const childCommand = testChild ? process.execPath : npm;
const childArguments = testChild
  ? ["-e", 'process.stdout.write("capture test child ready\\n"); setInterval(() => {}, 1000)']
  : ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", port];
const child = spawn(
  childCommand,
  childArguments,
  {
    cwd: process.cwd(),
    env: isolated.environment,
    stdio: "inherit",
    detached: process.platform !== "win32",
  },
);
let janitor = null;
if (child.pid !== undefined) {
  janitor = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./capture-runtime-janitor.mjs", import.meta.url)),
      String(process.pid),
      String(child.pid),
      isolated.directory,
    ],
    {
      detached: true,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
      },
      stdio: "ignore",
    },
  );
  janitor.unref();
}

let stopping = false;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  isolated.cleanup();
  janitor?.kill("SIGTERM");
}

function killChildTree(signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The child may have exited between the state check and signal.
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  killChildTree("SIGTERM");
  cleanup();
  const escalation = setTimeout(() => killChildTree("SIGKILL"), 5000);
  escalation.unref();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
process.once("exit", () => {
  killChildTree("SIGTERM");
  cleanup();
});

const exit = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }));
});

cleanup();
if (exit.error) process.stderr.write(`${exit.error.message}\n`);
process.exitCode = exit.code;
