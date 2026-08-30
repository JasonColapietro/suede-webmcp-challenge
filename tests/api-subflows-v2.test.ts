import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraphV2, SubflowReference } from "@/lib/flow/types";
import { hashFlowGraph } from "@/lib/projects/hash";

const root = mkdtempSync(join(tmpdir(), "suede-subflow-api-v2-"));
const sqlitePath = join(root, "subflows.db");
const db = new Database(sqlitePath);
runSqliteMigrations(db);
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
    get: (key: string) => key === "x-owner-id" ? currentOwner : null,
  }),
  cookies: async () => ({
    get: (key: string) => key === "agx_owner" && currentCookieOwner
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

function callable(id = "result"): FlowCallableInterface {
  return {
    inputs: [],
    outputs: [{
      id, label: id, schema: { type: "string" }, required: true,
      cardinality: "one", source: { nodeId: "output", portId: "value" },
    }],
  };
}

function graph(id: string, abi: FlowCallableInterface | null = callable()): FlowGraphV2 {
  return {
    schemaVersion: 2, id: `graph-${id}`, name: id,
    nodes: abi ? [{
      id: "output", type: "output", params: {}, bindings: {}, position: { x: 0, y: 0 },
    }] : [],
    edges: [], variables: [], groups: [], annotations: [],
    ...(abi ? { callableInterface: abi } : {}),
  };
}

function draft(flowId: string, abi = callable()): SubflowReference {
  return { kind: "draft", flowId, interface: abi, interfaceHash: hashCallableInterface(abi) };
}

function pinned(flowId: string, versionId: string, value: FlowGraphV2): SubflowReference {
  const abi = value.callableInterface!;
  return {
    kind: "pinned", flowId, versionId, interface: abi,
    interfaceHash: hashCallableInterface(abi),
    contentHash: hashFlowGraph(value, { semantic: true }),
  };
}

function parentGraph(id: string, references: readonly SubflowReference[] = []): FlowGraphV2 {
  return {
    ...graph(id, null),
    nodes: references.map((reference, index) => ({
      id: `sub-${index}`, type: "subflow" as const,
      params: JSON.parse(JSON.stringify({ reference })) as FlowGraphV2["nodes"][number]["params"],
      bindings: {},
      position: { x: index, y: 0 },
    })),
  };
}

function seedFlow(id: string, ownerId: string, value: FlowGraphV2, name = id): void {
  db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, ownerId, name, JSON.stringify(value), Date.now());
}

function seedVersion(input: {
  id: string; flowId: string; number: number; value: FlowGraphV2; semanticHash?: string;
}): void {
  const semanticHash = input.semanticHash ?? hashFlowGraph(input.value, { semantic: true });
  db.prepare(
    `INSERT INTO flow_versions
      (id, flow_id, version_number, schema_version, graph, semantic_hash, full_hash, created_by, created_at)
     VALUES (?, ?, ?, 2, ?, ?, ?, 'test', ?)`,
  ).run(
    input.id, input.flowId, input.number, JSON.stringify(input.value), semanticHash,
    hashFlowGraph(input.value, { semantic: false }), 1_700_000_000_000 + input.number,
  );
}

const url = (path: string) => `https://agents.suedeai.ai${path}`;

async function routes() {
  return {
    candidates: await import("@/app/api/v2/subflows/candidates/route"),
    versions: await import("@/app/api/v2/subflows/versions/route"),
    resolve: await import("@/app/api/v2/subflows/resolve/route"),
    dependents: await import("@/app/api/v2/subflows/dependents/route"),
  };
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url(path), {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

async function expectPrivate(response: Response, status: number, body: unknown): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe(JSON.stringify(body));
}

describe("pathless private subflow API v2", () => {
  it("lists strict bounded candidates and scans past a corrupt newest typed version", async () => {
    const owner = currentOwner!;
    const parent = `parent/%:@雪-${crypto.randomUUID()}`;
    const child = `child/%:@雪-${crypto.randomUUID()}`;
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, graph(child, null), "Reusable child");
    const older = graph("older");
    seedVersion({ id: `valid/${crypto.randomUUID()}`, flowId: child, number: 1, value: older });
    seedVersion({
      id: `tampered/${crypto.randomUUID()}`, flowId: child, number: 2,
      value: graph("newer"), semanticHash: "0".repeat(64),
    });

    const route = (await routes()).candidates;
    const before = db.prepare("SELECT COUNT(*) AS count FROM flows").get();
    const response = await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${encodeURIComponent(parent)}&query=reusable`,
    )));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = await response.json() as Record<string, any>;
    expect(Object.keys(payload).sort()).toEqual(["flows", "truncated"]);
    expect(payload.truncated).toBe(true);
    expect(payload.flows).toHaveLength(1);
    expect(payload.flows[0]).toEqual({
      flowId: child, name: "Reusable child", workbookName: null, draft: null,
      latestTypedVersion: {
        versionId: expect.stringContaining("valid/"), versionNumber: 1,
        createdAt: 1_700_000_000_001,
        interfaceHash: hashCallableInterface(older.callableInterface!),
        contentHash: hashFlowGraph(older, { semantic: true }),
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM flows").get()).toEqual(before);
    expect(JSON.stringify(payload)).not.toContain("owner_id");
    expect(JSON.stringify(payload)).not.toContain("nodes");
  });

  it("paginates only after proving another representable candidate and binds cursors", async () => {
    const owner = currentOwner!;
    const parent = `parent-${crypto.randomUUID()}`;
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(`a-${crypto.randomUUID()}`, owner, graph("a"), "Alpha");
    seedFlow(`b-${crypto.randomUUID()}`, owner, graph("b"), "Beta");
    const route = (await routes()).candidates;
    const first = await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}&limit=1`,
    )));
    const firstBody = await first.json() as { flows: unknown[]; nextCursor: string; truncated: boolean };
    expect(firstBody).toMatchObject({ truncated: true });
    expect(firstBody.flows).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}&limit=1&cursor=${firstBody.nextCursor}`,
    )));
    expect((await second.json() as { flows: unknown[] }).flows).toHaveLength(1);
    await expectPrivate(
      await route.GET(new Request(url(
        `/api/v2/subflows/candidates?parentFlowId=${parent}&query=changed&limit=1&cursor=${firstBody.nextCursor}`,
      ))),
      400, { error: "invalid request" },
    );
  });

  it("lists only verified versions and recomputes content hashes", async () => {
    const owner = currentOwner!;
    const parent = `parent-${crypto.randomUUID()}`;
    const child = `child-${crypto.randomUUID()}`;
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, graph(child));
    const good = graph("good");
    seedVersion({ id: `good-${crypto.randomUUID()}`, flowId: child, number: 1, value: good });
    seedVersion({
      id: `bad-${crypto.randomUUID()}`, flowId: child, number: 2,
      value: graph("bad"), semanticHash: "f".repeat(64),
    });
    const response = await (await routes()).versions.GET(new Request(url(
      `/api/v2/subflows/versions?parentFlowId=${parent}&childFlowId=${child}`,
    )));
    const payload = await response.json() as { versions: Array<Record<string, unknown>>; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(payload.versions).toHaveLength(1);
    expect(payload.versions[0]?.contentHash).toBe(hashFlowGraph(good, { semantic: true }));
    expect(payload.versions[0]?.interfaceHash).toBe(hashCallableInterface(good.callableInterface!));
  });

  it("reports only draft typed dependents, excluding pinned and legacy nodes", async () => {
    const owner = currentOwner!;
    const child = `child-${crypto.randomUUID()}`;
    const draftParent = `draft-${crypto.randomUUID()}`;
    const pinnedParent = `pinned-${crypto.randomUUID()}`;
    const childGraph = graph(child);
    seedFlow(child, owner, childGraph);
    seedVersion({ id: `version-${crypto.randomUUID()}`, flowId: child, number: 1, value: childGraph });
    seedFlow(draftParent, owner, parentGraph(draftParent, [draft(child)]), "Draft parent");
    const pinnedRef = pinned(
      child, (db.prepare("SELECT id FROM flow_versions WHERE flow_id = ?").get(child) as { id: string }).id,
      childGraph,
    );
    seedFlow(pinnedParent, owner, parentGraph(pinnedParent, [pinnedRef]), "Pinned parent");
    const legacyId = `legacy-${crypto.randomUUID()}`;
    seedFlow(legacyId, owner, {
      ...parentGraph(legacyId),
      nodes: [{ id: "legacy-node", type: "subflow", params: { flowId: child }, bindings: {}, position: { x: 0, y: 0 } }],
    });
    const response = await (await routes()).dependents.GET(new Request(url(
      `/api/v2/subflows/dependents?flowId=${child}`,
    )));
    const payload = await response.json() as { dependents: Array<{ flowId: string; nodeIds: string[] }> };
    expect(payload.dependents).toEqual([{ flowId: draftParent, name: "Draft parent", nodeIds: ["sub-0"] }]);
  });

  it("resolves draft and pinned references with fixed drift issue codes", async () => {
    const owner = currentOwner!;
    const child = `child-${crypto.randomUUID()}`;
    const parent = `parent-${crypto.randomUUID()}`;
    const childGraph = graph(child);
    seedFlow(child, owner, childGraph);
    const stale = callable("stale");
    seedFlow(parent, owner, parentGraph(parent, [draft(child, stale)]));
    const route = (await routes()).resolve;
    const response = await route.POST(jsonRequest("/api/v2/subflows/resolve", {
      parentFlowId: parent, nodeId: "sub-0", reference: draft(child, stale),
    }));
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.issues).toEqual(["interface-drift"]);
    expect(body.reference.kind).toBe("draft");
    expect(body).not.toHaveProperty("contentHash");

    const versionId = `version-${crypto.randomUUID()}`;
    seedVersion({ id: versionId, flowId: child, number: 1, value: childGraph });
    const pin = pinned(child, versionId, childGraph);
    const pinnedResponse = await route.POST(jsonRequest("/api/v2/subflows/resolve", {
      parentFlowId: parent, nodeId: "sub-0",
      reference: { ...pin, contentHash: "a".repeat(64) },
    }));
    const pinnedBody = await pinnedResponse.json() as Record<string, any>;
    expect(pinnedBody.issues).toEqual(["content-drift"]);
    expect(pinnedBody.dependency).toEqual({
      kind: "flow", resourceId: child, version: versionId,
      contentHash: hashFlowGraph(childGraph, { semantic: true }),
    });
  });

  it("resolves an absent bounded local wrapper but refuses an existing non-wrapper node", async () => {
    const owner = currentOwner!;
    const child = `child-${crypto.randomUUID()}`;
    const parent = `parent-${crypto.randomUUID()}`;
    const childGraph = graph(child);
    seedFlow(child, owner, childGraph);
    seedFlow(parent, owner, parentGraph(parent));
    const route = (await routes()).resolve;

    const local = await route.POST(jsonRequest("/api/v2/subflows/resolve", {
      parentFlowId: parent,
      nodeId: "local-unsaved-wrapper",
      reference: draft(child),
    }));
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ issues: [], reference: { flowId: child } });

    const occupied: FlowGraphV2 = {
      ...parentGraph(parent),
      nodes: [{
        id: "occupied",
        type: "input",
        params: {},
        bindings: {},
        position: { x: 0, y: 0 },
      }],
    };
    db.prepare("UPDATE flows SET graph = ? WHERE id = ?").run(JSON.stringify(occupied), parent);
    await expectPrivate(await route.POST(jsonRequest("/api/v2/subflows/resolve", {
      parentFlowId: parent,
      nodeId: "occupied",
      reference: draft(child),
    })), 404, { error: "not found" });
  });

  it("keeps foreign ownership private before full cursor and body validation", async () => {
    const owner = currentOwner!;
    const foreignParent = `foreign-${crypto.randomUUID()}`;
    seedFlow(foreignParent, `other-${owner}`, parentGraph(foreignParent));
    const all = await routes();
    const foreignCursor = await all.candidates.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${foreignParent}&cursor=%%%`,
    )));
    const foreignBody = await all.resolve.POST(new Request(url("/api/v2/subflows/resolve"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentFlowId: foreignParent, unexpected: true }),
    }));
    await expectPrivate(foreignCursor, 404, { error: "not found" });
    await expectPrivate(foreignBody, 404, { error: "not found" });
  });

  it("enforces UTF-8 opaque ID bounds and rejects mutation bearer auth", async () => {
    const owner = currentOwner!;
    const exact = "😀".repeat(128);
    seedFlow(exact, owner, parentGraph(exact));
    const all = await routes();
    expect((await all.candidates.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${encodeURIComponent(exact)}`,
    )))).status).toBe(200);
    await expectPrivate(
      await all.candidates.GET(new Request(url(
        `/api/v2/subflows/candidates?parentFlowId=${encodeURIComponent("😀".repeat(129))}`,
      ))), 400, { error: "invalid request" },
    );
    await expectPrivate(
      await all.resolve.POST(jsonRequest("/api/v2/subflows/resolve", {
        parentFlowId: exact, nodeId: "node", reference: draft("missing"),
      }, { authorization: "Bearer must-not-select-owner" })),
      401, { error: "Authentication required" },
    );
  });

  it("returns exact private 405 responses and keeps client schemas browser-safe", async () => {
    const all = await routes();
    const denied = await all.candidates.POST();
    expect(denied.headers.get("allow")).toBe("GET");
    await expectPrivate(denied, 405, { error: "method not allowed" });
    const resolveDenied = await all.resolve.GET();
    expect(resolveDenied.headers.get("allow")).toBe("POST");
    await expectPrivate(resolveDenied, 405, { error: "method not allowed" });

    const source = readFileSync(join(process.cwd(), "src/lib/flow/subflow-api.ts"), "utf8");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toContain("Buffer.");
    const schemas = await import("@/lib/flow/subflow-api");
    expect(schemas.SubflowCandidatePageSchema.safeParse({ flows: [], truncated: false }).success).toBe(true);
    expect(schemas.SubflowCandidatePageSchema.safeParse({ flows: [], truncated: false, extra: true }).success).toBe(false);
  });

  it("scans a long corrupt history within the row budget and reaches an older valid version", async () => {
    const owner = currentOwner!;
    const parent = `history-parent-${crypto.randomUUID()}`;
    const child = `history-child-${crypto.randomUUID()}`;
    const value = graph("history");
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, value);
    seedVersion({ id: `history-good-${crypto.randomUUID()}`, flowId: child, number: 1, value });
    for (let number = 2; number <= 520; number += 1) {
      const id = `history-bad-${String(number).padStart(3, "0")}-${crypto.randomUUID()}`;
      seedVersion({ id, flowId: child, number, value });
      db.prepare("UPDATE flow_versions SET created_at = -1 WHERE id = ?").run(id);
    }
    const response = await (await routes()).versions.GET(new Request(url(
      `/api/v2/subflows/versions?parentFlowId=${parent}&childFlowId=${child}`,
    )));
    const body = await response.json() as { versions: Array<{ versionNumber: number }>; truncated: boolean };
    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ truncated: true }));
    expect(body.versions.map((version) => version.versionNumber)).toEqual([1]);
  });

  it("keeps an older typed candidate selectable behind more than 128 untyped versions", async () => {
    const owner = currentOwner!;
    const parent = `candidate-history-parent-${crypto.randomUUID()}`;
    const child = `candidate-history-child-${crypto.randomUUID()}`;
    const typed = graph("candidate-history-typed");
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, graph("candidate-history-draft", null), "Deep typed child");
    seedVersion({ id: `candidate-history-good-${crypto.randomUUID()}`, flowId: child, number: 1, value: typed });
    for (let number = 2; number <= 132; number += 1) {
      seedVersion({
        id: `candidate-history-untyped-${String(number).padStart(3, "0")}-${crypto.randomUUID()}`,
        flowId: child,
        number,
        value: graph(`candidate-history-untyped-${number}`, null),
      });
    }
    const response = await (await routes()).candidates.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}&query=deep`,
    )));
    const body = await response.json() as {
      flows: Array<{ flowId: string; latestTypedVersion?: { versionNumber: number } }>;
      truncated: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.flows).toEqual([
      expect.objectContaining({ flowId: child, latestTypedVersion: expect.objectContaining({ versionNumber: 1 }) }),
    ]);
    expect(body.truncated).toBe(true);
  });

  it("omits an oversized version in SQL and still reaches the next representable version", async () => {
    const owner = currentOwner!;
    const parent = `oversized-parent-${crypto.randomUUID()}`;
    const child = `oversized-child-${crypto.randomUUID()}`;
    const value = graph("oversized-good");
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, value);
    seedVersion({ id: `oversized-good-${crypto.randomUUID()}`, flowId: child, number: 1, value });
    db.prepare(
      `INSERT INTO flow_versions
        (id, flow_id, version_number, schema_version, graph, semantic_hash, full_hash, created_by, created_at)
       VALUES (?, ?, 2, 2, ?, ?, ?, 'test', ?)`,
    ).run(
      `oversized-${crypto.randomUUID()}`, child, `{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`,
      "a".repeat(64), "b".repeat(64), 2,
    );
    const response = await (await routes()).versions.GET(new Request(url(
      `/api/v2/subflows/versions?parentFlowId=${parent}&childFlowId=${child}`,
    )));
    const body = await response.json() as { versions: Array<{ versionNumber: number }>; truncated: boolean };
    expect(response.status).toBe(200);
    expect(body.truncated).toBe(true);
    expect(body.versions.map((version) => version.versionNumber)).toEqual([1]);
  });

  it("recomputes pin-inclusive hashes and omits a version after dependency pin tampering", async () => {
    const owner = currentOwner!;
    const parent = `pin-parent-${crypto.randomUUID()}`;
    const child = `pin-child-${crypto.randomUUID()}`;
    const versionId = `pin-version-${crypto.randomUUID()}`;
    const value = graph("pin-child");
    const pins = [{ kind: "skill" as const, resourceId: "skill/a", version: "v1", contentHash: "c".repeat(64) }];
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, value);
    seedVersion({ id: versionId, flowId: child, number: 1, value });
    const pinnedHash = hashFlowGraph(value, { semantic: true }, pins);
    db.prepare("UPDATE flow_versions SET semantic_hash = ? WHERE id = ?").run(pinnedHash, versionId);
    db.prepare(
      `INSERT INTO dependency_pins
       (id, flow_version_id, kind, resource_id, version, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("pin-row-" + crypto.randomUUID(), versionId, "skill", "skill/a", "v1", "c".repeat(64), 1);
    const route = (await routes()).versions;
    const request = () => new Request(url(
      `/api/v2/subflows/versions?parentFlowId=${parent}&childFlowId=${child}`,
    ));
    const first = await (await route.GET(request())).json() as { versions: Array<{ contentHash: string }> };
    expect(first.versions[0]?.contentHash).toBe(pinnedHash);
    db.prepare("UPDATE dependency_pins SET version = 'tampered' WHERE flow_version_id = ?").run(versionId);
    const second = await (await route.GET(request())).json() as { versions: unknown[]; truncated: boolean };
    expect(second).toEqual({ versions: [], truncated: true });
  });

  it("keeps deep foreign bodies private and rejects the same deep shape after owned preflight", async () => {
    const owner = currentOwner!;
    const owned = `owned-deep-${crypto.randomUUID()}`;
    const foreign = `foreign-deep-${crypto.randomUUID()}`;
    seedFlow(owned, owner, parentGraph(owned));
    seedFlow(foreign, `other-${owner}`, parentGraph(foreign));
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 80; index += 1) deep = { nested: deep };
    const route = (await routes()).resolve;
    await expectPrivate(
      await route.POST(jsonRequest("/api/v2/subflows/resolve", { parentFlowId: foreign, extra: deep })),
      404, { error: "not found" },
    );
    await expectPrivate(
      await route.POST(jsonRequest("/api/v2/subflows/resolve", { parentFlowId: owned, extra: deep })),
      400, { error: "invalid request" },
    );
  });

  it("rejects invalid UTF-8 percent bytes after ownership while preserving one-decode opaque IDs", async () => {
    const owner = currentOwner!;
    const replacement = "�";
    const slash = `slash/%2F/%-${crypto.randomUUID()}`;
    seedFlow(replacement, owner, parentGraph(replacement));
    seedFlow(`owned=${replacement}`, owner, parentGraph(`owned=${replacement}`));
    seedFlow(slash, owner, parentGraph(slash));
    const route = (await routes()).candidates;
    await expectPrivate(
      await route.GET(new Request(url("/api/v2/subflows/candidates?parentFlowId=%FF"))),
      400, { error: "invalid request" },
    );
    await expectPrivate(
      await route.GET(new Request(url("/api/v2/subflows/candidates?parentFlowId=owned=%FF"))),
      400, { error: "invalid request" },
    );
    expect((await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${encodeURIComponent(replacement)}`,
    )))).status).toBe(200);
    expect((await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${encodeURIComponent(slash)}`,
    )))).status).toBe(200);
  });

  it("keeps large pages under 256 KiB and makes the omitted item cursor-reachable", async () => {
    const owner = currentOwner!;
    const parent = `page-parent-${crypto.randomUUID()}`;
    seedFlow(parent, owner, parentGraph(parent));
    for (let index = 0; index < 7; index += 1) {
      const base = callable(`large-${index}`);
      const abi: FlowCallableInterface = {
        ...base,
        outputs: [{ ...base.outputs[0]!, schema: { type: "string", description: "x".repeat(47_000) } }],
      };
      seedFlow(`large-${index}-${crypto.randomUUID()}`, owner, graph(`large-${index}`, abi), `Large ${index}`);
    }
    const route = (await routes()).candidates;
    const firstResponse = await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}&limit=50`,
    )));
    const firstText = await firstResponse.text();
    expect(firstResponse.status).toBe(200);
    expect(Buffer.byteLength(firstText, "utf8")).toBeLessThanOrEqual(256 * 1024);
    const first = JSON.parse(firstText) as { flows: unknown[]; nextCursor?: string; truncated: boolean };
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.flows.length).toBeGreaterThan(0);
    expect(first.flows.length).toBeLessThan(7);
    const next = await (await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}&limit=50&cursor=${first.nextCursor}`,
    )))).json() as { flows: unknown[] };
    expect(next.flows.length).toBeGreaterThan(0);
  });

  it("ignores GET bearer headers, performs no writes, and fails closed on unsupported stores", async () => {
    const owner = currentOwner!;
    const parent = `bearer-parent-${crypto.randomUUID()}`;
    seedFlow(parent, owner, parentGraph(parent));
    const route = (await routes()).candidates;
    const before = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get();
    const response = await route.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}`,
    ), { headers: { authorization: "Bearer ignored-owner-selector" } }));
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual(before);

    const api = await import("@/lib/flow/subflow-api");
    expect(() => new api.SubflowApiService({} as never)).toThrow(api.SubflowApiStoreUnavailableError);
  });

  it("makes missing and foreign child version lookups byte-identical", async () => {
    const owner = currentOwner!;
    const parent = `private-parent-${crypto.randomUUID()}`;
    const foreign = `private-child-${crypto.randomUUID()}`;
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(foreign, `other-${owner}`, graph(foreign));
    const route = (await routes()).versions;
    const missingResponse = await route.GET(new Request(url(
      `/api/v2/subflows/versions?parentFlowId=${parent}&childFlowId=missing`,
    )));
    const foreignResponse = await route.GET(new Request(url(
      `/api/v2/subflows/versions?parentFlowId=${parent}&childFlowId=${foreign}`,
    )));
    expect(missingResponse.status).toBe(404);
    expect(foreignResponse.status).toBe(404);
    expect(await missingResponse.text()).toBe(await foreignResponse.text());
  });

  it("rejects forged cursor shapes and deeply hostile client responses without throwing", async () => {
    const cursorModule = await import("@/lib/flow/subflow-api-route");
    const binding = ["owner", "parent", "", "name-id-asc"];
    const valid = cursorModule.encodeSubflowCursor({
      endpoint: "candidates", binding, last: ["Name", "id"],
    });
    expect(cursorModule.decodeSubflowCursor(valid, "candidates", binding)).toEqual(["Name", "id"]);
    expect(() => cursorModule.decodeSubflowCursor(valid + "=", "candidates", binding)).toThrow("cursor");
    const decoded = JSON.parse(Buffer.from(valid, "base64url").toString("utf8"));
    const extra = Buffer.from(JSON.stringify({ ...decoded, extra: true })).toString("base64url");
    expect(() => cursorModule.decodeSubflowCursor(extra, "candidates", binding)).toThrow("cursor");
    const reordered = Buffer.from(JSON.stringify({ l: decoded.l, b: decoded.b, e: decoded.e })).toString("base64url");
    expect(() => cursorModule.decodeSubflowCursor(reordered, "candidates", binding)).toThrow("cursor");
    const whitespace = Buffer.from(JSON.stringify(decoded, null, 1)).toString("base64url");
    expect(() => cursorModule.decodeSubflowCursor(whitespace, "candidates", binding)).toThrow("cursor");

    const schemas = await import("@/lib/flow/subflow-api");
    let schema: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 5_000; index += 1) schema = { items: schema };
    const hostile = {
      versions: [{
        versionId: "v", versionNumber: 1, createdAt: 1,
        interface: {
          inputs: [], outputs: [{
            id: "o", label: "o", schema, required: true, cardinality: "one",
            source: { nodeId: "n", portId: "p" },
          }],
        },
        interfaceHash: "a".repeat(64), contentHash: "b".repeat(64),
      }],
      truncated: false,
    };
    expect(() => schemas.SubflowVersionPageSchema.safeParse(hostile)).not.toThrow();
    expect(schemas.SubflowVersionPageSchema.safeParse(hostile).success).toBe(false);
    expect(schemas.SubflowVersionPageSchema.safeParse({
      versions: [{ ...hostile.versions[0], interface: callable(),
        interfaceHash: hashCallableInterface(callable()), versionNumber: Number.MAX_SAFE_INTEGER + 1 }],
      truncated: false,
    }).success).toBe(false);

    const routeSource = readFileSync(join(process.cwd(), "src/lib/flow/subflow-api-route.ts"), "utf8");
    expect(routeSource).not.toContain("decodeURIComponent");
  });

  it("returns private 405 for every unsupported method export on all four routes", async () => {
    const all = await routes();
    for (const [name, route] of Object.entries(all)) {
      const allowed = name === "resolve" ? "POST" : "GET";
      const unsupported = name === "resolve"
        ? ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
        : ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
      for (const method of unsupported) {
        const response = await (route as unknown as Record<string, () => Response | Promise<Response>>)[method]!();
        expect(response.status, `${name}.${method}`).toBe(405);
        expect(response.headers.get("allow")).toBe(allowed);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    }
  });

  it("reports an exhausted candidate scan honestly without inventing a cursor", async () => {
    const owner = currentOwner!;
    const parent = `ceiling-parent-${crypto.randomUUID()}`;
    seedFlow(parent, owner, parentGraph(parent));
    for (let index = 0; index < 513; index += 1) {
      seedFlow(
        `ceiling-${String(index).padStart(3, "0")}-${crypto.randomUUID()}`,
        owner,
        graph(`ceiling-${index}`, null),
        `Ceiling ${String(index).padStart(3, "0")}`,
      );
    }
    const response = await (await routes()).candidates.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}`,
    )));
    const body = await response.json() as { flows: unknown[]; truncated: boolean; nextCursor?: string };
    expect(response.status).toBe(200);
    expect(body).toEqual({ flows: [], truncated: true });
  });

  it("never exposes a workbook through a corrupted cross-owner binding chain", async () => {
    const owner = currentOwner!;
    const foreignOwner = `foreign-workbook-owner-${crypto.randomUUID()}`;
    const parent = `workbook-parent-${crypto.randomUUID()}`;
    const child = `workbook-child-${crypto.randomUUID()}`;
    const suffix = crypto.randomUUID();
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, graph(child), "Workbook child");
    db.prepare("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)")
      .run(`org-${suffix}`, foreignOwner, "Foreign", "personal", 1);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)")
      .run(`workspace-${suffix}`, `org-${suffix}`, "Foreign", `foreign-${suffix}`, 1);
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)")
      .run(`project-${suffix}`, `workspace-${suffix}`, "Foreign", `foreign-${suffix}`, 1, 1);
    db.prepare("INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)")
      .run(`workbook-${suffix}`, `project-${suffix}`, "Secret workbook", `secret-${suffix}`, 0, 1);
    db.prepare("INSERT INTO flow_project_bindings VALUES (?, ?, ?, ?)")
      .run(child, `project-${suffix}`, `workbook-${suffix}`, 1);
    const response = await (await routes()).candidates.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}&query=workbook`,
    )));
    const body = await response.json() as { flows: Array<{ workbookName: string | null }> };
    expect(response.status).toBe(200);
    expect(body.flows).toHaveLength(1);
    expect(body.flows[0]?.workbookName).toBeNull();
  });

  it("nulls a corrupted empty workbook name instead of failing the candidate page", async () => {
    const owner = currentOwner!;
    const parent = `empty-workbook-parent-${crypto.randomUUID()}`;
    const child = `empty-workbook-child-${crypto.randomUUID()}`;
    const suffix = crypto.randomUUID();
    seedFlow(parent, owner, parentGraph(parent));
    seedFlow(child, owner, graph(child), "Empty workbook child");
    db.prepare("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)")
      .run(`org-${suffix}`, owner, "Personal", "personal", 1);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)")
      .run(`workspace-${suffix}`, `org-${suffix}`, "Personal", `personal-${suffix}`, 1);
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)")
      .run(`project-${suffix}`, `workspace-${suffix}`, "Personal", `personal-${suffix}`, 1, 1);
    db.prepare("INSERT INTO workbooks VALUES (?, ?, ?, ?, ?, ?)")
      .run(`workbook-${suffix}`, `project-${suffix}`, "", `empty-${suffix}`, 0, 1);
    db.prepare("INSERT INTO flow_project_bindings VALUES (?, ?, ?, ?)")
      .run(child, `project-${suffix}`, `workbook-${suffix}`, 1);
    const response = await (await routes()).candidates.GET(new Request(url(
      `/api/v2/subflows/candidates?parentFlowId=${parent}&query=empty`,
    )));
    const body = await response.json() as {
      flows: Array<{ workbookName: string | null }>;
      truncated: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.flows).toHaveLength(1);
    expect(body.flows[0]?.workbookName).toBeNull();
    expect(body.truncated).toBe(true);
  });
});
