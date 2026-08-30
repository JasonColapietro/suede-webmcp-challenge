import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { FlowGraph, FlowGraphV2, SupportedFlowGraph } from "@/lib/flow/types";
import type { FlowCallableInterface, SubflowReference } from "@/lib/flow/types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowVersionRepo } from "@/lib/projects/repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type {
  DependencyKind,
  FlowVersionRecord,
} from "@/lib/projects/types";
import {
  compareFlowVersions,
  VersionService,
} from "@/lib/projects/version-service";
import { compareFlowVersionDetails } from "@/lib/projects/version-diff";
import { FlowVersionMutationError } from "@/lib/projects/version-mutation-error";

function graph(): FlowGraph {
  return {
    id: "graph-1",
    name: "Versioned flow",
    nodes: [
      {
        id: "input",
        type: "input",
        params: { schema: { topic: "string" } },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    meta: { createdBy: "studio", viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

function graphV2(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "graph-v2-not-row-id",
    name: "Exact v2 checkpoint",
    nodes: [
      {
        id: "input",
        type: "input",
        params: { prompt: "hello" },
        bindings: {},
        position: { x: 10, y: 20 },
      },
    ],
    edges: [],
    variables: [
      {
        id: "var-topic",
        name: "Topic",
        scope: "run",
        schema: { type: "string" },
        default: "music",
      },
    ],
    groups: [],
    annotations: [],
    ...overrides,
  };
}

function callable(id = "answer"): FlowCallableInterface {
  return {
    inputs: [],
    outputs: [{
      id,
      label: id,
      schema: { type: "string" },
      required: true,
      cardinality: "one",
      source: { nodeId: "input", portId: "value" },
    }],
  };
}

function typedGraph(id: string, abi = callable()): FlowGraphV2 {
  return graphV2({ id, name: id, callableInterface: abi });
}

function draftReference(flowId: string, abi = callable()): SubflowReference {
  return { kind: "draft", flowId, interface: abi, interfaceHash: hashCallableInterface(abi) };
}

function pinnedReference(
  flowId: string,
  versionId: string,
  contentHash: string,
  abi = callable(),
): SubflowReference {
  return {
    kind: "pinned",
    flowId,
    versionId,
    interface: abi,
    interfaceHash: hashCallableInterface(abi),
    contentHash,
  };
}

function referencingGraph(id: string, reference: SubflowReference | { flowId: string }): FlowGraphV2 {
  return graphV2({
    id,
    name: id,
    nodes: [{
      id: "child",
      type: "subflow",
      params: ("kind" in reference ? { reference } : reference) as never,
      bindings: {},
      position: { x: 0, y: 0 },
    }],
  });
}

function seedFlow(
  db: Database.Database,
  input: { id?: string; ownerId?: string; value?: unknown } = {},
): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.id ?? "flow-1",
    input.ownerId ?? "owner-1",
    "Flow",
    JSON.stringify(input.value ?? graph()),
    1,
  );
}

function makeService(): {
  db: Database.Database;
  repo: SqliteProjectRepo;
  service: VersionService;
} {
  const db = new Database(":memory:");
  const repo = new SqliteProjectRepo(db);
  return { db, repo, service: new VersionService(repo) };
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  // Each worker is a fresh vite-node process that must transform the repo and
  // service module graphs before it can signal readiness; under a saturated
  // parallel suite that boot regularly needs well over the idle-machine time.
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    if (paths.every(existsSync)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for worker readiness: ${paths.join(", ")}`);
}

interface VersionWorker {
  readonly child: ChildProcess;
  readonly done: Promise<{ id: string; versionNumber: number }>;
}

function spawnVersionWorker(input: {
  workerPath: string;
  dbPath: string;
  barrierPath: string;
  readyPath: string;
  label: string;
}): VersionWorker {
  const viteNodePath = join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
  const child = spawn(
    process.execPath,
    [viteNodePath, "--config", join(process.cwd(), "vitest.config.ts"), input.workerPath],
    {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VERSION_DB_PATH: input.dbPath,
      VERSION_BARRIER_PATH: input.barrierPath,
      VERSION_READY_PATH: input.readyPath,
      VERSION_LABEL: input.label,
    },
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<{ id: string; versionNumber: number }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Version worker exited ${String(code)}: ${stderr}`));
        return;
      }
      // vite-node can intercept SIGTERM and exit 0 without running the worker
      // body; a bare JSON.parse here would throw synchronously in the event
      // listener and escape the promise as an uncaught exception.
      try {
        resolve(JSON.parse(stdout) as { id: string; versionNumber: number });
      } catch {
        reject(new Error(`Version worker produced no result: ${stderr || stdout || "(empty)"}`));
      }
    });
  });
  return { child, done };
}

