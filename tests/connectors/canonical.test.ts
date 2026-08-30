import { describe, expect, it } from "vitest";
import {
  canonicalConnectorProjectionBytes,
  canonicalOperationProjectionBytes,
  canonicalSchemaBytes,
  connectorProjectionHash,
  operationProjectionHash,
  schemaHash,
} from "@/lib/connectors/canonical";

const emptyObject = { type: "object", properties: {}, required: [], additionalProperties: false } as const;

function operation(overrides: Record<string, unknown> = {}) {
  return {
    projectionVersion: 1,
    operationId: "caf\u00e9.create",
    method: "POST",
    path: "/things",
    authentication: { kind: "none" },
    requestSchema: {
      type: "object",
      properties: { path: emptyObject, query: emptyObject, headers: emptyObject },
      required: ["path", "query", "headers"],
      additionalProperties: false,
    },
    resultSchema: {
      type: "object",
      properties: { status: { type: "integer", minimum: 200, maximum: 200 }, body: emptyObject },
      required: ["status", "body"],
      additionalProperties: false,
    },
    redaction: { requestValues: "omit", responseValues: "omit", credentialValues: "redact" },
    testBehavior: { mode: "schema_sentinel", egress: "forbidden", credentials: "forbidden" },
    limitsProfile: "connector-import-v1",
    executionAvailability: "simulation_only",
    systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
    ...overrides,
  };
}

function connector(operationProjection = operation()) {
  return {
    projectionVersion: 1,
    origin: "https://api.example.com",
    operations: [{
      operationId: operationProjection.operationId,
      method: operationProjection.method,
      path: operationProjection.path,
      authentication: operationProjection.authentication,
      operationProjection,
      operationProjectionHash: operationProjectionHash(operationProjection),
    }],
  };
}

describe("canonical connector projections", () => {
  it("emits byte-identical canonical UTF-8 for key order and NFC-equivalent identity", () => {
    const left = operation();
    const right = operation({ operationId: "cafe\u0301.create" });
    expect(canonicalOperationProjectionBytes(left)).toEqual(canonicalOperationProjectionBytes(right));
    expect(operationProjectionHash(left)).toBe(operationProjectionHash(right));
    expect(operationProjectionHash(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalizes public authentication header names case-insensitively", () => {
    const upper = operation({ authentication: { kind: "api_key_header", headerName: "X-Api-Key" } });
    const lower = operation({ authentication: { kind: "api_key_header", headerName: "x-api-key" } });
    expect(operationProjectionHash(upper)).toBe(operationProjectionHash(lower));
  });

  it("hashes exactly the connector, operation, and schema projections", () => {
    const base = operation();
    const changedPath = operation({ path: "/other" });
    expect(operationProjectionHash(base)).not.toBe(operationProjectionHash(changedPath));
    expect(connectorProjectionHash(connector(base))).not.toBe(connectorProjectionHash(connector(changedPath)));
    expect(schemaHash(base.requestSchema, base.resultSchema)).toBe(schemaHash(changedPath.requestSchema, changedPath.resultSchema));
    expect(canonicalSchemaBytes(base.requestSchema, base.resultSchema).toString("utf8")).toBe(
      canonicalSchemaBytes(changedPath.requestSchema, changedPath.resultSchema).toString("utf8"),
    );
  });

  it("keeps author annotations and excluded literal canaries outside every digest", () => {
    const projection = operation();
    const versionA = { projection, authorAnnotation: { label: "Unverified", effectNote: "CANARY_A" } };
    const versionB = { projection, authorAnnotation: { label: "Unverified", effectNote: "CANARY_B" } };
    expect(operationProjectionHash(versionA.projection)).toBe(operationProjectionHash(versionB.projection));
    const bytes = canonicalOperationProjectionBytes(projection).toString("utf8");
    for (const excluded of ["CANARY_A", "CANARY_B", "authorization", "example", "default", "fixture"]) {
      expect(bytes).not.toContain(excluded);
    }
  });

  it("rejects unknown fields, accessors, symbols, and oversized projections", () => {
    expect(() => canonicalOperationProjectionBytes({ ...operation(), example: "CANARY" })).toThrow(/Invalid connector contract/);
    expect(() => canonicalOperationProjectionBytes({ ...operation(), [Symbol("secret")]: "CANARY" })).toThrow(/Invalid connector contract/);
    let calls = 0;
    const hostile = Object.defineProperty({ ...operation() }, "path", { enumerable: true, get() { calls += 1; return "/hostile"; } });
    expect(() => canonicalOperationProjectionBytes(hostile)).toThrow(/Invalid connector contract/);
    expect(calls).toBe(0);
    expect(() => canonicalOperationProjectionBytes(operation({ path: `/${"x".repeat(300_000)}` }))).toThrow(/projection exceeds/i);
  });

  it("returns immutable snapshots before hashing", () => {
    const value = connector();
    const bytes = canonicalConnectorProjectionBytes(value);
    const first = connectorProjectionHash(value);
    const changed = connector(operation({ path: "/mutated" }));
    expect(bytes.toString("utf8")).toContain("/things");
    expect(connectorProjectionHash(changed)).not.toBe(first);
  });

  it.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://api.service.internal",
    "https://xn--mnich-kva.example.com",
  ])("rejects unsafe canonical connector origin %s", (origin) => {
    expect(() => canonicalConnectorProjectionBytes({ ...connector(), origin }))
      .toThrow(/Invalid connector contract/);
  });

  it("normalizes the same public origin policy used by OpenAPI import", () => {
    expect(JSON.parse(canonicalConnectorProjectionBytes({
      ...connector(),
      origin: "https://api.example.com:443",
    }).toString("utf8"))).toMatchObject({ origin: "https://api.example.com" });
  });
});
