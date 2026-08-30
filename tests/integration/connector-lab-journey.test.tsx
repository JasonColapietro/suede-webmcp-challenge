import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/lib/connectors/flags", () => ({
  get CONNECTOR_LAB_ENABLED() { return flag.enabled; },
  get CONNECTOR_LAB_FLAG() {
    return Object.freeze({ enabled: flag.enabled, badge: "Prototype: simulation only" as const });
  },
}));

import CallableInterfaceEditor from "@/components/canvas/CallableInterfaceEditor";
import RunDock from "@/components/canvas/RunDock";
import ConnectionManager from "@/components/connections/ConnectionManager";
import { createAuditCorrelation } from "@/lib/audit/repository";
import { ConnectorImportService } from "@/lib/connectors/import-service";
import {
  API_OPERATION_LIVE_UNAVAILABLE,
  projectApiOperationClosureForBrowser,
  validateApiOperationReference,
} from "@/lib/connectors/operation-closure";
import { checkTestConnectionReadiness } from "@/lib/connectors/readiness";
import { ApiOperationSimulationService } from "@/lib/connectors/simulation-service";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import {
  commandForApiOperationPick,
  createStudioOperationPortResolver,
} from "@/lib/connectors/studio-authoring";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { FlowMutationService } from "@/lib/flow/flow-mutation-service";
import { projectAvailableNodeDefinitions } from "@/lib/flow/node-definitions";
import { createTestRunUiPlan } from "@/lib/flow/test-run-ui";
import type { FlowGraphV2, FlowNodeV2, JsonValue } from "@/lib/flow/types";
import { DeploymentService } from "@/lib/projects/deployment-service";

const OWNER = "owner-a";
const IDS = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
  "00000000-0000-4000-8000-000000000103",
  "00000000-0000-4000-8000-000000000104",
  "00000000-0000-4000-8000-000000000105",
  "00000000-0000-4000-8000-000000000106",
  "00000000-0000-4000-8000-000000000107",
  "00000000-0000-4000-8000-000000000108",
  "00000000-0000-4000-8000-000000000109",
] as const;

