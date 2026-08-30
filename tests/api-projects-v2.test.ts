import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "suede-project-api-v2-"));
const sqlitePath = join(root, "projects.db");
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

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  currentOwner = testOwner();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DB_DRIVER", "sqlite");
  vi.stubEnv("SQLITE_PATH", sqlitePath);
});

async function loadContextRoute() {
  try {
    return await import("@/app/api/v2/context/route");
  } catch {
    return null;
  }
}

async function loadProjectsRoute() {
  try {
    return await import("@/app/api/v2/projects/route");
  } catch {
    return null;
  }
}

async function loadProjectRoute() {
  try {
    return await import("@/app/api/v2/projects/[projectId]/route");
  } catch {
    return null;
  }
}

function projectParams(projectId: unknown) {
  return {
    params: Promise.resolve({ projectId }),
  } as unknown as { params: Promise<{ projectId: string }> };
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

describe("v2 personal project API", () => {
  it("exposes the six planned route modules before serving contracts", async () => {
    const routes = [await loadContextRoute(), await loadProjectsRoute(), await loadProjectRoute()];
    for (const route of routes) {
      expect(route).not.toBeNull();
      expect(route?.runtime).toBe("nodejs");
      expect(route?.dynamic).toBe("force-dynamic");
    }
  });

  it("creates and returns the silent personal context with private no-store caching", async () => {
    const route = await loadContextRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as {
      context: {
        organization: { personalOwnerId: string };
        project: { id: string; name: string; slug: string };
        workbook: { projectId: string; name: string; slug: string };
        environments: Array<{ projectId: string; kind: string }>;
      };
    };
    expect(Object.keys(payload)).toEqual(["context"]);
    expect(payload.context.organization.personalOwnerId).toBe(currentOwner);
    expect(payload.context.project).toMatchObject({ name: "My Project", slug: "my-project" });
    expect(payload.context.workbook).toMatchObject({
      projectId: payload.context.project.id,
      name: "Main",
      slug: "main",
    });
    expect(payload.context.environments.map(({ kind }) => kind)).toEqual([
      "draft",
      "test",
      "live",
    ]);
    const repeated = (await (await route.GET()).json()) as {
      context: { project: { id: string } };
    };
    expect(repeated.context.project.id).toBe(payload.context.project.id);
  });

  it("ensures personal context before deterministically listing projects", async () => {
    currentOwner = testOwner();
    const route = await loadProjectsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as {
      projects: Array<{ id: string; name: string; slug: string }>;
    };
    expect(Object.keys(payload)).toEqual(["projects"]);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]).toMatchObject({ name: "My Project", slug: "my-project" });
  });

  it("returns owner-scoped project detail with ordered workbooks and environments", async () => {
    const contextRoute = await loadContextRoute();
    const projectRoute = await loadProjectRoute();
    expect(contextRoute).not.toBeNull();
    expect(projectRoute).not.toBeNull();
    if (!contextRoute || !projectRoute) return;

    const contextPayload = (await (await contextRoute.GET()).json()) as {
      context: { project: { id: string } };
    };
    const response = await projectRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/projects/project"),
      projectParams(contextPayload.context.project.id),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as {
      project: {
        id: string;
        name: string;
        slug: string;
        workbooks: Array<{ name: string; position: number }>;
        environments: Array<{ kind: string }>;
      };
    };
    expect(Object.keys(payload)).toEqual(["project"]);
    expect(payload.project).toMatchObject({
      id: contextPayload.context.project.id,
      name: "My Project",
      slug: "my-project",
    });
    expect(payload.project.workbooks.map(({ name, position }) => ({ name, position }))).toEqual([
      { name: "Main", position: 0 },
    ]);
    expect(payload.project.environments.map(({ kind }) => kind)).toEqual([
      "draft",
      "test",
      "live",
    ]);
  });

  it("makes missing and wrong-owner project detail byte-identical", async () => {
    const contextRoute = await loadContextRoute();
    const projectRoute = await loadProjectRoute();
    expect(contextRoute).not.toBeNull();
    expect(projectRoute).not.toBeNull();
    if (!contextRoute || !projectRoute) return;

    const contextPayload = (await (await contextRoute.GET()).json()) as {
      context: { project: { id: string } };
    };
    const missing = await projectRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/projects/missing"),
      projectParams("opaque-missing-project"),
    );
    currentOwner = testOwner();
    const wrongOwner = await projectRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/projects/private"),
      projectParams(contextPayload.context.project.id),
    );

    await expectPrivateJson(missing, 404, { error: "not found" });
    await expectPrivateJson(wrongOwner, 404, { error: "not found" });
  });

  it.each(["   ", 42])("maps the invalid project path id %j to the private 404", async (projectId) => {
    const route = await loadProjectRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(
      await route.GET(
        new Request("https://agents.suedeai.ai/api/v2/projects/invalid"),
        projectParams(projectId),
      ),
      404,
      { error: "not found" },
    );
  });

  it("returns the exact production authentication failure before opening a store", async () => {
    currentOwner = null;
    const route = await loadContextRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    await expectPrivateJson(await route.GET(), 401, { error: "Authentication required" });
  });

  it("returns 503 for unsupported project stores and never falls back to SQLite", async () => {
    const unsupportedPath = join(root, "must-not-exist.db");
    vi.stubEnv("DB_DRIVER", "supabase");
    vi.stubEnv("SQLITE_PATH", unsupportedPath);
    const route = await loadContextRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    await expectPrivateJson(await route.GET(), 503, { error: "project store unavailable" });
    expect(existsSync(unsupportedPath)).toBe(false);
  });
});
