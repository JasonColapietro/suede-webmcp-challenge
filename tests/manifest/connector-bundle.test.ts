import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";
import type { ConnectorOperationClosure } from "@/lib/connectors/repository";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { codegen } from "@/lib/manifest/codegen";
import { API_OPERATION_V1_UNSUPPORTED } from "@/lib/flow/api-operation-contract";
import type { FlowGraphV2 } from "@/lib/flow/types";
import { flowToManifest } from "@/lib/manifest/from-flow";
import {
  importPortableAgentManifestV2,
  manifestToFlow,
} from "@/lib/manifest/to-flow";
import { parseConnectorDependencyBundles } from "@/lib/manifest/connector-bundle";
import { PortableAgentManifestV2Schema } from "@/lib/manifest/portable-schema";
import {
  AgentManifestV2Schema,
  type AgentManifestV2,
} from "@/lib/manifest/schema";

const EXPORT_OWNER = "owner-export";
const IMPORT_OWNER = "owner-import";
const CONNECTOR_ID = "00000000-0000-4000-8000-000000000701";
const DEFINITION_ID = "00000000-0000-4000-8000-000000000702";
const OPERATION_ID = "00000000-0000-4000-8000-000000000703";

function uncheckedCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(uncheckedCanonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key.normalize("NFC"))}:${uncheckedCanonical(record[key])}`).join(",")}}`;
}

function uncheckedHash(value: unknown): string {
  return createHash("sha256").update(uncheckedCanonical(value)).digest("hex");
}

