import { describe, expect, it } from "vitest";
import { CONNECTOR_IMPORT_V1_LIMITS } from "@/lib/connectors/limits";
import {
  CONNECTOR_SYSTEM_POLICY_V1,
  parseConnectorDefinitionVersionV1,
  parseOperationRequestV1,
  parseOperationResultV1,
  parseOperationProjectionV1,
  parseOperationVersionV1,
  parseSystemPolicyV1,
} from "@/lib/connectors/schema";
import { connectorLabFlagProjection, parseConnectorLabFlag } from "@/lib/connectors/flags";
import {
  connectorProjectionHash,
  operationProjectionHash,
  schemaHash,
} from "@/lib/connectors/canonical";

const objectSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

const operationProjection = {
  projectionVersion: 1,
  operationId: "createThing",
  method: "POST",
  path: "/things/{thingId}",
  authentication: { kind: "api_key_header", headerName: "X-Api-Key" },
  requestSchema: {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: { thingId: { type: "string", minLength: 1 } },
        required: ["thingId"],
        additionalProperties: false,
      },
      query: objectSchema,
      headers: objectSchema,
    },
    required: ["path", "query", "headers"],
    additionalProperties: false,
  },
  resultSchema: {
    type: "object",
    properties: {
      status: { type: "integer", minimum: 201, maximum: 201 },
      body: objectSchema,
    },
    required: ["status", "body"],
    additionalProperties: false,
  },
  redaction: { requestValues: "omit", responseValues: "omit", credentialValues: "redact" },
  testBehavior: { mode: "schema_sentinel", egress: "forbidden", credentials: "forbidden" },
  limitsProfile: "connector-import-v1",
  executionAvailability: "simulation_only",
  systemPolicy: {
    effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none",
  },
} as const;

const connectorProjection = {
  projectionVersion: 1,
  origin: "https://api.example.com",
  operations: [{
    operationId: "createThing",
    method: "POST",
    path: "/things/{thingId}",
    authentication: { kind: "api_key_header", headerName: "X-Api-Key" },
    operationProjection,
    operationProjectionHash: operationProjectionHash(operationProjection),
  }],
} as const;

const OPERATION_HASH = operationProjectionHash(operationProjection);
const CONNECTOR_HASH = connectorProjectionHash(connectorProjection);
const SCHEMA_HASH = schemaHash(operationProjection.requestSchema, operationProjection.resultSchema);

function operationProjectionWithHeaders(
  headerNames: readonly string[],
  authentication: unknown = { kind: "none" },
): Record<string, unknown> {
  const properties = Object.fromEntries(headerNames.map((name) => [name, { type: "string" }]));
  return {
    ...operationProjection,
    authentication,
    requestSchema: {
      ...operationProjection.requestSchema,
      properties: {
        ...operationProjection.requestSchema.properties,
        headers: { type: "object", properties, required: [], additionalProperties: false },
      },
    },
  };
}

