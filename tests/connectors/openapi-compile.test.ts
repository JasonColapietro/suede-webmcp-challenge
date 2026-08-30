import { describe, expect, it } from "vitest";
import basic from "../fixtures/openapi/supported-basic.json";
import secured from "../fixtures/openapi/supported-api-key.json";
import {
  compileOpenApi310,
  type OpenApiCompileFailureCode,
} from "@/lib/connectors/openapi/compile";

function source(value: unknown): string {
  return JSON.stringify(value);
}

function oneOperation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Fixture", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/things/{id}": {
        get: {
          operationId: "getThing",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "No content" } },
        },
      },
    },
    ...overrides,
  };
}

function expectRefusal(input: string, code: OpenApiCompileFailureCode): void {
  const result = compileOpenApi310(input);
  expect(result).toEqual({ ok: false, code });
  expect(Object.isFrozen(result)).toBe(true);
}

describe("compileOpenApi310", () => {
  it("compiles a normalized no-auth operation with independent namespaces", () => {
    const result = compileOpenApi310(source(basic));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.connectorProjection.origin).toBe("https://api.example.com");
    expect(result.connectorProjection.operations).toHaveLength(1);
    expect(result.operations).toHaveLength(1);
    const operation = result.operations[0]!;
    expect(operation.projection).toMatchObject({
      operationId: "getWidget",
      method: "GET",
      path: "/widgets/{id}",
      authentication: { kind: "none" },
      redaction: { requestValues: "omit", responseValues: "omit", credentialValues: "redact" },
      testBehavior: { mode: "schema_sentinel", egress: "forbidden", credentials: "forbidden" },
      limitsProfile: "connector-import-v1",
      executionAvailability: "simulation_only",
      systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
    });
    expect(Object.keys(operation.projection.requestSchema.properties ?? {})).toEqual(["headers", "path", "query"]);
    expect(operation.projection.requestSchema.properties?.path.properties).toHaveProperty("id");
    expect(operation.projection.requestSchema.properties?.query.properties).toHaveProperty("id");
    expect(operation.projection.requestSchema.properties?.headers.properties).toHaveProperty("x-trace");
    expect(operation.projection.resultSchema.properties?.status).toMatchObject({ type: "integer", minimum: 200, maximum: 200 });
    expect(operation.operationProjectionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(operation.schemaHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.connectorProjectionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(result.connectorProjection)).toBe(true);
    expect(Object.isFrozen(operation.projection)).toBe(true);
  });

  it("resolves local schema refs, normalizes default TLS port, and excludes credential headers", () => {
    const result = compileOpenApi310(source(secured));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const operation = result.operations[0]!;
    expect(result.connectorProjection.origin).toBe("https://secure.example.com");
    expect(operation.projection.authentication).toEqual({ kind: "api_key_header", headerName: "x-api-key" });
    expect(operation.projection.requestSchema.properties?.headers.properties).not.toHaveProperty("x-api-key");
    expect(operation.projection.requestSchema).toHaveProperty("properties.body");
    expect(operation.projection.requestSchema.required).toContain("body");
  });

  it("projects an exact selected 204 response to typed null", () => {
    const result = compileOpenApi310(source(oneOperation()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations[0]!.projection.resultSchema).toMatchObject({
      type: "object",
      properties: { status: { type: "integer", minimum: 204, maximum: 204 }, body: { type: "null" } },
      required: ["body", "status"],
      additionalProperties: false,
    });
  });

  it.each([
    [source({ ...oneOperation(), openapi: "3.0.3" }), "OPENAPI_VERSION_REFUSED"],
    [source({ ...oneOperation(), openapi: 3.1 }), "OPENAPI_VERSION_REFUSED"],
    [source({ ...oneOperation(), servers: [] }), "SERVER_ORIGIN_REFUSED"],
    [source({ ...oneOperation(), servers: [{ url: "https://a.example.com" }, { url: "https://b.example.com" }] }), "SERVER_ORIGIN_REFUSED"],
  ] as const)("refuses invalid version or server contracts", (input, code) => {
    expectRefusal(input, code);
  });

  it("rejects duplicate operation IDs", () => {
    const input = oneOperation({
      paths: {
        "/a": { get: { operationId: "same", responses: { "204": { description: "ok" } } } },
        "/b": { post: { operationId: "same", responses: { "204": { description: "ok" } } } },
      },
    });
    expectRefusal(source(input), "DUPLICATE_OPERATION_ID");
  });

  it.each([
    [{ responses: { "200": { description: "a", content: { "application/json": { schema: { type: "string" } } } }, "201": { description: "b", content: { "application/json": { schema: { type: "string" } } } } } }, "RESPONSE_SELECTION_REFUSED"],
    [{ responses: { "204": { description: "bad", content: { "application/json": { schema: { type: "string" } } } } } }, "RESPONSE_SELECTION_REFUSED"],
    [{ responses: { "200": { description: "bad" } } }, "RESPONSE_MEDIA_TYPE_REFUSED"],
  ] as const)("rejects ambiguous or malformed selected responses", (operationPatch, code) => {
    const doc = oneOperation();
    Object.assign((doc.paths as Record<string, any>)["/things/{id}"].get, operationPatch);
    expectRefusal(source(doc), code);
  });

  it("strips descriptions, examples, defaults, and titles from projections and hashes", () => {
    const left = structuredClone(secured) as any;
    const right = structuredClone(secured) as any;
    right.info.title = "CANARY title";
    right.paths["/widgets"].post.description = "CANARY operation";
    right.components.schemas.Widget.properties.ok = {
      type: "boolean", title: "CANARY", description: "CANARY", example: true, examples: [false], default: false,
    };
    right.paths["/widgets"].post.requestBody.example = "CANARY request example";
    const a = compileOpenApi310(source(left));
    const b = compileOpenApi310(source(right));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.connectorProjectionHash).toBe(a.connectorProjectionHash);
    expect(b.operations[0]!.operationProjectionHash).toBe(a.operations[0]!.operationProjectionHash);
    expect(JSON.stringify(b)).not.toContain("CANARY");
  });

  it("changes only the appropriate structural hashes when a selected schema changes", () => {
    const left = structuredClone(secured) as any;
    const right = structuredClone(secured) as any;
    right.components.schemas.Widget.properties.ok.type = "string";
    const a = compileOpenApi310(source(left));
    const b = compileOpenApi310(source(right));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.operations[0]!.schemaHash).not.toBe(a.operations[0]!.schemaHash);
    expect(b.operations[0]!.operationProjectionHash).not.toBe(a.operations[0]!.operationProjectionHash);
    expect(b.connectorProjectionHash).not.toBe(a.connectorProjectionHash);
  });

  it("keeps supported operations in mixed documents and records only fixed sanitized refusals", () => {
    const mixed = structuredClone(basic) as any;
    mixed.paths["/unsupported"] = {
      post: {
        operationId: "unsupportedBody",
        requestBody: { content: { "multipart/form-data": { schema: { type: "string" } } } },
        responses: { "204": { description: "ok" } },
      },
    };
    const result = compileOpenApi310(source(mixed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations.map((entry) => entry.operationId)).toEqual(["getWidget"]);
    expect(result.refusedOperations).toEqual([{
      operationId: "unsupportedBody",
      method: "POST",
      path: "/unsupported",
      code: "REQUEST_BODY_REFUSED",
    }]);
    expect(JSON.stringify(result)).not.toContain("multipart/form-data");
  });
});
