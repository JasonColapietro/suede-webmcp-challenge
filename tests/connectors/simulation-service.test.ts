import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditCorrelation } from "@/lib/audit/repository";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";
import type { ConnectorOperationClosure, ConnectorRepository, ConnectorRepositoryTransaction } from "@/lib/connectors/repository";
import { ApiOperationSimulationService } from "@/lib/connectors/simulation-service";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { ControlAuditEventInput } from "@/lib/audit/repository";
import type { FlowGraphV2 } from "@/lib/flow/types";

const IDS = {
  connector: "00000000-0000-4000-8000-000000000101",
  definition: "00000000-0000-4000-8000-000000000102",
  operation: "00000000-0000-4000-8000-000000000103",
  simulation: "00000000-0000-4000-8000-000000000104",
};

function closure(): ConnectorOperationClosure {
  const compiled = compileOpenApi310(JSON.stringify({
    openapi: "3.1.0", info: { title: "Things", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    paths: { "/things/{thingId}": { post: {
      operationId: "createThing",
      parameters: [
        { in: "path", name: "thingId", required: true, schema: { type: "string" } },
        { in: "query", name: "dryRun", required: true, schema: { type: "boolean" } },
      ],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false,
      } } } },
      responses: { "201": { description: "created", content: { "application/json": { schema: {
        type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false,
      } } } } },
    } } },
  }));
  if (!compiled.ok) throw new Error(compiled.code);
  const operation = compiled.operations[0]!;
  return {
    identity: { id: IDS.connector, displayLabel: "Things", archivedAt: null, lifecycleRevision: 1, createdAt: 1, updatedAt: 1 },
    definition: { contractVersion: 1, id: IDS.definition, connectorId: IDS.connector, versionNumber: 1, projection: compiled.connectorProjection, connectorProjectionHash: compiled.connectorProjectionHash, executionAvailability: "simulation_only" },
    operation: { contractVersion: 1, id: IDS.operation, connectorDefinitionVersionId: IDS.definition, operationId: operation.operationId, projection: operation.projection, operationProjectionHash: operation.operationProjectionHash, schemaHash: operation.schemaHash, executionAvailability: "simulation_only" },
  };
}

function graph(asset = closure()): FlowGraphV2 {
  return {
    schemaVersion: 2, id: "flow-a", name: "Simulation", variables: [], groups: [], annotations: [], edges: [],
    nodes: [{
      id: "api", type: "api.operation", position: { x: 0, y: 0 },
      params: {
        connectorDefinitionVersionId: asset.definition.id,
        operationVersionId: asset.operation.id,
        operationId: asset.operation.operationId,
        connectorProjectionHash: asset.definition.connectorProjectionHash,
        operationProjectionHash: asset.operation.operationProjectionHash,
        schemaHash: asset.operation.schemaHash,
      },
      bindings: { request: { kind: "literal", value: {
        path: { thingId: "thing-1" }, query: { dryRun: true }, headers: {}, body: { title: "redacted-title" },
      } } },
    }],
  };
}

function repository(asset: ConnectorOperationClosure, terminal = asset, options: {
  readonly failAudit?: boolean;
  readonly failAfterCompletionAppend?: boolean;
  readonly failFallback?: boolean;
  readonly beforeCompletedAppend?: () => void;
  readonly afterCompletedImmediate?: () => void;
} = {}) {
  const audits: ControlAuditEventInput[] = [];
  let completionFailurePending = options.failAfterCompletionAppend === true;
  const transaction = {
    getOperationClosure: vi.fn(() => terminal),
    appendAudit: vi.fn((input: ControlAuditEventInput) => {
      if (input.outcome === "completed") options.beforeCompletedAppend?.();
      if (options.failAudit || (options.failFallback && input.outcome === "refused")) throw new Error("audit unavailable");
      audits.push(input);
      return {};
    }),
  } as unknown as ConnectorRepositoryTransaction;
  const repo = {
    getOperationClosure: vi.fn(() => asset),
    immediate: vi.fn((work: (tx: ConnectorRepositoryTransaction) => unknown) => {
      const savepoint = audits.length;
      try {
        const result = work(transaction);
        if (completionFailurePending && audits.at(-1)?.outcome === "completed") {
          completionFailurePending = false;
          throw new Error("post-append failure");
        }
        if (audits.at(-1)?.outcome === "completed") options.afterCompletedImmediate?.();
        return result;
      } catch (error) {
        audits.splice(savepoint);
        throw error;
      }
    }),
  } as unknown as ConnectorRepository;
  return { repo, transaction, audits };
}

