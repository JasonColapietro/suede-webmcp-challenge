import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { FlowGraph } from "@/lib/flow/types";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { VersionService } from "@/lib/projects/version-service";
import { parseVersionDiffEnvelope } from "@/lib/projects/ui-model";
import type { FlowVersionSemanticDiff } from "@/lib/projects/types";

const root = mkdtempSync(join(tmpdir(), "suede-version-compare-api-"));
const sqlitePath = join(root, "compare.db");
const db = new Database(sqlitePath);
runSqliteMigrations(db);
const repo = new SqliteProjectRepo(db);
let ownerSequence = 0;
function testOwner(): string {
  ownerSequence += 1;
  return `00000000-0000-4000-8000-${ownerSequence.toString().padStart(12, "0")}`;
}
let currentOwner: string | null = testOwner();

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

function graph(revision: number): FlowGraph {
  return {
    id: "graph-compare",
    name: "Compare",
    nodes: [{ id: "input", type: "input", params: { revision }, position: { x: revision, y: 0 } }],
    edges: [],
  };
}

function seedFlow(flowId: string, ownerId: string): void {
  db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(flowId, ownerId, "Compare", JSON.stringify(graph(1)), Date.now());
}

async function seedVersions(flowId: string, ownerId: string): Promise<readonly [string, string]> {
  seedFlow(flowId, ownerId);
  const service = new VersionService(repo);
  const left = await service.createFlowVersion({ flowId, ownerId });
  db.prepare("UPDATE flows SET graph = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(graph(2)), Date.now() + 1, flowId);
  const right = await service.createFlowVersion({ flowId, ownerId });
  if (!left || !right) throw new Error("fixture version missing");
  return [left.id, right.id];
}

async function loadRoute() {
  try {
    return await import("@/app/api/v2/flows/[flowId]/versions/compare/route");
  } catch {
    return null;
  }
}

function params(flowId: unknown) {
  return { params: Promise.resolve({ flowId }) } as unknown as {
    params: Promise<{ flowId: string }>;
  };
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

function validDiff(): FlowVersionSemanticDiff {
  return {
    from: { id: "version-1", versionNumber: 1, semanticHash: "a".repeat(64) },
    to: { id: "version-2", versionNumber: 2, semanticHash: "b".repeat(64) },
    semanticEqual: false,
    fullEqual: false,
    visualOnly: false,
    changedSections: ["nodes"],
    counts: { added: 0, removed: 0, changed: 1 },
    entries: [{ kind: "node", id: "input", change: "changed", fields: ["params.revision"] }],
    truncated: false,
  };
}

describe("private v2 version compare API", () => {
  it("loads two owner-scoped opaque versions and returns a strict private diff", async () => {
    const flowId = "flow:opaque/@compare";
    const [from, to] = await seedVersions(flowId, currentOwner!);
    const route = await loadRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/x/versions/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      params(flowId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload: unknown = await response.json();
    const parsed = parseVersionDiffEnvelope(payload);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      from: { id: from, versionNumber: 1 },
      to: { id: to, versionNumber: 2 },
      semanticEqual: false,
      fullEqual: false,
      visualOnly: false,
      changedSections: ["nodes"],
      counts: { added: 0, removed: 0, changed: 1 },
      entries: [{ kind: "node", id: "input", change: "changed", fields: ["params.revision"] }],
      truncated: false,
    });

    const reversedQueryOrder = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/x/versions/compare?to=${encodeURIComponent(to)}&from=${encodeURIComponent(from)}`),
      params(flowId),
    );
    expect(reversedQueryOrder.status).toBe(200);
  });

  it("returns identical private 404s for missing and foreign records", async () => {
    const flowId = "flow-private-compare";
    const owner = testOwner();
    const [from, to] = await seedVersions(flowId, owner);
    const route = await loadRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    currentOwner = owner;
    await expectPrivateJson(
      await route.GET(new Request(`https://agents.suedeai.ai/compare?from=missing&to=${to}`), params(flowId)),
      404,
      { error: "not found" },
    );
    currentOwner = testOwner();
    await expectPrivateJson(
      await route.GET(new Request(`https://agents.suedeai.ai/compare?from=${from}&to=${to}`), params(flowId)),
      404,
      { error: "not found" },
    );
  });

  it("rejects absent, repeated, blank, and extra query parameters", async () => {
    const flowId = "flow-query-compare";
    const [from, to] = await seedVersions(flowId, currentOwner!);
    const route = await loadRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const invalid = [
      `?from=${from}`,
      `?from=${from}&to=${to}&to=${to}`,
      `?from=${from}&to=`,
      `?from=${from}&to=${to}&extra=1`,
    ];
    for (const query of invalid) {
      await expectPrivateJson(
        await route.GET(new Request(`https://agents.suedeai.ai/compare${query}`), params(flowId)),
        400,
        { error: "invalid request" },
      );
    }
  });
});

