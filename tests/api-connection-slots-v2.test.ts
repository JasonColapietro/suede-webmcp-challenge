import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { InvalidConnectionPageError } from "@/lib/connections/repository";
import { SqliteConnectionRepository } from "@/lib/connections/sqlite-repository";
import type { ConnectionCreateInput, ConnectionEnvironment, ConnectionSecretInput } from "@/lib/connections/types";

const root = mkdtempSync(join(tmpdir(), "suede-connection-slots-api-v2-"));
const sqlitePath = join(root, "connections.sqlite");
const KEY_HEX = "17".repeat(32);
const KEY = Buffer.from(KEY_HEX, "hex");
let ownerSequence = 0;
function testOwner(): string {
  ownerSequence += 1;
  return `00000000-0000-4000-8000-${ownerSequence.toString().padStart(12, "0")}`;
}
let currentOwner: string | null = testOwner();

vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("DB_DRIVER", "sqlite");
vi.stubEnv("SQLITE_PATH", sqlitePath);
vi.stubEnv("CONNECTION_ENCRYPTION_KEY", KEY_HEX);

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (key: string) => (key === "x-owner-id" ? currentOwner : null) }),
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
  vi.stubEnv("CONNECTION_ENCRYPTION_KEY", KEY_HEX);
});

async function loadSlotRoute() {
  try { return await import("@/app/api/v2/connections/[connectionId]/slots/[environment]/route"); } catch { return null; }
}

async function loadUsageRoute() {
  try { return await import("@/app/api/v2/connections/[connectionId]/usage/route"); } catch { return null; }
}

function slotContext(connectionId: unknown, environment: unknown) {
  return { params: Promise.resolve({ connectionId, environment }) } as unknown as {
    params: Promise<{ connectionId: string; environment: string }>;
  };
}

function usageContext(connectionId: unknown) {
  return { params: Promise.resolve({ connectionId }) } as unknown as {
    params: Promise<{ connectionId: string }>;
  };
}

function mutationRequest(method: "PUT" | "DELETE", url: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      origin: new URL(url).origin,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function unreadBodyRequest(input: {
  method?: "PUT" | "DELETE";
  url: string;
  headers: HeadersInit;
  onRead: () => void;
}): Request {
  const request = new Request(input.url, { method: input.method ?? "PUT", headers: input.headers });
  Object.defineProperty(request, "body", {
    value: {
      getReader() {
        input.onRead();
        throw new Error("body-read-canary");
      },
    },
  });
  return request;
}

async function expectPrivateJson(response: Response, status: number, expected: unknown): Promise<unknown> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
  const body = await response.json() as unknown;
  expect(body).toEqual(expected);
  return body;
}

function openDatabase(): Database.Database {
  const db = new Database(sqlitePath);
  runSqliteMigrations(db);
  return db;
}

async function createConnection(ownerId: string, input: ConnectionCreateInput) {
  const db = openDatabase();
  const repository = new SqliteConnectionRepository(db, KEY);
  const connection = await repository.create(ownerId, input, Date.now());
  db.close();
  return connection;
}

function graph(connectionId: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    id: `flow-${connectionId}`,
    name: "Usage flow",
    nodes: [{
      id: "http",
      type: "http",
      params: {},
      bindings: { headers: { kind: "secret", connectionId, field: "headers" } },
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  });
}

function recursivelyHasForbiddenSecret(value: unknown, canaries: readonly string[]): boolean {
  if (typeof value === "string") return canaries.some((canary) => value.includes(canary));
  if (value === null || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:apiKey|authTag|authorization|ciphertext|headers|keyVersion|nonce|password|secret|token|username|values)$/iu.test(key)) return true;
    if (recursivelyHasForbiddenSecret(item, canaries)) return true;
  }
  return false;
}