function service(repo: ConnectorRepository, storedGraph: FlowGraphV2, options: {
  readonly terminalUpdatedAt?: number;
  readonly terminalEnvironmentKind?: "test" | "live";
} = {}) {
  let flowReads = 0;
  let contextReads = 0;
  return new ApiOperationSimulationService({
    flowRepo: { getOwnedFlow: vi.fn(async () => ({
      id: "flow-a", ownerId: "owner-a", name: "Simulation", graph: storedGraph,
      updatedAt: flowReads++ === 0 ? 10 : (options.terminalUpdatedAt ?? 10),
    })) },
    projectRepo: { getFlowContext: vi.fn(async () => ({
      binding: { flowId: "flow-a", projectId: "project-a", workbookId: "workbook-a", createdAt: 1 },
      organization: { id: "organization-a", personalOwnerId: "owner-a", name: "Personal", kind: "personal", createdAt: 1 },
      workspace: { id: "workspace-a", organizationId: "organization-a", name: "Workspace", slug: "workspace", createdAt: 1 },
      project: { id: "project-a", workspaceId: "workspace-a", name: "Project", slug: "project", createdAt: 1, updatedAt: 1 },
      workbook: { id: "workbook-a", projectId: "project-a", name: "Workbook", slug: "workbook", position: 0, createdAt: 1 },
      environments: [{ id: "environment-test", projectId: "project-a", name: "Test", slug: "test", createdAt: 1, kind: contextReads++ === 0 ? "test" : (options.terminalEnvironmentKind ?? "test") }],
    })) } as never,
    connectorRepository: repo,
    now: (() => { let value = 100; return () => value++; })(),
  });
}

const request = { nodeId: "api", scope: "node" as const, environmentId: "environment-test", pinnedInputs: {} };