function requireVersion(version: FlowVersionRecord | null): FlowVersionRecord {
  if (version === null) throw new Error("Expected version");
  return version;
}

describe("VersionService immutable snapshots", () => {
  it("atomically persists and snapshots exact v2 bytes under the authoritative row id", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const checkpoint = graphV2();
    const expectedBytes = JSON.stringify(checkpoint);

    const created = requireVersion(
      await service.createFlowCheckpoint({
        flowId: "flow-1",
        ownerId: "owner-1",
        graph: checkpoint,
      }),
    );

    expect(created.flowId).toBe("flow-1");
    expect(created.schemaVersion).toBe(2);
    expect(created.graph).toEqual(checkpoint);
    expect("variables" in created.graph ? created.graph.variables[0] : null).toMatchObject({ default: "music" });
    expect(db.prepare("SELECT name, graph FROM flows WHERE id = ?").get("flow-1")).toEqual({
      name: checkpoint.name,
      graph: expectedBytes,
    });
    expect(db.prepare("SELECT graph FROM flow_versions WHERE id = ?").get(created.id)).toEqual({
      graph: expectedBytes,
    });
  });

  it("keeps wrong-owner and failed inserts atomic without changing draft bytes", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const before = db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = ?").get("flow-1");

    expect(
      await service.createFlowCheckpoint({
        flowId: "flow-1",
        ownerId: "owner-2",
        graph: graphV2(),
      }),
    ).toBeNull();
    expect(db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = ?").get("flow-1")).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });

    db.exec(`CREATE TRIGGER fail_checkpoint_insert BEFORE INSERT ON flow_versions
      BEGIN SELECT RAISE(ABORT, 'forced checkpoint insert failure'); END`);
    await expect(
      service.createFlowCheckpoint({ flowId: "flow-1", ownerId: "owner-1", graph: graphV2() }),
    ).rejects.toThrow("forced checkpoint insert failure");
    expect(db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = ?").get("flow-1")).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
  });

  it("refuses typed drafts, missing legacy targets, and transitive cycles inside version transactions", async () => {
    const { db, service } = makeService();
    seedFlow(db, { id: "child", value: typedGraph("child") });
    seedFlow(db, { id: "typed-parent", value: referencingGraph("typed-parent", draftReference("child")) });
    seedFlow(db, { id: "legacy-parent", value: referencingGraph("legacy-parent", { flowId: "missing" }) });
    seedFlow(db, { id: "cycle-a", value: typedGraph("cycle-a") });
    seedFlow(db, { id: "cycle-b", value: referencingGraph("cycle-b", { flowId: "cycle-a" }) });

    await expect(service.createFlowVersion({ flowId: "typed-parent", ownerId: "owner-1" }))
      .rejects.toBeInstanceOf(FlowVersionMutationError);
    await expect(service.createFlowVersion({ flowId: "legacy-parent", ownerId: "owner-1" }))
      .rejects.toBeInstanceOf(FlowVersionMutationError);
    const before = db.prepare("SELECT graph, updated_at FROM flows WHERE id = 'cycle-a'").get();
    await expect(service.createFlowCheckpoint({
      flowId: "cycle-a",
      ownerId: "owner-1",
      graph: referencingGraph("cycle-a-next", { flowId: "cycle-b" }),
    })).rejects.toBeInstanceOf(FlowVersionMutationError);
    expect(db.prepare("SELECT graph, updated_at FROM flows WHERE id = 'cycle-a'").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
  });

  it("refuses foreign and tampered pinned versions inside the checkpoint transaction", async () => {
    const { db, service } = makeService();
    seedFlow(db, { id: "root", value: typedGraph("root") });
    seedFlow(db, { id: "owned-child", value: typedGraph("owned-child") });
    seedFlow(db, { id: "foreign-child", ownerId: "owner-2", value: typedGraph("foreign-child") });
    const ownedVersion = requireVersion(await service.createFlowVersion({
      flowId: "owned-child", ownerId: "owner-1",
    }));
    const foreignVersion = requireVersion(await service.createFlowVersion({
      flowId: "foreign-child", ownerId: "owner-2",
    }));
    const before = db.prepare("SELECT graph, updated_at FROM flows WHERE id = 'root'").get();
    for (const reference of [
      pinnedReference("owned-child", ownedVersion.id, "0".repeat(64)),
      pinnedReference("foreign-child", foreignVersion.id, foreignVersion.semanticHash),
    ]) {
      await expect(service.createFlowCheckpoint({
        flowId: "root", ownerId: "owner-1", graph: referencingGraph("root-next", reference),
      })).rejects.toBeInstanceOf(FlowVersionMutationError);
      expect(db.prepare("SELECT graph, updated_at FROM flows WHERE id = 'root'").get()).toEqual(before);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = 'root'").get())
      .toEqual({ count: 0 });
  });

  it("persists one impact receipt, then atomically checkpoints only on its valid retry", async () => {
    const { db, service } = makeService();
    seedFlow(db, { id: "child", value: typedGraph("child") });
    seedFlow(db, { id: "parent", value: referencingGraph("parent", draftReference("child")) });
    const original = db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'child'").get();
    const proposed = typedGraph("child-next", callable("revised"));

    let receipt = "";
    try {
      await service.createFlowCheckpoint({ flowId: "child", ownerId: "owner-1", graph: proposed });
      throw new Error("expected impact refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowVersionMutationError);
      const mutation = (error as FlowVersionMutationError).result;
      expect(mutation.status).toBe("impact-required");
      if (mutation.status === "impact-required") receipt = mutation.receipt;
    }
    expect(receipt).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'child'").get()).toEqual(original);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM subflow_impact_receipts").get()).toEqual({ count: 1 });

    db.exec(`CREATE TRIGGER fail_impact_checkpoint_insert BEFORE INSERT ON flow_versions
      BEGIN SELECT RAISE(ABORT, 'forced impact checkpoint insert failure'); END`);
    await expect(service.createFlowCheckpoint({
      flowId: "child",
      ownerId: "owner-1",
      graph: proposed,
      impactReceipt: receipt,
    })).rejects.toThrow("forced impact checkpoint insert failure");
    expect(db.prepare("SELECT name, graph, updated_at FROM flows WHERE id = 'child'").get()).toEqual(original);
    expect(db.prepare("SELECT consumed_at FROM subflow_impact_receipts").get()).toEqual({ consumed_at: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_impact_checkpoint_insert");

    const created = requireVersion(await service.createFlowCheckpoint({
      flowId: "child",
      ownerId: "owner-1",
      graph: proposed,
      impactReceipt: receipt,
    }));
    expect(created.graph).toEqual(proposed);
    expect(db.prepare("SELECT graph FROM flows WHERE id = 'child'").get()).toEqual({ graph: JSON.stringify(proposed) });
    expect(db.prepare("SELECT consumed_at IS NOT NULL AS consumed FROM subflow_impact_receipts").get())
      .toEqual({ consumed: 1 });
  });

  it("rejects future checkpoint graphs before opening either write path", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const before = db.prepare("SELECT graph FROM flows WHERE id = ?").get("flow-1");
    await expect(
      service.createFlowCheckpoint({
        flowId: "flow-1",
        ownerId: "owner-1",
        graph: { ...graphV2(), schemaVersion: 3 } as unknown as SupportedFlowGraph,
      }),
    ).rejects.toThrow("Unsupported flow graph schemaVersion: 3");
    expect(db.prepare("SELECT graph FROM flows WHERE id = ?").get("flow-1")).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
  });

  it("dedupes checkpoints only for exact graph bytes and identical dependency pins", async () => {
    const fixture = makeService();
    seedFlow(fixture.db);
    const dependencies = [{ kind: "skill" as const, resourceId: "mail", version: "1" }];
    const firstGraph = graphV2();
    const first = requireVersion(await fixture.service.createFlowCheckpoint({
      flowId: "flow-1", ownerId: "owner-1", graph: firstGraph, dependencies,
    }));
    const exact = requireVersion(await fixture.service.createFlowCheckpoint({
      flowId: "flow-1", ownerId: "owner-1", graph: firstGraph, dependencies,
    }));
    const layout = graphV2({
      nodes: [{ ...firstGraph.nodes[0], position: { x: 999, y: 20 } }],
    });
    const layoutVersion = requireVersion(await fixture.service.createFlowCheckpoint({
      flowId: "flow-1", ownerId: "owner-1", graph: layout, dependencies,
    }));
    const pinVersion = requireVersion(await fixture.service.createFlowCheckpoint({
      flowId: "flow-1", ownerId: "owner-1", graph: layout,
      dependencies: [{ kind: "skill", resourceId: "mail", version: "2" }],
    }));

    expect(exact.id).toBe(first.id);
    expect(layoutVersion.id).not.toBe(first.id);
    expect(layoutVersion.semanticHash).toBe(first.semanticHash);
    expect(pinVersion.id).not.toBe(layoutVersion.id);
  });

  it("keeps v1 checkpoint bytes stable and refuses semantic dedupe across visual metadata", async () => {
    const fixture = makeService();
    seedFlow(fixture.db);
    const firstGraph = {
      name: "Ordered legacy checkpoint",
      id: "legacy-graph-id",
      edges: [],
      nodes: [],
      meta: { display: { color: "red" }, compatibleUnknown: "kept" },
    } satisfies FlowGraph;
    const firstBytes = JSON.stringify(firstGraph);
    const first = requireVersion(await fixture.service.createFlowCheckpoint({
      flowId: "flow-1", ownerId: "owner-1", graph: firstGraph,
    }));
    const changedVisual = {
      ...firstGraph,
      meta: { ...firstGraph.meta, display: { color: "blue" } },
    };
    const second = requireVersion(await fixture.service.createFlowCheckpoint({
      flowId: "flow-1", ownerId: "owner-1", graph: changedVisual,
    }));

    expect(first.schemaVersion).toBe(1);
    expect((fixture.db.prepare("SELECT graph FROM flow_versions WHERE id = ?").get(first.id) as { graph: string }).graph).toBe(firstBytes);
    expect(second.semanticHash).toBe(first.semanticHash);
    expect(second.id).not.toBe(first.id);
  });
  it("creates version 1 and keeps its deep snapshot after the draft changes", async () => {
    const { db, service } = makeService();
    seedFlow(db);

    const created = requireVersion(
      await service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1" }),
    );
    const changed = graph();
    changed.nodes[0].params = { schema: { topic: "number" } };
    changed.nodes[0].position = { x: 800, y: 400 };
    db.prepare("UPDATE flows SET graph = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(changed),
      2,
      "flow-1",
    );

    const stored = requireVersion(
      await service.getFlowVersion({
        flowId: "flow-1",
        versionId: created.id,
        ownerId: "owner-1",
      }),
    );

    expect(created.versionNumber).toBe(1);
    expect(created.schemaVersion).toBe(1);
    expect(created.semanticHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.fullHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).toEqual(created);
    expect(stored.graph.nodes[0]).toMatchObject({
      params: { schema: { topic: "string" } },
      position: { x: 0, y: 0 },
    });
    const callerGraph = stored.graph as unknown as FlowGraph;
    callerGraph.nodes[0].params = { schema: { topic: "caller mutation" } };
    expect((await service.getFlowVersion({
      flowId: "flow-1",
      versionId: created.id,
      ownerId: "owner-1",
    }))?.graph.nodes[0].params).toEqual({ schema: { topic: "string" } });
  });

  it("validates the persisted graph before creating a version", async () => {
    const { db, service } = makeService();
    seedFlow(db, { value: { id: "invalid", name: "Invalid", nodes: [] } });

    await expect(
      service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1" }),
    ).rejects.toBeInstanceOf(FlowVersionMutationError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
  });

  it("refuses oversized and excessively deep persisted snapshots without writing", async () => {
    const { db, service } = makeService();
    const oversized = graph();
    oversized.nodes[0].params = { payload: "x".repeat(2 * 1024 * 1024) };
    seedFlow(db, { id: "oversized", value: oversized });
    let nested: Record<string, unknown> = { value: "deep" };
    for (let index = 0; index < 70; index += 1) nested = { nested };
    const deep = graph();
    deep.nodes[0].params = nested;
    seedFlow(db, { id: "deep", value: deep });

    for (const flowId of ["oversized", "deep"]) {
      await expect(service.createFlowVersion({ flowId, ownerId: "owner-1" }))
        .rejects.toBeInstanceOf(FlowVersionMutationError);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM dependency_pins").get()).toEqual({ count: 0 });
  });

  it("bounds direct version metadata and dependency work before repository writes", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const tooMany = Array.from({ length: 1_001 }, (_, index) => ({
      kind: "skill" as const,
      resourceId: `skill-${index}`,
      version: "1",
    }));
    for (const input of [
      { label: "é".repeat(101) },
      { description: "é".repeat(1_001) },
      { dependencies: tooMany },
      { dependencies: [{ kind: "skill" as const, resourceId: "x".repeat(513), version: "1" }] },
    ]) {
      await expect(service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1", ...input }))
        .rejects.toBeInstanceOf(TypeError);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
  });

  it("allocates monotonic version numbers across simultaneous independent processes", async () => {
    const artifactsRoot = join(process.cwd(), ".artifacts");
    mkdirSync(artifactsRoot, { recursive: true });
    const directory = mkdtempSync(join(artifactsRoot, "version-concurrency-"));
    const dbPath = join(directory, "studio.db");
    const workerPath = join(directory, "create-version-worker.ts");
    const barrierPath = join(directory, "start");
    const readyPaths = [join(directory, "ready-a"), join(directory, "ready-b")];
    let workers: VersionWorker[] = [];
    try {
      const db = new Database(dbPath);
      runSqliteMigrations(db);
      seedFlow(db);
      db.close();

      const projectRepoUrl = join(
        process.cwd(),
        "src/lib/projects/sqlite-project-repo.ts",
      );
      const versionServiceUrl = join(
        process.cwd(),
        "src/lib/projects/version-service.ts",
      );
      writeFileSync(
        workerPath,
        `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteProjectRepo } from ${JSON.stringify(projectRepoUrl)};
import { VersionService } from ${JSON.stringify(versionServiceUrl)};

const dbPath = process.env.VERSION_DB_PATH;
const barrierPath = process.env.VERSION_BARRIER_PATH;
const readyPath = process.env.VERSION_READY_PATH;
const label = process.env.VERSION_LABEL;
if (!dbPath || !barrierPath || !readyPath || !label) throw new Error("missing worker input");
const service = new VersionService(new SqliteProjectRepo(dbPath));
writeFileSync(readyPath, "ready");
while (!existsSync(barrierPath)) await delay(5);
const version = await service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1", label });
if (!version) throw new Error("version creation failed");
process.stdout.write(JSON.stringify({ id: version.id, versionNumber: version.versionNumber }));
`,
        "utf8",
      );

      workers = [
        spawnVersionWorker({
          workerPath,
          dbPath,
          barrierPath,
          readyPath: readyPaths[0],
          label: "Checkpoint A",
        }),
        spawnVersionWorker({
          workerPath,
          dbPath,
          barrierPath,
          readyPath: readyPaths[1],
          label: "Checkpoint B",
        }),
      ];
      const completions = workers.map((worker) => worker.done);
      await Promise.race([
        waitForFiles(readyPaths),
        Promise.all(completions).then(() => {
          throw new Error("Version workers exited before the concurrency barrier");
        }),
      ]);
      writeFileSync(barrierPath, "start", "utf8");

      const created = await Promise.all(completions);
      expect(created.map((version) => version.versionNumber).sort()).toEqual([1, 2]);
      const inspection = new Database(dbPath, { readonly: true });
      expect(
        inspection
          .prepare("SELECT version_number FROM flow_versions ORDER BY version_number")
          .all(),
      ).toEqual([{ version_number: 1 }, { version_number: 2 }]);
      inspection.close();
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill("SIGTERM");
        }
      }
      await Promise.allSettled(workers.map((worker) => worker.done));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("VersionService deduplication and dependency pins", () => {
  it("deduplicates unlabeled semantic content but permits a labeled checkpoint", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const first = requireVersion(
      await service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1" }),
    );
    const moved = graph();
    moved.nodes[0].position = { x: 500, y: 250 };
    db.prepare("UPDATE flows SET graph = ? WHERE id = ?").run(JSON.stringify(moved), "flow-1");

    const whitespace = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        label: "   ",
      }),
    );
    const checkpoint = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        label: "  Layout checkpoint  ",
      }),
    );

    expect(whitespace.id).toBe(first.id);
    expect(checkpoint).toMatchObject({ versionNumber: 2, label: "Layout checkpoint" });
    expect((await service.listFlowVersions({ flowId: "flow-1", ownerId: "owner-1" })).map(
      (version) => version.versionNumber,
    )).toEqual([2, 1]);
  });

  it("round-trips pins stably and treats dependency-only changes as new content", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const first = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [
          { kind: "skill", resourceId: "summarize", version: "2" },
          { kind: "agent", resourceId: "research", version: "1", contentHash: "abc" },
        ],
      }),
    );
    const reordered = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [
          { kind: "agent", resourceId: "research", version: "1", contentHash: "abc" },
          { kind: "skill", resourceId: "summarize", version: "2" },
        ],
      }),
    );
    const changed = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [
          { kind: "agent", resourceId: "research", version: "2", contentHash: "def" },
          { kind: "skill", resourceId: "summarize", version: "2" },
        ],
      }),
    );

    expect(reordered.id).toBe(first.id);
    expect(first.dependencies.map(({ kind, resourceId, version }) => [kind, resourceId, version])).toEqual([
      ["agent", "research", "1"],
      ["skill", "summarize", "2"],
    ]);
    expect(changed.versionNumber).toBe(2);
    expect(compareFlowVersions(first, changed)).toEqual({
      semanticEqual: false,
      fullEqual: false,
      changedSections: ["dependencies"],
    });
  });

  it("deduplicates identical pins across adversarial Unicode sort orders", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const dependencies = [
      { kind: "skill" as const, resourceId: "\u{10000}", version: "1" },
      { kind: "skill" as const, resourceId: "\uE000", version: "1" },
    ];

    const first = requireVersion(
      await service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1", dependencies }),
    );
    const duplicate = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [...dependencies].reverse(),
      }),
    );

    expect(duplicate.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 1 });
  });

  it("rejects duplicate kind/resource pairs before writing anything", async () => {
    const { db, service } = makeService();
    seedFlow(db);

    await expect(
      service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [
          { kind: "agent", resourceId: "research", version: "1" },
          { kind: "agent", resourceId: "research", version: "2" },
        ],
      }),
    ).rejects.toThrow("Duplicate dependency pin: agent/research");
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM dependency_pins").get()).toEqual({ count: 0 });
  });

  it("rolls back the version and every pin when one pin insert fails", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    db.exec(`
      CREATE TRIGGER fail_version_pin
      BEFORE INSERT ON dependency_pins
      WHEN NEW.resource_id = 'fail'
      BEGIN
        SELECT RAISE(ABORT, 'forced pin failure');
      END;
    `);

    await expect(
      service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [
          { kind: "agent", resourceId: "ok", version: "1" },
          { kind: "skill", resourceId: "fail", version: "1" },
        ],
      }),
    ).rejects.toThrow("forced pin failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM dependency_pins").get()).toEqual({ count: 0 });
  });
});

