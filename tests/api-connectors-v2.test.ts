import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CloseableConnectorRepository } from "@/lib/connectors/repository";
import { connectorProjectionHash, operationProjectionHash, schemaHash } from "@/lib/connectors/schema";
import { parseConnectorDefinitionVersionV1, parseOperationVersionV1 } from "@/lib/connectors/schema";

const ID_CONNECTOR = "00000000-0000-4000-8000-000000000001";
const ID_DEFINITION = "00000000-0000-4000-8000-000000000002";
const ID_OPERATION = "00000000-0000-4000-8000-000000000003";
const ID_OPERATION_2 = "00000000-0000-4000-8000-000000000004";

const control = vi.hoisted(() => ({
  enabled: true,
  ownerId: "owner-a" as string | null,
  order: [] as string[],
  repository: null as CloseableConnectorRepository | null,
  reviewResult: null as unknown,
  operationResult: null as unknown,
}));

vi.mock("@/lib/connectors/flags", () => ({
  get CONNECTOR_LAB_ENABLED() { return control.enabled; },
}));
vi.mock("@/lib/auth", () => ({
  resolveReadOnlyOwnerId: async () => { control.order.push("owner"); return control.ownerId; },
}));
vi.mock("@/lib/connectors/provider", () => ({
  getConnectorRepository: async () => {
    control.order.push("provider");
    if (!control.repository) throw new Error("provider-canary");
    return control.repository;
  },
}));
vi.mock("@/lib/connectors/import-service", () => ({
  ConnectorImportService: class {
    reviewOpenApi(_input: unknown) { control.order.push("review"); return control.reviewResult ?? { ok: false, code: "PERSISTENCE_REFUSED" }; }
    addStoredOperation(_input: unknown) { control.order.push("add"); return control.operationResult ?? { ok: false, code: "PERSISTENCE_REFUSED" }; }
  },
}));

const MUTATION_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  origin: "https://studio.test",
  "sec-fetch-site": "same-origin",
};

class BodyObservedRequest extends Request {
  bodyReads = 0;
  jsonReads = 0;
  override get body(): Request["body"] { this.bodyReads += 1; return super.body; }
  override json(): Promise<unknown> { this.jsonReads += 1; throw new Error("request.json forbidden"); }
}

function mutation(path: string, body: unknown): BodyObservedRequest {
  return new BodyObservedRequest(`https://studio.test${path}`, {
    method: "POST",
    headers: MUTATION_HEADERS,
    body: JSON.stringify(body),
  });
}

function identity(id = ID_CONNECTOR, displayLabel = "Vendor API") {
  return { id, displayLabel, archivedAt: null, lifecycleRevision: 1, createdAt: 1, updatedAt: 2 };
}

function closure(operationVersionId = ID_OPERATION) {
  const emptyObject = { type: "object" as const, properties: {}, required: [], additionalProperties: false as const };
  const requestSchema = {
    type: "object" as const,
    properties: { path: emptyObject, query: emptyObject, headers: emptyObject },
    required: ["path", "query", "headers"],
    additionalProperties: false as const,
  };
  const resultSchema = {
    type: "object" as const,
    properties: { status: { type: "integer" as const, minimum: 200, maximum: 200 }, body: emptyObject },
    required: ["status", "body"],
    additionalProperties: false as const,
  };
  const projection = {
    projectionVersion: 1 as const,
    operationId: `operation-${operationVersionId.slice(-6)}`,
    method: "GET" as const,
    path: "/things",
    authentication: { kind: "none" as const },
    requestSchema,
    resultSchema,
    redaction: { requestValues: "omit" as const, responseValues: "omit" as const, credentialValues: "redact" as const },
    testBehavior: { mode: "schema_sentinel" as const, egress: "forbidden" as const, credentials: "forbidden" as const },
    limitsProfile: "connector-import-v1" as const,
    executionAvailability: "simulation_only" as const,
    systemPolicy: { effects: ["write"] as ["write"], retry: "unsafe" as const, cost: "unknown" as const, idempotency: "none" as const },
  };
  const operationHash = operationProjectionHash(projection);
  const schemaDigest = schemaHash(requestSchema, resultSchema);
  const connectorProjection = {
    projectionVersion: 1 as const, origin: "https://api.vendor.com",
    operations: [{ operationId: projection.operationId, method: "GET" as const, path: "/things", authentication: { kind: "none" as const }, operationProjection: projection, operationProjectionHash: operationHash }],
  };
  return {
    identity: identity(),
    definition: {
      contractVersion: 1 as const, id: ID_DEFINITION, connectorId: ID_CONNECTOR, versionNumber: 1,
      projection: connectorProjection,
      connectorProjectionHash: connectorProjectionHash(connectorProjection), executionAvailability: "simulation_only" as const,
    },
    operation: {
      contractVersion: 1 as const, id: operationVersionId, connectorDefinitionVersionId: ID_DEFINITION,
      operationId: projection.operationId, projection, operationProjectionHash: operationHash,
      schemaHash: schemaDigest, executionAvailability: "simulation_only" as const,
    },
  };
}

