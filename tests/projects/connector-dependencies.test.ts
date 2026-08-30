import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import type { ConnectorOperationClosure } from "@/lib/connectors/repository";
import type { FlowGraphV2 } from "@/lib/flow/types";
import {
  derivePinnedConnectorDependencies,
  rejectCallerConnectorDependencies,
} from "@/lib/projects/connector-dependencies";
import { CreateFlowVersionRequestSchema } from "@/lib/projects/request-schema";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { VersionService } from "@/lib/projects/version-service";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";

const OWNER = "owner-connector-pins";
const FOREIGN = "owner-foreign-pins";
const CONNECTOR_ID = "00000000-0000-4000-8000-000000000721";
const DEFINITION_ID = "00000000-0000-4000-8000-000000000722";
const OPERATION_ID = "00000000-0000-4000-8000-000000000723";

function persistOperation(db: Database.Database): ConnectorOperationClosure {
  runSqliteMigrations(db);
  const compiled = compileOpenApi310(JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Pins", version: "1" },
    servers: [{ url: "https://pins.example.com" }],
    paths: {
      "/things": {
        get: {
          operationId: "listThings",
          responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { type: "string" }, maxItems: 2 } } } } },
        },
      },
    },
  }));
  if (!compiled.ok) throw new Error(compiled.code);
  const operation = compiled.operations[0]!;
  const repository = new SqliteConnectorRepository(db);
  const result = repository.immediate((transaction) => transaction.persistCompiledImport({
    ownerId: OWNER,
    connectorId: null,
    newConnectorId: CONNECTOR_ID,
    definitionVersionId: DEFINITION_ID,
    operationVersionId: OPERATION_ID,
    displayLabel: "Pins",
    connectorProjection: compiled.connectorProjection,
    connectorProjectionHash: compiled.connectorProjectionHash,
    operation,
    now: 1,
  }));
  if (result.status !== "ok") throw new Error(result.status);
  return repository.getOperationClosure(OWNER, OPERATION_ID)!;
}

