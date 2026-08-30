/**
 * Tests for the suede CLI binary (packages/agent-kit/src/cli.ts).
 *
 * Tests argv dispatch, config read/write, and push/pull command logic
 * against a stub HTTP server (node:http).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ────────────────────────────────────────────────────────────────────────────
// Import pure CLI functions (not the process.argv entrypoint)
// ────────────────────────────────────────────────────────────────────────────

import {
  parseArgs,
  readConfig,
  writeConfig,
  extractBearer,
  buildInitFiles,
  type SuedeConfig,
} from "../src/cli.js";

// ────────────────────────────────────────────────────────────────────────────
// Stub HTTP server helpers
// ────────────────────────────────────────────────────────────────────────────

interface StubRoute {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

function startStubServer(routes: StubRoute[]): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes.find(
        (r) => r.method === req.method && req.url?.startsWith(r.path),
      );
      const payload = JSON.stringify(route?.body ?? { error: "not found" });
      res.writeHead(route?.status ?? 404, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Temp dir helpers
// ────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suede-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// parseArgs
// ────────────────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("returns the subcommand as command", () => {
    const result = parseArgs(["node", "suede", "init"]);
    expect(result.command).toBe("init");
  });

  it("returns undefined command when no subcommand given", () => {
    const result = parseArgs(["node", "suede"]);
    expect(result.command).toBeUndefined();
  });

  it("captures positional args after the subcommand", () => {
    const result = parseArgs(["node", "suede", "pull", "my-agent-slug"]);
    expect(result.command).toBe("pull");
    expect(result.args[0]).toBe("my-agent-slug");
  });

  it("captures the login key arg", () => {
    const result = parseArgs(["node", "suede", "login", "my-workspace-key"]);
    expect(result.command).toBe("login");
    expect(result.args[0]).toBe("my-workspace-key");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Config read/write
// ────────────────────────────────────────────────────────────────────────────

describe("readConfig / writeConfig", () => {
  it("returns null when no config exists", () => {
    const result = readConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("writes and reads back a config", () => {
    const config: SuedeConfig = {
      workspaceKey: "abc-123",
      apiUrl: "https://agents.suedeai.ai",
    };
    writeConfig(tmpDir, config);
    const loaded = readConfig(tmpDir);
    expect(loaded).toEqual(config);
  });

  it("config file is written to .suede/config.json", () => {
    const config: SuedeConfig = { workspaceKey: "x", apiUrl: "https://example.com" };
    writeConfig(tmpDir, config);
    const exists = fs.existsSync(path.join(tmpDir, ".suede", "config.json"));
    expect(exists).toBe(true);
  });

  it("returns null for malformed config", () => {
    const configDir = path.join(tmpDir, ".suede");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "not-json", "utf-8");
    const result = readConfig(tmpDir);
    expect(result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractBearer
// ────────────────────────────────────────────────────────────────────────────

describe("extractBearer", () => {
  it("extracts the key from a valid Authorization header", () => {
    expect(extractBearer("Bearer my-key-123")).toBe("my-key-123");
  });

  it("returns null for missing header", () => {
    expect(extractBearer(null)).toBeNull();
  });

  it("returns null for non-Bearer scheme", () => {
    expect(extractBearer("Basic abc123")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildInitFiles
// ────────────────────────────────────────────────────────────────────────────

describe("buildInitFiles", () => {
  it("returns file entries for config, agent.ts, package.json, .gitignore", () => {
    const files = buildInitFiles("https://agents.suedeai.ai");
    const names = files.map((f) => f.name);
    expect(names).toContain(".suede/config.json");
    expect(names).toContain("agent.ts");
    expect(names).toContain("package.json");
    expect(names).toContain(".gitignore");
  });

  it("agent.ts content imports defineAgent from @suedeai/agents", () => {
    const files = buildInitFiles("https://agents.suedeai.ai");
    const agent = files.find((f) => f.name === "agent.ts");
    expect(agent?.content).toContain("@suedeai/agents");
    expect(agent?.content).toContain("defineAgent");
  });

  it(".gitignore contains .suede/", () => {
    const files = buildInitFiles("https://agents.suedeai.ai");
    const gi = files.find((f) => f.name === ".gitignore");
    expect(gi?.content).toContain(".suede/");
  });

  it("package.json lists @suedeai/agents as a dependency", () => {
    const files = buildInitFiles("https://agents.suedeai.ai");
    const pkg = files.find((f) => f.name === "package.json");
    expect(pkg?.content).toContain("@suedeai/agents");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// push command logic (against stub server)
// ────────────────────────────────────────────────────────────────────────────

describe("push command", () => {
  it("POSTs the manifest to /api/cli/agents and returns slug + url", async () => {
    const { runPush } = await import("../src/cli.js");

    const stub = await startStubServer([
      {
        method: "POST",
        path: "/api/cli/agents",
        status: 201,
        body: {
          ok: true,
          slug: "my-cli-agent-abc12",
          url: "/a/my-cli-agent-abc12",
          manifest: { manifestVersion: 1, name: "My CLI Agent" },
        },
      },
    ]);

    try {
      const config: SuedeConfig = { workspaceKey: "test-key", apiUrl: stub.url };
      // Write a minimal agent.ts in tmpDir
      fs.writeFileSync(
        path.join(tmpDir, "agent.ts"),
        `
import { defineAgent, paidCall } from "@suedeai/agents";
export default defineAgent({
  name: "My CLI Agent",
  description: "test",
  triggers: [paidCall(0.1)],
  async run() { return {}; },
});
`,
        "utf-8",
      );

      const result = await runPush(config, tmpDir);
      expect(result.slug).toBe("my-cli-agent-abc12");
      expect(result.url).toContain("/a/");
    } finally {
      stub.close();
    }
  });

  it("throws when server returns non-201", async () => {
    const { runPush } = await import("../src/cli.js");

    const stub = await startStubServer([
      {
        method: "POST",
        path: "/api/cli/agents",
        status: 400,
        body: { error: "Invalid manifest" },
      },
    ]);

    try {
      const config: SuedeConfig = { workspaceKey: "test-key", apiUrl: stub.url };
      fs.writeFileSync(
        path.join(tmpDir, "agent.ts"),
        `export default { name: "x", triggers: [], run: async () => ({}) };`,
        "utf-8",
      );
      await expect(runPush(config, tmpDir)).rejects.toThrow();
    } finally {
      stub.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// pull command logic (against stub server)
// ────────────────────────────────────────────────────────────────────────────

describe("pull command", () => {
  it("GETs /api/cli/agents/:slug and writes manifest.json + agent.ts", async () => {
    const { runPull } = await import("../src/cli.js");

    const sampleManifest = {
      manifestVersion: 1,
      name: "Pulled Agent",
      description: "from the platform",
      triggers: [{ kind: "paidCall", priceUsdc: 0.25 }],
      steps: [
        { id: "n1", type: "input", config: {}, after: [] },
        { id: "n2", type: "output", config: {}, after: ["n1"] },
      ],
      meta: {},
    };

    const stub = await startStubServer([
      {
        method: "GET",
        path: "/api/cli/agents/pulled-agent-xyz",
        status: 200,
        body: { slug: "pulled-agent-xyz", manifest: sampleManifest },
      },
    ]);

    try {
      const config: SuedeConfig = { workspaceKey: "test-key", apiUrl: stub.url };
      await runPull("pulled-agent-xyz", config, tmpDir);

      const manifestPath = path.join(tmpDir, "manifest.json");
      const agentPath = path.join(tmpDir, "agent.ts");

      expect(fs.existsSync(manifestPath)).toBe(true);
      expect(fs.existsSync(agentPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
      expect((written as { name?: string }).name).toBe("Pulled Agent");

      const agentSrc = fs.readFileSync(agentPath, "utf-8");
      expect(agentSrc).toContain("defineAgent");
      expect(agentSrc).toContain("Pulled Agent");
    } finally {
      stub.close();
    }
  });

  it("throws when slug not found (404)", async () => {
    const { runPull } = await import("../src/cli.js");

    const stub = await startStubServer([
      {
        method: "GET",
        path: "/api/cli/agents/not-here",
        status: 404,
        body: { error: "not found" },
      },
    ]);

    try {
      const config: SuedeConfig = { workspaceKey: "test-key", apiUrl: stub.url };
      await expect(runPull("not-here", config, tmpDir)).rejects.toThrow();
    } finally {
      stub.close();
    }
  });
});