function repository(overrides: Partial<CloseableConnectorRepository> = {}): CloseableConnectorRepository {
  return {
    immediate: vi.fn(),
    getConnectorIdentity: vi.fn(() => identity()),
    listConnectorIdentities: vi.fn(() => ({ items: [identity()], nextCursor: null })),
    getDefinitionVersion: vi.fn(),
    getOperationVersion: vi.fn(),
    getOperationClosure: vi.fn(),
    listOperationVersions: vi.fn(() => ({ items: [], nextCursor: null })),
    listDefinitionHistoryPage: vi.fn(() => ({ items: [], nextBeforeVersionNumber: null })),
    listDefinitionHistory: vi.fn(() => []),
    rename: vi.fn(() => ({ status: "updated", identity: identity(ID_CONNECTOR, "Renamed") })),
    archive: vi.fn(() => ({ status: "updated", identity: { ...identity(), archivedAt: 3, lifecycleRevision: 2, updatedAt: 3 } })),
    close: vi.fn(() => { control.order.push("close"); }),
    dispose: vi.fn(),
    ...overrides,
  } as CloseableConnectorRepository;
}

function context(connectorId: unknown = ID_CONNECTOR) {
  return { params: Promise.resolve({ connectorId }) } as { params: Promise<{ connectorId: string }> };
}

async function expectPrivate(response: Response, status: number, body: object): Promise<void> {
  const text = await response.text();
  expect({ status: response.status, text }).toEqual({ status, text: JSON.stringify(body) });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  control.enabled = true;
  control.ownerId = "owner-a";
  control.order.length = 0;
  control.repository = repository();
  control.reviewResult = null;
  control.operationResult = null;
});

