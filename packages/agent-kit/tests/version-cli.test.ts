import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runVersionExport,
  runVersionInspect,
  runVersionPull,
  runVersionsCommand,
  runVersionsList,
  type SuedeConfig,
} from "../src/cli.js";

const SEMANTIC_HASH = "a".repeat(64);
const FULL_HASH = "b".repeat(64);
const WORKSPACE_KEY = "workspace-key-must-not-escape";
const CREATED_BY = "internal-created-by-must-not-escape";

interface CapturedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

function summary(schemaVersion = 1) {
  return {
    id: "version/one",
    flowId: "flow/opaque id",
    versionNumber: 1,
    schemaVersion,
    label: "First checkpoint",
    semanticHash: SEMANTIC_HASH,
    fullHash: FULL_HASH,
    createdBy: CREATED_BY,
    createdAt: 1_720_000_000_000,
    dependencyCount: 1,
  };
}

function version(schemaVersion = 1) {
  const { dependencyCount: _dependencyCount, ...base } = summary(schemaVersion);
  return {
    ...base,
    description: "Immutable checkpoint",
    graph: { id: "graph-1", name: "Graph", nodes: [], edges: [] },
    dependencies: [
      {
        id: "pin-db-id",
        flowVersionId: "version/one",
        kind: "connector",
        resourceId: "connector:search",
        version: "1.0.0",
        contentHash: "sha256:connector",
        createdAt: 1_720_000_000_000,
      },
    ],
  };
}

async function startVersionServer(
  schemaVersion = 1,
  versionBody: Record<string, unknown> = version(schemaVersion),
): Promise<{
  readonly url: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      const payload = JSON.stringify(
        request.url?.endsWith("/versions")
          ? { versions: [summary(schemaVersion)] }
          : { version: versionBody },
      );
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Version stub did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

let cwd: string;
let servers: Array<{ close(): Promise<void> }>;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "suede-version-cli-"));
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  fs.rmSync(cwd, { recursive: true, force: true });
});

function config(url: string): SuedeConfig {
  return { apiUrl: url, workspaceKey: WORKSPACE_KEY };
}

function expectNoSecrets(value: string): void {
  expect(value).not.toContain(WORKSPACE_KEY);
  expect(value).not.toContain(CREATED_BY);
  expect(value).not.toContain("createdBy");
}