function graph(closure: ConnectorOperationClosure, overrides: Record<string, unknown> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "connector-parent",
    name: "Connector parent",
    nodes: [{
      id: "operation",
      type: "api.operation",
      params: {
        connectorDefinitionVersionId: closure.definition.id,
        operationVersionId: closure.operation.id,
        operationId: closure.operation.operationId,
        connectorProjectionHash: closure.definition.connectorProjectionHash,
        operationProjectionHash: closure.operation.operationProjectionHash,
        schemaHash: closure.operation.schemaHash,
        ...overrides,
      },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

function seedFlow(db: Database.Database, id: string, value: FlowGraphV2): void {
  db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, OWNER, value.name, JSON.stringify(value), 1);
}

describe("server-derived connector dependencies", () => {
  it("rejects every caller connector pin at request, service, and pure boundaries", async () => {
    const dependency = { kind: "connector" as const, resourceId: "forged", version: "latest" };
    expect(CreateFlowVersionRequestSchema.safeParse({ dependencies: [dependency] }).success).toBe(false);
    expect(() => rejectCallerConnectorDependencies([dependency])).toThrow(/connector.*server|caller.*connector/i);

    const db = new Database(":memory:");
    const repo = new SqliteProjectRepo(db);
    const service = new VersionService(repo);
    const closure = persistOperation(db);
    seedFlow(db, "parent", graph(closure));
    await expect(service.createFlowVersion({ flowId: "parent", ownerId: OWNER, dependencies: [dependency] }))
      .rejects.toThrow(/connector.*server|caller.*connector/i);
    await expect(repo.createFlowVersion({ flowId: "parent", ownerId: OWNER, dependencies: [dependency] }))
      .rejects.toThrow(/connector.*server|caller.*connector/i);
    expect(db.prepare("SELECT COUNT(*) count FROM flow_versions").get()).toEqual({ count: 0 });
    db.close();
  });

  it("derives explicit parent, operation, and schema rows after same-owner three-hash validation", () => {
    const db = new Database(":memory:");
    const closure = persistOperation(db);
    const repository = new SqliteConnectorRepository(db);
    expect(derivePinnedConnectorDependencies(graph(closure), OWNER, repository)).toEqual([
      {
        kind: "connector",
        resourceId: `definition/${DEFINITION_ID}`,
        version: DEFINITION_ID,
        contentHash: closure.definition.connectorProjectionHash,
      },
      {
        kind: "connector",
        resourceId: `operation/${OPERATION_ID}`,
        version: OPERATION_ID,
        contentHash: closure.operation.operationProjectionHash,
      },
      {
        kind: "connector",
        resourceId: `schema/${OPERATION_ID}`,
        version: OPERATION_ID,
        contentHash: closure.operation.schemaHash,
      },
    ]);
    expect(() => derivePinnedConnectorDependencies(graph(closure), FOREIGN, repository))
      .toThrow(/asset|connector|unavailable/i);
    expect(() => derivePinnedConnectorDependencies(graph(closure, { schemaHash: "f".repeat(64) }), OWNER, repository))
      .toThrow(/asset|connector|unavailable/i);
    const transactional = repository.immediate((transaction) =>
      transaction.getOperationClosure(OWNER, OPERATION_ID));
    expect(transactional).toMatchObject({
      identity: { lifecycleRevision: 1, archivedAt: null },
      definition: { id: DEFINITION_ID },
      operation: { id: OPERATION_ID },
    });
    const duplicateGraph: FlowGraphV2 = {
      ...graph(closure),
      nodes: [
        ...graph(closure).nodes,
        { ...graph(closure).nodes[0]!, id: "operation-again" },
      ],
    };
    expect(derivePinnedConnectorDependencies(duplicateGraph, OWNER, repository)).toHaveLength(3);
    expect(repository.archive(OWNER, CONNECTOR_ID, 1, 2)).toMatchObject({ status: "updated" });
    expect(repository.immediate((transaction) =>
      transaction.getOperationClosure(OWNER, OPERATION_ID)))
      .toMatchObject({ identity: { lifecycleRevision: 2, archivedAt: 2 } });
    expect(() => derivePinnedConnectorDependencies(graph(closure), OWNER, repository))
      .toThrow(/asset|connector|archived|unavailable/i);
    db.close();
  });

  it("pins exact connector rows atomically for normal versions and checkpoints", async () => {
    const db = new Database(":memory:");
    const repo = new SqliteProjectRepo(db);
    const service = new VersionService(repo);
    const closure = persistOperation(db);
    seedFlow(db, "normal", graph(closure));
    seedFlow(db, "checkpoint", { ...graph(closure), id: "checkpoint", name: "Checkpoint" });

    const normal = await service.createFlowVersion({ flowId: "normal", ownerId: OWNER });
    const checkpoint = await service.createFlowCheckpoint({
      flowId: "checkpoint",
      ownerId: OWNER,
      graph: { ...graph(closure), id: "checkpoint", name: "Checkpoint updated" },
    });
    for (const version of [normal, checkpoint]) {
      expect(version).not.toBeNull();
      expect(version!.dependencies.map(({ kind, resourceId, version, contentHash }) => ({
        kind, resourceId, version, contentHash,
      }))).toEqual(derivePinnedConnectorDependencies(graph(closure), OWNER, new SqliteConnectorRepository(db)));
    }
    db.close();
  });

  it("rolls back graph/version/pins for foreign or drifted assets and pin insert failure", async () => {
    const db = new Database(":memory:");
    const repo = new SqliteProjectRepo(db);
    const service = new VersionService(repo);
    const closure = persistOperation(db);
    const bad = graph(closure, { operationProjectionHash: "e".repeat(64) });
    seedFlow(db, "foreign", bad);
    seedFlow(db, "checkpoint", { ...graph(closure), id: "checkpoint" });
    const before = db.prepare("SELECT graph FROM flows WHERE id = 'checkpoint'").get();

    await expect(service.createFlowVersion({ flowId: "foreign", ownerId: OWNER }))
      .rejects.toThrow(/asset|connector|unavailable/i);
    await expect(service.createFlowCheckpoint({
      flowId: "checkpoint",
      ownerId: OWNER,
      graph: { ...bad, id: "checkpoint", name: "mutated" },
    })).rejects.toThrow(/asset|connector|unavailable/i);
    expect(db.prepare("SELECT graph FROM flows WHERE id = 'checkpoint'").get()).toEqual(before);

    db.exec(`CREATE TRIGGER fail_connector_pin BEFORE INSERT ON dependency_pins
      WHEN NEW.kind = 'connector' BEGIN SELECT RAISE(ABORT, 'pin insert refused'); END;`);
    await expect(service.createFlowVersion({ flowId: "checkpoint", ownerId: OWNER }))
      .rejects.toThrow(/pin insert refused/i);
    expect(db.prepare("SELECT COUNT(*) count FROM flow_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM dependency_pins").get()).toEqual({ count: 0 });
    db.close();
  });

  it("rechecks connector lifecycle after pin writes and rolls back normal and checkpoint saves", async () => {
    const db = new Database(":memory:");
    const repo = new SqliteProjectRepo(db);
    const service = new VersionService(repo);
    const closure = persistOperation(db);
    seedFlow(db, "normal-race", { ...graph(closure), id: "normal-race" });
    seedFlow(db, "checkpoint-race", { ...graph(closure), id: "checkpoint-race" });
    const checkpointBefore = db.prepare("SELECT graph FROM flows WHERE id = 'checkpoint-race'").get();
    db.exec(`CREATE TRIGGER archive_connector_after_pin
      AFTER INSERT ON dependency_pins
      WHEN NEW.kind = 'connector'
      BEGIN
        UPDATE connector_identities
        SET archived_at = NEW.created_at + 1,
            lifecycle_revision = lifecycle_revision + 1,
            updated_at = NEW.created_at + 1
        WHERE owner_id = '${OWNER}' AND id = '${CONNECTOR_ID}';
      END;`);

    await expect(service.createFlowVersion({ flowId: "normal-race", ownerId: OWNER }))
      .rejects.toThrow(/asset|connector|unavailable/i);
    await expect(service.createFlowCheckpoint({
      flowId: "checkpoint-race",
      ownerId: OWNER,
      graph: { ...graph(closure), id: "checkpoint-race", name: "must roll back" },
    })).rejects.toThrow(/asset|connector|unavailable/i);

    expect(db.prepare("SELECT COUNT(*) count FROM flow_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM dependency_pins").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT archived_at, lifecycle_revision FROM connector_identities WHERE id = ?")
      .get(CONNECTOR_ID)).toEqual({ archived_at: null, lifecycle_revision: 1 });
    expect(db.prepare("SELECT graph FROM flows WHERE id = 'checkpoint-race'").get())
      .toEqual(checkpointBefore);
    db.close();
  });
});
