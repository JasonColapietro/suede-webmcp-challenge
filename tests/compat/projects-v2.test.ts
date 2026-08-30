import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { FlowGraph } from "@/lib/flow/types";

const root = mkdtempSync(join(tmpdir(), "suede-projects-v2-compat-"));
const sqlitePath = join(root, "compat.db");
const db = new Database(sqlitePath);
runSqliteMigrations(db);
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
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

const contextRoute = await import("@/app/api/v2/context/route");
const projectsRoute = await import("@/app/api/v2/projects/route");
const projectRoute = await import("@/app/api/v2/projects/[projectId]/route");
const versionsRoute = await import("@/app/api/v2/flows/[flowId]/versions/route");
const versionRoute = await import("@/app/api/v2/flows/[flowId]/versions/[versionId]/route");

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

function graph(id: string): FlowGraph {
  return {
    id,
    name: "Frozen v2 compatibility",
    nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
    edges: [],
  };
}

function seedFlow(flowId: string, ownerId: string): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(flowId, ownerId, "Frozen v2 compatibility", JSON.stringify(graph(`graph-${flowId}`)), Date.now());
}

const projectParams = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const flowParams = (flowId: string) => ({ params: Promise.resolve({ flowId }) });
const versionParams = (flowId: string, versionId: string) => ({
  params: Promise.resolve({ flowId, versionId }),
});

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectPrivate(
  response: Response,
  status: number,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe(JSON.stringify(body));
}

describe("frozen Phase 1 project/version v2 compatibility", () => {
  it("freezes success envelopes, private caching, and public version creator projection", async () => {
    const ownerId = testOwner();
    const flowId = `compat-v2-flow-${Date.now()}`;
    currentOwner = ownerId;
    seedFlow(flowId, ownerId);

    const contextResponse = await contextRoute.GET();
    expect(contextResponse.status).toBe(200);
    expect(contextResponse.headers.get("cache-control")).toBe("private, no-store");
    const context = (await contextResponse.json()) as {
      context: { project: { id: string } };
    };
    expect(Object.keys(context)).toEqual(["context"]);

    const projectsResponse = await projectsRoute.GET();
    expect(projectsResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(Object.keys(await projectsResponse.json())).toEqual(["projects"]);

    const projectResponse = await projectRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/projects/project"),
      projectParams(context.context.project.id),
    );
    expect(projectResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(Object.keys(await projectResponse.json())).toEqual(["project"]);

    const createdResponse = await versionsRoute.POST(
      post(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`, {}),
      flowParams(flowId),
    );
    const created = (await createdResponse.json()) as {
      version: { id: string; createdBy: string };
    };
    expect(createdResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(Object.keys(created)).toEqual(["version"]);
    expect(created.version.createdBy).toBe("workspace-owner");
    expect(
      (db.prepare("SELECT created_by FROM flow_versions WHERE id = ?").get(created.version.id) as { created_by: string }).created_by,
    ).toBe(ownerId);

    const listResponse = await versionsRoute.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions`),
      flowParams(flowId),
    );
    const list = (await listResponse.json()) as { versions: Array<{ createdBy: string }> };
    expect(listResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(Object.keys(list)).toEqual(["versions"]);
    expect(list.versions[0]?.createdBy).toBe("workspace-owner");

    const detailResponse = await versionRoute.GET(
      new Request(`https://agents.suedeai.ai/api/v2/flows/${flowId}/versions/${created.version.id}`),
      versionParams(flowId, created.version.id),
    );
    const detail = (await detailResponse.json()) as { version: { createdBy: string } };
    expect(detailResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(Object.keys(detail)).toEqual(["version"]);
    expect(detail.version.createdBy).toBe("workspace-owner");
  });

  it("freezes private 401, non-enumerating 404, and capability 503 envelopes", async () => {
    currentOwner = null;
    await expectPrivate(await contextRoute.GET(), 401, { error: "Authentication required" });

    currentOwner = testOwner();
    await expectPrivate(
      await projectRoute.GET(
        new Request("https://agents.suedeai.ai/api/v2/projects/missing"),
        projectParams("opaque-missing-project"),
      ),
      404,
      { error: "not found" },
    );

    const forbiddenFallback = join(root, "must-not-fallback.db");
    vi.stubEnv("DB_DRIVER", "supabase");
    vi.stubEnv("SQLITE_PATH", forbiddenFallback);
    await expectPrivate(await contextRoute.GET(), 503, { error: "project store unavailable" });
    expect(existsSync(forbiddenFallback)).toBe(false);
  });
});
