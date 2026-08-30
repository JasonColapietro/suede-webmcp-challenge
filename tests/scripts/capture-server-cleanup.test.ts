import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

describe("isolated capture server launcher", () => {
  it.skipIf(process.platform === "win32")(
    "cleans its runtime directory when Ctrl-C reaches the npm process group",
    async () => {
      const child = spawn(
        npm,
        ["run", "capture:phase0:server", "--", "--port", "3219", "--test-child"],
        {
          cwd: process.cwd(),
          detached: true,
          env: { ...process.env, NODE_ENV: "test" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      try {
        const runtimeDirectory = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`launcher did not start:\n${output}`)),
            20_000,
          );
          const inspect = (): void => {
            const match = output.match(/Runtime directory: (.+)/);
            if (match && output.includes("capture test child ready")) {
              clearTimeout(timeout);
              resolve(match[1].trim());
              return;
            }
            setTimeout(inspect, 25);
          };
          inspect();
        });
        expect(existsSync(runtimeDirectory)).toBe(true);

        if (child.pid === undefined) throw new Error("launcher has no process id");
        process.kill(-child.pid, "SIGINT");
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`launcher did not stop:\n${output}`)),
            10_000,
          );
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        await new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const inspect = (): void => {
            if (!existsSync(runtimeDirectory)) {
              resolve();
              return;
            }
            if (Date.now() - startedAt > 6000) {
              reject(new Error(`runtime directory leaked: ${runtimeDirectory}`));
              return;
            }
            setTimeout(inspect, 50);
          };
          inspect();
        });
      } finally {
        if (child.exitCode === null && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already stopped.
          }
        }
      }
    },
    45_000,
  );
});