describe("strict version diff client parser", () => {
  it("accepts only the exact envelope and canonical ordering", () => {
    const diff = validDiff();
    expect(parseVersionDiffEnvelope({ diff })).toEqual(diff);
    expect(parseVersionDiffEnvelope({ diff, extra: true })).toBeNull();
    expect(parseVersionDiffEnvelope({ diff: { ...diff, extra: true } })).toBeNull();
    expect(parseVersionDiffEnvelope({ diff: { ...diff, changedSections: ["nodes", "edges"] } })).toBeNull();
    expect(parseVersionDiffEnvelope({
      diff: {
        ...diff,
        entries: [
          { kind: "edge", id: "z", change: "added", fields: [] },
          ...diff.entries,
        ],
        counts: { added: 1, removed: 0, changed: 1 },
      },
    })).toBeNull();
  });

  it("rejects duplicate entries, invalid counts, unsafe keys, and over 200 entries", () => {
    const diff = validDiff();
    expect(parseVersionDiffEnvelope({ diff: { ...diff, entries: [...diff.entries, ...diff.entries], counts: { ...diff.counts, changed: 2 } } })).toBeNull();
    expect(parseVersionDiffEnvelope({ diff: { ...diff, counts: { ...diff.counts, changed: 2 } } })).toBeNull();
    expect(parseVersionDiffEnvelope(JSON.parse(`{"diff":${JSON.stringify(diff)},"__proto__":{"polluted":true}}`))).toBeNull();
    const entries = Array.from({ length: 201 }, (_, index) => ({
      kind: "node" as const,
      id: `node-${String(index).padStart(3, "0")}`,
      change: "added" as const,
      fields: [],
    }));
    expect(parseVersionDiffEnvelope({
      diff: { ...diff, entries, counts: { added: 201, removed: 0, changed: 0 }, truncated: true },
    })).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects changed entries without fields and contradictory equality states", () => {
    const changed = validDiff();
    expect(parseVersionDiffEnvelope({
      diff: {
        ...changed,
        entries: [{ ...changed.entries[0], fields: [] }],
      },
    })).toBeNull();

    const equal: FlowVersionSemanticDiff = {
      ...changed,
      to: { ...changed.to, semanticHash: changed.from.semanticHash },
      semanticEqual: true,
      fullEqual: true,
      visualOnly: false,
      changedSections: [],
      counts: { added: 0, removed: 0, changed: 0 },
      entries: [],
    };
    const truncatedEntries = Array.from({ length: 200 }, (_, index) => ({
      kind: "node" as const,
      id: `node-${String(index).padStart(3, "0")}`,
      change: "added" as const,
      fields: [],
    }));
    const impossible: readonly FlowVersionSemanticDiff[] = [
      { ...equal, semanticEqual: false },
      { ...equal, semanticEqual: false, fullEqual: false },
      { ...equal, fullEqual: false, visualOnly: false },
      { ...equal, fullEqual: false, visualOnly: true, changedSections: ["meta"] },
      {
        ...equal,
        fullEqual: false,
        counts: { added: 201, removed: 0, changed: 0 },
        entries: truncatedEntries,
        truncated: true,
      },
      { ...changed, semanticEqual: true },
    ];
    for (const diff of impossible) {
      expect(parseVersionDiffEnvelope({ diff })).toBeNull();
    }

    expect(parseVersionDiffEnvelope({
      diff: { ...equal, fullEqual: false, visualOnly: true },
    })).toEqual({ ...equal, fullEqual: false, visualOnly: true });
  });

  it("requires exact lowercase SHA-256 endpoints and hash-derived semantic equality", () => {
    const changed = validDiff();
    for (const semanticHash of ["a".repeat(63), "A".repeat(64), "g".repeat(64), `${"a".repeat(64)}0`]) {
      expect(parseVersionDiffEnvelope({
        diff: { ...changed, from: { ...changed.from, semanticHash } },
      })).toBeNull();
    }
    expect(parseVersionDiffEnvelope({
      diff: { ...changed, to: { ...changed.to, semanticHash: changed.from.semanticHash } },
    })).toBeNull();
    expect(parseVersionDiffEnvelope({
      diff: {
        ...changed,
        semanticEqual: true,
        fullEqual: true,
        changedSections: [],
        counts: { added: 0, removed: 0, changed: 0 },
        entries: [],
      },
    })).toBeNull();
  });
});
