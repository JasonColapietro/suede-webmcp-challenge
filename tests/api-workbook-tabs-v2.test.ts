import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type {
  EnvironmentRecord,
  PersonalContext,
  ProjectRecord,
  WorkbookRecord,
} from "@/lib/projects/types";

const root = mkdtempSync(join(tmpdir(), "suede-workbook-api-v2-"));
const sqlitePath = join(root, "workbooks.db");
const db = new Database(sqlitePath);
runSqliteMigrations(db);
const projectRepo = new SqliteProjectRepo(db);
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

async function loadTabsRoute() {
  try {
    return await import("@/app/api/v2/workbooks/[workbookId]/tabs/route");
  } catch {
    return null;
  }
}

async function loadTabRoute() {
  try {
    return await import("@/app/api/v2/workbooks/[workbookId]/tabs/[tabId]/route");
  } catch {
    return null;
  }
}

async function loadFlowWorkbookRoute() {
  try {
    return await import("@/app/api/v2/flows/[flowId]/workbook/route");
  } catch {
    return null;
  }
}

async function loadContextRoute() {
  return import("@/app/api/v2/context/route");
}

function workbookParams(workbookId: unknown) {
  return {
    params: Promise.resolve({ workbookId }),
  } as unknown as { params: Promise<{ workbookId: string }> };
}

function tabParams(workbookId: unknown, tabId: unknown) {
  return {
    params: Promise.resolve({ workbookId, tabId }),
  } as unknown as { params: Promise<{ workbookId: string; tabId: string }> };
}

function flowParams(flowId: unknown) {
  return {
    params: Promise.resolve({ flowId }),
  } as unknown as { params: Promise<{ flowId: string }> };
}

function jsonRequest(url: string, body: unknown, authorization?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(url, { method: "PATCH", headers, body: JSON.stringify(body) });
}