describe("private v2 connector lab routes", () => {
  it("keeps Connector Lab absent from public and template surfaces in the default-off slice", () => {
    const templates = readFileSync(new URL("../src/lib/templates.ts", import.meta.url), "utf8");
    const publicPage = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
    expect(`${templates}\n${publicPage}`).not.toMatch(/Connector Lab|api\.operation|\/api\/v2\/connectors/u);
  });

  it("exports Node dynamic collection, item, OpenAPI, and operation handlers", async () => {
    const [collection, item, openapi, operations, resolve] = await Promise.all([
      import("@/app/api/v2/connectors/route"),
      import("@/app/api/v2/connectors/[connectorId]/route"),
      import("@/app/api/v2/connectors/openapi/route"),
      import("@/app/api/v2/connectors/[connectorId]/operations/route"),
      import("@/app/api/v2/connectors/operations/resolve/route"),
    ]);
    for (const route of [collection, item, openapi, operations, resolve]) {
      expect(route).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
    }
    expect(collection.GET).toBeTypeOf("function");
    expect(item.GET).toBeTypeOf("function");
    expect(item.PATCH).toBeTypeOf("function");
    expect(openapi.POST).toBeTypeOf("function");
    expect(operations.GET).toBeTypeOf("function");
    expect(operations.POST).toBeTypeOf("function");
    expect(resolve.POST).toBeTypeOf("function");
  });

  it("returns flag-off private 404 before auth, body access, or connector storage", async () => {
    const route = await import("@/app/api/v2/connectors/openapi/route");
    control.enabled = false;
    const request = mutation("/api/v2/connectors/openapi", { source: "source-canary", displayLabel: "Vendor" });
    await expectPrivate(await route.POST(request), 404, { error: "not found" });
    expect(request.bodyReads).toBe(0);
    expect(control.order).toEqual([]);
  });

  it("rejects browser shape and auth failures before body parsing or storage", async () => {
    const route = await import("@/app/api/v2/connectors/openapi/route");
    const crossOrigin = mutation("/api/v2/connectors/openapi", { source: "{}", displayLabel: "Vendor" });
    crossOrigin.headers.set("origin", "https://evil.test");
    await expectPrivate(await route.POST(crossOrigin), 400, { error: "invalid request" });
    expect(crossOrigin.bodyReads).toBe(0);
    expect(control.order).toEqual([]);

    const authorization = mutation("/api/v2/connectors/openapi", { source: "{}", displayLabel: "Vendor" });
    authorization.headers.set("authorization", "Bearer request-canary");
    await expectPrivate(await route.POST(authorization), 400, { error: "invalid request" });
    expect(authorization.bodyReads).toBe(0);
    expect(control.order).toEqual([]);

    control.ownerId = null;
    const unauthenticated = mutation("/api/v2/connectors/openapi", { source: "{}", displayLabel: "Vendor" });
    await expectPrivate(await route.POST(unauthenticated), 401, { error: "authentication required" });
    expect(unauthenticated.bodyReads).toBe(0);
    expect(control.order).toEqual(["owner"]);
  });

  it("opens owner storage before one bounded body read and closes on invalid JSON", async () => {
    const route = await import("@/app/api/v2/connectors/openapi/route");
    const request = new BodyObservedRequest("https://studio.test/api/v2/connectors/openapi", {
      method: "POST", headers: MUTATION_HEADERS, body: "not-json",
    });
    await expectPrivate(await route.POST(request), 400, { error: "invalid request" });
    expect(request.bodyReads).toBe(1);
    expect(control.order).toEqual(["owner", "provider", "close"]);
  });

  it("lists owner-scoped search pages and emits canonical cursors", async () => {
    const route = await import("@/app/api/v2/connectors/route");
    const cursor = Buffer.from(JSON.stringify({ updatedAt: 2, id: ID_CONNECTOR })).toString("base64url");
    vi.mocked(control.repository!.listConnectorIdentities).mockImplementation((ownerId, options) => {
      expect(ownerId).toBe("owner-a");
      expect(options).toEqual({ limit: 2, search: "Vendor", includeArchived: true });
      return { items: [identity()], nextCursor: { updatedAt: 2, id: ID_CONNECTOR } };
    });
    const response = await route.GET(new Request("https://studio.test/api/v2/connectors?limit=2&search=Vendor&includeArchived=true"));
    await expectPrivate(response, 200, { connectors: [identity()], nextCursor: cursor });
    expect(control.order).toEqual(["owner", "provider", "close"]);
  });

  it("returns bounded definition history with only the sanitized operation index", async () => {
    const route = await import("@/app/api/v2/connectors/[connectorId]/route");
    const definition = closure().definition;
    vi.mocked(control.repository!.listDefinitionHistoryPage).mockReturnValue({
      items: [definition], nextBeforeVersionNumber: null,
    });
    const response = await route.GET(new Request(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}?limit=1`), context());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/authentication|requestSchema|resultSchema|headers|body|redaction/u);
    expect(JSON.parse(text)).toMatchObject({
      history: [{
        id: ID_DEFINITION,
        operationCount: 1,
        operations: [{ operationId: definition.projection.operations[0]!.operationId, method: "GET", path: "/things" }],
      }],
    });
  });

  it("reviews OpenAPI request-only source and never echoes raw or rejected details", async () => {
    const route = await import("@/app/api/v2/connectors/openapi/route");
    const source = "source-canary";
    control.reviewResult = {
      ok: true,
      correlationId: ID_CONNECTOR,
      identity: identity(),
      definition: { id: ID_DEFINITION, connectorId: ID_CONNECTOR, versionNumber: 1, connectorProjectionHash: "a".repeat(64) },
      identityDisposition: "created",
      definitionDisposition: "created",
      drift: null,
      connectorProjectionHash: "a".repeat(64),
      operations: [{ operationId: "listThings", method: "GET", path: "/things", operationProjectionHash: "b".repeat(64), schemaHash: "c".repeat(64) }],
      refusedOperations: [{ operationId: "rejected-canary", method: "POST", path: "/secret-canary", code: "UNSUPPORTED" }],
    };
    const response = await route.POST(mutation("/api/v2/connectors/openapi", { source, displayLabel: "Vendor API" }));
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(source);
    expect(text).not.toContain("rejected-canary");
    expect(text).not.toContain("secret-canary");
    expect(JSON.parse(text)).toMatchObject({ review: { refusedOperationCount: 1, operations: [{ operationId: "listThings" }] } });
    expect(control.order).toEqual(["owner", "provider", "review", "close"]);
  });

  it("returns strict server-correlated receipts for audited import refusals only", async () => {
    const openApiRoute = await import("@/app/api/v2/connectors/openapi/route");
    const operationRoute = await import("@/app/api/v2/connectors/[connectorId]/operations/route");

    control.reviewResult = {
      ok: false, code: "OPENAPI_INVALID", correlationId: ID_OPERATION,
      source: "must-not-echo", rejectedValue: "must-not-echo",
    };
    const review = await openApiRoute.POST(mutation("/api/v2/connectors/openapi", {
      source: "openapi: 3.1.0", displayLabel: "Vendor API",
    }));
    await expectPrivate(review, 422, { error: "import refused", correlationId: ID_OPERATION });

    vi.mocked(control.repository!.getDefinitionVersion).mockReturnValue({
      id: ID_DEFINITION, connectorId: ID_CONNECTOR, connectorProjectionHash: "a".repeat(64),
    } as never);
    control.operationResult = {
      ok: false, code: "CONNECTOR_ANNOTATION_CONFLICT", correlationId: ID_OPERATION_2,
      headers: "must-not-echo", rejectedValue: "must-not-echo",
    };
    const add = await operationRoute.POST(mutation(`/api/v2/connectors/${ID_CONNECTOR}/operations`, {
      connectorDefinitionVersionId: ID_DEFINITION, operationId: "listThings",
    }), context());
    await expectPrivate(add, 409, { error: "conflict", correlationId: ID_OPERATION_2 });

    control.reviewResult = { ok: false, code: "AUDIT_UNAVAILABLE", correlationId: ID_CONNECTOR };
    await expectPrivate(await openApiRoute.POST(mutation("/api/v2/connectors/openapi", {
      source: "openapi: 3.1.0", displayLabel: "Vendor API",
    })), 503, { error: "connector service unavailable" });
  });

  it("separately bounds escaped JSON transport and decoded source without request.json", async () => {
    const route = await import("@/app/api/v2/connectors/openapi/route");
    control.reviewResult = { ok: false, code: "PERSISTENCE_REFUSED", correlationId: ID_OPERATION };
    const exactSource = "\u0001".repeat(2 * 1024 * 1024);
    const exact = mutation("/api/v2/connectors/openapi", { source: exactSource, displayLabel: "Vendor API" });
    await expectPrivate(await route.POST(exact), 503, { error: "connector service unavailable", correlationId: ID_OPERATION });
    expect(exact.bodyReads).toBe(1);
    expect(exact.jsonReads).toBe(0);

    control.order.length = 0;
    const overSource = "a".repeat((2 * 1024 * 1024) + 1);
    const over = mutation("/api/v2/connectors/openapi", { source: overSource, displayLabel: "Vendor API" });
    await expectPrivate(await route.POST(over), 400, { error: "invalid request" });
    expect(over.bodyReads).toBe(1);
    expect(over.jsonReads).toBe(0);
    expect(control.order).toEqual(["owner", "provider", "close"]);
  });

  it("gets bounded metadata history, renames, archives, and adds an operation owner-first", async () => {
    const itemRoute = await import("@/app/api/v2/connectors/[connectorId]/route");
    const operationRoute = await import("@/app/api/v2/connectors/[connectorId]/operations/route");
    const getResponse = await itemRoute.GET(new Request(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}?limit=10`), context());
    await expectPrivate(getResponse, 200, { connector: identity(), history: [], nextCursor: null });

    const renameRequest = new BodyObservedRequest(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}`, {
      method: "PATCH", headers: MUTATION_HEADERS,
      body: JSON.stringify({ action: "rename", displayLabel: "Renamed", expectedLifecycleRevision: 1 }),
    });
    await expectPrivate(await itemRoute.PATCH(renameRequest, context()), 200, { connector: identity(ID_CONNECTOR, "Renamed") });
    expect(control.repository!.rename).toHaveBeenCalledWith("owner-a", ID_CONNECTOR, 1, "Renamed", expect.any(Number));

    const archiveRequest = new BodyObservedRequest(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}`, {
      method: "PATCH", headers: MUTATION_HEADERS,
      body: JSON.stringify({ action: "archive", expectedLifecycleRevision: 2 }),
    });
    expect((await itemRoute.PATCH(archiveRequest, context())).status).toBe(200);
    expect(control.repository!.archive).toHaveBeenCalledWith("owner-a", ID_CONNECTOR, 2, expect.any(Number));

    control.operationResult = {
      ok: true, correlationId: ID_CONNECTOR, disposition: "created",
      operation: {
        id: ID_OPERATION,
        connectorDefinitionVersionId: ID_DEFINITION,
        operationId: "listThings",
        operationProjectionHash: "b".repeat(64), schemaHash: "c".repeat(64),
        executionAvailability: "simulation_only",
        projection: { headers: "must-not-echo" },
      },
    };
    vi.mocked(control.repository!.getDefinitionVersion).mockReturnValue({
      id: ID_DEFINITION,
      connectorId: ID_CONNECTOR,
      connectorProjectionHash: "a".repeat(64),
    } as never);
    const add = await operationRoute.POST(mutation(`/api/v2/connectors/${ID_CONNECTOR}/operations`, {
      connectorDefinitionVersionId: ID_DEFINITION,
      operationId: "listThings",
    }), context());
    expect(add.status).toBe(201);
    const text = await add.text();
    expect(text).not.toContain("headers");
    expect(JSON.parse(text)).toMatchObject({ operation: { id: ID_OPERATION, operationId: "listThings" } });
  });

  it("lists materialized operation versions with a canonical owner-scoped cursor", async () => {
    const route = await import("@/app/api/v2/connectors/[connectorId]/operations/route");
    const materialized = closure().operation;
    const nextCursor = Buffer.from(JSON.stringify({ createdAt: 2, id: ID_OPERATION })).toString("base64url");
    vi.mocked(control.repository!.listOperationVersions).mockImplementation((ownerId, connectorId, page) => {
      expect({ ownerId, connectorId, page }).toEqual({
        ownerId: "owner-a",
        connectorId: ID_CONNECTOR,
        page: { limit: 1 },
      });
      return {
        items: [{
          operationVersionId: materialized.id,
          connectorDefinitionVersionId: materialized.connectorDefinitionVersionId,
          definitionVersionNumber: 1,
          operationId: materialized.operationId,
          connectorProjectionHash: closure().definition.connectorProjectionHash,
          operationProjectionHash: materialized.operationProjectionHash,
          schemaHash: materialized.schemaHash,
          executionAvailability: "simulation_only",
        }],
        nextCursor: { createdAt: 2, id: ID_OPERATION },
      };
    });
    const response = await route.GET(
      new Request(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}/operations?limit=1`),
      context(),
    );
    await expectPrivate(response, 200, {
      operations: [{
        operationVersionId: ID_OPERATION,
        connectorDefinitionVersionId: ID_DEFINITION,
        definitionVersionNumber: 1,
        operationId: materialized.operationId,
        connectorProjectionHash: closure().definition.connectorProjectionHash,
        operationProjectionHash: materialized.operationProjectionHash,
        schemaHash: materialized.schemaHash,
        executionAvailability: "simulation_only",
      }],
      nextCursor,
    });
    expect(control.order).toEqual(["owner", "provider", "close"]);
  });

  it("keeps operation listing flag-first, owner-first, bounded, and private for missing assets", async () => {
    const route = await import("@/app/api/v2/connectors/[connectorId]/operations/route");
    control.enabled = false;
    await expectPrivate(await route.GET(
      new Request(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}/operations?limit=1`),
      context(),
    ), 404, { error: "not found" });
    expect(control.order).toEqual([]);

    control.enabled = true;
    vi.mocked(control.repository!.getConnectorIdentity).mockReturnValue(null);
    await expectPrivate(await route.GET(
      new Request(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}/operations?limit=1`),
      context(),
    ), 404, { error: "not found" });
    expect(control.repository!.listOperationVersions).not.toHaveBeenCalled();

    vi.mocked(control.repository!.getConnectorIdentity).mockReturnValue(identity());
    for (const query of ["limit=0", "limit=1&limit=2", "unknown=1", "cursor=not-canonical"]) {
      await expectPrivate(await route.GET(
        new Request(`https://studio.test/api/v2/connectors/${ID_CONNECTOR}/operations?${query}`),
        context(),
      ), 400, { error: "invalid request" });
    }
  });

  it("resolves exact owner-scoped operation closures in request order", async () => {
    const route = await import("@/app/api/v2/connectors/operations/resolve/route");
    expect(() => parseConnectorDefinitionVersionV1(closure().definition)).not.toThrow();
    expect(() => parseOperationVersionV1(closure().operation)).not.toThrow();
    vi.mocked(control.repository!.getOperationClosure).mockImplementation((ownerId, operationVersionId) => {
      expect(ownerId).toBe("owner-a");
      return closure(operationVersionId);
    });
    const response = await route.POST(mutation("/api/v2/connectors/operations/resolve", {
      operationVersionIds: [ID_OPERATION_2, ID_OPERATION],
    }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { closures: Array<Record<string, unknown>> };
    expect(payload.closures.map((item) => (item.reference as { operationVersionId: string }).operationVersionId)).toEqual([ID_OPERATION_2, ID_OPERATION]);
    expect(payload.closures[0]).toMatchObject({
      reference: {
        operationVersionId: ID_OPERATION_2,
        connectorProjectionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        operationProjectionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      connectorDisplayLabel: "Vendor API",
      lifecycleRevision: 1, archivedAt: null, systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/rawSource|example|ciphertext|"requestValues":"omit"/u);
  });

  it("makes missing and foreign closure reads identical and refuses duplicate, drifted, and oversized requests", async () => {
    const route = await import("@/app/api/v2/connectors/operations/resolve/route");
    control.enabled = false;
    const flagged = mutation("/api/v2/connectors/operations/resolve", { operationVersionIds: [ID_OPERATION] });
    await expectPrivate(await route.POST(flagged), 404, { error: "not found" });
    expect(flagged.bodyReads).toBe(0);
    expect(control.order).toEqual([]);
    control.enabled = true;

    vi.mocked(control.repository!.getOperationClosure).mockReturnValue(null);
    const missing = await route.POST(mutation("/api/v2/connectors/operations/resolve", { operationVersionIds: [ID_OPERATION] }));
    const missingReceipt = { status: missing.status, body: await missing.text() };
    const foreign = await route.POST(mutation("/api/v2/connectors/operations/resolve", { operationVersionIds: [ID_OPERATION] }));
    expect({ status: foreign.status, body: await foreign.text() }).toEqual(missingReceipt);
    expect(missingReceipt).toEqual({ status: 404, body: JSON.stringify({ error: "not found" }) });

    vi.mocked(control.repository!.getOperationClosure).mockImplementation((_ownerId, operationVersionId) =>
      operationVersionId === ID_OPERATION ? closure(operationVersionId) : null);
    const partial = await route.POST(mutation("/api/v2/connectors/operations/resolve", { operationVersionIds: [ID_OPERATION, ID_OPERATION_2] }));
    await expectPrivate(partial, 404, { error: "not found" });

    vi.mocked(control.repository!.getOperationClosure).mockClear();
    const duplicate = await route.POST(mutation("/api/v2/connectors/operations/resolve", { operationVersionIds: [ID_OPERATION, ID_OPERATION] }));
    await expectPrivate(duplicate, 400, { error: "invalid request" });
    expect(control.repository!.getOperationClosure).not.toHaveBeenCalled();

    vi.mocked(control.repository!.getOperationClosure).mockReturnValue({
      ...closure(), definition: { ...closure().definition, projection: { ...closure().definition.projection, operations: [{ ...closure().definition.projection.operations[0]!, operationProjectionHash: "d".repeat(64) }] } },
    });
    await expectPrivate(await route.POST(mutation("/api/v2/connectors/operations/resolve", { operationVersionIds: [ID_OPERATION] })), 503, { error: "connector service unavailable" });

    const oversized = mutation("/api/v2/connectors/operations/resolve", { operationVersionIds: [ID_OPERATION] });
    oversized.headers.set("content-length", "65537");
    await expectPrivate(await route.POST(oversized), 413, { error: "payload too large" });
  });
});
