import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApiOperationInspector, {
  boundCompatibleApiOperationConnection,
  compatibleApiOperationConnections,
  redactedIdentifierTag,
} from "@/components/connectors/ApiOperationInspector";
import type { ApiOperationBrowserClosureProjection } from "@/lib/connectors/operation-closure";
import type { ConnectionChoice } from "@/lib/connections/client";
import Inspector from "@/components/canvas/Inspector";
import type { FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";

const closure: ApiOperationBrowserClosureProjection = Object.freeze({
  reference: Object.freeze({
    connectorDefinitionVersionId: "11111111-1111-4111-8111-111111111111",
    operationVersionId: "22222222-2222-4222-8222-222222222222",
    operationId: "listOrders",
    connectorProjectionHash: "a".repeat(64),
    operationProjectionHash: "b".repeat(64),
    schemaHash: "c".repeat(64),
  }),
  connectorId: "33333333-3333-4333-8333-333333abcdef",
  connectorDisplayLabel: "Orders API",
  lifecycleRevision: 3,
  archivedAt: null,
  definitionVersionNumber: 4,
  method: "GET",
  path: "/orders/{orderId}",
  authentication: Object.freeze({ kind: "api_key_header", headerName: "x-api-key" }),
  requestSchema: Object.freeze({ type: "object" as const, properties: { orderId: { type: "string" as const } } }),
  resultSchema: Object.freeze({ type: "object" as const, properties: { state: { type: "string" as const } } }),
  systemPolicy: Object.freeze({ effects: Object.freeze(["write"] as const), retry: "unsafe", cost: "unknown", idempotency: "none" }),
  authorAnnotation: Object.freeze({ label: "Unverified", effectNote: "Vendor says this is read-only." }),
  executionAvailability: "simulation_only",
});

const connections = Object.freeze([
  Object.freeze({ id: "wrong", label: "Bearer", kind: "bearer" as const, publicHeaderNames: Object.freeze(["authorization"]), lifecycleRevision: 1, slots: Object.freeze({ test: "configured" as const, live: "missing" as const }) }),
  Object.freeze({ id: "right", label: "Orders key", kind: "api_key" as const, publicHeaderNames: Object.freeze(["x-api-key"]), lifecycleRevision: 2, slots: Object.freeze({ test: "configured" as const, live: "missing" as const }) }),
]) satisfies readonly ConnectionChoice[];

describe("API operation Inspector", () => {
  it("shows immutable trusted receipts and separate actions without full IDs or values", () => {
    const onSimulate = vi.fn();
    const onCheckReadiness = vi.fn();
    const markup = renderToStaticMarkup(createElement(ApiOperationInspector, {
      closure,
      connectionChoices: connections,
      readinessBinding: undefined,
      disabledReason: null,
      simulation: { status: "idle" },
      readiness: { status: "idle" },
      onReadinessBindingChange: () => undefined,
      onSimulate,
      onCheckReadiness,
    }));

    expect(markup).toContain("Prototype: simulation only");
    expect(markup).toContain("Cannot run in published workflows");
    expect(markup).toContain("Orders API · …abcdef");
    expect(markup).toContain("Projection hash");
    expect(markup).toContain("Connector projection hash");
    expect(markup).toContain("Schema hash");
    expect(markup).toContain("…111111");
    expect(markup).toContain("…222222");
    expect(markup).toContain("listOrders");
    expect(markup).toContain("untrusted public metadata");
    expect(markup).toContain("write / unsafe / unknown / none");
    expect(markup).toContain("Unverified");
    expect(markup).toContain("Simulate workflow");
    expect(markup).toContain("Check Test readiness");
    expect(markup).not.toContain(closure.connectorId);
    expect(markup).not.toContain(closure.reference.operationVersionId);
    expect(markup).not.toContain("Vendor says this is read-only." + closure.reference.schemaHash);
  });

  it("filters connection metadata by exact auth kind and public header names", () => {
    expect(compatibleApiOperationConnections(closure.authentication, connections).map(({ id }) => id)).toEqual(["right"]);
  });

  it("selects the bound connection revision independently from the connector revision", () => {
    const revisionNine = { ...connections[1]!, lifecycleRevision: 9 };
    const selected = boundCompatibleApiOperationConnection(
      closure.authentication,
      { kind: "connection", connectionId: revisionNine.id, capability: "http.headers" },
      [revisionNine],
    );
    expect(closure.lifecycleRevision).toBe(3);
    expect(selected?.lifecycleRevision).toBe(9);
  });

  it("matches bearer, basic, API key, custom-header, and no-auth metadata fail closed", () => {
    const matrix = Object.freeze([
      ...connections,
      Object.freeze({ id: "basic", label: "Basic", kind: "basic" as const, publicHeaderNames: Object.freeze(["Authorization"]), lifecycleRevision: 1, slots: Object.freeze({ test: "configured" as const, live: "missing" as const }) }),
      Object.freeze({ id: "custom-key", label: "Custom key", kind: "custom_headers" as const, publicHeaderNames: Object.freeze(["X-API-Key"]), lifecycleRevision: 1, slots: Object.freeze({ test: "configured" as const, live: "missing" as const }) }),
      Object.freeze({ id: "custom-extra", label: "Custom extra", kind: "custom_headers" as const, publicHeaderNames: Object.freeze(["x-api-key", "x-extra"]), lifecycleRevision: 1, slots: Object.freeze({ test: "configured" as const, live: "missing" as const }) }),
    ]) satisfies readonly ConnectionChoice[];

    expect(compatibleApiOperationConnections({ kind: "http_bearer" }, matrix).map(({ id }) => id)).toEqual(["wrong"]);
    expect(compatibleApiOperationConnections({ kind: "http_basic" }, matrix).map(({ id }) => id)).toEqual(["basic"]);
    expect(compatibleApiOperationConnections({ kind: "api_key_header", headerName: "x-api-key" }, matrix).map(({ id }) => id)).toEqual(["right", "custom-key"]);
    expect(compatibleApiOperationConnections({ kind: "none" }, matrix)).toEqual([]);
  });

  it("repairs a stale stored binding while keeping simulation independently available", () => {
    const staleConnectionId = "stale-connection-id-must-not-render";
    const markup = renderToStaticMarkup(createElement(ApiOperationInspector, {
      closure,
      connectionChoices: connections,
      readinessBinding: { kind: "connection", connectionId: staleConnectionId, capability: "http.headers" },
      disabledReason: null,
      simulation: { status: "idle" },
      readiness: { status: "idle" },
      onReadinessBindingChange: () => undefined,
      onSimulate: () => undefined,
      onCheckReadiness: () => undefined,
    }));

    expect(markup).toContain("The saved Test connection is unavailable or incompatible");
    expect(markup).toContain("Simulation remains available");
    expect(markup).toMatch(/<button[^>]*>Simulate workflow<\/button>/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Check Test readiness<\/button>/u);
    expect(markup).not.toContain(staleConnectionId);
  });

  it("disambiguates duplicate connection names with short IDs without exposing full IDs", () => {
    const duplicateId = "44444444-4444-4444-8444-444444000003";
    const markup = renderToStaticMarkup(createElement(ApiOperationInspector, {
      closure,
      connectionChoices: [...connections, { ...connections[1]!, id: duplicateId }],
      readinessBinding: undefined,
      disabledReason: null,
      simulation: { status: "idle" },
      readiness: { status: "idle" },
      onReadinessBindingChange: () => undefined,
      onSimulate: () => undefined,
      onCheckReadiness: () => undefined,
    }));

    expect(markup).toContain(`Orders key · …${redactedIdentifierTag("right")}`);
    expect(markup).toContain("Orders key · …000003");
    expect(redactedIdentifierTag("right")).not.toContain("right");
    expect(markup).not.toContain("…right");
    expect(markup).not.toContain(duplicateId);
  });

  it("exposes independent busy states without blocking the other action", () => {
    const baseProps = {
      closure,
      connectionChoices: connections,
      readinessBinding: { kind: "connection" as const, connectionId: "right", capability: "http.headers" as const },
      disabledReason: null,
      onReadinessBindingChange: () => undefined,
      onSimulate: () => undefined,
      onCheckReadiness: () => undefined,
    };
    const simulationBusy = renderToStaticMarkup(createElement(ApiOperationInspector, {
      ...baseProps,
      simulation: { status: "busy" },
      readiness: { status: "idle" },
    }));
    const readinessBusy = renderToStaticMarkup(createElement(ApiOperationInspector, {
      ...baseProps,
      simulation: { status: "idle" },
      readiness: { status: "busy" },
    }));

    expect(simulationBusy).toMatch(/aria-busy="true"[^>]*disabled=""[^>]*>Simulating…<\/button>/u);
    expect(simulationBusy).toMatch(/aria-busy="false"[^>]*>Check Test readiness<\/button>/u);
    expect(readinessBusy).toMatch(/aria-busy="false"[^>]*>Simulate workflow<\/button>/u);
    expect(readinessBusy).toMatch(/aria-busy="true"[^>]*disabled=""[^>]*>Checking…<\/button>/u);
  });

  it("shows fixed loading state without falsely declaring an existing binding incompatible", () => {
    const markup = renderToStaticMarkup(createElement(ApiOperationInspector, {
      closure,
      connectionChoices: [],
      connectionChoicesStatus: "loading",
      readinessBinding: { kind: "connection", connectionId: "right", capability: "http.headers" },
      disabledReason: null,
      simulation: { status: "idle" },
      readiness: { status: "idle" },
      onReadinessBindingChange: () => undefined,
      onSimulate: () => undefined,
      onCheckReadiness: () => undefined,
    }));

    expect(markup).toContain("Loading Test connection metadata");
    expect(markup).toContain("Simulation remains available");
    expect(markup).not.toContain("saved Test connection is unavailable or incompatible");
    expect(markup).toMatch(/aria-busy="false"[^>]*>Simulate workflow<\/button>/u);
    expect(markup).toMatch(/aria-busy="false"[^>]*disabled=""[^>]*>Check Test readiness<\/button>/u);
  });

  it("mounts no specialized placeholder or actions when the feature action model is absent", () => {
    const apiNode: FlowNodeV2 = { id: "operation", type: "api.operation", params: closure.reference, bindings: {}, position: { x: 0, y: 0 } };
    const apiGraph: FlowGraphV2 = { schemaVersion: 2, id: "flow", name: "Flow", nodes: [apiNode], edges: [], variables: [], groups: [], annotations: [] };
    const before = JSON.stringify(apiGraph);
    const markup = renderToStaticMarkup(createElement(Inspector, {
      node: apiNode,
      graph: apiGraph,
      graphVersion: 2,
      onCallableInterfaceSet: () => undefined,
      onCallableInterfaceRemove: () => undefined,
    }));
    expect(markup).not.toContain("Prototype: simulation only");
    expect(markup).not.toContain("Cannot run in published workflows");
    expect(markup).not.toContain("Simulate workflow");
    expect(markup).not.toContain("Check Test readiness");
    expect(markup).not.toContain("API operation details");
    expect(markup).not.toContain("API operation ports are unavailable");
    expect(JSON.stringify(apiGraph)).toBe(before);
  });
});
