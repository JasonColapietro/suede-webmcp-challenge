import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorClientError,
  connectorChoices,
  createConnectorClient,
  parseClientConnectorListEnvelope,
  parseClientConnectorOperationsEnvelope,
  parseClientOperationClosuresEnvelope,
  readBoundedConnectorJson,
} from "@/lib/connectors/client";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "00000000-0000-4000-8000-000000000002";

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function identity(id: string, displayLabel = "Shared API") {
  return { id, displayLabel, archivedAt: null, lifecycleRevision: 1, createdAt: 1, updatedAt: 2 };
}

function browserClosure(
  authentication: Readonly<Record<string, unknown>> = { kind: "none" },
  readinessBinding?: Readonly<Record<string, unknown>>,
) {
  const empty = { type: "object", properties: {}, required: [], additionalProperties: false };
  return {
    reference: {
      connectorDefinitionVersionId: ID_A,
      operationVersionId: ID_B,
      operationId: "listThings",
      connectorProjectionHash: "a".repeat(64),
      operationProjectionHash: "b".repeat(64),
      schemaHash: "c".repeat(64),
      ...(readinessBinding === undefined ? {} : { readinessBinding }),
    },
    connectorId: ID_A,
    connectorDisplayLabel: "Vendor API",
    lifecycleRevision: 1,
    archivedAt: null,
    definitionVersionNumber: 1,
    method: "GET",
    path: "/things",
    authentication,
    requestSchema: {
      type: "object", properties: { path: empty, query: empty, headers: empty },
      required: ["path", "query", "headers"], additionalProperties: false,
    },
    resultSchema: {
      type: "object", properties: { status: { type: "integer", minimum: 200, maximum: 200 }, body: empty },
      required: ["status", "body"], additionalProperties: false,
    },
    systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
    authorAnnotation: null,
    executionAvailability: "simulation_only",
  };
}

function browserPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("strict connector browser metadata client", () => {
  it("accepts the exact Task 6 closure DTO and discriminated readiness bindings only", () => {
    const connection = browserClosure(
      { kind: "http_bearer" },
      { kind: "connection", connectionId: "connection-opaque", capability: "http.headers" },
    );
    const unresolved = browserClosure(
      { kind: "http_bearer" },
      { kind: "unresolved", requirementKey: "requirement-opaque", capability: "http.headers" },
    );
    for (const fixture of [connection, unresolved]) {
      const plain = JSON.parse(JSON.stringify(fixture)) as unknown;
      const parsed = parseClientOperationClosuresEnvelope({ closures: [plain] });
      expect(parsed).not.toBeNull();
      expect(Object.keys(parsed!.closures[0]!).sort()).toEqual([
        "archivedAt", "authentication", "authorAnnotation", "connectorDisplayLabel", "connectorId", "definitionVersionNumber",
        "executionAvailability", "lifecycleRevision", "method", "path", "reference", "requestSchema",
        "resultSchema", "systemPolicy",
      ]);
      expect(parsed!.closures[0]!.method).toBe("GET");
      expect(parsed!.closures[0]!.path).toBe("/things");
    }

    for (const invalid of [
      browserClosure({ kind: "http_bearer" }, { connectionId: "connection-opaque", capability: "http.headers" }),
      browserClosure({ kind: "http_bearer" }, { kind: "other", connectionId: "connection-opaque", capability: "http.headers" }),
      browserClosure({ kind: "none" }, { kind: "unresolved", requirementKey: "requirement-opaque", capability: "http.headers" }),
    ]) {
      const plain = JSON.parse(JSON.stringify(invalid)) as unknown;
      expect(parseClientOperationClosuresEnvelope({ closures: [plain] })).toBeNull();
    }
  });

  it("parses exact secret-free lists and disambiguates duplicate labels with short IDs", () => {
    const envelope = parseClientConnectorListEnvelope({
      connectors: [identity(ID_A), identity(ID_B)],
      nextCursor: null,
    });
    expect(envelope).not.toBeNull();
    expect(connectorChoices(envelope!)).toEqual([
      { id: ID_A, label: "Shared API · …000001", archived: false, lifecycleRevision: 1 },
      { id: ID_B, label: "Shared API · …000002", archived: false, lifecycleRevision: 1 },
    ]);
    expect(Object.isFrozen(connectorChoices(envelope!)[0])).toBe(true);
  });

  it("parses exact bounded materialized-operation pages", () => {
    const operation = {
      operationVersionId: ID_B,
      connectorDefinitionVersionId: ID_A,
      definitionVersionNumber: 1,
      operationId: "listThings",
      connectorProjectionHash: "a".repeat(64),
      operationProjectionHash: "b".repeat(64),
      schemaHash: "c".repeat(64),
      executionAvailability: "simulation_only",
      authorAnnotation: { label: "Unverified", effectNote: "Writes records" },
    };
    expect(parseClientConnectorOperationsEnvelope({ operations: [operation], nextCursor: null }))
      .toEqual({ operations: [operation], nextCursor: null });
    expect(parseClientConnectorOperationsEnvelope({ operations: [{ ...operation, source: "canary" }], nextCursor: null }))
      .toBeNull();
    expect(parseClientConnectorOperationsEnvelope({ operations: Array(1), nextCursor: null })).toBeNull();
    expect(parseClientConnectorOperationsEnvelope({ operations: Array.from({ length: 101 }, () => operation), nextCursor: null })).toBeNull();
    const symbol = { operations: [operation], nextCursor: null, [Symbol("hostile")]: true };
    expect(parseClientConnectorOperationsEnvelope(symbol)).toBeNull();
    let invoked = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "operations", {
      enumerable: true,
      get() { invoked = true; return [operation]; },
    });
    Object.defineProperty(accessor, "nextCursor", { enumerable: true, value: null });
    expect(parseClientConnectorOperationsEnvelope(accessor)).toBeNull();
    expect(invoked).toBe(false);
  });

  it("uses stable short-ID labels even when duplicates are split across pages or searches", () => {
    const firstPage = parseClientConnectorListEnvelope({ connectors: [identity(ID_A)], nextCursor: null });
    const secondPage = parseClientConnectorListEnvelope({ connectors: [identity(ID_B)], nextCursor: null });
    expect(connectorChoices(firstPage!)).toEqual([
      { id: ID_A, label: "Shared API · …000001", archived: false, lifecycleRevision: 1 },
    ]);
    expect(connectorChoices(secondPage!)).toEqual([
      { id: ID_B, label: "Shared API · …000002", archived: false, lifecycleRevision: 1 },
    ]);
  });

  it("rejects forbidden authentication headers and noncanonical operation port schemas", () => {
    const forbiddenAuthentication = [
      browserClosure({ kind: "api_key_header", headerName: "Authorization" }),
      browserClosure({ kind: "api_key_header", headerName: "x-forwarded-for" }),
    ];
    const forbiddenHeaderProperty = browserClosure();
    (forbiddenHeaderProperty.requestSchema.properties.headers as { properties: Record<string, unknown> }).properties.Authorization = { type: "string" };
    const genericRequest = browserClosure() as unknown as { requestSchema: unknown };
    genericRequest.requestSchema = {
      type: "object", properties: { arbitrary: { type: "string" } }, required: ["arbitrary"], additionalProperties: false,
    };
    const openRequestNamespace = browserClosure();
    (openRequestNamespace.requestSchema.properties.query as { additionalProperties: boolean }).additionalProperties = true;
    const genericResult = browserClosure() as unknown as { resultSchema: unknown };
    genericResult.resultSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
    const rangedStatus = browserClosure();
    (rangedStatus.resultSchema.properties.status as { maximum: number }).maximum = 299;

    for (const fixture of [
      ...forbiddenAuthentication, forbiddenHeaderProperty, genericRequest,
      openRequestNamespace, genericResult, rangedStatus,
    ]) {
      expect(parseClientOperationClosuresEnvelope({ closures: [browserPlain(fixture)] })).toBeNull();
    }
  });

  it("rejects hostile, secret-shaped, raw-source, and oversized responses", async () => {
    let invoked = false;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "connectors", {
      enumerable: true,
      get() { invoked = true; return []; },
    });
    Object.defineProperty(hostile, "nextCursor", { enumerable: true, value: null });
    expect(parseClientConnectorListEnvelope(hostile)).toBeNull();
    expect(invoked).toBe(false);
    expect(await readBoundedConnectorJson(json({ source: "raw" }))).toBeNull();
    expect(await readBoundedConnectorJson(json({ nested: { headers: {} } }))).toBeNull();
    expect(await readBoundedConnectorJson(json({ ok: true }, 200, { "content-length": "262145" }))).toBeNull();
  });

  it("uses relative same-origin no-store requests and exact metadata bodies", async () => {
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      expect(String(path)).not.toMatch(/^https?:/u);
      expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error" });
      if (String(path).includes("/operations/resolve")) {
        expect(JSON.parse(String(init?.body))).toEqual({ operationVersionIds: [ID_B] });
        return json({ closures: [browserPlain(browserClosure())] });
      }
      if (String(path).includes(`/connectors/${ID_A}/operations`)) {
        expect(init?.method).toBe("GET");
        return json({
          operations: [{
            operationVersionId: ID_B,
            connectorDefinitionVersionId: ID_A,
            definitionVersionNumber: 1,
            operationId: "listThings",
            connectorProjectionHash: "a".repeat(64),
            operationProjectionHash: "b".repeat(64),
            schemaHash: "c".repeat(64),
            executionAvailability: "simulation_only",
          }],
          nextCursor: null,
        });
      }
      if (String(path).includes("/openapi")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ source: "{\"openapi\":\"3.1.0\"}", displayLabel: "Vendor" });
        return json({
          review: {
            correlationId: ID_A,
            identity: identity(ID_A, "Vendor"),
            definition: { id: ID_B, connectorId: ID_A, versionNumber: 1, connectorProjectionHash: "a".repeat(64) },
            identityDisposition: "created",
            definitionDisposition: "created",
            drift: null,
            operations: [{ operationId: "listThings", method: "GET", path: "/things", operationProjectionHash: "b".repeat(64), schemaHash: "c".repeat(64) }],
            refusedOperationCount: 0,
          },
        }, 201);
      }
      return json({ connectors: [identity(ID_A)], nextCursor: null });
    });
    const client = createConnectorClient(fetcher);
    await expect(client.list({ limit: 2, search: "Vendor" })).resolves.toMatchObject({ connectors: [{ id: ID_A }] });
    await expect(client.reviewOpenApi({ source: "{\"openapi\":\"3.1.0\"}", displayLabel: "Vendor" })).resolves.toMatchObject({
      review: { operations: [{ operationId: "listThings" }] },
    });
    await expect(client.resolveOperations([ID_B])).resolves.toMatchObject({ closures: [{ reference: { operationVersionId: ID_B } }] });
    await expect(client.listOperations(ID_A, { limit: 20 })).resolves.toMatchObject({ operations: [{ operationVersionId: ID_B }] });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("limit=2&search=Vendor");
  });

  it("refuses invalid input before fetch and preserves exact private errors", async () => {
    const fetcher = vi.fn(async (path: RequestInfo | URL) => String(path).includes("/openapi")
      ? json({ error: "import refused", correlationId: ID_B }, 422)
      : json({ error: "not found" }, 404));
    const client = createConnectorClient(fetcher);
    await expect(client.get("not-a-uuid")).rejects.toMatchObject({ status: 400, error: "invalid request" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.list({ cursor: "not-a-canonical-cursor" })).rejects.toMatchObject({ status: 400, error: "invalid request" });
    await expect(client.resolveOperations([ID_A, ID_A])).rejects.toMatchObject({ status: 400, error: "invalid request" });
    await expect(client.get(ID_A, { cursor: Buffer.from(JSON.stringify({ beforeVersionNumber: 0 })).toString("base64url") }))
      .rejects.toMatchObject({ status: 400, error: "invalid request" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.get(ID_A)).rejects.toEqual(expect.objectContaining<Partial<ConnectorClientError>>({
      status: 404,
      error: "not found",
    }));
    await expect(client.reviewOpenApi({ source: "openapi: 3.1.0", displayLabel: "Vendor" })).rejects.toEqual(
      expect.objectContaining<Partial<ConnectorClientError>>({ status: 422, error: "import refused", correlationId: ID_B }),
    );
  });

  it("keeps operation-list cancellation distinguishable before fetch, during body read, and after a late fetch", async () => {
    const pre = new AbortController();
    pre.abort();
    const preFetcher = vi.fn(async () => json({ operations: [], nextCursor: null }));
    await expect(createConnectorClient(preFetcher).listOperations(ID_A, undefined, pre.signal))
      .rejects.toMatchObject({ status: 0, error: "request cancelled" });
    expect(preFetcher).not.toHaveBeenCalled();

    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() { streamCancelled = true; },
    });
    const mid = new AbortController();
    const midResult = createConnectorClient(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    })).listOperations(ID_A, undefined, mid.signal);
    await Promise.resolve();
    mid.abort();
    await expect(midResult).rejects.toMatchObject({ status: 0, error: "request cancelled" });
    expect(streamCancelled).toBe(true);

    let release: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const late = new AbortController();
    const lateResult = createConnectorClient(async () => pending).listOperations(ID_A, undefined, late.signal);
    late.abort();
    release!(json({ operations: [], nextCursor: null }));
    await expect(lateResult).rejects.toMatchObject({ status: 0, error: "request cancelled" });
  });

  it("parses operation pages in a browser runtime without Buffer", async () => {
    const response = json({ operations: [], nextCursor: null });
    vi.stubGlobal("Buffer", undefined);
    try {
      const client = createConnectorClient(async () => response);
      await expect(client.listOperations(ID_A)).resolves.toEqual({ operations: [], nextCursor: null });
    } finally {
      vi.unstubAllGlobals();
    }
    const parser = readFileSync(new URL("../../src/lib/connectors/openapi/json.ts", import.meta.url), "utf8");
    expect(parser).not.toMatch(/\bBuffer\b/u);
  });
});
