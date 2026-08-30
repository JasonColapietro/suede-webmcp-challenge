import Database from "better-sqlite3";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FlowGraph } from "@/lib/flow/types";
import { DeploymentService } from "@/lib/projects/deployment-service";
import { PersonalContextAdapter } from "@/lib/projects/personal-context";
import { publicFlowVersionRecord } from "@/lib/projects/public-version";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { VersionService } from "@/lib/projects/version-service";
import { runVersionExport, runVersionInspect } from "../../packages/agent-kit/src/cli.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function graph(name: string, revision: number): FlowGraph {
  return {
    id: "phase1-uat-graph",
    name,
    nodes: [
      {
        id: "input",
        type: "input",
        params: { revision },
        position: { x: revision * 10, y: 0 },
      },
    ],
    edges: [],
  };
}

describe("Phase 1 disposable zero-price UAT", () => {
  it("binds, versions, deploys, edits, and exports locally without execution or settlement", async () => {
    const root = mkdtempSync(join(tmpdir(), "suede-phase1-uat-"));
    cleanupPaths.push(root);
    const sqlitePath = join(root, "phase1.db");
    const db = new Database(sqlitePath);
    const repo = new SqliteProjectRepo(db);
    const ownerId = "phase1-local-owner-secret";
    const flowId = "phase1-local-flow";
    const initialGraph = graph("Phase 1 local draft", 1);
    const initialGraphBytes = JSON.stringify(initialGraph);
    db.prepare(
      "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(flowId, ownerId, initialGraph.name, initialGraphBytes, Date.now());

    const context = await new PersonalContextAdapter(repo).ensurePersonalContext(ownerId);
    expect(await repo.bindFlow(flowId, context)).toMatchObject({
      flowId,
      projectId: context.project.id,
      workbookId: context.workbook.id,
    });
    expect(
      (db.prepare("SELECT graph FROM flows WHERE id = ?").get(flowId) as { graph: string }).graph,
    ).toBe(initialGraphBytes);

    const versions = new VersionService(repo);
    const version = await versions.createFlowVersion({
      flowId,
      ownerId,
      label: "Local zero-price checkpoint",
    });
    expect(version).not.toBeNull();
    if (!version) return;
    expect(version.graph).toEqual(initialGraph);
    expect(version.dependencies).toEqual([]);

    const testEnvironment = context.environments.find(({ kind }) => kind === "test");
    expect(testEnvironment).toBeDefined();
    if (!testEnvironment) return;
    const deployments = new DeploymentService(repo);
    const deployment = await deployments.deployVersion({
      flowId,
      versionId: version.id,
      versionSemanticHash: version.semanticHash,
      versionFullHash: version.fullHash,
      environmentId: testEnvironment.id,
      environmentKind: "test",
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST",
      ownerId,
    });
    expect(deployment).toMatchObject({
      status: "deployed",
      deployment: {
        flowId,
        flowVersionId: version.id,
        environmentId: testEnvironment.id,
        status: "test",
      },
    });

    const editedGraph = graph("Edited local draft", 2);
    db.prepare("UPDATE flows SET name = ?, graph = ?, updated_at = ? WHERE id = ?").run(
      editedGraph.name,
      JSON.stringify(editedGraph),
      Date.now(),
      flowId,
    );
    const immutable = await versions.getFlowVersion({ flowId, versionId: version.id, ownerId });
    expect(immutable?.graph).toEqual(initialGraph);
    expect(
      await deployments.getActiveDeployment({ flowId, environmentKind: "test", ownerId }),
    ).toMatchObject({ flowVersionId: version.id, status: "test" });

    const requests: Array<{ method?: string; authorization?: string }> = [];
    const server = http.createServer((request, response) => {
      requests.push({
        method: request.method,
        authorization: request.headers.authorization,
      });
      const payload = JSON.stringify({ version: publicFlowVersionRecord(version) });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("UAT server did not bind");
      const config = {
        apiUrl: `http://127.0.0.1:${address.port}`,
        workspaceKey: ownerId,
      };
      const inspected = await runVersionInspect(flowId, version.id, config);
      const exportPath = await runVersionExport(flowId, version.id, config, root, {
        out: join(root, "version.suede-version.json"),
      });
      const exported = readFileSync(exportPath, "utf8");
      expect(inspected).toContain(version.semanticHash);
      expect(exported).toContain(version.fullHash);
      expect(`${inspected}\n${exported}`).not.toContain(ownerId);
      expect(exported).not.toContain("createdBy");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }

    expect(requests).toHaveLength(2);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(requests.every(({ authorization }) => authorization === `Bearer ${ownerId}`)).toBe(true);
    for (const table of ["agents", "runs", "usage", "credits"] as const) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      ).toBe(0);
    }
    db.close();
  });
});
