import { describe, expect, it, vi } from "vitest";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";
import type { ConnectorOperationClosure, ConnectorRepository } from "@/lib/connectors/repository";
import {
  API_OPERATION_ASSET_UNAVAILABLE,
  API_OPERATION_V1_UNSUPPORTED_RESULT,
  parseApiOperationReference,
  parseApiOperationNodeParams,
  resolveApiOperationClosure,
  validateApiOperationReference,
  projectApiOperationClosureForBrowser,
  type ApiOperationReference,
  type OperationClosureSnapshot,
} from "@/lib/connectors/operation-closure";
import { FlowGraphV1Schema, FlowGraphV2Schema, parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { downconvertFlowGraph, inspectV2OnlyFeatures } from "@/lib/flow/graph-v2-codec";
import { createValidatedNodePortResolver } from "@/lib/flow/node-ports";
import { assertGraphPortReferences } from "@/lib/flow/node-ports";
import { createApiOperationPortResolver } from "@/lib/flow/operation-port-resolver";
import { validateCallableInterfaceForGraph } from "@/lib/flow/callable-interface-validation";
import type { FlowGraphV2 } from "@/lib/flow/types";

const DEFINITION_ID = "00000000-0000-4000-8000-000000000601";
const OPERATION_ID = "00000000-0000-4000-8000-000000000602";
const CONNECTOR_ID = "00000000-0000-4000-8000-000000000603";

function compiledClosure(): ConnectorOperationClosure {
  const compiled = compileOpenApi310(JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Things", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/things/{thingId}": {
        post: {
          operationId: "createThing",
          parameters: [
            { in: "path", name: "thingId", required: true, schema: { type: "string" } },
            { in: "query", name: "dryRun", required: true, schema: { type: "boolean" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } } },
          },
          responses: { "201": { description: "created", content: { "application/json": { schema: { type: "string" } } } } },
        },
      },
    },
  }));
  if (!compiled.ok) throw new Error(compiled.code);
  const operation = compiled.operations[0]!;
  return {
    identity: {
      id: CONNECTOR_ID,
      displayLabel: "Things",
      archivedAt: null,
      lifecycleRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    definition: {
      contractVersion: 1,
      id: DEFINITION_ID,
      connectorId: CONNECTOR_ID,
      versionNumber: 1,
      projection: compiled.connectorProjection,
      connectorProjectionHash: compiled.connectorProjectionHash,
      executionAvailability: "simulation_only",
    },
    operation: {
      contractVersion: 1,
      id: OPERATION_ID,
      connectorDefinitionVersionId: DEFINITION_ID,
      operationId: operation.operationId,
      projection: operation.projection,
      operationProjectionHash: operation.operationProjectionHash,
      schemaHash: operation.schemaHash,
      executionAvailability: "simulation_only",
    },
  };
}

function pins(closure = compiledClosure()): ApiOperationReference {
  return {
    connectorDefinitionVersionId: closure.definition.id,
    operationVersionId: closure.operation.id,
    operationId: closure.operation.operationId,
    connectorProjectionHash: closure.definition.connectorProjectionHash,
    operationProjectionHash: closure.operation.operationProjectionHash,
    schemaHash: closure.operation.schemaHash,
    ...(closure.operation.projection.authentication.kind === "none" ? {} : {
      readinessBinding: { kind: "connection" as const, connectionId: "connection_test_1", capability: "http.headers" as const },
    }),
  };
}

