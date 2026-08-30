import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";
import type { FlowCallableInterface } from "@/lib/flow/types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";

const root = mkdtempSync(join(tmpdir(), "suede-version-api-v2-"));
const sqlitePath = join(root, "versions.db");
const db = new Database(sqlitePath);
runSqliteMigrations(db);
const projectRepo = new SqliteProjectRepo(db);
let ownerSequence = 0;
function testOwner(): string {
  ownerSequence += 1;
  return `00000000-0000-4000-8000-${ownerSequence.toString().padStart(12, "0")}`;
}
let currentOwner: string | null = testOwner();
let currentCookieOwner: string | null = null;

vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("DB_DRIVER", "sqlite");
vi.stubEnv("SQLITE_PATH", sqlitePath);

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({
    get: (key: string) =>
      key === "agx_owner" && currentCookieOwner !== null
        ? { value: currentCookieOwner }
        : undefined,
  }),
}));

afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  currentOwner = testOwner();
  currentCookieOwner = null;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DB_DRIVER", "sqlite");
  vi.stubEnv("SQLITE_PATH", sqlitePath);
});

function graph(graphId: string, revision = 1): FlowGraph {
  return {
    id: graphId,
    name: `Version API ${revision}`,
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

function graphV2(graphId: string): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: graphId,
    name: "API exact v2 checkpoint",
    nodes: [],
    edges: [],
    variables: [{
      id: "var-topic",
      name: "Topic",
      scope: "run",
      schema: { type: "string" },
      default: "music",
    }],
    groups: [],
    annotations: [],
  };
}

function seedFlow(input: {
  flowId: string;
  ownerId: string;
  graphId?: string;
  revision?: number;
}): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.flowId,
    input.ownerId,
    "Version API flow",
    JSON.stringify(graph(input.graphId ?? `graph-${input.flowId}`, input.revision)),
    Date.now(),
  );
}

async function loadVersionsRoute() {
  try {
    return await import("@/app/api/v2/flows/[flowId]/versions/route");
  } catch {
    return null;
  }
}

async function loadVersionRoute() {
  try {
    return await import("@/app/api/v2/flows/[flowId]/versions/[versionId]/route");
  } catch {
    return null;
  }
}

async function loadDeploymentsRoute() {
  try {
    return await import("@/app/api/v2/flows/[flowId]/deployments/route");
  } catch {
    return null;
  }
}

function flowParams(flowId: unknown) {
  return {
    params: Promise.resolve({ flowId }),
  } as unknown as { params: Promise<{ flowId: string }> };
}