function compiledClosure(): ConnectorOperationClosure {
  const compiled = compileOpenApi310(JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Portable", version: "1" },
    servers: [{ url: "https://portable.example.com" }],
    paths: {
      "/things/{thingId}": {
        post: {
          operationId: "createThing",
          description: "RAW_SOURCE_MUST_NOT_EXPORT",
          security: [{ token: [] }],
          parameters: [
            { in: "path", name: "thingId", required: true, schema: { type: "string" } },
          ],
          responses: {
            "201": {
              description: "created",
              content: { "application/json": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        token: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
  }));
  if (!compiled.ok) throw new Error(compiled.code);
  const operation = compiled.operations[0]!;
  return {
    identity: {
      id: CONNECTOR_ID,
      displayLabel: "Portable",
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

function reference(closure = compiledClosure()) {
  return {
    connectorDefinitionVersionId: closure.definition.id,
    operationVersionId: closure.operation.id,
    operationId: closure.operation.operationId,
    connectorProjectionHash: closure.definition.connectorProjectionHash,
    operationProjectionHash: closure.operation.operationProjectionHash,
    schemaHash: closure.operation.schemaHash,
    readinessBinding: {
      kind: "connection" as const,
      connectionId: "local-connection-must-not-export",
      capability: "http.headers" as const,
    },
  };
}

function graph(closure = compiledClosure()): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "portable-flow",
    name: "Portable flow",
    nodes: [{
      id: "call-api",
      type: "api.operation",
      params: reference(closure),
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function persistClosure(repository: SqliteConnectorRepository, ownerId: string): ConnectorOperationClosure {
  const closure = compiledClosure();
  const result = repository.immediate((transaction) => transaction.persistCompiledImport({
    ownerId,
    connectorId: null,
    newConnectorId: closure.identity.id,
    definitionVersionId: closure.definition.id,
    operationVersionId: closure.operation.id,
    displayLabel: closure.identity.displayLabel,
    connectorProjection: closure.definition.projection,
    connectorProjectionHash: closure.definition.connectorProjectionHash,
    operation: {
      operationId: closure.operation.operationId,
      projection: closure.operation.projection,
      operationProjectionHash: closure.operation.operationProjectionHash,
      schemaHash: closure.operation.schemaHash,
    },
    now: 1,
  }));
  if (result.status !== "ok") throw new Error(result.status);
  return repository.getOperationClosure(ownerId, result.operation.id)!;
}

function exportManifest(closure = compiledClosure()): AgentManifestV2 {
  return flowToManifest(graph(closure), {
    resolveApiOperation: () => closure,
  });
}

describe("portable connector dependency bundles", () => {
  it("exports one canonical sanitized bundle and replaces local bindings with a stable unresolved requirement", () => {
    const closure = compiledClosure();
    const manifest = exportManifest(closure);
    const exportedReference = manifest.graph.nodes[0]!.params;

    expect(manifest.connectorBundles).toEqual([{
      bundleVersion: 1,
      definition: closure.definition,
      operation: closure.operation,
    }]);
    expect(exportedReference).toMatchObject({
      readinessBinding: {
        kind: "unresolved",
        requirementKey: "api.operation:call-api:http.headers",
        capability: "http.headers",
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("local-connection-must-not-export");
    expect(JSON.stringify(manifest)).not.toContain("RAW_SOURCE_MUST_NOT_EXPORT");
    expect(graph(closure).nodes[0]!.params).toEqual(reference(closure));
    expect(AgentManifestV2Schema.parse(manifest)).toBe(manifest);
  });

  it("refuses missing, extra, duplicate, hash-mismatched, and local-binding bundles", () => {
    const closure = compiledClosure();
    const valid = exportManifest();
    const bundle = { bundleVersion: 1 as const, definition: closure.definition, operation: closure.operation };
    const cases: unknown[] = [
      { ...valid, connectorBundles: undefined },
      { ...valid, connectorBundles: [bundle, { ...bundle, operation: { ...bundle.operation, id: "00000000-0000-4000-8000-000000000799" } }] },
      { ...valid, connectorBundles: [bundle, bundle] },
      { ...valid, connectorBundles: [{ ...bundle, operation: { ...bundle.operation, schemaHash: "f".repeat(64) } }] },
      { ...valid, graph: graph() },
    ];
    for (const value of cases) {
      expect(() => AgentManifestV2Schema.parse(value)).toThrow(/connector|bundle|dependenc|hash|binding/i);
    }
  });

  it("keeps the server parser authoritative when graph and bundle forge the same digest", () => {
    const valid = exportManifest();
    const forgedHash = "f".repeat(64);
    const forged = {
      ...valid,
      graph: {
        ...valid.graph,
        nodes: valid.graph.nodes.map((node) => ({
          ...node,
          params: { ...node.params, schemaHash: forgedHash },
        })),
      },
      connectorBundles: valid.connectorBundles!.map((bundle) => ({
        ...bundle,
        operation: { ...bundle.operation, schemaHash: forgedHash },
      })),
    };
    expect(() => PortableAgentManifestV2Schema.parse(forged)).toThrow(/connector|bundle|hash|invalid/i);
  });

  it.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://service.internal",
    "https://xn--mnich-kva.example.com",
  ])("refuses a hash-consistent portable bundle with unsafe origin %s", (origin) => {
    const valid = exportManifest();
    const bundle = valid.connectorBundles![0]!;
    const projection = { ...bundle.definition.projection, origin };
    const connectorProjectionHash = uncheckedHash(projection);
    const hostile = {
      ...valid,
      graph: {
        ...valid.graph,
        nodes: valid.graph.nodes.map((node) => ({
          ...node,
          params: { ...node.params, connectorProjectionHash },
        })),
      },
      connectorBundles: [{
        ...bundle,
        definition: { ...bundle.definition, projection, connectorProjectionHash },
      }],
    };
    expect(() => PortableAgentManifestV2Schema.parse(hostile))
      .toThrow(/connector|bundle|invalid/i);
  });

  it("refuses hostile bundle containers without invoking accessors, proxies, or toJSON", () => {
    const valid = exportManifest();
    const bundle = valid.connectorBundles![0]!;
    let calls = 0;
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, "0", {
      enumerable: true,
      get: () => {
        calls += 1;
        return bundle;
      },
    });
    Object.defineProperty(getterArray, "length", { value: 1 });
    const proxy = new Proxy([bundle], {
      get: () => {
        calls += 1;
        throw new Error("proxy executed");
      },
      getOwnPropertyDescriptor: () => {
        calls += 1;
        throw new Error("proxy executed");
      },
      ownKeys: () => {
        calls += 1;
        throw new Error("proxy executed");
      },
      getPrototypeOf: () => {
        calls += 1;
        throw new Error("proxy executed");
      },
    });
    const withToJson = { ...bundle, toJSON: () => {
      calls += 1;
      return bundle;
    } };
    const withSymbol = [bundle];
    Object.defineProperty(withSymbol, Symbol("hostile"), { value: true });

    for (const connectorBundles of [getterArray, proxy, withToJson, withSymbol, new Array(1)]) {
      expect(() => parseConnectorDependencyBundles(connectorBundles))
        .toThrow(/connector|bundle|dependenc|invalid/i);
    }
    expect(calls).toBe(0);
  });

  it("refuses nested bundle proxies and accessors without invoking either", () => {
    const valid = exportManifest();
    const bundle = valid.connectorBundles![0]!;
    let calls = 0;
    const nestedProxy = new Proxy(bundle.definition.projection, {
      get: () => { calls += 1; throw new Error("nested proxy executed"); },
      ownKeys: () => { calls += 1; throw new Error("nested proxy executed"); },
      getOwnPropertyDescriptor: () => { calls += 1; throw new Error("nested proxy executed"); },
      getPrototypeOf: () => { calls += 1; throw new Error("nested proxy executed"); },
    });
    const proxied = [{
      ...bundle,
      definition: { ...bundle.definition, projection: nestedProxy },
    }];
    const accessorOperation = { ...bundle.operation };
    Object.defineProperty(accessorOperation, "projection", {
      enumerable: true,
      get: () => { calls += 1; return bundle.operation.projection; },
    });

    expect(() => parseConnectorDependencyBundles(proxied)).toThrow(/connector|bundle/i);
    expect(() => parseConnectorDependencyBundles([{ ...bundle, operation: accessorOperation }]))
      .toThrow(/connector|bundle/i);
    expect(() => PortableAgentManifestV2Schema.parse({ ...valid, connectorBundles: proxied }))
      .toThrow(/connector|bundle|invalid/i);
    expect(() => PortableAgentManifestV2Schema.parse({
      ...valid,
      connectorBundles: [{ ...bundle, operation: accessorOperation }],
    })).toThrow(/connector|bundle|invalid/i);
    expect(calls).toBe(0);
  });

  it("recreates owner-local immutable assets, rewrites ids, and keeps rebinding unresolved", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteConnectorRepository(db);
    const exportedClosure = persistClosure(repository, EXPORT_OWNER);
    const manifest = exportManifest(exportedClosure);
    const ids = [
      "00000000-0000-4000-8000-000000000711",
      "00000000-0000-4000-8000-000000000712",
      "00000000-0000-4000-8000-000000000713",
      "00000000-0000-4000-8000-000000000714",
      "00000000-0000-4000-8000-000000000715",
      "00000000-0000-4000-8000-000000000716",
      "00000000-0000-4000-8000-000000000717",
      "00000000-0000-4000-8000-000000000718",
      "00000000-0000-4000-8000-000000000719",
    ];
    let index = 0;

    const imported = importPortableAgentManifestV2(manifest, {
      ownerId: IMPORT_OWNER,
      actorId: "actor-import",
      repository,
      now: 2,
      createId: () => ids[index++]!,
    });
    const importedReference = imported.nodes[0]!.params as typeof reference extends (...args: never[]) => infer R ? R : never;
    expect(importedReference.operationVersionId).not.toBe(OPERATION_ID);
    expect(importedReference.connectorDefinitionVersionId).not.toBe(DEFINITION_ID);
    expect(importedReference.readinessBinding).toEqual({
      kind: "unresolved",
      requirementKey: "api.operation:call-api:http.headers",
      capability: "http.headers",
    });
    expect(repository.getOperationClosure(IMPORT_OWNER, importedReference.operationVersionId))
      .toMatchObject({
        definition: { connectorProjectionHash: exportedClosure.definition.connectorProjectionHash },
        operation: {
          operationProjectionHash: exportedClosure.operation.operationProjectionHash,
          schemaHash: exportedClosure.operation.schemaHash,
        },
      });
    expect(repository.getOperationClosure(EXPORT_OWNER, importedReference.operationVersionId)).toBeNull();
    const firstAudit = db.prepare(`SELECT actor_id, correlation_id, action, outcome,
      resource_id, projection_hash, schema_hash, egress_count, cost_micro_usdc
      FROM control_audit_events WHERE owner_id = ? ORDER BY action`).all(IMPORT_OWNER) as Array<Record<string, unknown>>;
    expect(firstAudit).toHaveLength(2);
    expect(new Set(firstAudit.map((event) => event.correlation_id)).size).toBe(1);
    expect(firstAudit.map((event) => event.action)).toEqual(["connector.import", "connector.operation.create"]);
    expect(firstAudit.every((event) => event.actor_id === "actor-import" && event.outcome === "completed" &&
      event.egress_count === 0 && event.cost_micro_usdc === 0)).toBe(true);
    expect(JSON.stringify(firstAudit)).not.toContain("local-connection-must-not-export");

    const firstIds = {
      definition: importedReference.connectorDefinitionVersionId,
      operation: importedReference.operationVersionId,
    };
    const firstClosure = repository.getOperationClosure(IMPORT_OWNER, firstIds.operation)!;
    expect(repository.archive(
      IMPORT_OWNER,
      firstClosure.definition.connectorId,
      firstClosure.identity.lifecycleRevision,
      3,
    )).toMatchObject({ status: "updated" });
    const importedAgain = importPortableAgentManifestV2(manifest, {
      ownerId: IMPORT_OWNER,
      actorId: "actor-import",
      repository,
      now: 4,
      createId: () => ids[index++]!,
    });
    expect(importedAgain.nodes[0]!.params).not.toMatchObject({
      connectorDefinitionVersionId: firstIds.definition,
      operationVersionId: firstIds.operation,
    });
    const activeReference = importedAgain.nodes[0]!.params as { operationVersionId: string };
    expect(repository.getOperationClosure(IMPORT_OWNER, activeReference.operationVersionId))
      .toMatchObject({ identity: { archivedAt: null, lifecycleRevision: 1 } });

    const boundedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "listConnectorIdentities" || property === "listDefinitionHistoryPage") {
          return () => { throw new Error("unbounded history scan"); };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => importPortableAgentManifestV2(manifest, {
      ownerId: IMPORT_OWNER,
      actorId: "actor-import",
      repository: boundedRepository,
      now: 5,
      createId: () => ids[index++]!,
    })).not.toThrow();
    const grouped = db.prepare(`SELECT correlation_id, COUNT(*) count FROM control_audit_events
      WHERE owner_id = ? GROUP BY correlation_id ORDER BY correlation_id`).all(IMPORT_OWNER) as Array<{ count: number }>;
    expect(grouped).toHaveLength(3);
    expect(grouped.every(({ count }) => count === 2)).toBe(true);
    expect(manifestToFlow(flowToManifest(importedAgain))).toBeTypeOf("object");
    db.close();
  });

  it("skips annotation-conflicting reuse candidates and creates a new identity when none match", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteConnectorRepository(db);
    const base = compiledClosure();
    const annotations = [
      { label: "Unverified" as const, effectNote: "candidate-a" },
      { label: "Unverified" as const, effectNote: "candidate-b" },
      { label: "Unverified" as const, effectNote: "candidate-c" },
    ];
    const persistCandidate = (suffix: string, annotation: typeof annotations[number]) => {
      const result = repository.immediate((transaction) => transaction.persistCompiledImport({
        ownerId: IMPORT_OWNER,
        connectorId: null,
        newConnectorId: `00000000-0000-4000-8000-0000000008${suffix}1`,
        definitionVersionId: `00000000-0000-4000-8000-0000000008${suffix}2`,
        operationVersionId: `00000000-0000-4000-8000-0000000008${suffix}3`,
        displayLabel: `Candidate ${suffix}`,
        connectorProjection: base.definition.projection,
        connectorProjectionHash: base.definition.connectorProjectionHash,
        operation: {
          operationId: base.operation.operationId,
          projection: base.operation.projection,
          operationProjectionHash: base.operation.operationProjectionHash,
          schemaHash: base.operation.schemaHash,
        },
        authorAnnotation: annotation,
        now: Number(suffix),
      }));
      if (result.status !== "ok") throw new Error(result.status);
      return result;
    };
    const candidateA = persistCandidate("1", annotations[0]!);
    const candidateB = persistCandidate("2", annotations[1]!);
    const manifestFor = (annotation: typeof annotations[number]) => exportManifest({
      ...base,
      operation: { ...base.operation, authorAnnotation: annotation },
    });
    const ids = [
      "00000000-0000-4000-8000-000000000891",
      "00000000-0000-4000-8000-000000000892",
      "00000000-0000-4000-8000-000000000893",
      "00000000-0000-4000-8000-000000000894",
      "00000000-0000-4000-8000-000000000895",
      "00000000-0000-4000-8000-000000000896",
    ];
    let idIndex = 0;
    const reused = importPortableAgentManifestV2(manifestFor(annotations[1]!), {
      ownerId: IMPORT_OWNER,
      actorId: "actor-import",
      repository,
      now: 10,
      createId: () => ids[idIndex++]!,
    });
    expect(reused.nodes[0]!.params).toMatchObject({
      connectorDefinitionVersionId: candidateB.definition.id,
      operationVersionId: candidateB.operation.id,
    });
    expect(reused.nodes[0]!.params).not.toMatchObject({
      connectorDefinitionVersionId: candidateA.definition.id,
    });

    const created = importPortableAgentManifestV2(manifestFor(annotations[2]!), {
      ownerId: IMPORT_OWNER,
      actorId: "actor-import",
      repository,
      now: 11,
      createId: () => ids[idIndex++]!,
    });
    expect(created.nodes[0]!.params).toMatchObject({
      connectorDefinitionVersionId: ids[4],
      operationVersionId: ids[5],
    });
    db.close();
  });

  it("leaves v2 manifests without api.operation byte-identical", () => {
    const plain: FlowGraphV2 = {
      ...graph(),
      nodes: [{ id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
    };
    const before = JSON.stringify(plain);
    const manifest = flowToManifest(plain, {
      versionMetadata: {
        dependencies: [{ kind: "connector", resourceId: "legacy", version: "1" }],
      },
    });
    expect(manifest).not.toHaveProperty("connectorBundles");
    expect(manifest.dependencies).toEqual([
      { kind: "connector", resourceId: "legacy", version: "1" },
    ]);
    expect(JSON.stringify(manifest.graph)).toBe(before);
    expect(JSON.stringify(manifestToFlow(manifest))).toBe(before);
  });

  it("rolls back every imported asset when lifecycle changes before the transaction returns", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteConnectorRepository(db);
    const exportedClosure = persistClosure(repository, EXPORT_OWNER);
    const manifest = exportManifest(exportedClosure);
    const before = {
      identities: (db.prepare("SELECT COUNT(*) count FROM connector_identities").get() as { count: number }).count,
      definitions: (db.prepare("SELECT COUNT(*) count FROM connector_definition_versions").get() as { count: number }).count,
      operations: (db.prepare("SELECT COUNT(*) count FROM connector_operation_versions").get() as { count: number }).count,
    };
    db.exec(`CREATE TRIGGER archive_during_portable_import
      AFTER INSERT ON connector_operation_versions
      WHEN NEW.owner_id = 'owner-import-drift'
      BEGIN
        UPDATE connector_identities
        SET archived_at = NEW.created_at + 1,
            lifecycle_revision = lifecycle_revision + 1,
            updated_at = NEW.created_at + 1
        WHERE owner_id = NEW.owner_id
          AND id = (SELECT connector_id FROM connector_definition_versions WHERE id = NEW.connector_definition_version_id);
      END;`);
    const ids = [
      "00000000-0000-4000-8000-000000000731",
      "00000000-0000-4000-8000-000000000732",
      "00000000-0000-4000-8000-000000000733",
    ];
    let index = 0;
    expect(() => importPortableAgentManifestV2(manifest, {
      ownerId: "owner-import-drift",
      actorId: "actor-import",
      repository,
      now: 10,
      createId: () => ids[index++]!,
    })).toThrow(/portable connector import refused/i);
    expect(db.prepare("SELECT COUNT(*) count FROM connector_identities").get())
      .toEqual({ count: before.identities });
    expect(db.prepare("SELECT COUNT(*) count FROM connector_definition_versions").get())
      .toEqual({ count: before.definitions });
    expect(db.prepare("SELECT COUNT(*) count FROM connector_operation_versions").get())
      .toEqual({ count: before.operations });
    db.close();
  });

  it("rolls back assets and emits no partial evidence when either portable audit append fails", () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repository = new SqliteConnectorRepository(db);
    const manifest = exportManifest(persistClosure(repository, EXPORT_OWNER));
    const before = Object.fromEntries([
      "connector_identities", "connector_definition_versions", "connector_operation_versions",
      "control_audit_events", "flows", "flow_versions", "dependency_pins",
    ].map((table) => [table, (db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count]));
    db.exec(`CREATE TRIGGER fail_portable_operation_audit BEFORE INSERT ON control_audit_events
      WHEN NEW.owner_id = 'owner-audit-failure' AND NEW.action = 'connector.operation.create'
      BEGIN SELECT RAISE(ABORT, 'injected portable audit failure'); END;`);
    const ids = [
      "00000000-0000-4000-8000-000000000741",
      "00000000-0000-4000-8000-000000000742",
      "00000000-0000-4000-8000-000000000743",
    ];
    let index = 0;
    expect(() => importPortableAgentManifestV2(manifest, {
      ownerId: "owner-audit-failure",
      actorId: "actor-audit-failure",
      repository,
      now: 12,
      createId: () => ids[index++]!,
    })).toThrow(/portable connector import refused/i);
    for (const [table, count] of Object.entries(before)) {
      expect(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(), table).toEqual({ count });
    }
    db.close();
  });

  it("uses the fixed v1 refusal before any lossy code generation", () => {
    let refusal: unknown;
    try {
      codegen(exportManifest());
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: API_OPERATION_V1_UNSUPPORTED });
  });

  it("refuses direct legacy api.operation manifests and graphs with the fixed code", () => {
    const legacyManifest = {
      manifestVersion: 1 as const,
      name: "Legacy operation",
      description: "",
      triggers: [{ kind: "manual" as const }],
      steps: [{ id: "api", type: "api.operation", config: {}, after: [] }],
      meta: {},
    };
    const legacyGraph = {
      id: "legacy-operation",
      name: "Legacy operation",
      nodes: [{ id: "api", type: "api.operation", params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    for (const invoke of [
      () => manifestToFlow(legacyManifest),
      () => flowToManifest(legacyGraph as never),
      () => codegen(legacyManifest),
    ]) {
      let refusal: unknown;
      try { invoke(); } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ code: API_OPERATION_V1_UNSUPPORTED });
    }
  });
});