describe("namespaced immutable version CLI reads", () => {
  it("lists and inspects versions with GET-only requests and sanitized output", async () => {
    const stub = await startVersionServer();
    servers.push(stub);

    const listed = await runVersionsList("flow/opaque id", config(stub.url));
    const inspected = await runVersionInspect(
      "flow/opaque id",
      "version/one",
      config(stub.url),
    );

    expect(listed).toContain("v1");
    expect(listed).toContain("First checkpoint");
    expect(inspected).toContain(SEMANTIC_HASH);
    expect(inspected).toContain(FULL_HASH);
    expect(inspected).toContain("connector:search@1.0.0");
    expectNoSecrets(`${listed}\n${inspected}`);
    expect(stub.requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "/api/v2/flows/flow%2Fopaque%20id/versions",
        authorization: `Bearer ${WORKSPACE_KEY}`,
        body: "",
      }),
      expect.objectContaining({
        method: "GET",
        url: "/api/v2/flows/flow%2Fopaque%20id/versions/version%2Fone",
        authorization: `Bearer ${WORKSPACE_KEY}`,
        body: "",
      }),
    ]);
  });

  it("pulls a sanitized immutable version atomically and refuses overwrite", async () => {
    const stub = await startVersionServer();
    servers.push(stub);
    const out = path.join(cwd, "pulled");

    const target = await runVersionPull(
      "flow/opaque id",
      "version/one",
      config(stub.url),
      cwd,
      { out },
    );
    const first = fs.readFileSync(target, "utf8");

    expect(target).toBe(path.join(out, "version.json"));
    expect(JSON.parse(first)).toMatchObject({ id: "version/one", schemaVersion: 1 });
    expectNoSecrets(first);
    expect(first).not.toContain("pin-db-id");
    expect(fs.readdirSync(out)).toEqual(["version.json"]);
    await expect(
      runVersionPull("flow/opaque id", "version/one", config(stub.url), cwd, { out }),
    ).rejects.toThrow("refusing to overwrite");
    expect(fs.readFileSync(target, "utf8")).toBe(first);
    await expect(
      runVersionPull("flow/opaque id", "version/one", config(stub.url), cwd, {
        out,
        force: true,
      }),
    ).resolves.toBe(target);
    expect(fs.readdirSync(out)).toEqual(["version.json"]);
  });

  it("exports deterministic self-hostable bundle bytes without timestamps or secrets", async () => {
    const stub = await startVersionServer();
    servers.push(stub);
    const firstPath = path.join(cwd, "first.suede-version.json");
    const secondPath = path.join(cwd, "second.suede-version.json");

    await runVersionExport("flow/opaque id", "version/one", config(stub.url), cwd, {
      out: firstPath,
    });
    await runVersionExport("flow/opaque id", "version/one", config(stub.url), cwd, {
      out: secondPath,
    });
    const first = fs.readFileSync(firstPath, "utf8");
    const second = fs.readFileSync(secondPath, "utf8");

    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      bundleVersion: 1,
      version: { id: "version/one", schemaVersion: 1 },
    });
    expect(first).not.toContain("exportedAt");
    expectNoSecrets(first);
  });

  it("exports identical bytes across graph-key and dependency insertion order", async () => {
    const firstVersion = version();
    const secondVersion = {
      ...version(),
      graph: { edges: [], nodes: [], name: "Graph", id: "graph-1" },
      dependencies: [...version().dependencies].reverse(),
    };
    const firstStub = await startVersionServer(1, firstVersion);
    const secondStub = await startVersionServer(1, secondVersion);
    servers.push(firstStub, secondStub);
    const firstPath = path.join(cwd, "ordered-first.json");
    const secondPath = path.join(cwd, "ordered-second.json");

    await runVersionExport("flow", "version", config(firstStub.url), cwd, { out: firstPath });
    await runVersionExport("flow", "version", config(secondStub.url), cwd, { out: secondPath });

    expect(fs.readFileSync(firstPath, "utf8")).toBe(fs.readFileSync(secondPath, "utf8"));
  });

  it("rejects a future schema before creating pull or export files", async () => {
    const stub = await startVersionServer(2);
    servers.push(stub);
    const pullOut = path.join(cwd, "future-pull");
    const exportOut = path.join(cwd, "future-export.json");

    await expect(
      runVersionPull("flow", "future", config(stub.url), cwd, { out: pullOut }),
    ).rejects.toThrow("Unsupported flow schema version 2");
    await expect(
      runVersionExport("flow", "future", config(stub.url), cwd, { out: exportOut }),
    ).rejects.toThrow("Unsupported flow schema version 2");
    expect(fs.existsSync(pullOut)).toBe(false);
    expect(fs.existsSync(exportOut)).toBe(false);
  });

  it("keeps opaque version ids inside the safe default version directory", async () => {
    const stub = await startVersionServer();
    servers.push(stub);

    const target = await runVersionPull("flow", "../secret", config(stub.url), cwd);

    expect(path.relative(path.join(cwd, ".suede", "versions"), target)).not.toMatch(/^\.\./);
    expect(target).toContain(path.join(".suede", "versions"));
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked output directory instead of writing through it",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const external = fs.mkdtempSync(path.join(os.tmpdir(), "suede-version-cli-external-"));
      const linked = path.join(cwd, "linked-output");
      fs.symlinkSync(external, linked);
      try {
        await expect(
          runVersionPull("flow", "version", config(stub.url), cwd, { out: linked }),
        ).rejects.toThrow("symbolic link");
        expect(fs.readdirSync(external)).toEqual([]);
      } finally {
        fs.rmSync(external, { recursive: true, force: true });
      }
    },
  );

  it("rejects an explicit output path outside the working directory", async () => {
    const stub = await startVersionServer();
    servers.push(stub);
    const outside = path.join(path.dirname(cwd), `${path.basename(cwd)}-outside.json`);
    try {
      await expect(
        runVersionExport("flow", "version", config(stub.url), cwd, { out: outside }),
      ).rejects.toThrow("outside the working directory");
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a force target symlink without changing its external file",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const external = path.join(os.tmpdir(), `suede-version-cli-target-${process.pid}.json`);
      const target = path.join(cwd, "bundle.json");
      fs.writeFileSync(external, "external-sentinel", "utf8");
      fs.symlinkSync(external, target);
      try {
        await expect(
          runVersionExport("flow", "version", config(stub.url), cwd, {
            out: target,
            force: true,
          }),
        ).rejects.toThrow("symbolic link");
        expect(fs.readFileSync(external, "utf8")).toBe("external-sentinel");
      } finally {
        fs.rmSync(external, { force: true });
      }
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "rejects an other-writable cwd before staging output content",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const target = path.join(cwd, "bundle.json");
      fs.chmodSync(cwd, 0o777);

      await expect(
        runVersionExport("flow", "version", config(stub.url), cwd, { out: target }),
      ).rejects.toThrow("group or other writable");

      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(path.join(cwd, ".suede-version-tmp"))).toBe(false);
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "rejects a group-writable output ancestor before staging output content",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const outputDirectory = path.join(cwd, "group-writable");
      const target = path.join(outputDirectory, "bundle.json");
      fs.mkdirSync(outputDirectory, { mode: 0o700 });
      fs.chmodSync(outputDirectory, 0o775);

      await expect(
        runVersionExport("flow", "version", config(stub.url), cwd, { out: target }),
      ).rejects.toThrow("group or other writable");

      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(path.join(cwd, ".suede-version-tmp"))).toBe(false);
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "rejects a foreign-owned output ancestor before staging output content",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const outputDirectory = path.join(cwd, "foreign-owned");
      const target = path.join(outputDirectory, "bundle.json");
      fs.mkdirSync(outputDirectory, { mode: 0o700 });
      const realLstatSync = fs.lstatSync.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((file, ...args) => {
        const stat = Reflect.apply(realLstatSync, fs, [file, ...args]) as ReturnType<typeof fs.lstatSync>;
        if (path.resolve(String(file)) !== outputDirectory) return stat;
        if (!stat) throw new Error("expected foreign-owned output ancestor stat");
        return new Proxy(stat, {
          get(value, property) {
            return property === "uid"
              ? process.getuid!() + 1
              : Reflect.get(value as object, property, value);
          },
        });
      }) as typeof fs.lstatSync);

      try {
        await expect(
          runVersionExport("flow", "version", config(stub.url), cwd, { out: target }),
        ).rejects.toThrow("current user");
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.existsSync(path.join(cwd, ".suede-version-tmp"))).toBe(false);
      } finally {
        lstatSpy.mockRestore();
      }
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "allows secure 0700 cwd and 0755 output ancestors",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const outputDirectory = path.join(cwd, "trusted-output");
      const target = path.join(outputDirectory, "bundle.json");
      fs.chmodSync(cwd, 0o700);
      fs.mkdirSync(outputDirectory, { mode: 0o700 });
      fs.chmodSync(outputDirectory, 0o755);

      await expect(
        runVersionExport("flow", "version", config(stub.url), cwd, { out: target }),
      ).resolves.toBe(target);
      expect(fs.statSync(target).isFile()).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "revalidates target ancestry after staging without writing outside cwd",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const external = fs.mkdtempSync(path.join(os.tmpdir(), "suede-version-cli-race-"));
      const outputDirectory = path.join(cwd, "race-output");
      const target = path.join(outputDirectory, "bundle.json");
      fs.mkdirSync(outputDirectory);
      const realWriteFileSync = fs.writeFileSync.bind(fs);
      let swapped = false;
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, ...args) => {
        if (!swapped && String(file).includes(".tmp")) {
          swapped = true;
          fs.rmSync(outputDirectory, { recursive: true, force: true });
          fs.symlinkSync(external, outputDirectory);
        }
        return Reflect.apply(realWriteFileSync, fs, [file, ...args]);
      }) as typeof fs.writeFileSync);

      try {
        await expect(
          runVersionExport("flow", "version", config(stub.url), cwd, {
            out: target,
            force: true,
          }),
        ).rejects.toThrow("symbolic link");
        expect(swapped).toBe(true);
        expect(fs.readdirSync(external)).toEqual([]);
        const staging = path.join(cwd, ".suede-version-tmp");
        expect(fs.existsSync(staging) ? fs.readdirSync(staging) : []).toEqual([]);
      } finally {
        writeSpy.mockRestore();
        fs.rmSync(external, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a force target FIFO without replacing it",
    async () => {
      const stub = await startVersionServer();
      servers.push(stub);
      const target = path.join(cwd, "bundle.fifo");
      execFileSync("mkfifo", [target]);
      const before = fs.lstatSync(target);

      await expect(
        runVersionExport("flow", "version", config(stub.url), cwd, {
          out: target,
          force: true,
        }),
      ).rejects.toThrow("regular file");

      const after = fs.lstatSync(target);
      expect(after.isFIFO()).toBe(true);
      expect({ ino: after.ino, mode: after.mode, size: after.size }).toEqual({
        ino: before.ino,
        mode: before.mode,
        size: before.size,
      });
    },
  );

  it("dispatches only the four read-oriented versions subcommands", async () => {
    const stub = await startVersionServer();
    servers.push(stub);
    const listed = await runVersionsCommand(
      ["list", "flow/opaque id"],
      config(stub.url),
      cwd,
    );

    expect(listed).toContain("v1");
    await expect(runVersionsCommand(["deploy", "flow"], config(stub.url), cwd)).rejects.toThrow(
      "Usage: suede versions",
    );
    await expect(runVersionsCommand(["pull", "flow"], config(stub.url), cwd)).rejects.toThrow(
      "Usage: suede versions pull",
    );
  });

  it("keeps the version command implementation free of deploy, payment, and provider paths", () => {
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts"),
      "utf8",
    );
    const start = source.indexOf("// versions-read-start");
    const end = source.indexOf("// versions-read-end");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const versionCommands = source.slice(start, end);
    expect(versionCommands).not.toMatch(/\bPOST\b|deploy|payment|provider|settle|x402/i);
  });
});