function openApiSource(): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Orders", version: "1" },
    servers: [{ url: "https://orders.example.com" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/orders": {
        get: {
          operationId: "listOrders",
          parameters: [{
            name: "trace",
            in: "query",
            required: true,
            schema: { type: "string" },
          }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                    required: ["ok"],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

function projectContext(graph: FlowGraphV2) {
  return {
    binding: { flowId: graph.id, projectId: "project-a", workbookId: "workbook-a", createdAt: 1 },
    organization: { id: "organization-a", personalOwnerId: OWNER, name: "Personal", kind: "personal", createdAt: 1 },
    workspace: { id: "workspace-a", organizationId: "organization-a", name: "Workspace", slug: "workspace", createdAt: 1 },
    project: { id: "project-a", workspaceId: "workspace-a", name: "Project", slug: "project", createdAt: 1, updatedAt: 1 },
    workbook: { id: "workbook-a", projectId: "project-a", name: "Workbook", slug: "workbook", position: 0, createdAt: 1 },
    environments: [{ id: "environment-test", projectId: "project-a", name: "Test", slug: "test", kind: "test", createdAt: 1 }],
  } as const;
}

describe("Connector Lab local vertical journey", () => {
  it("imports, authors, types, simulates, checks readiness, and refuses publish without egress", async () => {
    flag.enabled = true;
    const database = new Database(":memory:");
    runSqliteMigrations(database);
    const repository = new SqliteConnectorRepository(database);
    let idIndex = 0;
    const importer = new ConnectorImportService(repository, {
      id: () => IDS[idIndex++] ?? `00000000-0000-4000-8000-${String(200 + idIndex).padStart(12, "0")}`,
      now: (() => { let value = 1_000; return () => value++; })(),
    });
    try {
      const imported = importer.importOpenApi({
        ownerId: OWNER,
        actorId: OWNER,
        source: openApiSource(),
        selectedOperationId: "listOrders",
        displayLabel: "Orders API",
      });
      expect(imported).toMatchObject({
        ok: true,
        identityDisposition: "created",
        definitionDisposition: "created",
        operationDisposition: "created",
      });
      if (!imported.ok) throw new Error(imported.code);

      const reference = Object.freeze({
        connectorDefinitionVersionId: imported.definition.id,
        operationVersionId: imported.operation.id,
        operationId: imported.operation.operationId,
        connectorProjectionHash: imported.definition.connectorProjectionHash,
        operationProjectionHash: imported.operation.operationProjectionHash,
        schemaHash: imported.operation.schemaHash,
      });
      const stored = repository.getOperationClosure(OWNER, imported.operation.id);
      if (!stored) throw new Error("missing imported operation closure");
      const closure = projectApiOperationClosureForBrowser(
        validateApiOperationReference(reference, stored),
      );

      const add = commandForApiOperationPick({
        closure,
        position: { x: 100, y: 0 },
        commandId: "add-api",
        nodeId: "api",
      });
      expect(add).toMatchObject({ kind: "node.add", node: { type: "api.operation", bindings: {} } });
      expect(Object.keys(add.node.params)).toHaveLength(6);
      const apiNode = add.node as FlowNodeV2;

      const graph: FlowGraphV2 = {
        schemaVersion: 2,
        id: "flow-a",
        name: "Orders simulation",
        variables: [],
        groups: [],
        annotations: [],
        nodes: [
          { id: "memory-input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
          apiNode,
          { id: "typed-transform", type: "transform", params: { expression: "in.status == 200 ? in.body.ok : false" }, bindings: {}, position: { x: 200, y: 0 } },
          { id: "output", type: "output", params: {}, bindings: {}, position: { x: 300, y: 0 } },
        ],
        edges: [
          { id: "memory-api", source: "memory-input", sourceHandle: "result", target: "api", targetHandle: "request" },
          { id: "api-transform", source: "api", sourceHandle: "result", target: "typed-transform", targetHandle: "in" },
          { id: "transform-output", source: "typed-transform", sourceHandle: "result", target: "output", targetHandle: "in" },
        ],
      };
      const resolvePorts = createStudioOperationPortResolver(
        graph,
        new Map([["api", closure]]),
      );
      const apiPorts = resolvePorts(apiNode);
      expect(apiPorts.inputPorts.map(({ id }) => id)).toEqual(["request"]);
      expect(apiPorts.outputPorts.map(({ id }) => id)).toEqual(["result"]);
      expect(apiPorts.inputPorts[0]?.schema).toEqual(closure.requestSchema);
      expect(apiPorts.outputPorts[0]?.schema).toEqual(closure.resultSchema);

      const callable = renderToStaticMarkup(createElement(CallableInterfaceEditor, {
        graph,
        resolvePorts,
        value: {
          inputs: [],
          outputs: [{
            id: "orders",
            label: "Orders",
            schema: closure.resultSchema as unknown as Readonly<Record<string, JsonValue>>,
            required: true,
            cardinality: "one" as const,
            source: { nodeId: "api", portId: "result" },
          }],
        },
        onSet: () => undefined,
        onRemove: () => undefined,
      }));
      expect(callable).toContain("Result (result)");

      const uiPlan = createTestRunUiPlan(graph, { kind: "from-node", nodeId: "api" }, resolvePorts);
      expect(uiPlan.status).toBe("ready");
      if (uiPlan.status !== "ready") throw new Error(uiPlan.message);
      expect(uiPlan.executionOrder).toEqual(["api", "typed-transform", "output"]);
      expect(uiPlan.pins).toHaveLength(1);
      expect(uiPlan.pins[0]).toMatchObject({ kind: "edge-input", label: "memory-input.result → api.request" });
      const memoryOnlyRequest: JsonValue = {
        path: {},
        query: { trace: "MEMORY_ONLY_BOUNDARY_CANARY" },
        headers: {},
      };
      const pinnedInputs = Object.freeze({ [uiPlan.pins[0]!.key]: memoryOnlyRequest });

      const context = projectContext(graph);
      const simulation = new ApiOperationSimulationService({
        flowRepo: { getOwnedFlow: vi.fn(async () => ({
          id: graph.id,
          ownerId: OWNER,
          name: graph.name,
          graph,
          updatedAt: 10,
        })) },
        projectRepo: { getFlowContext: vi.fn(async () => context) } as never,
        connectorRepository: repository,
        now: (() => { let value = 2_000; return () => value++; })(),
      });
      const originalFetch = globalThis.fetch;
      const hostileFetch = vi.fn(async () => { throw new Error("network must remain closed"); });
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: hostileFetch });
      let result;
      try {
        result = await simulation.simulate({
          ownerId: OWNER,
          actorId: OWNER,
          flowId: graph.id,
          request: {
            nodeId: "api",
            scope: "from-node",
            environmentId: "environment-test",
            pinnedInputs,
          },
          correlation: createAuditCorrelation(OWNER, OWNER),
          simulationId: IDS[8],
          signal: new AbortController().signal,
          deadlineGeneration: 1,
          deadlineAtMs: performance.now() + 10_000,
        });
      } finally {
        Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: originalFetch });
      }
      expect(hostileFetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: true,
        receipt: {
          message: "Simulated locally. No request sent.",
          execution: { plannedNodeCount: 3, completedNodeCount: 3 },
          egressCount: 0,
          costUsdc: 0,
        },
      });
      if (!result?.ok) throw new Error(result?.code ?? "simulation failed");
      expect(JSON.stringify(result)).not.toContain("MEMORY_ONLY_BOUNDARY_CANARY");
      expect(JSON.stringify(database.prepare("SELECT * FROM control_audit_events").all()))
        .not.toContain("MEMORY_ONLY_BOUNDARY_CANARY");

      const dock = renderToStaticMarkup(createElement(RunDock, {
        flowId: graph.id,
        immutableVersionStatus: "ready",
        immutableVersion: { id: "version-a", versionNumber: 1 },
        testScope: null,
        apiOperationSimulation: { status: "success", receipt: result.receipt },
      }));
      expect(dock).toContain("Simulated locally. No request sent.");
      expect(dock).toContain("0 egress");
      expect(dock).toContain("0 USDC");
      expect(dock).not.toContain("MEMORY_ONLY_BOUNDARY_CANARY");
      expect(dock).not.toContain("Test outputs");

      const readTestMetadata = vi.fn(() => ({
        kind: "bearer" as const,
        publicHeaderNames: Object.freeze(["authorization"]),
        lifecycleRevision: 7,
        testSlotStatus: "configured" as const,
        idSuffix: "deadbeef",
      }));
      const readiness = checkTestConnectionReadiness({
        ownerId: OWNER,
        operation: {
          reference: {
            ...reference,
            readinessBinding: { kind: "connection", connectionId: "connection-a", capability: "http.headers" },
          },
          authentication: closure.authentication,
          archived: false,
        },
        reader: { readTestMetadata },
        expectedLifecycleRevision: 7,
      });
      expect(readiness).toMatchObject({
        ok: true,
        receipt: {
          message: "Test slot configured. Authentication unverified.",
          authentication: "unverified",
          egressCount: 0,
          costUsdc: 0,
        },
      });
      expect(readTestMetadata).toHaveBeenCalledTimes(2);
      expect(readTestMetadata).toHaveBeenCalledWith(OWNER, "connection-a");

      const deployVersion = vi.fn();
      const deployment = new DeploymentService({
        getFlowVersion: vi.fn(async () => ({ graph })),
        deployVersion,
      } as never);
      await expect(deployment.deployVersion({
        flowId: graph.id,
        versionId: "version-a",
        versionSemanticHash: "a".repeat(64),
        versionFullHash: "b".repeat(64),
        environmentId: "environment-live",
        environmentKind: "live",
        expectedActiveDeploymentId: null,
        sourceTestDeploymentId: "deployment-test",
        confirmation: "PROMOTE LIVE",
        ownerId: OWNER,
      })).resolves.toEqual({ status: API_OPERATION_LIVE_UNAVAILABLE });
      expect(deployVersion).not.toHaveBeenCalled();
    } finally {
      repository.close();
    }
  });

  it("removes every flag-off page, palette, Studio action, and API entry before side effects", async () => {
    flag.enabled = false;
    expect(projectAvailableNodeDefinitions({ enabled: false }, "visible")
      .some(({ type }) => type === "api.operation")).toBe(false);
    expect(projectAvailableNodeDefinitions({ enabled: false }, "executable")
      .some(({ type }) => type === "api.operation")).toBe(false);

    const manager = renderToStaticMarkup(createElement(ConnectionManager, {
      client: {} as never,
      connectorLabEnabled: false,
    }));
    expect(manager).not.toContain("Connector Lab");
    expect(manager).not.toContain("Import API");

    const { default: NodePalette } = await import("@/components/canvas/NodePalette");
    const palette = renderToStaticMarkup(createElement(NodePalette, {
      onAdd: vi.fn(),
      onBrowseApiOperations: vi.fn(),
    }));
    expect(palette).not.toContain("API Operation");
    expect(palette).not.toContain("Prototype: simulation only");

    const disabledGraph: FlowGraphV2 = {
      schemaVersion: 2,
      id: "flow-disabled",
      name: "Disabled",
      nodes: [{
        id: "api",
        type: "api.operation",
        params: {
          connectorDefinitionVersionId: IDS[0],
          operationVersionId: IDS[1],
          operationId: "listOrders",
          connectorProjectionHash: "a".repeat(64),
          operationProjectionHash: "b".repeat(64),
          schemaHash: "c".repeat(64),
        },
        bindings: {},
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [],
      groups: [],
      annotations: [],
    };
    const mutateFlow = vi.fn();
    await expect(new FlowMutationService({ mutateFlow } as never, { enabled: false }).save({
      id: disabledGraph.id,
      mustExist: true,
      ownerId: OWNER,
      name: disabledGraph.name,
      graph: disabledGraph,
    })).resolves.toEqual({ status: "invalid-reference" });
    expect(mutateFlow).not.toHaveBeenCalled();

    const { default: ImportApiPage } = await import("@/app/connections/import-api/page");
    expect(() => ImportApiPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/iu);

    class ObservedRequest extends Request {
      reads = 0;
      override get body(): Request["body"] { this.reads += 1; return super.body; }
    }
    const incoming = new ObservedRequest("https://studio.test/api/v2/connectors/openapi", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ source: openApiSource(), displayLabel: "Orders" }),
    });
    const route = await import("@/app/api/v2/connectors/openapi/route");
    const response = await route.POST(incoming);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404,
      body: { error: "not found" },
    });
    expect(incoming.reads).toBe(0);
  });
});
