import { describe, expect, it } from "vitest";
import {
  SIMULATION_INVALID_REQUEST,
  UNSUPPORTED_FIXTURE_INPUT,
  buildApiOperationSimulationReceipt,
  parseApiOperationSimulationJson,
  parseApiOperationSimulationRequest,
  validateConnectorValue,
} from "@/lib/connectors/simulation-contract";

const pinKey = JSON.stringify(["edge-input", "edge-1", "source", "result", "api", "request"]);

describe("API operation simulation contract", () => {
  it("accepts only the exact bounded client request and freezes the result", () => {
    const parsed = parseApiOperationSimulationRequest({
      nodeId: "api",
      scope: "from-node",
      environmentId: "environment-test",
      pinnedInputs: { [pinKey]: { path: {}, query: {}, headers: {} } },
    });
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(Object.isFrozen(parsed.value)).toBe(true);
      expect(Object.isFrozen(parsed.value.pinnedInputs)).toBe(true);
      expect(Object.keys(parsed.value)).toEqual(["environmentId", "nodeId", "pinnedInputs", "scope"]);
    }
    for (const extra of ["graph", "correlationId", "fixture", "resolver", "readiness"] as const) {
      const result = parseApiOperationSimulationRequest({
        nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs: {}, [extra]: "canary",
      });
      expect(result).toEqual({
        ok: false,
        code: extra === "fixture" ? UNSUPPORTED_FIXTURE_INPUT : SIMULATION_INVALID_REQUEST,
      });
    }
  });

  it("rejects fixture-like keys at any depth before generic parsing and never echoes values", () => {
    const canary = "never-echo-this-canary";
    for (const pinnedInputs of [
      { fixture: canary },
      { [pinKey]: { nestedFixtureValue: canary } },
      { [pinKey]: [{ FIXTURE_payload: canary }] },
    ]) {
      const result = parseApiOperationSimulationRequest({
        nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs,
      });
      expect(result).toEqual({ ok: false, code: UNSUPPORTED_FIXTURE_INPUT });
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  it("rejects duplicate raw JSON keys and sparse arrays", () => {
    expect(parseApiOperationSimulationJson('{"nodeId":"api","nodeId":"other","scope":"node","environmentId":"environment-test","pinnedInputs":{}}'))
      .toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = null;
    expect(parseApiOperationSimulationRequest({
      nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs: { [pinKey]: sparse },
    })).toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
  });

  it("rejects accessors, symbols, hostile prototypes, and noncanonical pin keys without invocation", () => {
    let getterCalls = 0;
    const accessor = { nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs: {} };
    Object.defineProperty(accessor, "nodeId", { enumerable: true, get: () => { getterCalls += 1; return "api"; } });
    expect(parseApiOperationSimulationRequest(accessor)).toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
    expect(getterCalls).toBe(0);

    const symbol = { nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs: {}, [Symbol("x")]: 1 };
    expect(parseApiOperationSimulationRequest(symbol)).toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
    expect(parseApiOperationSimulationRequest(Object.assign(Object.create({ polluted: true }), {
      nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs: {},
    }))).toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
    expect(parseApiOperationSimulationRequest({
      nodeId: "api", scope: "node", environmentId: "environment-test", pinnedInputs: { "[ \"bad\" ]": null },
    })).toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
  });

  it("enforces canonical pin identity, pointer, per-value, and aggregate budgets", () => {
    const requestFor = (pinnedInputs: Record<string, unknown>, nodeId = "api") => ({
      nodeId, scope: "node", environmentId: "environment-test", pinnedInputs,
    });
    expect(parseApiOperationSimulationRequest(requestFor({}, "n".repeat(129))))
      .toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
    const longKey = JSON.stringify(["edge-input", "e".repeat(129), "source", "result", "api", "request"]);
    expect(parseApiOperationSimulationRequest(requestFor({ [longKey]: null })))
      .toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
    for (const path of ["", "/", "/ leading and trailing "]) {
      const key = JSON.stringify(["node-binding", "api", "request", "source", "result", path]);
      expect(parseApiOperationSimulationRequest(requestFor({ [key]: null }))).toMatchObject({ ok: true });
    }
    let deep: unknown = null;
    for (let index = 0; index < 17; index += 1) deep = [deep];
    expect(parseApiOperationSimulationRequest(requestFor({ [pinKey]: deep })))
      .toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
    const aggregate = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      JSON.stringify(["edge-input", `edge-${index}`, "source", "result", "api", "request"]),
      Array.from({ length: 9_999 }, () => null),
    ]));
    expect(parseApiOperationSimulationRequest(requestFor(aggregate)))
      .toEqual({ ok: false, code: SIMULATION_INVALID_REQUEST });
  });

  it("validates values against the closed connector schema without echoing rejected input", () => {
    const schema = {
      type: "object" as const,
      properties: {
        path: { type: "object" as const, properties: { id: { type: "integer" as const, minimum: 1 } }, required: ["id"], additionalProperties: false as const },
        query: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
        headers: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
      },
      required: ["path", "query", "headers"],
      additionalProperties: false as const,
    };
    expect(validateConnectorValue(schema, { path: { id: 1 }, query: {}, headers: {} })).toBe(true);
    expect(validateConnectorValue(schema, { path: { id: 0 }, query: {}, headers: {} })).toBe(false);
    expect(validateConnectorValue(schema, { path: { id: 1 }, query: {}, headers: {}, fixture: "canary" })).toBe(false);
  });

  it("validates exact RFC string formats without WHATWG normalization", () => {
    const valid: Readonly<Record<string, readonly string[]>> = {
      uuid: ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", "018f3f72-7c58-8cc0-9a3d-5a278f1eb670"],
      uri: ["https://example.com/a?b=c#d", "http://[v1.fe]/"],
      "date-time": ["2024-02-29t12:00:00z", "2016-12-31T23:59:60Z"],
      email: ['"a@b"@example.com', "user@[192.0.2.1]", "user@[IPv6:2001:db8::1]"],
    };
    const invalid: Readonly<Record<string, readonly string[]>> = {
      uuid: ["00000000-0000-f000-0000-000000000000"],
      uri: ["https://example.com/{x}", "https://example.com/a\\b", "https://example.com/[]", "foo://user@@host/x", "https://example.com/#a#b"],
      "date-time": ["2024-01-01T23:59:60Z", "2023-02-29T00:00:00Z"],
      email: ["a..b@example.com", "user@[999.2.3.4]"],
    };
    for (const [format, values] of Object.entries(valid)) {
      for (const value of values) expect(validateConnectorValue({ type: "string", format }, value)).toBe(true);
    }
    for (const [format, values] of Object.entries(invalid)) {
      for (const value of values) expect(validateConnectorValue({ type: "string", format }, value)).toBe(false);
    }
  });

  it("builds an exact deeply frozen value-opaque receipt with an unsubstituted path", () => {
    const receipt = buildApiOperationSimulationReceipt({
      correlationId: "00000000-0000-4000-8000-000000000001",
      simulationId: "00000000-0000-4000-8000-000000000002",
      operationVersionId: "00000000-0000-4000-8000-000000000003",
      operationId: "getWidget",
      connectorProjectionHash: "a".repeat(64),
      operationProjectionHash: "b".repeat(64),
      schemaHash: "c".repeat(64),
      method: "GET",
      origin: "https://api.example.invalid",
      pathTemplate: "/widgets/{id}",
      pathParameterNames: ["id"],
      queryParameterNames: ["expand"],
      requestHeaderNames: [],
      hasBody: false,
      selectedStatus: 200,
      credentialPlaceholder: null,
      systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
      authorAnnotation: null,
      plannedNodeCount: 2,
      completedNodeCount: 2,
      durationMs: 4,
    });
    expect(receipt.message).toBe("Simulated locally. No request sent.");
    expect(receipt.operation.pathTemplate).toBe("/widgets/{id}");
    expect(receipt).toMatchObject({ egressCount: 0, costUsdc: 0 });
    expect(JSON.stringify(receipt)).not.toContain("sentinel");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.operation)).toBe(true);
  });
});