function versionParams(flowId: unknown, versionId: unknown) {
  return {
    params: Promise.resolve({ flowId, versionId }),
  } as unknown as { params: Promise<{ flowId: string; versionId: string }> };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authorizedJsonRequest(url: string, body: unknown, authorization: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function rawRequest(url: string, body: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function expectPrivateJson(
  response: Response,
  status: number,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe(JSON.stringify(body));
}

describe("v2 immutable version and deployment API", () => {
  it("atomically checkpoints an exact v2 graph and keeps row ownership private", async () => {
    const ownerId = testOwner();
    const flowId = "row-exact-checkpoint-api";
    seedFlow({ flowId, ownerId, graphId: "old-graph" });
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const checkpoint = graphV2("graph-id-is-not-row-id");
    const response = await route.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, { graph: checkpoint }),
      flowParams(flowId),
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as { version: { flowId: string; schemaVersion: number; graph: FlowGraphV2 } };
    expect(payload.version).toMatchObject({ flowId, schemaVersion: 2, graph: checkpoint });
    expect(db.prepare("SELECT graph FROM flows WHERE id = ?").get(flowId)).toEqual({ graph: JSON.stringify(checkpoint) });

    const bytesBeforeWrongOwner = (db.prepare("SELECT graph FROM flows WHERE id = ?").get(flowId) as { graph: string }).graph;
    currentOwner = testOwner();
    await expectPrivateJson(
      await route.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, { graph: graphV2("wrong") }),
        flowParams(flowId),
      ),
      404,
      { error: "not found" },
    );
    expect(db.prepare("SELECT graph FROM flows WHERE id = ?").get(flowId)).toEqual({ graph: bytesBeforeWrongOwner });

    currentOwner = ownerId;
    await expectPrivateJson(
      await route.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {
          graph: { ...checkpoint, schemaVersion: 3 },
        }),
        flowParams(flowId),
      ),
      400,
      { error: "invalid request" },
    );
    expect(db.prepare("SELECT graph FROM flows WHERE id = ?").get(flowId)).toEqual({ graph: bytesBeforeWrongOwner });
  });
  it("refuses an invalid checkpoint without lazily creating any project or version rows", async () => {
    const ownerId = testOwner();
    const flowId = "row-refused-checkpoint-api";
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const checkpoint: FlowGraphV2 = {
      ...graphV2("invalid-reference"),
      nodes: [{
        id: "missing-child",
        type: "subflow",
        params: { flowId: "missing/opaque:%2F@雪" },
        bindings: {},
        position: { x: 0, y: 0 },
      }],
    };
    const tracked = [
      "organizations", "workspaces", "projects", "workbooks", "flow_project_bindings",
      "workbook_flow_tabs", "flow_versions", "dependency_pins", "subflow_impact_receipts",
    ];
    const before = tracked.map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
    await expectPrivateJson(
      await route.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, { graph: checkpoint }),
        flowParams(flowId),
      ),
      400,
      { error: "invalid request" },
    );
    expect(tracked.map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()))
      .toEqual(before);

    currentOwner = testOwner();
    await expectPrivateJson(
      await route.POST(rawRequest("https://agents.suedeai.ai/v", "{"), flowParams(flowId)),
      404,
      { error: "not found" },
    );
  });
  it("returns a bounded impact handshake and checkpoints on the one-use retry", async () => {
    const ownerId = testOwner();
    const childId = "child-impact-checkpoint-api";
    const parentId = "parent-impact-checkpoint-api";
    const callable = (id: string): FlowCallableInterface => ({
      inputs: [],
      outputs: [{
        id, label: id, schema: { type: "string" }, required: true, cardinality: "one",
        source: { nodeId: "output", portId: "result" },
      }],
    });
    const child = (abi: FlowCallableInterface): FlowGraphV2 => ({
      schemaVersion: 2,
      id: "presentation-child",
      name: "Child",
      nodes: [{ id: "output", type: "output", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
      edges: [], variables: [], groups: [], annotations: [], callableInterface: abi,
    });
    const originalAbi = callable("answer");
    const original = child(originalAbi);
    const parent: FlowGraphV2 = {
      ...graphV2("presentation-parent"),
      nodes: [{
        id: "child-node",
        type: "subflow",
        params: { reference: {
          kind: "draft",
          flowId: childId,
          interface: originalAbi,
          interfaceHash: hashCallableInterface(originalAbi),
        } } as never,
        bindings: {},
        position: { x: 0, y: 0 },
      }],
    };
    for (const [id, value] of [[childId, original], [parentId, parent]] as const) {
      db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, ownerId, id, JSON.stringify(value), Date.now());
    }
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const proposed = child(callable("revised"));
    const first = await route.POST(
      jsonRequest("https://agents.suedeai.ai/v", { graph: proposed }),
      flowParams(childId),
    );
    expect(first.status).toBe(409);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const impact = await first.json() as {
      error: string;
      receipt: string;
      impact: { dependents: Array<{ flowId: string; name: string; nodeIds: string[] }>; truncated: boolean; total: number };
    };
    expect(impact).toEqual({
      error: "impact confirmation required",
      receipt: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
      impact: {
        dependents: [{ flowId: parentId, name: parentId, nodeIds: ["child-node"] }],
        truncated: false,
        total: 1,
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = ?").get(childId))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings WHERE flow_id = ?").get(childId))
      .toEqual({ count: 0 });

    const retry = await route.POST(
      jsonRequest("https://agents.suedeai.ai/v", { graph: proposed, impactReceipt: impact.receipt }),
      flowParams(childId),
    );
    expect(retry.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = ?").get(childId))
      .toEqual({ count: 1 });
  });
  it("exposes the planned version and deployment route modules", async () => {
    const routes = [
      await loadVersionsRoute(),
      await loadVersionRoute(),
      await loadDeploymentsRoute(),
    ];
    for (const route of routes) {
      expect(route).not.toBeNull();
      expect(route?.runtime).toBe("nodejs");
      expect(route?.dynamic).toBe("force-dynamic");
    }
  });

  it("lazily binds an opaque row id without changing the row or graph id", async () => {
    const ownerId = testOwner();
    const flowId = "flow:opaque-row@v2";
    const graphId = "graph-is-not-the-row-id";
    seedFlow({ flowId, ownerId, graphId });
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${encodeURIComponent(flowId)}/versions`),
      flowParams(flowId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ versions: [] });

    const stored = db.prepare("SELECT id, graph FROM flows WHERE id = ?").get(flowId) as {
      id: string;
      graph: string;
    };
    const binding = db
      .prepare("SELECT flow_id FROM flow_project_bindings WHERE flow_id = ?")
      .get(flowId) as { flow_id: string };
    expect(stored.id).toBe(flowId);
    expect((JSON.parse(stored.graph) as FlowGraph).id).toBe(graphId);
    expect(binding.flow_id).toBe(flowId);
  });

  it("preserves an existing future custom project binding", async () => {
    const ownerId = testOwner();
    const flowId = "flow-custom-binding-api";
    seedFlow({ flowId, ownerId });
    const personal = await projectRepo.ensurePersonalContext(ownerId);
    const projectId = "project-custom-api";
    const workbookId = "workbook-custom-api";
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, workspace_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(projectId, personal.workspace.id, "Custom", "custom", now, now);
    db.prepare(
      "INSERT INTO workbooks (id, project_id, name, slug, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(workbookId, projectId, "Custom book", "custom-book", 0, now);
    db.prepare(
      "INSERT INTO flow_project_bindings (flow_id, project_id, workbook_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(flowId, projectId, workbookId, now);
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`),
      flowParams(flowId),
    );
    expect(response.status).toBe(200);
    expect(
      db
        .prepare("SELECT project_id, workbook_id FROM flow_project_bindings WHERE flow_id = ?")
        .get(flowId),
    ).toEqual({ project_id: projectId, workbook_id: workbookId });
  });

  it("creates an immutable version and returns the same version for unlabeled dedupe", async () => {
    const ownerId = testOwner();
    const flowId = "flow-version-create-api";
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const requestBody = {
      description: "API checkpoint",
      dependencies: [
        {
          kind: "skill",
          resourceId: "skill:opaque/id",
          version: "2026.07",
          contentHash: "sha256:opaque",
        },
      ],
    };

    const first = await route.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, requestBody),
      flowParams(flowId),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const firstPayload = (await first.json()) as {
      version: {
        id: string;
        flowId: string;
        versionNumber: number;
        schemaVersion: number;
        dependencies: Array<{ resourceId: string }>;
      };
    };
    expect(Object.keys(firstPayload)).toEqual(["version"]);
    expect(firstPayload.version).toMatchObject({
      flowId,
      versionNumber: 1,
      schemaVersion: 1,
      dependencies: [{ resourceId: "skill:opaque/id" }],
    });

    const duplicate = await route.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, requestBody),
      flowParams(flowId),
    );
    const duplicatePayload = (await duplicate.json()) as { version: { id: string } };
    expect(duplicate.status).toBe(200);
    expect(duplicatePayload.version.id).toBe(firstPayload.version.id);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = ?").get(flowId),
    ).toEqual({ count: 1 });
  });

  it.each([
    { name: "malformed JSON", request: () => rawRequest("https://agents.suedeai.ai/v", "{") },
    { name: "unknown keys", request: () => jsonRequest("https://agents.suedeai.ai/v", { surprise: true }) },
    { name: "wrong field types", request: () => jsonRequest("https://agents.suedeai.ai/v", { label: 7 }) },
    { name: "blank text", request: () => jsonRequest("https://agents.suedeai.ai/v", { label: "   " }) },
    {
      name: "duplicate dependency pins",
      request: () =>
        jsonRequest("https://agents.suedeai.ai/v", {
          dependencies: [
            { kind: "skill", resourceId: "same", version: "1" },
            { kind: "skill", resourceId: "same", version: "2" },
          ],
        }),
    },
    {
      name: "caller-supplied flow dependency pin",
      request: () =>
        jsonRequest("https://agents.suedeai.ai/v", {
          dependencies: [{
            kind: "flow",
            resourceId: "child",
            version: "version",
            contentHash: "a".repeat(64),
          }],
        }),
    },
    {
      name: "caller-supplied connector dependency pin",
      request: () =>
        jsonRequest("https://agents.suedeai.ai/v", {
          dependencies: [{
            kind: "connector",
            resourceId: "connector",
            version: "latest",
          }],
        }),
    },
    {
      name: "caller-supplied resource dependency pin",
      request: () =>
        jsonRequest("https://agents.suedeai.ai/v", {
          dependencies: [{
            kind: "resource",
            resourceId: "product:pack",
            version: "caller-selected",
            contentHash: "b".repeat(64),
          }],
        }),
    },
  ])("returns one stable 400 body for $name", async ({ request }) => {
    const ownerId = testOwner();
    const flowId = `flow-invalid-${Math.random().toString(36).slice(2)}`;
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    await expectPrivateJson(await route.POST(request(), flowParams(flowId)), 400, {
      error: "invalid request",
    });
  });

  it("returns version detail and makes missing and wrong-owner look identical", async () => {
    const ownerId = testOwner();
    const flowId = "flow-version-detail-api";
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const versionsRoute = await loadVersionsRoute();
    const versionRoute = await loadVersionRoute();
    expect(versionsRoute).not.toBeNull();
    expect(versionRoute).not.toBeNull();
    if (!versionsRoute || !versionRoute) return;

    const created = (await (
      await versionsRoute.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {}),
        flowParams(flowId),
      )
    ).json()) as { version: { id: string } };
    const detail = await versionRoute.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions/${created.version.id}`),
      versionParams(flowId, created.version.id),
    );
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("private, no-store");
    expect((await detail.json()) as { version: { id: string } }).toMatchObject({
      version: { id: created.version.id },
    });

    const missing = await versionRoute.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions/missing`),
      versionParams(flowId, "opaque-missing-version"),
    );
    currentOwner = testOwner();
    const wrongOwner = await versionRoute.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions/${created.version.id}`),
      versionParams(flowId, created.version.id),
    );
    await expectPrivateJson(missing, 404, { error: "not found" });
    await expectPrivateJson(wrongOwner, 404, { error: "not found" });
  });

  it("accepts Bearer auth only for version GET reads", async () => {
    const ownerId = testOwner();
    const flowId = "flow-bearer-version-read";
    seedFlow({ flowId, ownerId });
    currentOwner = null;
    const versionsRoute = await loadVersionsRoute();
    expect(versionsRoute).not.toBeNull();
    if (!versionsRoute) return;

    const list = await versionsRoute.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {
        headers: { authorization: `Bearer ${ownerId}` },
      }),
      flowParams(flowId),
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ versions: [] });

    const create = await versionsRoute.POST(
      authorizedJsonRequest(
        `https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`,
        {},
        `Bearer ${ownerId}`,
      ),
      flowParams(flowId),
    );
    await expectPrivateJson(create, 401, { error: "Authentication required" });
  });

  it("rejects Authorization on version and deployment mutations despite middleware identity", async () => {
    const ownerId = testOwner();
    const flowId = "flow-mutation-auth-boundary";
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const versionsRoute = await loadVersionsRoute();
    const deploymentsRoute = await loadDeploymentsRoute();
    expect(versionsRoute).not.toBeNull();
    expect(deploymentsRoute).not.toBeNull();
    if (!versionsRoute || !deploymentsRoute) return;

    const created = (await (
      await versionsRoute.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {}),
        flowParams(flowId),
      )
    ).json()) as { version: { id: string } };

    const versionCountBefore = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = ?").get(flowId) as { count: number }).count,
    );
    const rejectedVersion = await versionsRoute.POST(
      authorizedJsonRequest(
        `https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`,
        { label: "must-not-mutate" },
        `Bearer ${ownerId}`,
      ),
      flowParams(flowId),
    );
    await expectPrivateJson(rejectedVersion, 401, { error: "Authentication required" });
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM flow_versions WHERE flow_id = ?").get(flowId) as { count: number }).count,
    ).toBe(versionCountBefore);

    currentOwner = null;
    currentCookieOwner = ownerId;
    const rejectedDeployment = await deploymentsRoute.POST(
      authorizedJsonRequest(
        `https://agents.suedeai.ai/api/v2/flows/${flowId}/deployments`,
        { versionId: created.version.id, environmentId: "missing-environment" },
        `Bearer ${ownerId}`,
      ),
      flowParams(flowId),
    );
    await expectPrivateJson(rejectedDeployment, 401, { error: "Authentication required" });
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM deployments WHERE flow_id = ?").get(flowId) as { count: number }).count,
    ).toBe(0);
  });

  it("fails malformed version-read Authorization without falling back to browser identity", async () => {
    const ownerId = testOwner();
    const flowId = "flow-malformed-bearer";
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {
        headers: { authorization: "Bearer    " },
      }),
      flowParams(flowId),
    );

    await expectPrivateJson(response, 401, { error: "Authentication required" });
  });

  it("keeps a wrong Bearer owner private and non-enumerating", async () => {
    const ownerId = testOwner();
    const flowId = "flow-private-bearer";
    seedFlow({ flowId, ownerId });
    currentOwner = null;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {
        headers: { authorization: `Bearer ${testOwner()}` },
      }),
      flowParams(flowId),
    );

    await expectPrivateJson(response, 404, { error: "not found" });
  });

  it("replaces secret internal createdBy at POST, list, and detail boundaries", async () => {
    const ownerSentinel = testOwner();
    const flowId = "flow-public-created-by";
    seedFlow({ flowId, ownerId: ownerSentinel });
    currentOwner = ownerSentinel;
    const versionsRoute = await loadVersionsRoute();
    const versionRoute = await loadVersionRoute();
    expect(versionsRoute).not.toBeNull();
    expect(versionRoute).not.toBeNull();
    if (!versionsRoute || !versionRoute) return;

    const createdResponse = await versionsRoute.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {}),
      flowParams(flowId),
    );
    const createdText = await createdResponse.text();
    const created = JSON.parse(createdText) as { version: { id: string; createdBy: string } };
    expect(created.version.createdBy).toBe("workspace-owner");
    expect(createdText).not.toContain(ownerSentinel);

    const listText = await (
      await versionsRoute.GET(
        new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`),
        flowParams(flowId),
      )
    ).text();
    expect(JSON.parse(listText)).toMatchObject({
      versions: [{ createdBy: "workspace-owner" }],
    });
    expect(listText).not.toContain(ownerSentinel);

    const detailText = await (
      await versionRoute.GET(
        new Request(
          `https://agents.suedeai.ai/api/v2/flows/${flowId}/versions/${created.version.id}`,
        ),
        versionParams(flowId, created.version.id),
      )
    ).text();
    expect(JSON.parse(detailText)).toMatchObject({
      version: { createdBy: "workspace-owner" },
    });
    expect(detailText).not.toContain(ownerSentinel);
  });

  it("makes missing and wrong-owner version lists byte-identical", async () => {
    const ownerId = testOwner();
    const flowId = "flow-version-list-private";
    seedFlow({ flowId, ownerId });
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    currentOwner = ownerId;
    const missing = await route.GET(
      new Request("https://agents.suedeai.ai/api/v2/flows/missing/versions"),
      flowParams("opaque-missing-flow"),
    );
    currentOwner = testOwner();
    const wrongOwner = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`),
      flowParams(flowId),
    );
    await expectPrivateJson(missing, 404, { error: "not found" });
    await expectPrivateJson(wrongOwner, 404, { error: "not found" });
  });

  it("does not parse or reveal a corrupt flow owned by somebody else", async () => {
    const flowId = "flow-corrupt-other-owner";
    seedFlow({ flowId, ownerId: testOwner() });
    db.prepare("UPDATE flows SET graph = ? WHERE id = ?").run("not-json", flowId);
    currentOwner = testOwner();
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(
      await route.GET(
        new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`),
        flowParams(flowId),
      ),
      404,
      { error: "not found" },
    );
  });

  it.each(["   ", 42])("maps the invalid flow path id %j to the private 404", async (flowId) => {
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(
      await route.GET(new Request("https://agents.suedeai.ai/v"), flowParams(flowId)),
      404,
      { error: "not found" },
    );
  });

  it("returns 404 for an invalid version-list path before parsing a malformed body", async () => {
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(
      await route.POST(rawRequest("https://agents.suedeai.ai/v", "{"), flowParams("   ")),
      404,
      { error: "not found" },
    );
  });

  it.each(["   ", 42])("maps the invalid version path id %j to the private 404", async (versionId) => {
    const ownerId = testOwner();
    const flowId = `flow-invalid-version-path-${String(versionId).trim() || "blank"}`;
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const route = await loadVersionRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(
      await route.GET(
        new Request("https://agents.suedeai.ai/v/version"),
        versionParams(flowId, versionId),
      ),
      404,
      { error: "not found" },
    );
  });

  it("deploys only an owned immutable version into its bound project environment", async () => {
    const ownerId = testOwner();
    const flowId = "flow-deployment-api";
    seedFlow({ flowId, ownerId });
    currentOwner = ownerId;
    const versionsRoute = await loadVersionsRoute();
    const deploymentsRoute = await loadDeploymentsRoute();
    expect(versionsRoute).not.toBeNull();
    expect(deploymentsRoute).not.toBeNull();
    if (!versionsRoute || !deploymentsRoute) return;
    const versionPayload = (await (
      await versionsRoute.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {}),
        flowParams(flowId),
      )
    ).json()) as { version: { id: string; semanticHash: string; fullHash: string } };
    await projectRepo.bindFlow(flowId, await projectRepo.ensurePersonalContext(ownerId));
    const context = await projectRepo.getFlowContext(flowId, ownerId);
    const test = context?.environments.find(({ kind }) => kind === "test");
    const live = context?.environments.find(({ kind }) => kind === "live");
    expect(test).toBeDefined();
    expect(live).toBeDefined();
    if (!test || !live) return;

    const versionReceipt = {
      versionId: versionPayload.version.id,
      versionSemanticHash: versionPayload.version.semanticHash,
      versionFullHash: versionPayload.version.fullHash,
    };
    const testResponse = await deploymentsRoute.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/deployments`, {
        ...versionReceipt,
        environmentId: test.id,
        environmentKind: "test",
        expectedActiveDeploymentId: null,
        sourceTestDeploymentId: null,
        confirmation: "PROMOTE TEST",
      }),
      flowParams(flowId),
    );
    expect(testResponse.status).toBe(200);
    const testPayload = (await testResponse.json()) as { deployment: { id: string } };
    const requestBody = {
      ...versionReceipt,
      environmentId: live.id,
      environmentKind: "live",
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: testPayload.deployment.id,
      confirmation: "PROMOTE LIVE",
    };
    const deployed = await deploymentsRoute.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/deployments`, requestBody),
      flowParams(flowId),
    );
    expect(deployed.status).toBe(200);
    expect(deployed.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await deployed.json()) as {
      deployment: { id: string; flowId: string; flowVersionId: string; status: string };
    };
    expect(Object.keys(payload)).toEqual(["deployment"]);
    expect(payload.deployment).toMatchObject({
      flowId,
      flowVersionId: versionPayload.version.id,
      status: "live",
    });

    const repeated = await deploymentsRoute.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/deployments`, {
        ...requestBody,
        expectedActiveDeploymentId: payload.deployment.id,
      }),
      flowParams(flowId),
    );
    expect(((await repeated.json()) as { deployment: { id: string } }).deployment.id).toBe(
      payload.deployment.id,
    );
  });

  it("maps cross-owner deployment references and missing flows to the same 404", async () => {
    const ownerA = testOwner();
    const ownerB = testOwner();
    const flowA = "flow-deployment-a";
    const flowB = "flow-deployment-b";
    seedFlow({ flowId: flowA, ownerId: ownerA });
    seedFlow({ flowId: flowB, ownerId: ownerB });
    const versionsRoute = await loadVersionsRoute();
    const deploymentsRoute = await loadDeploymentsRoute();
    expect(versionsRoute).not.toBeNull();
    expect(deploymentsRoute).not.toBeNull();
    if (!versionsRoute || !deploymentsRoute) return;

    currentOwner = ownerB;
    const versionB = (await (
      await versionsRoute.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowB}/versions`, {}),
        flowParams(flowB),
      )
    ).json()) as { version: { id: string; semanticHash: string; fullHash: string } };
    await projectRepo.bindFlow(flowB, await projectRepo.ensurePersonalContext(ownerB));
    const contextB = await projectRepo.getFlowContext(flowB, ownerB);
    const environmentB = contextB?.environments.find(({ kind }) => kind === "test");
    expect(environmentB).toBeDefined();
    if (!environmentB) return;

    currentOwner = ownerA;
    const crossOwner = await deploymentsRoute.POST(
      jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowA}/deployments`, {
        versionId: versionB.version.id,
        versionSemanticHash: versionB.version.semanticHash,
        versionFullHash: versionB.version.fullHash,
        environmentId: environmentB.id,
        environmentKind: "test",
        expectedActiveDeploymentId: null,
        sourceTestDeploymentId: null,
        confirmation: "PROMOTE TEST",
      }),
      flowParams(flowA),
    );
    const missing = await deploymentsRoute.POST(
      jsonRequest("https://agents.suedeai.ai/api/v2/flows/missing/deployments", {
        versionId: "opaque-version",
        versionSemanticHash: "a".repeat(64),
        versionFullHash: "b".repeat(64),
        environmentId: "opaque-environment",
        environmentKind: "test",
        expectedActiveDeploymentId: null,
        sourceTestDeploymentId: null,
        confirmation: "PROMOTE TEST",
      }),
      flowParams("opaque-missing-flow"),
    );
    await expectPrivateJson(crossOwner, 404, { error: "not found" });
    await expectPrivateJson(missing, 404, { error: "not found" });
  });

  it.each([
    { name: "malformed JSON", request: () => rawRequest("https://agents.suedeai.ai/d", "{") },
    {
      name: "unknown keys",
      request: () =>
        jsonRequest("https://agents.suedeai.ai/d", {
          versionId: "version",
          environmentId: "environment",
          surprise: true,
        }),
    },
    {
      name: "wrong field types",
      request: () =>
        jsonRequest("https://agents.suedeai.ai/d", {
          versionId: 7,
          environmentId: "environment",
        }),
    },
    {
      name: "blank identifiers",
      request: () =>
        jsonRequest("https://agents.suedeai.ai/d", {
          versionId: "   ",
          environmentId: "environment",
        }),
    },
  ])("strictly rejects deployment $name", async ({ request }) => {
    const route = await loadDeploymentsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(await route.POST(request(), flowParams("opaque-flow")), 400, {
      error: "invalid request",
    });
  });

  it.each(["   ", 42])(
    "maps the invalid deployment flow path id %j to the private 404",
    async (flowId) => {
      const route = await loadDeploymentsRoute();
      expect(route).not.toBeNull();
      if (!route) return;
      await expectPrivateJson(
        await route.POST(
          jsonRequest("https://agents.suedeai.ai/d", {
            versionId: "opaque-version",
            environmentId: "opaque-environment",
          }),
          flowParams(flowId),
        ),
        404,
        { error: "not found" },
      );
    },
  );

  it("returns 404 for an invalid deployment path before parsing a malformed body", async () => {
    const route = await loadDeploymentsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(
      await route.POST(rawRequest("https://agents.suedeai.ai/d", "{"), flowParams("   ")),
      404,
      { error: "not found" },
    );
  });

  it("maps corrupt stored flow data to a fixed private invalid-reference 400", async () => {
    const ownerId = testOwner();
    const flowId = "flow-corrupt-version-api";
    seedFlow({ flowId, ownerId });
    db.prepare("UPDATE flows SET graph = ? WHERE id = ?").run("not-json", flowId);
    currentOwner = ownerId;
    const route = await loadVersionsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    await expectPrivateJson(
      await route.POST(
        jsonRequest(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {}),
        flowParams(flowId),
      ),
      400,
      { error: "invalid request" },
    );
  });

  it("authenticates before every version and deployment operation", async () => {
    currentOwner = null;
    const versionsRoute = await loadVersionsRoute();
    const versionRoute = await loadVersionRoute();
    const deploymentsRoute = await loadDeploymentsRoute();
    expect(versionsRoute).not.toBeNull();
    expect(versionRoute).not.toBeNull();
    expect(deploymentsRoute).not.toBeNull();
    if (!versionsRoute || !versionRoute || !deploymentsRoute) return;

    const responses = await Promise.all([
      versionsRoute.GET(new Request("https://agents.suedeai.ai/v"), flowParams("flow")),
      versionsRoute.POST(rawRequest("https://agents.suedeai.ai/v", "{"), flowParams("flow")),
      versionRoute.GET(
        new Request("https://agents.suedeai.ai/v/1"),
        versionParams("flow", "version"),
      ),
      deploymentsRoute.POST(
        rawRequest("https://agents.suedeai.ai/d", "{"),
        flowParams("flow"),
      ),
    ]);
    for (const response of responses) {
      await expectPrivateJson(response, 401, { error: "Authentication required" });
    }
  });

  it("keeps v2 routes free of paid, model, run, launch, and settlement imports", () => {
    const sources = [
      "src/app/api/v2/context/route.ts",
      "src/app/api/v2/projects/route.ts",
      "src/app/api/v2/projects/[projectId]/route.ts",
      "src/app/api/v2/flows/[flowId]/versions/route.ts",
      "src/app/api/v2/flows/[flowId]/versions/[versionId]/route.ts",
      "src/app/api/v2/flows/[flowId]/deployments/route.ts",
    ].map((file) => {
      try {
        return readFileSync(join(process.cwd(), file), "utf8");
      } catch {
        return "missing-route";
      }
    });
    const combined = sources.join("\n");
    expect(combined).not.toContain("missing-route");
    expect(combined).not.toMatch(
      /@ai-sdk|from ["']ai["']|lib\/llm|x402|settlement|run-service|\/launch|fetch\s*\(/,
    );
    const provider = readFileSync(
      join(process.cwd(), "src/lib/projects/provider.ts"),
      "utf8",
    );
    expect(provider).not.toMatch(/\bgetRepo\b|JSON\.parse|\.graph\b/);
  });
});