function rawRequest(url: string, body: string): Request {
  return new Request(url, {
    method: "PATCH",
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

function insertFlow(input: {
  rowId: string;
  ownerId: string;
  graphId?: string;
  name?: string;
}): void {
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.rowId,
    input.ownerId,
    input.name ?? input.rowId,
    JSON.stringify({
      id: input.graphId ?? `graph-${input.rowId}`,
      name: input.name ?? input.rowId,
      nodes: [],
      edges: [],
      secret: "GRAPH_SECRET_MUST_NEVER_LEAVE",
    }),
    Date.now(),
  );
}

function addNonDefaultProject(
  context: PersonalContext,
  suffix: string,
): {
  project: ProjectRecord;
  workbook: WorkbookRecord;
  environments: readonly EnvironmentRecord[];
} {
  const now = Date.now();
  const project: ProjectRecord = {
    id: `project-${suffix}`,
    workspaceId: context.workspace.id,
    name: `Project ${suffix}`,
    slug: `project-${suffix}`,
    createdAt: now,
    updatedAt: now,
  };
  const workbook: WorkbookRecord = {
    id: `workbook-${suffix}`,
    projectId: project.id,
    name: `Workbook ${suffix}`,
    slug: `workbook-${suffix}`,
    position: 0,
    createdAt: now,
  };
  const environments: readonly EnvironmentRecord[] = ["draft", "test", "live"].map(
    (kind, index) => ({
      id: `environment-${suffix}-${kind}`,
      projectId: project.id,
      name: kind[0].toUpperCase() + kind.slice(1),
      slug: kind,
      kind: kind as EnvironmentRecord["kind"],
      createdAt: now + index,
    }),
  );
  db.prepare(
    `INSERT INTO projects (id, workspace_id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.workspaceId,
    project.name,
    project.slug,
    project.createdAt,
    project.updatedAt,
  );
  db.prepare(
    `INSERT INTO workbooks (id, project_id, name, slug, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    workbook.id,
    workbook.projectId,
    workbook.name,
    workbook.slug,
    workbook.position,
    workbook.createdAt,
  );
  const insertEnvironment = db.prepare(
    `INSERT INTO environments (id, project_id, name, slug, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const environment of environments) {
    insertEnvironment.run(
      environment.id,
      environment.projectId,
      environment.name,
      environment.slug,
      environment.kind,
      environment.createdAt,
    );
  }
  return { project, workbook, environments };
}

async function seedBoundFlows(input: {
  ownerId: string;
  suffix: string;
  rows: readonly { rowId: string; graphId?: string; name?: string }[];
  nonDefault?: boolean;
}) {
  const personal = await projectRepo.ensurePersonalContext(input.ownerId);
  const selected = input.nonDefault
    ? addNonDefaultProject(personal, input.suffix)
    : {
        project: personal.project,
        workbook: personal.workbook,
        environments: personal.environments,
      };
  const bindingContext: PersonalContext = {
    organization: personal.organization,
    workspace: personal.workspace,
    project: selected.project,
    workbook: selected.workbook,
    environments: selected.environments,
  };
  for (const row of input.rows) {
    insertFlow({ ...row, ownerId: input.ownerId });
    const binding = await projectRepo.bindFlow(row.rowId, bindingContext);
    if (!binding) throw new Error("fixture binding failed");
  }
  const tabs = await projectRepo.listWorkbookTabs({
    workbookId: selected.workbook.id,
    ownerId: input.ownerId,
  });
  if (!tabs) throw new Error("fixture tabs missing");
  return { personal, ...selected, tabs };
}

function rawTabBytes(workbookId: string): string {
  return JSON.stringify(
    db.prepare(
      "SELECT * FROM workbook_flow_tabs WHERE workbook_id = ? ORDER BY position, id",
    ).all(workbookId),
  );
}

describe("private v2 workbook tab API", () => {
  it("exports dynamic Node routes and strict public response parsers", async () => {
    const tabsRoute = await loadTabsRoute();
    const tabRoute = await loadTabRoute();
    const flowRoute = await loadFlowWorkbookRoute();
    for (const route of [tabsRoute, tabRoute, flowRoute]) {
      expect(route).not.toBeNull();
      expect(route?.runtime).toBe("nodejs");
      expect(route?.dynamic).toBe("force-dynamic");
    }
    const publicModule = await import("@/lib/projects/public-workbook").catch(() => null);
    expect(publicModule).not.toBeNull();
    expect(publicModule?.parseWorkbookTabsEnvelope).toBeTypeOf("function");
    expect(publicModule?.parseFlowWorkbookEnvelope).toBeTypeOf("function");
  });

  it("lists ordered public tabs with exactly seven allowlisted fields", async () => {
    const ownerId = testOwner();
    currentOwner = ownerId;
    const fixture = await seedBoundFlows({
      ownerId,
      suffix: "list",
      rows: [
        { rowId: "row-list-a", name: "First" },
        { rowId: "row-list-b", name: "Second" },
      ],
    });
    const route = await loadTabsRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET(
      new Request(`https://agents.suedeai.ai/api/v2/workbooks/${fixture.workbook.id}/tabs`, {
        headers: { authorization: "Bearer ignored-for-GET" },
      }),
      workbookParams(fixture.workbook.id),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as { tabs: Array<Record<string, unknown>> };
    expect(payload.tabs.map((tab) => tab.position)).toEqual([0, 1]);
    for (const tab of payload.tabs) {
      expect(Object.keys(tab).sort()).toEqual(
        ["createdAt", "flowId", "id", "position", "title", "updatedAt", "workbookId"].sort(),
      );
    }
    expect(JSON.stringify(payload)).not.toMatch(/owner|personalOwner|GRAPH_SECRET|provider|connection/i);
  });

  it("returns the current row's non-default workbook context, never the personal default", async () => {
    const ownerId = testOwner();
    currentOwner = ownerId;
    const fixture = await seedBoundFlows({
      ownerId,
      suffix: "non-default",
      nonDefault: true,
      rows: [{ rowId: "row-authoritative", graphId: "graph-id-is-not-row-id", name: "Bound" }],
    });
    const route = await loadFlowWorkbookRoute();
    expect(route).not.toBeNull();
    if (!route) return;

    const response = await route.GET(
      new Request("https://agents.suedeai.ai/api/v2/flows/row-authoritative/workbook"),
      flowParams("row-authoritative"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as {
      context: { project: { id: string }; workbook: { id: string }; environments: unknown[] };
      tabs: Array<{ flowId: string }>;
    };
    expect(Object.keys(payload.context).sort()).toEqual(["environments", "project", "workbook"]);
    expect(payload.context.project.id).toBe(fixture.project.id);
    expect(payload.context.workbook.id).toBe(fixture.workbook.id);
    expect(payload.context.workbook.id).not.toBe(fixture.personal.workbook.id);
    expect(payload.tabs.map((tab) => tab.flowId)).toEqual(["row-authoritative"]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(ownerId);
    expect(serialized).not.toMatch(
      /"(?:personalOwnerId|ownerId|organization|workspace|binding|graph|secret|provider|connection)"\s*:/i,
    );

    const defaultPayload = (await (await (await loadContextRoute()).GET()).json()) as {
      context: { workbook: { id: string } };
    };
    expect(defaultPayload.context.workbook.id).toBe(fixture.personal.workbook.id);
  });

  it("makes missing, invalid, and wrong-owner workbook and tab responses byte-identical", async () => {
    const ownerId = testOwner();
    currentOwner = ownerId;
    const fixture = await seedBoundFlows({
      ownerId,
      suffix: "privacy",
      rows: [{ rowId: "row-private", name: "Private" }],
    });
    const tabsRoute = await loadTabsRoute();
    const tabRoute = await loadTabRoute();
    const flowRoute = await loadFlowWorkbookRoute();
    expect(tabsRoute && tabRoute && flowRoute).toBeTruthy();
    if (!tabsRoute || !tabRoute || !flowRoute) return;

    const missingWorkbook = await tabsRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/workbooks/missing/tabs"),
      workbookParams("missing-workbook"),
    );
    const invalidWorkbook = await tabsRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/workbooks/invalid/tabs"),
      workbookParams("   "),
    );
    const missingTab = await tabRoute.PATCH(
      jsonRequest("https://agents.suedeai.ai/api/v2/workbooks/x/tabs/missing", { title: "Nope" }),
      tabParams(fixture.workbook.id, "missing-tab"),
    );
    const missingFlow = await flowRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/flows/missing/workbook"),
      flowParams("missing-flow"),
    );
    currentOwner = testOwner();
    const wrongWorkbook = await tabsRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/workbooks/private/tabs"),
      workbookParams(fixture.workbook.id),
    );
    const wrongTab = await tabRoute.PATCH(
      jsonRequest("https://agents.suedeai.ai/api/v2/workbooks/private/tabs/private", { title: "Nope" }),
      tabParams(fixture.workbook.id, fixture.tabs[0].id),
    );
    const wrongFlow = await flowRoute.GET(
      new Request("https://agents.suedeai.ai/api/v2/flows/private/workbook"),
      flowParams("row-private"),
    );
    for (const response of [
      missingWorkbook,
      invalidWorkbook,
      missingTab,
      missingFlow,
      wrongWorkbook,
      wrongTab,
      wrongFlow,
    ]) {
      await expectPrivateJson(response, 404, { error: "not found" });
    }
  });

  it("rejects authentication failures and mutation Authorization before JSON parsing or writes", async () => {
    const ownerId = testOwner();
    currentOwner = ownerId;
    const fixture = await seedBoundFlows({
      ownerId,
      suffix: "auth",
      rows: [{ rowId: "row-auth", name: "Auth" }],
    });
    const tabsRoute = await loadTabsRoute();
    const tabRoute = await loadTabRoute();
    const flowRoute = await loadFlowWorkbookRoute();
    expect(tabsRoute && tabRoute && flowRoute).toBeTruthy();
    if (!tabsRoute || !tabRoute || !flowRoute) return;
    const before = rawTabBytes(fixture.workbook.id);

    const bearerReorder = await tabsRoute.PATCH(
      new Request("https://agents.suedeai.ai/api/v2/workbooks/x/tabs", {
        method: "PATCH",
        headers: { authorization: "Bearer alternate-owner", "content-type": "application/json" },
        body: "not-json",
      }),
      workbookParams(fixture.workbook.id),
    );
    const bearerRename = await tabRoute.PATCH(
      new Request("https://agents.suedeai.ai/api/v2/workbooks/x/tabs/y", {
        method: "PATCH",
        headers: { Authorization: "Basic alternate-owner", "content-type": "application/json" },
        body: "not-json",
      }),
      tabParams(fixture.workbook.id, fixture.tabs[0].id),
    );
    await expectPrivateJson(bearerReorder, 401, { error: "Authentication required" });
    await expectPrivateJson(bearerRename, 401, { error: "Authentication required" });
    expect(rawTabBytes(fixture.workbook.id)).toBe(before);

    currentOwner = null;
    await expectPrivateJson(
      await tabsRoute.GET(
        new Request("https://agents.suedeai.ai/api/v2/workbooks/x/tabs"),
        workbookParams(fixture.workbook.id),
      ),
      401,
      { error: "Authentication required" },
    );
    await expectPrivateJson(
      await flowRoute.GET(
        new Request("https://agents.suedeai.ai/api/v2/flows/x/workbook"),
        flowParams("row-auth"),
      ),
      401,
      { error: "Authentication required" },
    );
  });

  it.each([
    ["malformed", "{"],
    ["unknown reorder key", JSON.stringify({ tabIds: [], extra: true })],
    ["blank reorder id", JSON.stringify({ tabIds: ["   "] })],
    ["duplicate reorder ids", JSON.stringify({ tabIds: ["same", "same"] })],
    ["too many reorder ids", JSON.stringify({ tabIds: Array.from({ length: 1001 }, (_, i) => `tab-${i}`) })],
  ])("rejects %s with one stable private 400", async (_name, body) => {
    const ownerId = testOwner();
    currentOwner = ownerId;
    const fixture = await seedBoundFlows({
      ownerId,
      suffix: `invalid-${Math.random().toString(36).slice(2)}`,
      rows: [{ rowId: `row-invalid-${Math.random()}`, name: "Invalid" }],
    });
    const route = await loadTabsRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const before = rawTabBytes(fixture.workbook.id);
    await expectPrivateJson(
      await route.PATCH(
        rawRequest("https://agents.suedeai.ai/api/v2/workbooks/x/tabs", body),
        workbookParams(fixture.workbook.id),
      ),
      400,
      { error: "invalid request" },
    );
    expect(rawTabBytes(fixture.workbook.id)).toBe(before);
  });

  it.each([
    ["malformed", "{"],
    ["unknown key", JSON.stringify({ title: "Good", extra: true })],
    ["blank title", JSON.stringify({ title: "   " })],
    ["overlong title", JSON.stringify({ title: "x".repeat(201) })],
  ])("rejects %s rename with one stable private 400", async (_name, body) => {
    const ownerId = testOwner();
    currentOwner = ownerId;
    const fixture = await seedBoundFlows({
      ownerId,
      suffix: `rename-${Math.random().toString(36).slice(2)}`,
      rows: [{ rowId: `row-rename-${Math.random()}`, name: "Rename" }],
    });
    const route = await loadTabRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    await expectPrivateJson(
      await route.PATCH(
        rawRequest("https://agents.suedeai.ai/api/v2/workbooks/x/tabs/y", body),
        tabParams(fixture.workbook.id, fixture.tabs[0].id),
      ),
      400,
      { error: "invalid request" },
    );
  });

  it("renames and atomically exact-set reorders tabs with strict envelopes", async () => {
    const ownerId = testOwner();
    currentOwner = ownerId;
    const fixture = await seedBoundFlows({
      ownerId,
      suffix: "mutations",
      rows: [
        { rowId: "row-mutation-a", name: "A" },
        { rowId: "row-mutation-b", name: "B" },
        { rowId: "row-mutation-c", name: "C" },
      ],
    });
    const tabsRoute = await loadTabsRoute();
    const tabRoute = await loadTabRoute();
    expect(tabsRoute && tabRoute).toBeTruthy();
    if (!tabsRoute || !tabRoute) return;

    const rename = await tabRoute.PATCH(
      jsonRequest("https://agents.suedeai.ai/api/v2/workbooks/x/tabs/y", { title: "  New title  " }),
      tabParams(fixture.workbook.id, fixture.tabs[1].id),
    );
    expect(rename.status).toBe(200);
    expect(rename.headers.get("cache-control")).toBe("private, no-store");
    expect(await rename.json()).toMatchObject({
      tab: { id: fixture.tabs[1].id, title: "New title", position: 1 },
    });

    const requested = [fixture.tabs[2].id, fixture.tabs[0].id, fixture.tabs[1].id];
    const reorder = await tabsRoute.PATCH(
      jsonRequest("https://agents.suedeai.ai/api/v2/workbooks/x/tabs", { tabIds: requested }),
      workbookParams(fixture.workbook.id),
    );
    expect(reorder.status).toBe(200);
    expect(reorder.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await reorder.json()) as { tabs: Array<{ id: string; position: number }> };
    expect(payload.tabs.map((tab) => tab.id)).toEqual(requested);
    expect(payload.tabs.map((tab) => tab.position)).toEqual([0, 1, 2]);

    const beforeRejected = rawTabBytes(fixture.workbook.id);
    await expectPrivateJson(
      await tabsRoute.PATCH(
        jsonRequest("https://agents.suedeai.ai/api/v2/workbooks/x/tabs", { tabIds: requested.slice(1) }),
        workbookParams(fixture.workbook.id),
      ),
      404,
      { error: "not found" },
    );
    expect(rawTabBytes(fixture.workbook.id)).toBe(beforeRejected);
  });

  it("strict parsers reject forbidden fields, sentinels, and malformed tab sets", async () => {
    const module = await import("@/lib/projects/public-workbook").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    const context = {
      project: {
        id: "project",
        workspaceId: "workspace-resource-id",
        name: "Project",
        slug: "project",
        createdAt: 1,
        updatedAt: 2,
      },
      workbook: {
        id: "workbook",
        projectId: "project",
        name: "Workbook",
        slug: "workbook",
        position: 0,
        createdAt: 1,
      },
      environments: [
        { id: "env", projectId: "project", name: "Draft", slug: "draft", kind: "draft", createdAt: 1 },
      ],
    };
    const tabs = [
      { id: "tab", workbookId: "workbook", flowId: "row", title: "Main", position: 0, createdAt: 1, updatedAt: 1 },
    ];
    expect(module.parseFlowWorkbookEnvelope({ context, tabs })).toEqual({ context, tabs });
    expect(module.parseWorkbookTabsEnvelope({ tabs })).toEqual(tabs);
    expect(module.parseWorkbookTabsEnvelope({ tabs }, "workbook")).toEqual(tabs);
    expect(module.parseWorkbookTabsEnvelope({ tabs }, "workbook-wrong")).toBeNull();
    expect(module.parseWorkbookTabsEnvelope({ tabs: [] }, "workbook")).toEqual([]);
    expect(
      module.parseWorkbookTabsEnvelope({
        tabs: [
          tabs[0],
          {
            ...tabs[0],
            id: "tab-other-workbook",
            workbookId: "workbook-other",
            flowId: "row-other-workbook",
            position: 1,
          },
        ],
      }),
    ).toBeNull();
    for (const forbidden of [
      { context: { ...context, ownerId: "OWNER_SENTINEL" }, tabs },
      { context: { ...context, personalOwnerId: "OWNER_SENTINEL" }, tabs },
      { context: { ...context, organization: { personalOwnerId: "OWNER_SENTINEL" } }, tabs },
      { context: { ...context, workspace: {} }, tabs },
      { context: { ...context, binding: {} }, tabs },
      { context, tabs: [{ ...tabs[0], secret: "SECRET_SENTINEL" }] },
      { context, tabs: [{ ...tabs[0], position: 1 }] },
      { context, tabs: [tabs[0], { ...tabs[0], id: "tab-2", position: 1 }] },
      { context, tabs: [tabs[0], { ...tabs[0], flowId: "row-2", position: 0 }] },
    ]) {
      expect(module.parseFlowWorkbookEnvelope(forbidden)).toBeNull();
    }
  });

  it("constructs the client-safe projection explicitly without casts or context spreads", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/projects/public-workbook.ts"),
      "utf8",
    );
    const routeSource = readFileSync(
      join(process.cwd(), "src/app/api/v2/flows/[flowId]/workbook/route.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/as\s+(?:unknown\s+as\s+)?(?:PersonalContext|FlowWorkbookContext)/);
    expect(source).not.toMatch(/\.\.\.\s*(?:value|context|flowContext)/);
    expect(routeSource).not.toMatch(/\.\.\.\s*(?:value|context|flowContext)/);
    expect(routeSource).not.toMatch(/\b(?:organization|workspace|binding)\s*:/);
    expect(routeSource).toContain("publicFlowWorkbookContext(flowContext)");
    expect(routeSource).toContain("ensureOwnedFlowContext");
    expect(routeSource).not.toContain("ensurePersonalContext");
  });
});