describe("connector contract", () => {
  it("publishes the exact frozen connector-import-v1 limits", () => {
    expect(CONNECTOR_IMPORT_V1_LIMITS).toEqual({
      profile: "connector-import-v1",
      maxInputBytes: 2 * 1024 * 1024,
      maxJsonDepth: 64,
      maxContainerEntries: 50_000,
      maxOperations: 250,
      maxParametersPerOperation: 64,
      maxSchemaDepth: 32,
      maxLocalReferenceExpansions: 1_000,
      maxInspectedValues: 100_000,
      compilerDeadlineMs: 5_000,
      maxImportsPerOwnerPerMinute: 10,
      maxCanonicalProjectionBytes: 256 * 1024,
      maxTerminalReceiptBytes: 64 * 1024,
    });
    expect(Object.isFrozen(CONNECTOR_IMPORT_V1_LIMITS)).toBe(true);
  });

  it("accepts only the fixed trusted system policy", () => {
    expect(parseSystemPolicyV1(CONNECTOR_SYSTEM_POLICY_V1)).toEqual({
      effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none",
    });
    expect(Object.isFrozen(parseSystemPolicyV1(CONNECTOR_SYSTEM_POLICY_V1).effects)).toBe(true);
    expect(() => parseSystemPolicyV1({ ...CONNECTOR_SYSTEM_POLICY_V1, retry: "safe" })).toThrow(/Invalid connector contract/);
    expect(() => parseSystemPolicyV1({ ...CONNECTOR_SYSTEM_POLICY_V1, fixture: "canary" })).toThrow(/Invalid connector contract/);
  });

  it("rejects accessors, symbols, and exotic prototypes without invoking accessors", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "effects", { enumerable: true, get() { calls += 1; return ["write"]; } });
    Object.defineProperties(accessor, {
      retry: { enumerable: true, value: "unsafe" },
      cost: { enumerable: true, value: "unknown" },
      idempotency: { enumerable: true, value: "none" },
    });
    expect(() => parseSystemPolicyV1(accessor)).toThrow(/Invalid connector contract/);
    expect(calls).toBe(0);

    const hostileEffects = ["write"];
    Object.defineProperty(hostileEffects, "0", { enumerable: true, get() { calls += 1; return "write"; } });
    expect(() => parseSystemPolicyV1({ ...CONNECTOR_SYSTEM_POLICY_V1, effects: hostileEffects })).toThrow(/Invalid connector contract/);
    expect(calls).toBe(0);

    const symbol = { ...CONNECTOR_SYSTEM_POLICY_V1, [Symbol("secret")]: "canary" };
    expect(() => parseSystemPolicyV1(symbol)).toThrow(/Invalid connector contract/);
    expect(() => parseSystemPolicyV1(Object.assign(Object.create({ inherited: true }), CONNECTOR_SYSTEM_POLICY_V1))).toThrow(/Invalid connector contract/);
  });

  it("parses and deeply freezes immutable connector and operation versions", () => {
    const connector = parseConnectorDefinitionVersionV1({
      contractVersion: 1,
      id: "connector-version-1",
      connectorId: "connector-1",
      versionNumber: 1,
      projection: connectorProjection,
      connectorProjectionHash: CONNECTOR_HASH,
      executionAvailability: "simulation_only",
    });
    const operation = parseOperationVersionV1({
      contractVersion: 1,
      id: "operation-version-1",
      connectorDefinitionVersionId: connector.id,
      operationId: "createThing",
      projection: operationProjection,
      operationProjectionHash: OPERATION_HASH,
      schemaHash: SCHEMA_HASH,
      executionAvailability: "simulation_only",
      authorAnnotation: { label: "Unverified", effectNote: "claims read only", retryNote: "claims safe" },
    });
    expect(connector.projection.operations[0]?.operationId).toBe("createThing");
    expect(operation.authorAnnotation?.label).toBe("Unverified");
    expect(Object.isFrozen(connector.projection.operations)).toBe(true);
    expect(Object.isFrozen(operation.projection.requestSchema)).toBe(true);
  });

  it("rejects unknown version fields and mismatched immutable identities", () => {
    expect(() => parseConnectorDefinitionVersionV1({
      contractVersion: 1,
      id: "connector-version-1",
      connectorId: "connector-1",
      versionNumber: 1,
      projection: connectorProjection,
      connectorProjectionHash: CONNECTOR_HASH,
      executionAvailability: "simulation_only",
      rawSource: "canary",
    })).toThrow(/Invalid connector contract/);
    expect(() => parseOperationVersionV1({
      contractVersion: 1,
      id: "operation-version-1",
      connectorDefinitionVersionId: "connector-version-1",
      operationId: "otherOperation",
      projection: operationProjection,
      operationProjectionHash: OPERATION_HASH,
      schemaHash: SCHEMA_HASH,
      executionAvailability: "simulation_only",
    })).toThrow(/Invalid connector contract/);
  });

  it("recomputes and refuses every stale projection and schema digest", () => {
    expect(() => parseConnectorDefinitionVersionV1({
      contractVersion: 1,
      id: "connector-version-1",
      connectorId: "connector-1",
      versionNumber: 1,
      projection: connectorProjection,
      connectorProjectionHash: "0".repeat(64),
      executionAvailability: "simulation_only",
    })).toThrow(/Invalid connector contract/);
    expect(() => parseConnectorDefinitionVersionV1({
      contractVersion: 1,
      id: "connector-version-1",
      connectorId: "connector-1",
      versionNumber: 1,
      projection: {
        ...connectorProjection,
        operations: [{ ...connectorProjection.operations[0], operationProjectionHash: "0".repeat(64) }],
      },
      connectorProjectionHash: CONNECTOR_HASH,
      executionAvailability: "simulation_only",
    })).toThrow(/Invalid connector contract/);
    const valid = {
      contractVersion: 1,
      id: "operation-version-1",
      connectorDefinitionVersionId: "connector-version-1",
      operationId: "createThing",
      projection: operationProjection,
      operationProjectionHash: OPERATION_HASH,
      schemaHash: SCHEMA_HASH,
      executionAvailability: "simulation_only",
    } as const;
    expect(() => parseOperationVersionV1({ ...valid, operationProjectionHash: "0".repeat(64) })).toThrow(/Invalid connector contract/);
    expect(() => parseOperationVersionV1({ ...valid, schemaHash: "0".repeat(64) })).toThrow(/Invalid connector contract/);
  });

  it("accepts exactly 64 ASCII token characters for an API-key header", () => {
    const boundary = `X${"a".repeat(63)}`;
    expect(parseOperationProjectionV1({
      ...operationProjection,
      authentication: { kind: "api_key_header", headerName: boundary },
    }).authentication).toEqual({ kind: "api_key_header", headerName: boundary.toLowerCase() });

    expect(() => parseOperationProjectionV1({
      ...operationProjection,
      authentication: { kind: "api_key_header", headerName: `${boundary}a` },
    })).toThrow(/Invalid connector contract/);
    expect(() => parseOperationProjectionV1({
      ...operationProjection,
      authentication: { kind: "api_key_header", headerName: "X-Api-Kéy" },
    })).toThrow(/Invalid connector contract/);
    expect(() => parseOperationProjectionV1({
      ...operationProjection,
      authentication: { kind: "api_key_header", headerName: "X Api Key" },
    })).toThrow(/Invalid connector contract/);
  });

  it.each([
    "__PrOtO__",
    "Constructor",
    "PROTOTYPE",
    "Connection",
    "Cookie",
    "Host",
    "Keep-Alive",
    "Proxy-Authenticate",
    "Proxy-Authorization",
    "Proxy-Connection",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
    "Authorization",
    "Accept",
    "Content-Type",
    "Content-Length",
    "Forwarded",
    "Via",
    "X-Forwarded-For",
    "x-FoRwArDeD-Custom",
    "Origin",
    "Referer",
    "User-Agent",
  ])("rejects the case-insensitive executor-owned API-key header %s", (headerName) => {
    expect(() => parseOperationProjectionV1({
      ...operationProjection,
      authentication: { kind: "api_key_header", headerName },
    })).toThrow(/Invalid connector contract/);
  });

  it.each(["http_bearer", "http_basic"] as const)(
    "keeps the internal Authorization scheme %s valid",
    (kind) => {
      expect(parseOperationProjectionV1({
        ...operationProjection,
        authentication: { kind },
      }).authentication).toEqual({ kind });
    },
  );

  it("rejects case-folded request-header duplicates and credential-owned collisions", () => {
    expect(() => parseOperationProjectionV1(
      operationProjectionWithHeaders(["X-Trace", "x-trace"]),
    )).toThrow(/Invalid connector contract/);
    expect(() => parseOperationProjectionV1(
      operationProjectionWithHeaders(
        ["X-API-KEY"],
        { kind: "api_key_header", headerName: "x-api-key" },
      ),
    )).toThrow(/Invalid connector contract/);
    expect(() => parseOperationProjectionV1(
      operationProjectionWithHeaders(["Authorization"], { kind: "http_bearer" }),
    )).toThrow(/Invalid connector contract/);
    expect(() => parseOperationProjectionV1(
      operationProjectionWithHeaders(["authorization"], { kind: "http_basic" }),
    )).toThrow(/Invalid connector contract/);
  });

  it.each([
    "Content-Type",
    "X-Forwarded-For",
    "X Api Key",
    "X".repeat(65),
  ])("rejects the invalid request header property %s", (headerName) => {
    expect(() => parseOperationProjectionV1(
      operationProjectionWithHeaders([headerName]),
    )).toThrow(/Invalid connector contract/);
  });

  it("keeps a safe same-name field independent across path, query, and headers", () => {
    const sharedNamespace = {
      type: "object",
      properties: { shared: { type: "string" } },
      required: ["shared"],
      additionalProperties: false,
    } as const;
    const parsed = parseOperationProjectionV1({
      ...operationProjection,
      authentication: { kind: "none" },
      requestSchema: {
        ...operationProjection.requestSchema,
        properties: {
          path: sharedNamespace,
          query: sharedNamespace,
          headers: sharedNamespace,
        },
      },
    });

    expect(parsed.requestSchema.properties?.path.properties).toHaveProperty("shared");
    expect(parsed.requestSchema.properties?.query.properties).toHaveProperty("shared");
    expect(parsed.requestSchema.properties?.headers.properties).toHaveProperty("shared");
  });

  it("requires the closed request/result port shape and null 204 bodies", () => {
    expect(() => parseOperationVersionV1({
      contractVersion: 1,
      id: "operation-version-1",
      connectorDefinitionVersionId: "connector-version-1",
      operationId: "createThing",
      projection: { ...operationProjection, requestSchema: objectSchema },
      operationProjectionHash: OPERATION_HASH,
      schemaHash: SCHEMA_HASH,
      executionAvailability: "simulation_only",
    })).toThrow(/Invalid connector contract/);

    const response204 = {
      ...operationProjection,
      resultSchema: {
        type: "object",
        properties: {
          status: { type: "integer", minimum: 204, maximum: 204 },
          body: { type: "null" },
        },
        required: ["status", "body"],
        additionalProperties: false,
      },
    } as const;
    expect(parseOperationVersionV1({
      contractVersion: 1,
      id: "operation-version-204",
      connectorDefinitionVersionId: "connector-version-1",
      operationId: "createThing",
      projection: response204,
      operationProjectionHash: operationProjectionHash(response204),
      schemaHash: schemaHash(response204.requestSchema, response204.resultSchema),
      executionAvailability: "simulation_only",
    }).projection.resultSchema.properties?.body).toEqual({ type: "null" });
    expect(() => parseOperationResultV1({ status: 204, body: { leaked: true } })).toThrow(/Invalid connector contract/);
  });

  it("clones and freezes exact request and result values", () => {
    const request = parseOperationRequestV1({ path: { thingId: "one" }, query: {}, headers: {}, body: { enabled: true } });
    const result = parseOperationResultV1({ status: 201, body: { id: "generated" } });
    expect(request).toEqual({ path: { thingId: "one" }, query: {}, headers: {}, body: { enabled: true } });
    expect(result).toEqual({ status: 201, body: { id: "generated" } });
    expect(Object.isFrozen(request.body)).toBe(true);
    expect(() => parseOperationRequestV1({ path: {}, query: {}, headers: {}, fixture: {} })).toThrow(/Invalid connector contract/);
    expect(() => parseOperationResultV1({ status: 200, body: undefined })).toThrow(/Invalid connector contract/);
  });

  it("keeps the shared Connector Lab flag default-off and exact", () => {
    expect(parseConnectorLabFlag(undefined)).toBe(false);
    expect(parseConnectorLabFlag("0")).toBe(false);
    expect(parseConnectorLabFlag("1")).toBe(true);
    expect(parseConnectorLabFlag("true")).toBe(false);
    expect(connectorLabFlagProjection(undefined)).toEqual({ enabled: false, badge: "Prototype: simulation only" });
    expect(Object.isFrozen(connectorLabFlagProjection("1"))).toBe(true);
  });
});