function graph(params = pins()): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "api-graph",
    name: "API graph",
    nodes: [{ id: "api", type: "api.operation", params, bindings: {}, position: { x: 0, y: 0 } }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

describe("api.operation closed contract", () => {
  it("accepts only immutable version/hash pins and one opaque readiness reference", () => {
    const parsed = parseApiOperationNodeParams(pins());
    expect(parsed).toEqual(pins());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseApiOperationReference(parsed)).toBeTypeOf("object");
    const reference: ApiOperationReference = parsed;
    expect(reference.operationVersionId).toBe(OPERATION_ID);
    expect(Object.isFrozen(parsed.readinessBinding)).toBe(true);

    for (const extra of [
      { requestSchema: {} },
      { resultSchema: {} },
      { secretBinding: { kind: "secret", connectionId: "x", field: "headers" } },
      { fixture: { body: "forbidden" } },
    ]) expect(() => parseApiOperationNodeParams({ ...pins(), ...extra })).toThrow(/Invalid API operation node/);
    expect(() => parseApiOperationNodeParams({
      ...pins(), readinessBinding: { kind: "connection", connectionId: "x", capability: "plaintext-secret" },
    })).toThrow(/Invalid API operation node/);
    expect(() => parseApiOperationNodeParams({ ...pins(), operationVersionId: "latest" }))
      .toThrow(/Invalid API operation node/);
    expect(parseApiOperationReference({
      ...pins(), readinessBinding: { kind: "unresolved", requirementKey: "api-node:headers", capability: "http.headers" },
    }).readinessBinding).toEqual({ kind: "unresolved", requirementKey: "api-node:headers", capability: "http.headers" });
  });

  it("loads one owner-scoped closure and refuses missing, foreign, or drifted pins", () => {
    const closure = compiledClosure();
    const getOperationClosure = vi.fn(() => closure);
    const repository = { getOperationClosure } as unknown as ConnectorRepository;
    const snapshot: OperationClosureSnapshot = resolveApiOperationClosure(repository, "owner-a", pins(closure));
    expect(getOperationClosure).toHaveBeenCalledOnce();
    expect(getOperationClosure).toHaveBeenCalledWith("owner-a", OPERATION_ID);
    expect(snapshot.closure).toBe(closure);
    expect(snapshot.reference).toEqual(pins(closure));
    expect(snapshot.requestSchema).toBe(closure.operation.projection.requestSchema);
    expect(snapshot.resultSchema).toBe(closure.operation.projection.resultSchema);
    expect(snapshot.systemPolicy).toEqual({ effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" });
    expect(snapshot.authentication).toEqual(closure.operation.projection.authentication);
    expect(validateApiOperationReference(snapshot.reference, closure)).toMatchObject({ operationId: "createThing" });
    const browser = projectApiOperationClosureForBrowser(snapshot);
    expect(browser).toEqual({
      reference: snapshot.reference,
      connectorId: CONNECTOR_ID,
      connectorDisplayLabel: closure.identity.displayLabel,
      lifecycleRevision: 1,
      archivedAt: null,
      definitionVersionNumber: 1,
      method: "POST",
      path: "/things/{thingId}",
      authentication: snapshot.authentication,
      requestSchema: snapshot.requestSchema,
      resultSchema: snapshot.resultSchema,
      systemPolicy: snapshot.systemPolicy,
      authorAnnotation: null,
      executionAvailability: "simulation_only",
    });
    expect(browser).not.toHaveProperty("identity");
    expect(browser).not.toHaveProperty("closure");
    expect(Object.isFrozen(browser)).toBe(true);

    const task5EnvelopeFixture = Object.freeze({
      closures: Object.freeze([browser]),
    }) satisfies Readonly<{ closures: readonly import("@/lib/connectors/operation-closure").ApiOperationBrowserClosureProjection[] }>;
    expect(task5EnvelopeFixture).toEqual({ closures: [browser] });
    expect(Object.keys(task5EnvelopeFixture.closures[0]!).sort()).toEqual([
      "archivedAt", "authentication", "authorAnnotation", "connectorDisplayLabel", "connectorId",
      "definitionVersionNumber", "executionAvailability", "lifecycleRevision",
      "method", "path", "reference", "requestSchema", "resultSchema", "systemPolicy",
    ]);
    const task5ReadinessReferences: readonly ApiOperationReference[] = [
      parseApiOperationReference({
        ...pins(closure),
        readinessBinding: { kind: "connection", connectionId: "connection_test_1", capability: "http.headers" },
      }),
      parseApiOperationReference({
        ...pins(closure),
        readinessBinding: { kind: "unresolved", requirementKey: "api:headers", capability: "http.headers" },
      }),
    ];
    expect(task5ReadinessReferences.map(({ readinessBinding }) => readinessBinding)).toEqual([
      { kind: "connection", connectionId: "connection_test_1", capability: "http.headers" },
      { kind: "unresolved", requirementKey: "api:headers", capability: "http.headers" },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);

    for (const key of ["connectorProjectionHash", "operationProjectionHash", "schemaHash"] as const) {
      expect(() => resolveApiOperationClosure(repository, "owner-a", {
        ...pins(closure), [key]: "0".repeat(64),
      })).toThrow(API_OPERATION_ASSET_UNAVAILABLE);
    }
    expect(() => resolveApiOperationClosure({ getOperationClosure: () => null } as unknown as ConnectorRepository, "owner-a", pins(closure)))
      .toThrow(API_OPERATION_ASSET_UNAVAILABLE);
    expect(() => validateApiOperationReference(pins(closure), {
      ...closure,
      identity: { ...closure.identity, id: "00000000-0000-4000-8000-000000000699" },
    })).toThrow(API_OPERATION_ASSET_UNAVAILABLE);
    for (const identity of [
      { ...closure.identity, displayLabel: "" },
      { ...closure.identity, displayLabel: ` ${closure.identity.displayLabel}` },
      { ...closure.identity, displayLabel: "x".repeat(121) },
      { ...closure.identity, lifecycleRevision: 0 },
      { ...closure.identity, lifecycleRevision: 1.5 },
      { ...closure.identity, createdAt: -1 },
      { ...closure.identity, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...closure.identity, createdAt: 2, updatedAt: 1 },
      { ...closure.identity, archivedAt: -1 },
      { ...closure.identity, archivedAt: 2, updatedAt: 1 },
    ]) {
      expect(() => validateApiOperationReference(pins(closure), { ...closure, identity }))
        .toThrow(API_OPERATION_ASSET_UNAVAILABLE);
    }
    expect(() => validateApiOperationReference(pins(closure), {
      ...closure,
      identity: { ...closure.identity, id: "not-a-uuid" },
      definition: { ...closure.definition, connectorId: "not-a-uuid" },
    })).toThrow(API_OPERATION_ASSET_UNAVAILABLE);
    expect(() => validateApiOperationReference({
      ...pins(closure),
      readinessBinding: { kind: "connection", connectionId: "connection_test_1", capability: "http.headers" },
    }, closure)).toThrow(API_OPERATION_ASSET_UNAVAILABLE);
    expect(() => validateApiOperationReference(pins(closure), {
      ...closure,
      definition: {
        ...closure.definition,
        projection: {
          ...closure.definition.projection,
          operations: closure.definition.projection.operations.map((entry) => ({
            ...entry,
            operationProjection: { ...entry.operationProjection, path: "/different" },
          })),
        },
      },
    })).toThrow(API_OPERATION_ASSET_UNAVAILABLE);
  });

  it("resolves request/result schemas only from the validated closure snapshot", () => {
    const closure = compiledClosure();
    const snapshot = resolveApiOperationClosure(
      { getOperationClosure: () => closure } as unknown as ConnectorRepository,
      "owner-a",
      pins(closure),
    );
    const source = graph(pins(closure));
    const resolvePorts = createValidatedNodePortResolver(
      source,
      undefined,
      createApiOperationPortResolver(new Map([["api", projectApiOperationClosureForBrowser(snapshot)]])),
    );
    const resolved = resolvePorts(source.nodes[0]!);
    expect(resolved.inputPorts).toEqual([expect.objectContaining({ id: "request", schema: closure.operation.projection.requestSchema })]);
    expect(resolved.outputPorts).toEqual([expect.objectContaining({ id: "result", schema: closure.operation.projection.resultSchema })]);
    expect(resolved.inputPorts[0]!.schema).toBe(closure.operation.projection.requestSchema);
    expect(resolved.outputPorts[0]!.schema).toBe(closure.operation.projection.resultSchema);
    expect(() => assertGraphPortReferences(source, undefined, resolvePorts)).not.toThrow();
    const observed = vi.fn(resolvePorts);
    expect(validateCallableInterfaceForGraph(source, {
      inputs: [],
      outputs: [{ id: "response", label: "Response", schema: closure.operation.projection.resultSchema, required: true, cardinality: "one", source: { nodeId: "api", portId: "result" } }],
    }, observed)).toHaveProperty("outputs.0.source.portId", "result");
    expect(observed).toHaveBeenCalled();

    const task5AssetOnlyDto = projectApiOperationClosureForBrowser(snapshot);
    expect(task5AssetOnlyDto.reference).not.toHaveProperty("readinessBinding");
    for (const localParams of [
      pins(closure),
      { ...pins(closure), readinessBinding: { kind: "connection" as const, connectionId: "connection_test_1", capability: "http.headers" as const } },
      { ...pins(closure), readinessBinding: { kind: "unresolved" as const, requirementKey: "api:headers", capability: "http.headers" as const } },
    ]) {
      const localGraph = graph(localParams);
      const localResolver = createValidatedNodePortResolver(
        localGraph,
        undefined,
        createApiOperationPortResolver(new Map([["api", task5AssetOnlyDto]])),
      );
      expect(localResolver(localGraph.nodes[0]!).inputPorts[0]?.schema).toBe(task5AssetOnlyDto.requestSchema);
      expect(localResolver(localGraph.nodes[0]!).outputPorts[0]?.schema).toBe(task5AssetOnlyDto.resultSchema);
      expect(localGraph.nodes[0]!.params).toEqual(localParams);
    }
  });

  it("admits api.operation only in schemaVersion 2", () => {
    expect(FlowGraphV2Schema.safeParse(graph()).success).toBe(true);
    const legacy = { id: "legacy", name: "legacy", nodes: [{ id: "api", type: "api.operation", params: pins(), position: { x: 0, y: 0 } }], edges: [] };
    expect(FlowGraphV1Schema.safeParse(legacy).success).toBe(false);
    expect(() => parseSupportedFlowGraph(legacy)).toThrow("API_OPERATION_V1_UNSUPPORTED");
    expect(inspectV2OnlyFeatures(graph())).toEqual(["API_OPERATION_V1_UNSUPPORTED"]);
    expect(downconvertFlowGraph(graph())).toEqual({ ok: false, nonRoundTrippableFeatures: ["API_OPERATION_V1_UNSUPPORTED"] });
    expect(API_OPERATION_V1_UNSUPPORTED_RESULT).toEqual({ ok: false, code: "API_OPERATION_V1_UNSUPPORTED" });
    expect(Object.isFrozen(API_OPERATION_V1_UNSUPPORTED_RESULT)).toBe(true);
  });
});