describe("VersionService ownership and immutable surface", () => {
  it("makes missing and wrong-owner reads and creates indistinguishable", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const version = requireVersion(
      await service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-1" }),
    );

    expect(await service.createFlowVersion({ flowId: "flow-1", ownerId: "owner-2" })).toBeNull();
    expect(await service.createFlowVersion({ flowId: "missing", ownerId: "owner-2" })).toBeNull();
    expect(await service.getFlowVersion({
      flowId: "flow-1",
      versionId: version.id,
      ownerId: "owner-2",
    })).toBeNull();
    expect(await service.getFlowVersion({
      flowId: "missing",
      versionId: "missing",
      ownerId: "owner-2",
    })).toBeNull();
    expect(await service.listFlowVersions({ flowId: "flow-1", ownerId: "owner-2" })).toEqual([]);
    expect(await service.listFlowVersions({ flowId: "missing", ownerId: "owner-2" })).toEqual([]);
  });

  it("exposes no public version update or delete operation", () => {
    const { repo, service } = makeService();
    const versionRepo: FlowVersionRepo = repo;

    // @ts-expect-error Immutable versions have no public update operation.
    expect(versionRepo.updateFlowVersion).toBeUndefined();
    // @ts-expect-error Immutable versions have no public delete operation.
    expect(versionRepo.deleteFlowVersion).toBeUndefined();
    // @ts-expect-error The service also has no update operation.
    expect(service.updateFlowVersion).toBeUndefined();
    // @ts-expect-error The service also has no delete operation.
    expect(service.deleteFlowVersion).toBeUndefined();
  });

  it("validates and normalizes direct repository creation input", async () => {
    const { db, repo } = makeService();
    seedFlow(db);
    const first = requireVersion(
      await repo.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        label: "   ",
        dependencies: [],
      }),
    );
    const duplicate = requireVersion(
      await repo.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [],
      }),
    );

    expect(duplicate.id).toBe(first.id);
    await expect(
      repo.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [
          {
            kind: "invalid" as DependencyKind,
            resourceId: "resource",
            version: "1",
          },
        ],
      }),
    ).rejects.toThrow("Invalid dependency kind: invalid");
    await expect(
      repo.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        dependencies: [{ kind: "skill", resourceId: "   ", version: "1" }],
      }),
    ).rejects.toThrow("dependency resourceId is required");
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions").get()).toEqual({ count: 1 });
  });
});