describe("API operation simulation service", () => {
  it("uses the owner-local stored Draft graph and releases a value-opaque receipt only after terminal audit", async () => {
    const asset = closure();
    const fixture = repository(asset);
    const result = await service(fixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result.ok).toBe(true);
    expect(fixture.audits).toHaveLength(1);
    expect(fixture.audits[0]).toMatchObject({ action: "connector.simulation", outcome: "completed", connection: null });
    expect(JSON.stringify(result)).not.toContain("redacted-title");
    expect(JSON.stringify(result)).not.toContain("thing-1");
  });

  it("maps existing hash/lifecycle drift to a durable refusal", async () => {
    const asset = closure();
    const stale = { ...asset, identity: { ...asset.identity, lifecycleRevision: 2 } };
    const fixture = repository(asset, stale);
    const result = await service(fixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result).toMatchObject({ ok: false, code: "SIMULATION_DRIFT_REFUSED" });
    expect(fixture.audits).toHaveLength(1);
    expect(fixture.audits[0]).toMatchObject({
      outcome: "refused", errorCode: "DRIFT_REFUSED", connection: null,
      resource: {
        versionId: asset.operation.id,
        projectionHash: asset.operation.operationProjectionHash,
        schemaHash: asset.operation.schemaHash,
      },
    });
  });

  it("refuses a mutable Draft or Test-environment race before terminal connector commit", async () => {
    for (const options of [{ terminalUpdatedAt: 11 }, { terminalEnvironmentKind: "live" as const }]) {
      const asset = closure();
      const fixture = repository(asset);
      const result = await service(fixture.repo, graph(asset), options).simulate({
        ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
        correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
        signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
      });
      expect(result).toMatchObject({ ok: false, code: "SIMULATION_DRIFT_REFUSED" });
      expect(fixture.audits.at(-1)).toMatchObject({ outcome: "refused", errorCode: "DRIFT_REFUSED" });
    }
  });

  it("returns AUDIT_UNAVAILABLE and no receipt when terminal evidence cannot commit", async () => {
    const asset = closure();
    const fixture = repository(asset, asset, { failAudit: true });
    const result = await service(fixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result).toEqual({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain(IDS.simulation);
  });

  it("rolls back a failed completion append and leaves exactly one fallback refusal", async () => {
    const asset = closure();
    const fixture = repository(asset, asset, { failAfterCompletionAppend: true });
    const result = await service(fixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result).toMatchObject({ ok: false, code: "SIMULATION_UNAVAILABLE" });
    expect(fixture.audits).toHaveLength(1);
    expect(fixture.audits[0]).toMatchObject({ outcome: "refused", errorCode: "PERSISTENCE_REFUSED", connection: null });
  });

  it("returns only AUDIT_UNAVAILABLE when both completion and fallback refusal cannot commit", async () => {
    const asset = closure();
    const fixture = repository(asset, asset, { failAfterCompletionAppend: true, failFallback: true });
    const result = await service(fixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result).toEqual({ ok: false, code: "AUDIT_UNAVAILABLE" });
    expect(fixture.audits).toEqual([]);
  });

  it("maps trusted deadline cancellation to one TIMEOUT_REFUSED terminal row", async () => {
    const asset = closure();
    const fixture = repository(asset);
    const controller = new AbortController();
    controller.abort("SIMULATION_TIMEOUT");
    const result = await service(fixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: controller.signal, deadlineGeneration: 1, deadlineAtMs: 0,
    });
    expect(result).toMatchObject({ ok: false, code: "SIMULATION_TIMEOUT" });
    expect(fixture.audits).toHaveLength(1);
    expect(fixture.audits[0]).toMatchObject({ outcome: "refused", errorCode: "TIMEOUT_REFUSED", connection: null });
  });

  it("projects away out-of-scope nodes and refuses a second included API operation", async () => {
    const asset = closure();
    const base = graph(asset);
    const canary = "out-of-scope-secret-readiness-canary";
    const outside: FlowGraphV2 = {
      ...base,
      nodes: [...base.nodes, {
        id: "outside", type: "llm", position: { x: 500, y: 500 }, params: { prompt: canary },
        bindings: { token: { kind: "secret", connectionId: canary, field: canary } },
      }],
    };
    const fixture = repository(asset);
    const success = await service(fixture.repo, outside).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(success.ok).toBe(true);
    expect(JSON.stringify(success)).not.toContain(canary);

    const second = { ...base.nodes[0]!, id: "api-two" };
    const included: FlowGraphV2 = {
      ...base,
      nodes: [...base.nodes, second],
      edges: [{ id: "to-second", source: "api", sourceHandle: "result", target: "api-two", targetHandle: "request" }],
    };
    const refusalFixture = repository(asset);
    const refused = await service(refusalFixture.repo, included).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request: { ...request, scope: "from-node" },
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(refused).toMatchObject({ ok: false, code: "SIMULATION_POLICY_REFUSED" });
    expect(refusalFixture.audits).toHaveLength(1);
  });

  it("linearizes precommit cancellation as one refusal and ignores postcommit cancellation", async () => {
    const asset = closure();
    const precommit = new AbortController();
    const precommitFixture = repository(asset, asset, {
      beforeCompletedAppend: () => precommit.abort("SIMULATION_CANCELLED"),
    });
    const refused = await service(precommitFixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: precommit.signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(refused).toMatchObject({ ok: false, code: "SIMULATION_CANCELLED" });
    expect(precommitFixture.audits).toHaveLength(1);
    expect(precommitFixture.audits[0]).toMatchObject({ outcome: "refused", errorCode: "SIMULATION_REFUSED" });

    const postcommit = new AbortController();
    const postcommitFixture = repository(asset, asset, {
      afterCompletedImmediate: () => postcommit.abort("SIMULATION_CANCELLED"),
    });
    const completed = await service(postcommitFixture.repo, graph(asset)).simulate({
      ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
      correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
      signal: postcommit.signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(completed.ok).toBe(true);
    expect(postcommitFixture.audits).toHaveLength(1);
    expect(postcommitFixture.audits[0]).toMatchObject({ outcome: "completed", errorCode: null });
  });

  it("keeps request and sentinel canaries out of real SQLite, WAL, SHM, audit, and receipt bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "simulation-canary-"));
    const filename = join(directory, "connectors.db");
    const db = new Database(filename);
    try {
      db.pragma("journal_mode = WAL");
      runSqliteMigrations(db);
      const repo = new SqliteConnectorRepository(db);
      const asset = closure();
      const persisted = repo.immediate((transaction) => transaction.persistCompiledImport({
        ownerId: "owner-a",
        connectorId: null,
        newConnectorId: asset.identity.id,
        definitionVersionId: asset.definition.id,
        operationVersionId: asset.operation.id,
        displayLabel: asset.identity.displayLabel,
        connectorProjection: asset.definition.projection,
        connectorProjectionHash: asset.definition.connectorProjectionHash,
        operation: {
          operationId: asset.operation.operationId,
          projection: asset.operation.projection,
          operationProjectionHash: asset.operation.operationProjectionHash,
          schemaHash: asset.operation.schemaHash,
        },
        now: 1,
      }));
      expect(persisted.status).toBe("ok");
      const stored = repo.getOperationClosure("owner-a", asset.operation.id);
      if (!stored) throw new Error("missing stored operation");
      const canary = "TASK9_REQUEST_SENTINEL_SECRET_CANARY_91f62d";
      const storedGraph = graph(stored);
      const api = storedGraph.nodes[0]!;
      const canaryGraph: FlowGraphV2 = {
        ...storedGraph,
        nodes: [{ ...api, bindings: { request: { kind: "literal", value: {
          path: { thingId: canary }, query: { dryRun: true }, headers: {}, body: { title: canary },
        } } } }],
      };
      const result = await service(repo, canaryGraph).simulate({
        ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", request,
        correlation: createAuditCorrelation("owner-a", "owner-a"), simulationId: IDS.simulation,
        signal: new AbortController().signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER,
      });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(JSON.stringify(db.prepare("SELECT * FROM control_audit_events WHERE action = 'connector.simulation'").all())).not.toContain(canary);
      db.pragma("wal_checkpoint(PASSIVE)");
      for (const path of [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`]) {
        if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(canary))).toBe(false);
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
