import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraphV2, SubflowReference } from "@/lib/flow/types";
import { hashFlowGraph } from "@/lib/projects/hash";

const root = mkdtempSync(join(tmpdir(), "suede-subflow-breadcrumbs-"));
const sqlitePath = join(root, "breadcrumbs.db");
const db = new Database(sqlitePath);
runSqliteMigrations(db);
let ownerSequence = 0;
function testOwner(): string {
  ownerSequence += 1;
  return `00000000-0000-4000-8000-${ownerSequence.toString().padStart(12, "0")}`;
}
let currentOwner = testOwner();

vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("DB_DRIVER", "sqlite");
vi.stubEnv("SQLITE_PATH", sqlitePath);
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (key: string) => key === "x-owner-id" ? currentOwner : null }),
  cookies: async () => ({ get: () => undefined }),
}));

afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  currentOwner = testOwner();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DB_DRIVER", "sqlite");
  vi.stubEnv("SQLITE_PATH", sqlitePath);
});

const callable: FlowCallableInterface = {
  inputs: [],
  outputs: [{
    id: "result", label: "Result", schema: { type: "string" }, required: true,
    cardinality: "one", source: { nodeId: "output", portId: "value" },
  }],
};

function leaf(id: string): FlowGraphV2 {
  return {
    schemaVersion: 2, id: `graph-${id}`, name: id,
    nodes: [{ id: "output", type: "output", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
    edges: [], variables: [], groups: [], annotations: [], callableInterface: callable,
  };
}

function draft(flowId: string): SubflowReference {
  return { kind: "draft", flowId, interface: callable, interfaceHash: hashCallableInterface(callable) };
}

function pinned(flowId: string, versionId: string, graph: FlowGraphV2): SubflowReference {
  return {
    kind: "pinned", flowId, versionId, interface: callable,
    interfaceHash: hashCallableInterface(callable),
    contentHash: hashFlowGraph(graph, { semantic: true }),
  };
}

function parent(id: string, references: readonly SubflowReference[]): FlowGraphV2 {
  return {
    schemaVersion: 2, id: `graph-${id}`, name: id,
    nodes: [
      { id: "output", type: "output" as const, params: {}, bindings: {}, position: { x: 0, y: 0 } },
      ...references.map((reference, index) => ({
        id: `wrapper-${index}`, type: index % 2 === 0 ? "subflow" as const : "loop" as const,
        params: { reference } as never, bindings: {}, position: { x: index + 1, y: index },
      })),
    ],
    edges: [], variables: [], groups: [], annotations: [], callableInterface: callable,
  };
}

function seedFlow(id: string, owner: string, name: string, graph: FlowGraphV2): void {
  db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, owner, name, JSON.stringify(graph), Date.now());
}

function seedVersion(id: string, flowId: string, number: number, graph: FlowGraphV2): string {
  const contentHash = hashFlowGraph(graph, { semantic: true });
  db.prepare(
    `INSERT INTO flow_versions
      (id, flow_id, version_number, schema_version, graph, semantic_hash, full_hash, created_by, created_at)
     VALUES (?, ?, ?, 2, ?, ?, ?, 'test', ?)`,
  ).run(id, flowId, number, JSON.stringify(graph), contentHash,
    hashFlowGraph(graph, { semantic: false }), Date.now());
  return contentHash;
}

const endpoint = "https://agents.suedeai.ai/api/v2/subflows/breadcrumbs";
const request = (body: unknown, headers: Record<string, string> = {}) => new Request(endpoint, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

async function route() {
  return import("@/app/api/v2/subflows/breadcrumbs/route");
}

async function expectPrivate(response: Response, status: number, body: unknown): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe(JSON.stringify(body));
}

describe("private subflow breadcrumb API", () => {
  it("returns a direct owner-scoped route with no synthetic crumbs", async () => {
    const id = `direct-${crypto.randomUUID()}`;
    seedFlow(id, currentOwner, "Direct flow", leaf(id));
    const response = await (await route()).POST(request({ currentFlowId: id, trail: [] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ crumbs: [] });
  });

  it("validates one mixed draft and pinned chain from persisted parent receipts", async () => {
    const rootId = `root-${crypto.randomUUID()}`;
    const middleId = `middle-${crypto.randomUUID()}`;
    const currentId = `current-${crypto.randomUUID()}`;
    const pinnedGraph = leaf(currentId);
    const versionId = `version-${crypto.randomUUID()}`;
    seedFlow(currentId, currentOwner, "Current", leaf(currentId));
    const contentHash = seedVersion(versionId, currentId, 7, pinnedGraph);
    seedFlow(middleId, currentOwner, "Middle", parent(middleId, [pinned(currentId, versionId, pinnedGraph)]));
    seedFlow(rootId, currentOwner, "Root", parent(rootId, [draft(middleId)]));

    const response = await (await route()).POST(request({
      currentFlowId: currentId,
      trail: [
        { flowId: rootId },
        { flowId: middleId },
        { flowId: currentId, versionId, contentHash },
      ],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ crumbs: [
      { flowId: rootId, name: "Root" },
      { flowId: middleId, name: "Middle" },
      { flowId: currentId, name: "Current", versionId, versionNumber: 7, contentHash },
    ] });
  });

  it("validates draft and pinned adjacency independently", async () => {
    const draftParentId = `draft-parent-${crypto.randomUUID()}`;
    const draftChildId = `draft-child-${crypto.randomUUID()}`;
    seedFlow(draftChildId, currentOwner, "Draft child", leaf(draftChildId));
    seedFlow(draftParentId, currentOwner, "Draft parent", parent(draftParentId, [draft(draftChildId)]));
    expect((await (await route()).POST(request({ currentFlowId: draftParentId, trail: [] }))).status).toBe(200);
    expect((await (await route()).POST(request({
      currentFlowId: draftChildId,
      trail: [{ flowId: draftParentId }, { flowId: draftChildId }],
    }))).status).toBe(200);

    const pinnedParentId = `pinned-parent-${crypto.randomUUID()}`;
    const pinnedChildId = `pinned-child-${crypto.randomUUID()}`;
    const pinnedGraph = leaf(pinnedChildId);
    const versionId = `pinned-version-${crypto.randomUUID()}`;
    seedFlow(pinnedChildId, currentOwner, "Pinned child", pinnedGraph);
    const contentHash = seedVersion(versionId, pinnedChildId, 3, pinnedGraph);
    seedFlow(pinnedParentId, currentOwner, "Pinned parent", parent(
      pinnedParentId, [pinned(pinnedChildId, versionId, pinnedGraph)],
    ));
    expect((await (await route()).POST(request({
      currentFlowId: pinnedChildId,
      trail: [{ flowId: pinnedParentId }, { flowId: pinnedChildId, versionId, contentHash }],
    }))).status).toBe(200);
  });

  it("uses a pinned intermediate graph, never its changed live draft, for the next edge", async () => {
    const rootId = `pinned-root-${crypto.randomUUID()}`;
    const middleId = `pinned-middle-${crypto.randomUUID()}`;
    const versionChildId = `version-child-${crypto.randomUUID()}`;
    const draftChildId = `draft-child-${crypto.randomUUID()}`;
    const middleVersionId = `middle-version-${crypto.randomUUID()}`;
    const middleVersionGraph = parent(middleId, [draft(versionChildId)]);
    const middleDraftGraph = parent(middleId, [draft(draftChildId)]);
    seedFlow(versionChildId, currentOwner, "Version child", leaf(versionChildId));
    seedFlow(draftChildId, currentOwner, "Draft child", leaf(draftChildId));
    seedFlow(middleId, currentOwner, "Middle", middleDraftGraph);
    const middleHash = seedVersion(middleVersionId, middleId, 4, middleVersionGraph);
    seedFlow(rootId, currentOwner, "Root", parent(rootId, [
      pinned(middleId, middleVersionId, middleVersionGraph),
    ]));
    const middleCrumb = { flowId: middleId, versionId: middleVersionId, contentHash: middleHash };

    expect((await (await route()).POST(request({
      currentFlowId: versionChildId,
      trail: [{ flowId: rootId }, middleCrumb, { flowId: versionChildId }],
    }))).status).toBe(200);
    await expectPrivate(await (await route()).POST(request({
      currentFlowId: draftChildId,
      trail: [{ flowId: rootId }, middleCrumb, { flowId: draftChildId }],
    })), 404, { error: "not found" });
  });

  it.each([
    { currentFlowId: "a", trail: [{ flowId: "a" }, { flowId: "a" }] },
    { currentFlowId: "b", trail: [{ flowId: "a" }] },
    { currentFlowId: "a", trail: [{ flowId: "a", versionId: "v" }] },
    { currentFlowId: "a", trail: [{ flowId: "a", contentHash: "a".repeat(64) }] },
    { currentFlowId: "a", trail: [{ flowId: "a", versionId: "v", contentHash: "a".repeat(64) }] },
    { currentFlowId: "a", trail: [], extra: true },
    { currentFlowId: "a", trail: [{ flowId: "a", extra: true }] },
    { currentFlowId: "a", trail: Array.from({ length: 33 }, (_, index) => ({ flowId: `flow-${index}` })) },
    { currentFlowId: "😀".repeat(129), trail: [] },
  ])("rejects malformed, cyclic, mismatched, partial, or unknown input", async (body) => {
    await expectPrivate(await (await route()).POST(request(body)), 400, { error: "invalid request" });
  });

  it("uses one indistinguishable private 404 for missing, foreign, adjacency, version, and hash failures", async () => {
    const rootId = `private-root-${crypto.randomUUID()}`;
    const childId = `private-child-${crypto.randomUUID()}`;
    const otherId = `other-${crypto.randomUUID()}`;
    const versionId = `private-version-${crypto.randomUUID()}`;
    const childGraph = leaf(childId);
    seedFlow(childId, currentOwner, "Child", childGraph);
    const contentHash = seedVersion(versionId, childId, 1, childGraph);
    seedFlow(rootId, currentOwner, "Root", parent(rootId, [pinned(childId, versionId, childGraph)]));
    seedFlow(otherId, currentOwner, "Other", leaf(otherId));
    const foreignId = `foreign-${crypto.randomUUID()}`;
    seedFlow(foreignId, testOwner(), "Foreign secret", leaf(foreignId));
    const cases = [
      { currentFlowId: "missing", trail: [] },
      { currentFlowId: foreignId, trail: [] },
      { currentFlowId: otherId, trail: [{ flowId: rootId }, { flowId: otherId }] },
      { currentFlowId: childId, trail: [{ flowId: rootId }, { flowId: childId, versionId: "wrong", contentHash }] },
      { currentFlowId: childId, trail: [{ flowId: rootId }, { flowId: childId, versionId, contentHash: "f".repeat(64) }] },
    ];
    for (const body of cases) {
      const response = await (await route()).POST(request(body));
      await expectPrivate(response, 404, { error: "not found" });
      expect(JSON.stringify(await Promise.resolve(body))).not.toContain("Foreign secret");
    }
  });

  it("privately refuses persisted draft receipt drift and tampered pinned version bytes", async () => {
    const draftParentId = `drift-parent-${crypto.randomUUID()}`;
    const draftChildId = `drift-child-${crypto.randomUUID()}`;
    const staleInterface: FlowCallableInterface = { inputs: [], outputs: [] };
    seedFlow(draftChildId, currentOwner, "Draft child", leaf(draftChildId));
    seedFlow(draftParentId, currentOwner, "Draft parent", parent(draftParentId, [{
      kind: "draft", flowId: draftChildId, interface: staleInterface,
      interfaceHash: hashCallableInterface(staleInterface),
    }]));
    await expectPrivate(await (await route()).POST(request({
      currentFlowId: draftChildId,
      trail: [{ flowId: draftParentId }, { flowId: draftChildId }],
    })), 404, { error: "not found" });

    const pinnedParentId = `tampered-parent-${crypto.randomUUID()}`;
    const pinnedChildId = `tampered-child-${crypto.randomUUID()}`;
    const versionId = `tampered-version-${crypto.randomUUID()}`;
    const versionGraph = leaf(pinnedChildId);
    seedFlow(pinnedChildId, currentOwner, "Pinned child", versionGraph);
    const contentHash = seedVersion(versionId, pinnedChildId, 2, versionGraph);
    seedFlow(pinnedParentId, currentOwner, "Pinned parent", parent(
      pinnedParentId, [pinned(pinnedChildId, versionId, versionGraph)],
    ));
    db.prepare("UPDATE flow_versions SET graph = ? WHERE id = ?")
      .run(JSON.stringify(leaf("different-bytes")), versionId);
    await expectPrivate(await (await route()).POST(request({
      currentFlowId: pinnedChildId,
      trail: [{ flowId: pinnedParentId }, { flowId: pinnedChildId, versionId, contentHash }],
    })), 404, { error: "not found" });
  });

  it("rejects authorization mutation and non-POST methods with private stable responses", async () => {
    const routes = await route();
    await expectPrivate(
      await routes.POST(request({ currentFlowId: "x", trail: [] }, { authorization: "Bearer no" })),
      401, { error: "Authentication required" },
    );
    const denied = await routes.GET();
    expect(denied.headers.get("allow")).toBe("POST");
    await expectPrivate(denied, 405, { error: "method not allowed" });
  });
});