describe("compareFlowVersions", () => {
  it("ignores visual-only changes and reports stable runtime sections", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const baseline = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        label: "Baseline",
      }),
    );
    const visualGraph = graph();
    visualGraph.nodes[0].position = { x: 300, y: 900 };
    visualGraph.meta = { ...visualGraph.meta, viewport: { x: 30, y: 90, zoom: 2 } };
    db.prepare("UPDATE flows SET graph = ? WHERE id = ?").run(
      JSON.stringify(visualGraph),
      "flow-1",
    );
    const visual = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        label: "Visual",
      }),
    );

    expect(compareFlowVersions(baseline, visual)).toEqual({
      semanticEqual: true,
      fullEqual: false,
      changedSections: [],
    });
    expect(compareFlowVersions(baseline, visual)).toEqual({
      semanticEqual: compareFlowVersionDetails(baseline, visual).semanticEqual,
      fullEqual: compareFlowVersionDetails(baseline, visual).fullEqual,
      changedSections: compareFlowVersionDetails(baseline, visual).changedSections,
    });

    const runtimeGraph = structuredClone(visualGraph);
    runtimeGraph.nodes[0].params = { schema: { topic: "number" } };
    runtimeGraph.meta = { ...runtimeGraph.meta, retryPolicy: { attempts: 3 } };
    db.prepare("UPDATE flows SET graph = ? WHERE id = ?").run(
      JSON.stringify(runtimeGraph),
      "flow-1",
    );
    const runtime = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        label: "Runtime",
        dependencies: [{ kind: "skill", resourceId: "retry", version: "1" }],
      }),
    );

    expect(compareFlowVersions(baseline, runtime)).toEqual({
      semanticEqual: false,
      fullEqual: false,
      changedSections: ["dependencies", "meta", "nodes"],
    });
  });

  it("recomputes hashes instead of trusting stale record fields", async () => {
    const { db, service } = makeService();
    seedFlow(db);
    const baseline = requireVersion(
      await service.createFlowVersion({
        flowId: "flow-1",
        ownerId: "owner-1",
        label: "Baseline",
      }),
    );
    const changedGraph = structuredClone(baseline.graph) as unknown as FlowGraph;
    changedGraph.nodes[0].params = { schema: { topic: "number" } };
    const stale: FlowVersionRecord = {
      ...baseline,
      id: "stale-version",
      graph: changedGraph,
      semanticHash: baseline.semanticHash,
      fullHash: baseline.fullHash,
    };

    expect(compareFlowVersions(baseline, stale)).toEqual({
      semanticEqual: false,
      fullEqual: false,
      changedSections: ["nodes"],
    });
  });
});