describe("private v2 connection slot and usage API", () => {
  it("exports dynamic Node routes for slot mutation and usage", async () => {
    const slotRoute = await loadSlotRoute();
    const usageRoute = await loadUsageRoute();
    expect(slotRoute).not.toBeNull();
    expect(usageRoute).not.toBeNull();
    expect(slotRoute).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    expect(usageRoute).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    expect(slotRoute?.PUT).toBeTypeOf("function");
    expect(slotRoute?.DELETE).toBeTypeOf("function");
    expect(usageRoute?.GET).toBeTypeOf("function");
  });

  it("rejects media, cross-origin, unauthenticated, and unavailable-provider mutations before body or repository access", async () => {
    const route = await loadSlotRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const configure = vi.spyOn(SqliteConnectionRepository.prototype, "configureSlot");
    const decrypt = vi.spyOn(SqliteConnectionRepository.prototype, "resolveHeaders");
    try {
      const cases = [
        {
          name: "authorization",
          owner: testOwner(),
          key: KEY_HEX,
          headers: {
            authorization: "Bearer forbidden",
            "content-type": "application/json",
            origin: "https://agents.suedeai.ai",
            "sec-fetch-site": "same-origin",
          },
          status: 400,
          error: "invalid request",
        },
        {
          name: "media",
          owner: testOwner(),
          key: KEY_HEX,
          headers: { "content-type": "text/plain", origin: "https://agents.suedeai.ai", "sec-fetch-site": "same-origin" },
          status: 415,
          error: "unsupported media type",
        },
        {
          name: "encoding",
          owner: testOwner(),
          key: KEY_HEX,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            origin: "https://agents.suedeai.ai",
            "sec-fetch-site": "same-origin",
          },
          status: 415,
          error: "unsupported media type",
        },
        {
          name: "missing-origin",
          owner: testOwner(),
          key: KEY_HEX,
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          status: 400,
          error: "invalid request",
        },
        {
          name: "cross-origin",
          owner: testOwner(),
          key: KEY_HEX,
          headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          status: 400,
          error: "invalid request",
        },
        {
          name: "unauthenticated",
          owner: null,
          key: KEY_HEX,
          headers: { "content-type": "application/json", origin: "https://agents.suedeai.ai", "sec-fetch-site": "same-origin" },
          status: 401,
          error: "authentication required",
        },
        {
          name: "provider",
          owner: testOwner(),
          key: "invalid-key",
          headers: { "content-type": "application/json", origin: "https://agents.suedeai.ai", "sec-fetch-site": "same-origin" },
          status: 503,
          error: "connection service unavailable",
        },
      ] as const;
      for (const item of cases) {
        const isolatedPath = join(root, `blocked-${item.name}.sqlite`);
        vi.stubEnv("SQLITE_PATH", isolatedPath);
        vi.stubEnv("CONNECTION_ENCRYPTION_KEY", item.key);
        currentOwner = item.owner;
        let bodyReads = 0;
        const request = unreadBodyRequest({
          url: "https://agents.suedeai.ai/api/v2/connections/missing/slots/live",
          headers: item.headers,
          onRead: () => { bodyReads += 1; },
        });
        await expectPrivateJson(
          await route.PUT(request, slotContext("missing", "live")),
          item.status,
          { error: item.error },
        );
        expect(bodyReads, item.name).toBe(0);
        expect(existsSync(isolatedPath), item.name).toBe(false);
      }
      expect(configure).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      configure.mockRestore();
      decrypt.mockRestore();
    }
  });

  it("configures, rotates, and revokes Test and Live slots for every connection kind without readback", async () => {
    const route = await loadSlotRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const variants: readonly {
      kind: ConnectionCreateInput["kind"];
      create: ConnectionCreateInput;
      first: ConnectionSecretInput;
      second: ConnectionSecretInput;
      canaries: readonly string[];
    }[] = [
      {
        kind: "api_key",
        create: { name: "API", kind: "api_key", publicConfig: { headerName: "X-API-Key" } },
        first: { kind: "api_key", apiKey: "api-first-secret" },
        second: { kind: "api_key", apiKey: "api-second-secret" },
        canaries: ["api-first-secret", "api-second-secret"],
      },
      {
        kind: "bearer",
        create: { name: "Bearer", kind: "bearer", publicConfig: {} },
        first: { kind: "bearer", token: "bearer-first-secret" },
        second: { kind: "bearer", token: "bearer-second-secret" },
        canaries: ["bearer-first-secret", "bearer-second-secret"],
      },
      {
        kind: "basic",
        create: { name: "Basic", kind: "basic", publicConfig: {} },
        first: { kind: "basic", username: "basic-first-user", password: "basic-first-password" },
        second: { kind: "basic", username: "basic-second-user", password: "basic-second-password" },
        canaries: ["basic-first-user", "basic-first-password", "basic-second-user", "basic-second-password"],
      },
      {
        kind: "custom_headers",
        create: { name: "Custom", kind: "custom_headers", publicConfig: { headerNames: ["X-One", "X-Two"] } },
        first: { kind: "custom_headers", values: { "X-One": "custom-first-one", "X-Two": "custom-first-two" } },
        second: { kind: "custom_headers", values: { "X-One": "custom-second-one", "X-Two": "custom-second-two" } },
        canaries: ["custom-first-one", "custom-first-two", "custom-second-one", "custom-second-two"],
      },
    ];
    for (const environment of ["test", "live"] as const) {
      for (const variant of variants) {
        const owner = testOwner();
        currentOwner = owner;
        const connection = await createConnection(owner, variant.create);
        const url = `https://agents.suedeai.ai/api/v2/connections/${connection.id}/slots/${environment}`;
        const first = await route.PUT(
          mutationRequest("PUT", url, { expectedLifecycleRevision: 1, secret: variant.first }),
          slotContext(connection.id, environment),
        );
        const firstBody = await expectPrivateJson(first, 201, expect.objectContaining({
          connection: expect.objectContaining({ id: connection.id, lifecycleRevision: 2 }),
        }));
        expect(recursivelyHasForbiddenSecret(firstBody, variant.canaries)).toBe(false);

        const second = await route.PUT(
          mutationRequest("PUT", url, { expectedLifecycleRevision: 2, secret: variant.second }),
          slotContext(connection.id, environment),
        );
        const secondBody = await expectPrivateJson(second, 200, expect.objectContaining({
          connection: expect.objectContaining({ id: connection.id, lifecycleRevision: 3 }),
        }));
        expect(recursivelyHasForbiddenSecret(secondBody, variant.canaries)).toBe(false);
        const parsedSecond = secondBody as { connection: { slots: Record<ConnectionEnvironment, { status: string; secretVersion: number }> } };
        expect(parsedSecond.connection.slots[environment]).toMatchObject({ status: "configured", secretVersion: 2 });

        const revoked = await route.DELETE(
          mutationRequest("DELETE", url, { expectedLifecycleRevision: 3 }),
          slotContext(connection.id, environment),
        );
        const revokedBody = await expectPrivateJson(revoked, 200, expect.objectContaining({
          connection: expect.objectContaining({ id: connection.id, lifecycleRevision: 4 }),
        }));
        expect(recursivelyHasForbiddenSecret(revokedBody, variant.canaries)).toBe(false);
        const parsedRevoked = revokedBody as { connection: { slots: Record<ConnectionEnvironment, { status: string; secretVersion: number }> } };
        expect(parsedRevoked.connection.slots[environment]).toMatchObject({ status: "revoked", secretVersion: 2 });
      }
    }
  });

  it("returns fixed stale and private missing/foreign receipts without decrypting or hard deleting", async () => {
    const route = await loadSlotRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const owner = testOwner();
    const connection = await createConnection(owner, { name: "Bearer", kind: "bearer", publicConfig: {} });
    const url = `https://agents.suedeai.ai/api/v2/connections/${connection.id}/slots/live`;
    currentOwner = owner;
    await expectPrivateJson(
      await route.PUT(
        mutationRequest("PUT", url, {
          expectedLifecycleRevision: 1,
          secret: { kind: "api_key", apiKey: "wrong-kind-secret" },
        }),
        slotContext(connection.id, "live"),
      ),
      400,
      { error: "invalid request" },
    );
    await expectPrivateJson(
      await route.PUT(
        mutationRequest("PUT", url, { expectedLifecycleRevision: 99, secret: { kind: "bearer", token: "stale-secret" } }),
        slotContext(connection.id, "live"),
      ),
      409,
      { error: "conflict" },
    );
    await expectPrivateJson(
      await route.PUT(
        mutationRequest("PUT", url, {
          expectedLifecycleRevision: 1,
          secret: { kind: "bearer", token: "configured-secret" },
        }),
        slotContext(connection.id, "live"),
      ),
      201,
      expect.objectContaining({ connection: expect.objectContaining({ lifecycleRevision: 2 }) }),
    );
    await expectPrivateJson(
      await route.DELETE(
        mutationRequest("DELETE", url, { expectedLifecycleRevision: 1 }),
        slotContext(connection.id, "live"),
      ),
      409,
      { error: "conflict" },
    );
    await expectPrivateJson(
      await route.DELETE(
        mutationRequest("DELETE", url, { expectedLifecycleRevision: 2, extra: true }),
        slotContext(connection.id, "live"),
      ),
      400,
      { error: "invalid request" },
    );
    const decrypt = vi.spyOn(SqliteConnectionRepository.prototype, "resolveHeaders");
    try {
      currentOwner = testOwner();
      const foreign = await route.DELETE(
        mutationRequest("DELETE", url, { expectedLifecycleRevision: 2 }),
        slotContext(connection.id, "live"),
      );
      currentOwner = owner;
      const missing = await route.DELETE(
        mutationRequest("DELETE", url, { expectedLifecycleRevision: 2 }),
        slotContext("missing-connection", "live"),
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.text()).toBe(await missing.text());
      expect(decrypt).not.toHaveBeenCalled();
      const db = openDatabase();
      expect(db.prepare("SELECT COUNT(*) AS count FROM connections WHERE id=?").get(connection.id)).toEqual({ count: 1 });
      db.close();
    } finally {
      decrypt.mockRestore();
    }
  });

  it("opens protection before bounded body parsing and closes every opened repository", async () => {
    const route = await loadSlotRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    currentOwner = testOwner();
    const close = vi.spyOn(SqliteConnectionRepository.prototype, "close");
    const configure = vi.spyOn(SqliteConnectionRepository.prototype, "configureSlot");
    try {
      const request = mutationRequest(
        "PUT",
        "https://agents.suedeai.ai/api/v2/connections/missing/slots/test",
        { expectedLifecycleRevision: 1, secret: { kind: "bearer", token: "x" } },
        { "content-length": "65537" },
      );
      await expectPrivateJson(
        await route.PUT(request, slotContext("missing", "test")),
        413,
        { error: "payload too large" },
      );
      await expectPrivateJson(
        await route.PUT(
          mutationRequest(
            "PUT",
            "https://agents.suedeai.ai/api/v2/connections/missing/slots/draft",
            { expectedLifecycleRevision: 1, secret: { kind: "bearer", token: "path-secret" } },
          ),
          slotContext("missing", "draft"),
        ),
        400,
        { error: "invalid request" },
      );
      expect(configure).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
      configure.mockRestore();
    }
  });

  it("returns bounded usage and resumes SQLite-generated non-UUID cursors", async () => {
    const route = await loadUsageRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const owner = testOwner();
    currentOwner = owner;
    const connection = await createConnection(owner, { name: "Bearer", kind: "bearer", publicConfig: {} });
    const db = openDatabase();
    const repository = new SqliteConnectionRepository(db, KEY);
    const configured = await repository.configureSlot(
      owner,
      connection.id,
      "live",
      1,
      { kind: "bearer", token: "usage-secret-canary" },
      Date.now() + 1,
    );
    expect(configured.status).toBe("updated");
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("usage-draft-a", owner, "Draft A", graph(connection.id), 50);
    db.prepare("INSERT INTO flows VALUES (?,?,?,?,?)").run("usage-draft-b", owner, "Draft B", graph(connection.id), 40);
    db.exec(`
      INSERT INTO organizations VALUES ('usage-org','${owner}','Org','personal',1);
      INSERT INTO workspaces VALUES ('usage-workspace','usage-org','Workspace','workspace',1);
      INSERT INTO projects VALUES ('usage-project','usage-workspace','Project','project',1,1);
      INSERT INTO workbooks VALUES ('usage-workbook','usage-project','Workbook','workbook',0,1);
      INSERT INTO environments VALUES ('usage-live-env','usage-project','Live','live','live',1);
    `);
    db.prepare("INSERT INTO flow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("usage-version", "usage-draft-a", 1, 2, null, null, graph(connection.id), "semantic", "full", owner, 45);
    db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?)")
      .run("usage-deployment", "usage-draft-a", "usage-version", "usage-live-env", "live", 45, null);
    db.close();
    const decrypt = vi.spyOn(SqliteConnectionRepository.prototype, "resolveHeaders");
    try {
      const complete = await route.GET(
        new Request(`https://agents.suedeai.ai/api/v2/connections/${connection.id}/usage?limit=100`),
        usageContext(connection.id),
      );
      expect(complete.status).toBe(200);
      expect(complete.headers.get("cache-control")).toBe("private, no-store");
      const body = await complete.json() as {
        usage: readonly { artifactKind: string; flowId: string; flowName: string }[];
        nextCursor: string | null;
        matchedLowerBound: number;
        truncated: boolean;
        lifecycleRevision: number;
      };
      expect(Object.keys(body).sort()).toEqual(["lifecycleRevision", "matchedLowerBound", "nextCursor", "truncated", "usage"]);
      expect(body).toMatchObject({ matchedLowerBound: 3, truncated: false, lifecycleRevision: 2, nextCursor: null });
      expect(body.usage).toEqual(expect.arrayContaining([
        expect.objectContaining({ artifactKind: "draft", flowId: "usage-draft-a", flowName: "Draft A" }),
        expect.objectContaining({ artifactKind: "draft", flowId: "usage-draft-b", flowName: "Draft B" }),
        expect.objectContaining({
          artifactKind: "active_deployment",
          flowId: "usage-draft-a",
          flowVersionId: "usage-version",
          environment: "live",
        }),
      ]));
      expect(recursivelyHasForbiddenSecret(body, [KEY_HEX, "usage-secret-canary"])).toBe(false);
      expect(decrypt).not.toHaveBeenCalled();

      const paged: string[] = [];
      let cursor: string | null = null;
      let observedNonUuidCursor = false;
      do {
        const suffix = cursor === null ? "" : `&cursor=${cursor}`;
        const response = await route.GET(
          new Request(`https://agents.suedeai.ai/api/v2/connections/${connection.id}/usage?limit=1${suffix}`),
          usageContext(connection.id),
        );
        expect(response.status).toBe(200);
        const page = await response.json() as { usage: readonly { artifactKind: string; flowId: string }[]; nextCursor: string | null };
        expect(page.usage).toHaveLength(1);
        paged.push(`${page.usage[0]?.artifactKind}:${page.usage[0]?.flowId}`);
        if (page.nextCursor !== null) {
          const decoded = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8")) as { flowId?: unknown };
          expect(decoded.flowId).toMatch(/^usage-draft-/u);
          observedNonUuidCursor = true;
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(observedNonUuidCursor).toBe(true);
      expect(paged).toEqual([
        "draft:usage-draft-a",
        "draft:usage-draft-b",
        "active_deployment:usage-draft-a",
      ]);

      const listCursor = Buffer.from(JSON.stringify({ updatedAt: 1, id: "connection" }), "utf8").toString("base64url");
      await expectPrivateJson(
        await route.GET(
          new Request(`https://agents.suedeai.ai/api/v2/connections/${connection.id}/usage?cursor=${listCursor}`),
          usageContext(connection.id),
        ),
        400,
        { error: "invalid request" },
      );
    } finally {
      decrypt.mockRestore();
    }
  });

  it("maps only the hosted invalid-page signal to a usage 400", async () => {
    const route = await loadUsageRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const owner = testOwner();
    currentOwner = owner;
    const connection = await createConnection(owner, { name: "Bearer", kind: "bearer", publicConfig: {} });
    const usage = vi.spyOn(SqliteConnectionRepository.prototype, "usage");
    try {
      usage.mockRejectedValueOnce(new InvalidConnectionPageError());
      await expectPrivateJson(
        await route.GET(
          new Request(`https://agents.suedeai.ai/api/v2/connections/${connection.id}/usage`),
          usageContext(connection.id),
        ),
        400,
        { error: "invalid request" },
      );

      usage.mockRejectedValueOnce(new TypeError("Invalid connection page"));
      await expectPrivateJson(
        await route.GET(
          new Request(`https://agents.suedeai.ai/api/v2/connections/${connection.id}/usage`),
          usageContext(connection.id),
        ),
        503,
        { error: "connection service unavailable" },
      );
    } finally {
      usage.mockRestore();
    }
  });

  it("keeps usage foreign/missing responses identical and rejects auth/provider failures without repository calls", async () => {
    const route = await loadUsageRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const owner = testOwner();
    const connection = await createConnection(owner, { name: "Bearer", kind: "bearer", publicConfig: {} });
    const usage = vi.spyOn(SqliteConnectionRepository.prototype, "usage");
    try {
      currentOwner = testOwner();
      const foreign = await route.GET(
        new Request(`https://agents.suedeai.ai/api/v2/connections/${connection.id}/usage`),
        usageContext(connection.id),
      );
      currentOwner = owner;
      const missing = await route.GET(
        new Request("https://agents.suedeai.ai/api/v2/connections/missing/usage"),
        usageContext("missing"),
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.text()).toBe(await missing.text());
      usage.mockClear();

      currentOwner = null;
      await expectPrivateJson(
        await route.GET(new Request("https://agents.suedeai.ai/api/v2/connections/missing/usage"), usageContext("missing")),
        401,
        { error: "authentication required" },
      );
      vi.stubEnv("CONNECTION_ENCRYPTION_KEY", "invalid");
      currentOwner = owner;
      await expectPrivateJson(
        await route.GET(new Request("https://agents.suedeai.ai/api/v2/connections/missing/usage"), usageContext("missing")),
        503,
        { error: "connection service unavailable" },
      );
      expect(usage).not.toHaveBeenCalled();
    } finally {
      usage.mockRestore();
    }
  });
});
