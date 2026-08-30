import Database from "better-sqlite3";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";
import type { ConnectorOperationClosure } from "@/lib/connectors/repository";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { hashFlowGraph } from "@/lib/projects/hash";
import { API_OPERATION_LIVE_UNAVAILABLE } from "@/lib/connectors/operation-closure";
import { DeploymentService } from "@/lib/projects/deployment-service";
import type { DeployVersionInput } from "@/lib/projects/deployment-service";
import type { DeploymentRepo, FlowVersionRepo } from "@/lib/projects/repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type {
  DeploymentRecord,
  EnvironmentKind,
  FlowVersionRecord,
  PersonalContext,
} from "@/lib/projects/types";
import { VersionService } from "@/lib/projects/version-service";

const forbiddenModuleLoaded = vi.hoisted(() => vi.fn());

vi.mock("ai", () => { forbiddenModuleLoaded("ai"); return {}; });
vi.mock("@ai-sdk/openai", () => { forbiddenModuleLoaded("openai"); return {}; });
vi.mock("@ai-sdk/anthropic", () => { forbiddenModuleLoaded("anthropic"); return {}; });
vi.mock("@/lib/llm", () => { forbiddenModuleLoaded("llm"); return {}; });
vi.mock("@/lib/payout", () => { forbiddenModuleLoaded("payout"); return {}; });
vi.mock("@/lib/cli/settlement-handler", () => {
  forbiddenModuleLoaded("settlement");
  return {};
});
vi.mock("@/lib/rails/x402-client", () => { forbiddenModuleLoaded("x402"); return {}; });
vi.mock("@/lib/flow/nodes/schedule", () => {
  forbiddenModuleLoaded("schedule");
  return {};
});
vi.mock("@/lib/cron", () => { forbiddenModuleLoaded("cron"); return {}; });
vi.mock("@/lib/run-service", () => { forbiddenModuleLoaded("run-service"); return {}; });
vi.mock("@/lib/db/repo", () => { forbiddenModuleLoaded("global-repo"); return {}; });

function graph(revision = 1): FlowGraph {
  return {
    id: "graph-1",
    name: "Deployable flow",
    nodes: [
      {
        id: "input",
        type: "input",
        params: { revision },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
}

function httpGraph(input: {
  headers?: Record<string, string>;
  binding?: FlowGraphV2["nodes"][number]["bindings"][string];
  bindingKey?: string;
} = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "http-graph",
    name: "HTTP graph",
    nodes: [{
      id: "request",
      type: "http",
      params: {
        method: "GET",
        url: "https://example.com",
        headers: input.headers ?? { Accept: "application/json", "X-Request-Id": "safe-id" },
      },
      bindings: input.binding
        ? { [input.bindingKey ?? "headers"]: input.binding }
        : {},
      position: { x: 0, y: 0 },
    }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

function versionForGraph(graphValue: FlowGraph | FlowGraphV2): FlowVersionRecord {
  return {
    id: "version-1",
    flowId: "flow-1",
    versionNumber: 1,
    schemaVersion: "schemaVersion" in graphValue && graphValue.schemaVersion === 2 ? 2 : 1,
    graph: graphValue,
    semanticHash: hashFlowGraph(graphValue, { semantic: true }, []),
    fullHash: hashFlowGraph(graphValue, { semantic: false }, []),
    createdBy: "owner-1",
    createdAt: 1,
    dependencies: [],
  };
}

function mockDeploymentRepo(version: FlowVersionRecord) {
  const deployment: DeploymentRecord = {
    id: "deployment-1", flowId: "flow-1", flowVersionId: version.id,
    environmentId: "environment-1", status: "test", createdAt: 1,
  };
  const repo: DeploymentRepo & Pick<FlowVersionRepo, "getFlowVersion"> = {
    deployVersion: vi.fn().mockResolvedValue({ status: "deployed", deployment }),
    getFlowVersion: vi.fn().mockResolvedValue(version),
    getActiveDeployment: vi.fn().mockResolvedValue(null),
    listDeployments: vi.fn().mockResolvedValue([]),
    retireDeployment: vi.fn().mockResolvedValue(null),
  };
  return { repo, deployment };
}

function promotionInput(version: FlowVersionRecord): DeployVersionInput {
  return {
    flowId: version.flowId,
    versionId: version.id,
    versionSemanticHash: version.semanticHash,
    versionFullHash: version.fullHash,
    environmentId: "environment-1",
    environmentKind: "test",
    expectedActiveDeploymentId: null,
    sourceTestDeploymentId: null,
    confirmation: "PROMOTE TEST",
    ownerId: "owner-1",
  };
}

const API_OPERATION_IDS = {
  connector: "00000000-0000-4000-8000-000000000600",
  definition: "00000000-0000-4000-8000-000000000601",
  operation: "00000000-0000-4000-8000-000000000602",
} as const;

function persistApiOperation(db: Database.Database): ConnectorOperationClosure {
  const compiled = compileOpenApi310(JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Deployment fixture", version: "1" },
    servers: [{ url: "https://deployment.vendor.com" }],
    paths: {
      "/things": {
        post: {
          operationId: "createThing",
          responses: { "204": { description: "created" } },
        },
      },
    },
  }));
  if (!compiled.ok) throw new Error(compiled.code);
  const repository = new SqliteConnectorRepository(db);
  const result = repository.immediate((transaction) => transaction.persistCompiledImport({
    ownerId: "owner-1",
    connectorId: null,
    newConnectorId: API_OPERATION_IDS.connector,
    definitionVersionId: API_OPERATION_IDS.definition,
    operationVersionId: API_OPERATION_IDS.operation,
    displayLabel: "Deployment fixture",
    connectorProjection: compiled.connectorProjection,
    connectorProjectionHash: compiled.connectorProjectionHash,
    operation: compiled.operations[0]!,
    now: 1,
  }));
  if (result.status !== "ok") throw new Error(result.status);
  const closure = repository.getOperationClosure("owner-1", result.operation.id);
  if (!closure) throw new Error("Expected API operation fixture closure");
  return closure;
}

function apiOperationGraph(closure: ConnectorOperationClosure): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "api-graph",
    name: "API graph",
    nodes: [{
      id: "api",
      type: "api.operation",
      params: {
        connectorDefinitionVersionId: closure.definition.id,
        operationVersionId: closure.operation.id,
        operationId: closure.operation.operationId,
        connectorProjectionHash: closure.definition.connectorProjectionHash,
        operationProjectionHash: closure.operation.operationProjectionHash,
        schemaHash: closure.operation.schemaHash,
      },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

function seedFlow(
  db: Database.Database,
  input: { id?: string; ownerId?: string; revision?: number } = {},
): string {
  const id = input.id ?? "flow-1";
  db.prepare(
    "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    id,
    input.ownerId ?? "owner-1",
    "Deployable flow",
    JSON.stringify(graph(input.revision)),
    1,
  );
  return id;
}

function environment(context: PersonalContext, kind: EnvironmentKind) {
  const record = context.environments.find((candidate) => candidate.kind === kind);
  if (!record) throw new Error(`Missing ${kind} environment`);
  return record;
}

function requireVersion(record: FlowVersionRecord | null): FlowVersionRecord {
  if (!record) throw new Error("Expected version");
  return record;
}

function requireDeployment(record: DeploymentRecord | null): DeploymentRecord {
  if (!record) throw new Error("Expected deployment");
  return record;
}

interface LegacyDeployVersionInput {
  readonly flowId: string;
  readonly versionId: string;
  readonly environmentId: string;
  readonly ownerId: string;
}

/** Keeps the pre-hardening scenarios readable while sending the strict contract to production code. */
class DeploymentTestHarness {
  private readonly service: DeploymentService;

  constructor(
    repo: DeploymentRepo & Pick<FlowVersionRepo, "getFlowVersion">,
    private readonly db: Database.Database,
  ) {
    this.service = new DeploymentService(repo);
  }

  async deployVersion(input: LegacyDeployVersionInput): Promise<DeploymentRecord | null> {
    const version = this.db.prepare(
      "SELECT semantic_hash, full_hash FROM flow_versions WHERE id = ?",
    ).get(input.versionId) as { semantic_hash: string; full_hash: string } | undefined;
    const environmentRow = this.db.prepare(
      "SELECT kind FROM environments WHERE id = ?",
    ).get(input.environmentId) as { kind: string } | undefined;
    const active = this.db.prepare(
      "SELECT id FROM deployments WHERE flow_id = ? AND environment_id = ? AND retired_at IS NULL",
    ).get(input.flowId, input.environmentId) as { id: string } | undefined;
    const strict: DeployVersionInput = {
      ...input,
      versionSemanticHash: version?.semantic_hash ?? "0".repeat(64),
      versionFullHash: version?.full_hash ?? "0".repeat(64),
      environmentKind: environmentRow?.kind === "live" ? "live" : "test",
      expectedActiveDeploymentId: active?.id ?? null,
      sourceTestDeploymentId: null,
      confirmation: environmentRow?.kind === "live" ? "PROMOTE LIVE" : "PROMOTE TEST",
    };
    const result = await this.service.deployVersion(strict);
    return result.status === "deployed" ? result.deployment : null;
  }

  getActiveDeployment(input: Parameters<DeploymentService["getActiveDeployment"]>[0]) {
    return this.service.getActiveDeployment(input);
  }

  listDeployments(input: Parameters<DeploymentService["listDeployments"]>[0]) {
    return this.service.listDeployments(input);
  }

  retireDeployment(input: Parameters<DeploymentService["retireDeployment"]>[0]) {
    return this.service.retireDeployment(input);
  }
}

async function createFixture(): Promise<{
  db: Database.Database;
  repo: SqliteProjectRepo;
  service: DeploymentTestHarness;
  versionService: VersionService;
  context: PersonalContext;
  flowId: string;
  version: FlowVersionRecord;
}> {
  const db = new Database(":memory:");
  const repo = new SqliteProjectRepo(db);
  const service = new DeploymentTestHarness(repo, db);
  const versionService = new VersionService(repo);
  const context = await repo.ensurePersonalContext("owner-1");
  const flowId = seedFlow(db);
  await repo.bindFlow(flowId, context);
  const version = requireVersion(
    await versionService.createFlowVersion({ flowId, ownerId: "owner-1" }),
  );
  return { db, repo, service, versionService, context, flowId, version };
}

async function createSecondVersion(input: {
  db: Database.Database;
  versionService: VersionService;
  flowId: string;
}): Promise<FlowVersionRecord> {
  input.db.prepare("UPDATE flows SET graph = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(graph(2)),
    2,
    input.flowId,
  );
  return requireVersion(
    await input.versionService.createFlowVersion({
      flowId: input.flowId,
      ownerId: "owner-1",
    }),
  );
}

describe("DeploymentService environments and immutable versions", () => {
  it.each([
    ["authorization", { Authorization: "Bearer promotion-bearer-canary" }],
    ["API key header", { "X-Api-Key": "promotion-api-key-canary" }],
    ["credential-shaped value", { "X-Custom": "sk_promotion_canary_12345678" }],
    ["cookie", { Cookie: "session=promotion-cookie-canary" }],
  ] as const)("refuses promotion with a static HTTP %s before repository writes", async (_name, headers) => {
    const version = versionForGraph(httpGraph({ headers: { Accept: "application/json", ...headers } }));
    const { repo } = mockDeploymentRepo(version);

    await expect(new DeploymentService(repo).deployVersion(promotionInput(version)))
      .resolves.toEqual({ status: "invalid-request" });
    expect(repo.deployVersion).not.toHaveBeenCalled();
  });

  it("allows safe static HTTP headers and opaque connection-backed headers", async () => {
    const safe = versionForGraph(httpGraph());
    const safeFixture = mockDeploymentRepo(safe);
    await expect(new DeploymentService(safeFixture.repo).deployVersion(promotionInput(safe)))
      .resolves.toEqual({ status: "deployed", deployment: safeFixture.deployment });

    const connected = versionForGraph(httpGraph({
      binding: { kind: "secret", connectionId: "connection-opaque-id", field: "headers" },
    }));
    const connectedFixture = mockDeploymentRepo(connected);
    await expect(new DeploymentService(connectedFixture.repo).deployVersion(promotionInput(connected)))
      .resolves.toEqual({ status: "deployed", deployment: connectedFixture.deployment });
  });

  it.each([
    ["wrong key", "auth", "headers"],
    ["wrong field", "headers", "token"],
  ] as const)("refuses a secret HTTP binding with the %s", async (_name, bindingKey, field) => {
    const version = versionForGraph(httpGraph({
      bindingKey,
      binding: { kind: "secret", connectionId: "connection-opaque-id", field },
    }));
    const { repo } = mockDeploymentRepo(version);

    await expect(new DeploymentService(repo).deployVersion(promotionInput(version)))
      .resolves.toEqual({ status: "invalid-request" });
    expect(repo.deployVersion).not.toHaveBeenCalled();
  });

  it("preserves immutable api.operation authoring but refuses every deployment before writes", async () => {
    const fixture = await createFixture();
    const closure = persistApiOperation(fixture.db);
    fixture.db.prepare("UPDATE flows SET graph = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(apiOperationGraph(closure)), 2, fixture.flowId);
    const version = requireVersion(await fixture.versionService.createFlowVersion({ flowId: fixture.flowId, ownerId: "owner-1" }));
    expect(version.dependencies.filter((dependency) => dependency.kind === "connector"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          resourceId: `definition/${closure.definition.id}`,
          version: closure.definition.id,
          contentHash: closure.definition.connectorProjectionHash,
        }),
        expect.objectContaining({
          resourceId: `operation/${closure.operation.id}`,
          version: closure.operation.id,
          contentHash: closure.operation.operationProjectionHash,
        }),
        expect.objectContaining({
          resourceId: `schema/${closure.operation.id}`,
          version: closure.operation.id,
          contentHash: closure.operation.schemaHash,
        }),
      ]));
    expect(version.dependencies.filter((dependency) => dependency.kind === "connector"))
      .toHaveLength(3);
    const test = environment(fixture.context, "test");
    const input = {
      flowId: fixture.flowId,
      versionId: version.id,
      versionSemanticHash: version.semanticHash,
      versionFullHash: version.fullHash,
      environmentId: test.id,
      environmentKind: "test" as const,
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST" as const,
      ownerId: "owner-1",
    };
    expect(await new DeploymentService(fixture.repo).deployVersion(input)).toEqual({ status: API_OPERATION_LIVE_UNAVAILABLE });
    expect(await fixture.repo.deployVersion(input)).toEqual({ status: API_OPERATION_LIVE_UNAVAILABLE });
    expect(fixture.db.prepare("SELECT COUNT(*) count FROM deployments").get()).toEqual({ count: 0 });
  });

  it.each(["subflow", "loop"] as const)(
    "refuses api.operation in an exact pinned %s child at service and SQLite boundaries",
    async (nodeType) => {
      const fixture = await createFixture();
      const childFlowId = "child-flow";
      const callableInterface = { inputs: [], outputs: [] } as const;
      const closure = persistApiOperation(fixture.db);
      const childGraph = { ...apiOperationGraph(closure), id: "child-api", callableInterface };
      fixture.db.prepare(
        "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(childFlowId, "owner-1", "Child", JSON.stringify(childGraph), 2);
      const child = requireVersion(await fixture.versionService.createFlowVersion({
        flowId: childFlowId,
        ownerId: "owner-1",
      }));
      expect(child.dependencies.filter((dependency) => dependency.kind === "connector"))
        .toHaveLength(3);
      const rootGraph: FlowGraphV2 = {
        schemaVersion: 2,
        id: "root",
        name: "Root",
        nodes: [{
          id: "child",
          type: nodeType,
          params: { reference: {
            kind: "pinned",
            flowId: childFlowId,
            versionId: child.id,
            interface: callableInterface,
            interfaceHash: hashCallableInterface(callableInterface),
            contentHash: child.semanticHash,
          } },
          bindings: {},
          position: { x: 0, y: 0 },
        }],
        edges: [], variables: [], groups: [], annotations: [], callableInterface,
      };
      fixture.db.prepare("UPDATE flows SET graph = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(rootGraph), 3, fixture.flowId);
      const root = requireVersion(await fixture.versionService.createFlowVersion({
        flowId: fixture.flowId,
        ownerId: "owner-1",
      }));
      const test = environment(fixture.context, "test");
      const input = {
        flowId: fixture.flowId,
        versionId: root.id,
        versionSemanticHash: root.semanticHash,
        versionFullHash: root.fullHash,
        environmentId: test.id,
        environmentKind: "test" as const,
        expectedActiveDeploymentId: null,
        sourceTestDeploymentId: null,
        confirmation: "PROMOTE TEST" as const,
        ownerId: "owner-1",
      };

      expect(await new DeploymentService(fixture.repo).deployVersion(input))
        .toEqual({ status: API_OPERATION_LIVE_UNAVAILABLE });
      expect(await fixture.repo.deployVersion(input))
        .toEqual({ status: API_OPERATION_LIVE_UNAVAILABLE });
      expect(fixture.db.prepare("SELECT COUNT(*) count FROM deployments").get()).toEqual({ count: 0 });
    },
  );
  it("accepts Test while refusing Draft and direct Live promotion", async () => {
    const fixture = await createFixture();
    const service = new DeploymentService(fixture.repo);
    const base = {
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      versionSemanticHash: fixture.version.semanticHash,
      versionFullHash: fixture.version.fullHash,
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      ownerId: "owner-1",
    } as const;
    expect(await service.deployVersion({
      ...base,
      environmentId: environment(fixture.context, "draft").id,
      environmentKind: "test",
      confirmation: "PROMOTE TEST",
    })).toEqual({ status: "invalid-request" });
    expect(await service.deployVersion({
      ...base,
      environmentId: environment(fixture.context, "live").id,
      environmentKind: "live",
      confirmation: "PROMOTE LIVE",
    })).toEqual({ status: "invalid-request" });
    const test = await service.deployVersion({
      ...base,
      environmentId: environment(fixture.context, "test").id,
      environmentKind: "test",
      confirmation: "PROMOTE TEST",
    });
    expect(test).toMatchObject({ status: "deployed", deployment: { status: "test" } });
  });

  it("retires the prior active row atomically and preserves immutable history", async () => {
    const fixture = await createFixture();
    const draft = environment(fixture.context, "test");
    const first = requireDeployment(
      await fixture.service.deployVersion({
        flowId: fixture.flowId,
        versionId: fixture.version.id,
        environmentId: draft.id,
        ownerId: "owner-1",
      }),
    );
    const secondVersion = await createSecondVersion(fixture);

    const second = requireDeployment(
      await fixture.service.deployVersion({
        flowId: fixture.flowId,
        versionId: secondVersion.id,
        environmentId: draft.id,
        ownerId: "owner-1",
      }),
    );

    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ flowVersionId: secondVersion.id, status: "test" });
    const history = await fixture.service.listDeployments({
      flowId: fixture.flowId,
      ownerId: "owner-1",
    });
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, status: "retired", retiredAt: expect.any(Number) }),
      expect.objectContaining({ id: second.id, status: "test" }),
    ]));
    expect(history.find(({ id }) => id === first.id)).not.toHaveProperty("flowVersionId", secondVersion.id);
    expect(history.map(({ id }) => id)).toEqual(
      (fixture.db
        .prepare("SELECT id FROM deployments ORDER BY created_at DESC, id DESC")
        .all() as Array<{ id: string }>).map(({ id }) => id),
    );
    expect(await fixture.service.listDeployments({
      flowId: fixture.flowId,
      ownerId: "owner-1",
    })).toEqual(history);
  });

  it("returns the existing active row for an identical request", async () => {
    const fixture = await createFixture();
    const input = {
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-1",
    };

    const first = requireDeployment(await fixture.service.deployVersion(input));
    const second = requireDeployment(await fixture.service.deployVersion(input));

    expect(second).toEqual(first);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({
      count: 1,
    });
  });

  it("keeps an active immutable version unchanged when the draft graph changes", async () => {
    const fixture = await createFixture();
    await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-1",
    });
    fixture.db.prepare("UPDATE flows SET graph = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(graph(99)),
      99,
      fixture.flowId,
    );

    const active = await fixture.service.getActiveDeployment({
      flowId: fixture.flowId,
      environmentKind: "test",
      ownerId: "owner-1",
    });
    const storedVersion = await fixture.versionService.getFlowVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      ownerId: "owner-1",
    });

    expect(active?.flowVersionId).toBe(fixture.version.id);
    expect(storedVersion?.graph.nodes[0].params).toEqual({ revision: 1 });
  });
});

describe("DeploymentService ownership, project binding, and retirement", () => {
  it("fails closed across owners, flow versions, and project environments", async () => {
    const fixture = await createFixture();
    const otherContext = await fixture.repo.ensurePersonalContext("owner-2");
    const otherFlowId = seedFlow(fixture.db, { id: "flow-2", ownerId: "owner-2" });
    const otherVersion = requireVersion(
      await fixture.versionService.createFlowVersion({
        flowId: otherFlowId,
        ownerId: "owner-2",
      }),
    );
    const before = fixture.db.prepare("SELECT COUNT(*) AS count FROM deployments").get();

    expect(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: otherVersion.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-1",
    })).toBeNull();
    expect(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(otherContext, "draft").id,
      ownerId: "owner-1",
    })).toBeNull();
    expect(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-2",
    })).toBeNull();
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual(before);
    expect(await fixture.service.getActiveDeployment({
      flowId: fixture.flowId,
      environmentKind: "test",
      ownerId: "owner-2",
    })).toBeNull();
    expect(await fixture.service.listDeployments({
      flowId: fixture.flowId,
      ownerId: "owner-2",
    })).toEqual([]);
  });

  it("refuses an unbound legacy flow without lazily creating a binding", async () => {
    const fixture = await createFixture();
    fixture.db.prepare("DELETE FROM flow_project_bindings WHERE flow_id = ?").run(fixture.flowId);
    expect(fixture.db.prepare("SELECT * FROM flow_project_bindings").all()).toEqual([]);

    const deployment = await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-1",
    });

    expect(deployment).toBeNull();
    expect(fixture.db.prepare("SELECT * FROM flow_project_bindings").all()).toEqual([]);
  });

  it("does not create hierarchy and rejects unbound custom-project or mismatched bindings", async () => {
    const fixture = await createFixture();
    fixture.db.prepare("DELETE FROM flow_project_bindings WHERE flow_id = ?").run(fixture.flowId);
    fixture.db.prepare(
      `INSERT INTO projects (id, workspace_id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("project-custom", fixture.context.workspace.id, "Custom", "custom", 1, 1);
    fixture.db.prepare(
      `INSERT INTO workbooks (id, project_id, name, slug, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("workbook-custom", "project-custom", "Main", "main", 0, 1);
    fixture.db.prepare(
      `INSERT INTO environments (id, project_id, name, slug, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("environment-custom", "project-custom", "Draft", "draft", "draft", 1);

    expect(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: "environment-custom",
      ownerId: "owner-1",
    })).toBeNull();
    expect(fixture.db.prepare("SELECT * FROM flow_project_bindings").all()).toEqual([]);

    fixture.db.prepare(
      `INSERT INTO flow_project_bindings (flow_id, project_id, workbook_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(fixture.flowId, "project-custom", "workbook-custom", 1);
    expect(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-1",
    })).toBeNull();

    const blankDb = new Database(":memory:");
    const blankRepo = new SqliteProjectRepo(blankDb);
    seedFlow(blankDb, { id: "flow-blank", ownerId: "owner-blank" });
    const blankVersion = requireVersion(await new VersionService(blankRepo).createFlowVersion({
      flowId: "flow-blank",
      ownerId: "owner-blank",
    }));
    expect(await new DeploymentService(blankRepo).deployVersion({
      flowId: "flow-blank",
      versionId: blankVersion.id,
      versionSemanticHash: blankVersion.semanticHash,
      versionFullHash: blankVersion.fullHash,
      environmentId: "missing",
      environmentKind: "test",
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST",
      ownerId: "owner-blank",
    })).toEqual({ status: "not-found" });
    expect(blankDb.prepare("SELECT COUNT(*) AS count FROM organizations").get()).toEqual({ count: 0 });
  });

  it("retires idempotently and returns stable owner-scoped history", async () => {
    const fixture = await createFixture();
    const deployed = requireDeployment(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-1",
    }));

    const retired = requireDeployment(await fixture.service.retireDeployment({
      deploymentId: deployed.id,
      ownerId: "owner-1",
    }));
    const repeated = requireDeployment(await fixture.service.retireDeployment({
      deploymentId: deployed.id,
      ownerId: "owner-1",
    }));

    expect(retired).toMatchObject({ status: "retired", retiredAt: expect.any(Number) });
    expect(repeated).toEqual(retired);
    expect(await fixture.service.retireDeployment({
      deploymentId: deployed.id,
      ownerId: "owner-2",
    })).toBeNull();
    expect(await fixture.service.retireDeployment({
      deploymentId: "missing",
      ownerId: "owner-1",
    })).toBeNull();
    expect(await fixture.service.getActiveDeployment({
      flowId: fixture.flowId,
      environmentKind: "test",
      ownerId: "owner-1",
    })).toBeNull();
    expect(await fixture.service.listDeployments({
      flowId: fixture.flowId,
      ownerId: "owner-1",
    })).toEqual([retired]);
  });
});

describe("DeploymentService transaction and contention safety", () => {
  it("restores only the exact prior deployment and refuses a stale compensation race", async () => {
    const fixture = await createFixture();
    const target = environment(fixture.context, "test");
    const first = requireDeployment(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: target.id,
      ownerId: "owner-1",
    }));
    const secondVersion = await createSecondVersion(fixture);
    const second = requireDeployment(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: secondVersion.id,
      environmentId: target.id,
      ownerId: "owner-1",
    }));

    await expect(fixture.repo.restoreActiveDeployment({
      deploymentId: first.id,
      expectedActiveDeploymentId: second.id,
      ownerId: "owner-1",
    })).resolves.toMatchObject({ id: first.id, status: "test" });
    await expect(fixture.repo.restoreActiveDeployment({
      deploymentId: first.id,
      expectedActiveDeploymentId: second.id,
      ownerId: "owner-1",
    })).resolves.toBeNull();
    await expect(fixture.service.getActiveDeployment({
      flowId: fixture.flowId,
      environmentKind: "test",
      ownerId: "owner-1",
    })).resolves.toMatchObject({ id: first.id, status: "test" });
    await expect(fixture.repo.restoreActiveDeployment({
      deploymentId: second.id,
      expectedActiveDeploymentId: first.id,
      ownerId: "owner-2",
    })).resolves.toBeNull();
  });

  it("rolls retirement back when the replacement insert fails", async () => {
    const fixture = await createFixture();
    const draft = environment(fixture.context, "test");
    const first = requireDeployment(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: draft.id,
      ownerId: "owner-1",
    }));
    const secondVersion = await createSecondVersion(fixture);
    fixture.db.exec(`
      CREATE TRIGGER fail_replacement_deployment
      BEFORE INSERT ON deployments
      WHEN NEW.flow_version_id = '${secondVersion.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced deployment failure');
      END;
    `);

    await expect(fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: secondVersion.id,
      environmentId: draft.id,
      ownerId: "owner-1",
    })).rejects.toThrow("forced deployment failure");

    expect(await fixture.service.getActiveDeployment({
      flowId: fixture.flowId,
      environmentKind: "test",
      ownerId: "owner-1",
    })).toEqual(first);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({ count: 1 });
  });

  it("rolls a lazy binding back when the first deployment insert fails", async () => {
    const fixture = await createFixture();
    fixture.db.exec(`
      CREATE TRIGGER fail_first_deployment
      BEFORE INSERT ON deployments
      BEGIN
        SELECT RAISE(ABORT, 'forced first deployment failure');
      END;
    `);

    await expect(fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: environment(fixture.context, "test").id,
      ownerId: "owner-1",
    })).rejects.toThrow("forced first deployment failure");

    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({ count: 0 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get()).toEqual({ count: 1 });
  });

  it("does not persist a lazy binding when a preexisting active row is invalid", async () => {
    const fixture = await createFixture();
    const draft = environment(fixture.context, "test");
    fixture.db.prepare(
      `INSERT INTO deployments
        (id, flow_id, flow_version_id, environment_id, status, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      "deployment-corrupt",
      fixture.flowId,
      fixture.version.id,
      draft.id,
      "live",
      1,
    );
    const before = fixture.db
      .prepare("SELECT * FROM deployments WHERE id = ?")
      .get("deployment-corrupt");

    expect(await fixture.service.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      environmentId: draft.id,
      ownerId: "owner-1",
    })).toBeNull();

    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get()).toEqual({
      count: 1,
    });
    expect(
      fixture.db.prepare("SELECT * FROM deployments WHERE id = ?").get("deployment-corrupt"),
    ).toEqual(before);
  });

  it.each([0, 1, 2, 3])(
    "serializes simultaneous independent process startup iteration %i",
    async (iteration) => {
    const artifactsRoot = join(process.cwd(), ".artifacts");
    mkdirSync(artifactsRoot, { recursive: true });
    const directory = mkdtempSync(
      join(artifactsRoot, `deployment-concurrency-${String(iteration)}-`),
    );
    const dbPath = join(directory, "studio.db");
    const workerPath = join(directory, "deploy-worker.ts");
    const barrierPath = join(directory, "start");
    const readyPaths = [join(directory, "ready-a"), join(directory, "ready-b")];
    let workers: Array<{ child: ChildProcess; done: Promise<DeploymentRecord> }> = [];
    try {
      const db = new Database(dbPath);
      const repo = new SqliteProjectRepo(db);
      const context = await repo.ensurePersonalContext("owner-1");
      const flowId = seedFlow(db);
      const version = requireVersion(await new VersionService(repo).createFlowVersion({
        flowId,
        ownerId: "owner-1",
      }));
      await repo.bindFlow(flowId, context);
      const environmentId = environment(context, "test").id;
      db.close();
      writeFileSync(
        workerPath,
        `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DeploymentService } from ${JSON.stringify(join(process.cwd(), "src/lib/projects/deployment-service.ts"))};
import { SqliteProjectRepo } from ${JSON.stringify(join(process.cwd(), "src/lib/projects/sqlite-project-repo.ts"))};
const dbPath = process.env.DEPLOYMENT_DB_PATH;
const barrierPath = process.env.DEPLOYMENT_BARRIER_PATH;
const readyPath = process.env.DEPLOYMENT_READY_PATH;
const flowId = process.env.DEPLOYMENT_FLOW_ID;
const versionId = process.env.DEPLOYMENT_VERSION_ID;
const environmentId = process.env.DEPLOYMENT_ENVIRONMENT_ID;
const versionSemanticHash = process.env.DEPLOYMENT_SEMANTIC_HASH;
const versionFullHash = process.env.DEPLOYMENT_FULL_HASH;
if (!dbPath || !barrierPath || !readyPath || !flowId || !versionId || !environmentId || !versionSemanticHash || !versionFullHash) throw new Error("missing worker input");
const service = new DeploymentService(new SqliteProjectRepo(dbPath));
writeFileSync(readyPath, "ready");
while (!existsSync(barrierPath)) await delay(5);
const result = await service.deployVersion({
  flowId,
  versionId,
  versionSemanticHash,
  versionFullHash,
  environmentId,
  environmentKind: "test",
  expectedActiveDeploymentId: null,
  sourceTestDeploymentId: null,
  confirmation: "PROMOTE TEST",
  ownerId: "owner-1",
});
process.stdout.write(JSON.stringify(result));
`,
        "utf8",
      );
      const spawnWorker = (readyPath: string) => {
        const child = spawn(
          process.execPath,
          [join(process.cwd(), "node_modules/vite-node/vite-node.mjs"), "--config", join(process.cwd(), "vitest.config.ts"), workerPath],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              DEPLOYMENT_DB_PATH: dbPath,
              DEPLOYMENT_BARRIER_PATH: barrierPath,
              DEPLOYMENT_READY_PATH: readyPath,
              DEPLOYMENT_FLOW_ID: flowId,
              DEPLOYMENT_VERSION_ID: version.id,
              DEPLOYMENT_SEMANTIC_HASH: version.semanticHash,
              DEPLOYMENT_FULL_HASH: version.fullHash,
              DEPLOYMENT_ENVIRONMENT_ID: environmentId,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        const done = new Promise<DeploymentRecord>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => {
            if (code !== 0) reject(new Error(`Deployment worker exited ${String(code)}: ${stderr}`));
            else {
              try {
                resolve(JSON.parse(stdout) as DeploymentRecord);
              } catch (error) {
                reject(
                  new Error(
                    `Deployment worker returned invalid JSON: ${stdout || "<empty>"}; ${stderr}`,
                    { cause: error },
                  ),
                );
              }
            }
          });
        });
        return { child, done };
      };
      workers = readyPaths.map(spawnWorker);
      const completions = workers.map(({ done }) => done);
      const waitForReady = async (): Promise<void> => {
        // The release verifier gives child processes a fresh, isolated temp
        // directory, so vite-node has no shared transform cache to warm from.
        // Keep the readiness gate strict, but allow a cold worker to compile.
        for (let attempt = 0; attempt < 1500; attempt += 1) {
          if (readyPaths.every(existsSync)) return;
          await delay(10);
        }
        throw new Error("Timed out waiting for deployment worker readiness");
      };
      await Promise.race([
        waitForReady(),
        Promise.all(completions).then(() => {
          throw new Error("Deployment workers exited before the concurrency barrier");
        }),
      ]);
      writeFileSync(barrierPath, "start", "utf8");

      const deployed = await Promise.all(completions);
      expect(deployed.map((result) => (result as unknown as { status: string }).status).sort())
        .toEqual(["conflict", "deployed"]);
      const inspection = new Database(dbPath, { readonly: true });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM deployments WHERE retired_at IS NULL").get()).toEqual({ count: 1 });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get()).toEqual({ count: 1 });
      inspection.close();
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGTERM");
      }
      await Promise.allSettled(workers.map(({ done }) => done));
      rmSync(directory, { recursive: true, force: true });
      expect(existsSync(directory)).toBe(false);
    }
    },
    30_000,
  );

  // 2026-08-09 deliberate pin rewrite: deploy-on-launch means every launched
  // flow carries a version + Live deployment, so legacy deleteFlow now
  // cascades that history instead of rejecting on the FK (the public v0 API
  // pins delete-after-launch working). Durable execution rows still block
  // deletion — that audit FK keeps no cascade.
  it("cascades version and deployment history during legacy flow deletion", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".artifacts", "deployment-delete-"));
    const path = join(directory, "studio.db");
    try {
      const legacyRepo = new SqliteRepo(path);
      const repo = new SqliteProjectRepo(path);
      const context = await repo.ensurePersonalContext("owner-1");
      const flow = await legacyRepo.saveFlow({ ownerId: "owner-1", name: "Flow", graph: graph() });
      const version = requireVersion(await new VersionService(repo).createFlowVersion({
        flowId: flow.id,
        ownerId: "owner-1",
      }));
      await repo.bindFlow(flow.id, context);
      const result = await new DeploymentService(repo).deployVersion({
        flowId: flow.id,
        versionId: version.id,
        versionSemanticHash: version.semanticHash,
        versionFullHash: version.fullHash,
        environmentId: environment(context, "test").id,
        environmentKind: "test",
        expectedActiveDeploymentId: null,
        sourceTestDeploymentId: null,
        confirmation: "PROMOTE TEST",
        ownerId: "owner-1",
      });
      expect(result.status).toBe("deployed");
      if (result.status !== "deployed") throw new Error("Expected deployment");

      await expect(legacyRepo.deleteFlow(flow.id, "owner-1")).resolves.toBe(true);
      expect(await legacyRepo.getFlow(flow.id)).toBeNull();
      expect(await repo.getFlowContext(flow.id, "owner-1")).toBeNull();
      expect(await new DeploymentService(repo).listDeployments({
        flowId: flow.id,
        ownerId: "owner-1",
      })).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("DeploymentService cost and integration isolation", () => {
  it("imports and calls no provider, model, payment, settlement, schedule, or launch path", async () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/projects/deployment-service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /@ai-sdk|from\s+["']ai["']|\/(?:llm|payout|settlement|gateway|x402|schedule|launch)/,
    );
    vi.resetModules();
    forbiddenModuleLoaded.mockClear();
    const { DeploymentService: RuntimeDeploymentService } = await import(
      "@/lib/projects/deployment-service"
    );
    const expected: DeploymentRecord = {
      id: "deployment-1",
      flowId: "flow-1",
      flowVersionId: "version-1",
      environmentId: "environment-1",
      status: "live",
      createdAt: 1,
    };
    const runtimeGraph = graph();
    const runtimeVersion: FlowVersionRecord = {
      id: "version-1",
      flowId: "flow-1",
      versionNumber: 1,
      schemaVersion: 1,
      graph: runtimeGraph,
      semanticHash: hashFlowGraph(runtimeGraph, { semantic: true }, []),
      fullHash: hashFlowGraph(runtimeGraph, { semantic: false }, []),
      createdBy: "owner-1",
      createdAt: 1,
      dependencies: [],
    };
    const runtimeRepo: DeploymentRepo & Pick<FlowVersionRepo, "getFlowVersion"> = {
      deployVersion: vi.fn().mockResolvedValue({ status: "deployed", deployment: expected }),
      getFlowVersion: vi.fn().mockResolvedValue(runtimeVersion),
      getActiveDeployment: vi.fn().mockResolvedValue(expected),
      listDeployments: vi.fn().mockResolvedValue([expected]),
      retireDeployment: vi.fn().mockResolvedValue({
        ...expected,
        status: "retired",
        retiredAt: 2,
      }),
    };
    const runtimeService = new RuntimeDeploymentService(runtimeRepo);

    expect(await runtimeService.deployVersion({
      flowId: "flow-1",
      versionId: "version-1",
      versionSemanticHash: "a".repeat(64),
      versionFullHash: "b".repeat(64),
      environmentId: "environment-1",
      environmentKind: "test",
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST",
      ownerId: "owner-1",
    })).toEqual({ status: "deployed", deployment: expected });
    expect(forbiddenModuleLoaded).not.toHaveBeenCalled();
    expect(runtimeRepo.deployVersion).toHaveBeenCalledTimes(1);
  });
});

describe("SqliteProjectRepo deployment boundary", () => {
  it("keeps the string in-memory constructor compatible without WAL", async () => {
    const repo = new SqliteProjectRepo(":memory:");

    expect((await repo.ensurePersonalContext("memory-owner")).organization.personalOwnerId).toBe(
      "memory-owner",
    );
  });

  it("normalizes and rejects invalid direct repository input before writing", async () => {
    const fixture = await createFixture();
    const valid = {
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      versionSemanticHash: fixture.version.semanticHash,
      versionFullHash: fixture.version.fullHash,
      environmentId: environment(fixture.context, "test").id,
      environmentKind: "test" as const,
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST" as const,
      ownerId: "owner-1",
    };

    for (const [field, value] of [
      ["flowId", "   "],
      ["versionId", 42],
      ["environmentId", ""],
      ["ownerId", null],
    ] as const) {
      await expect(
        fixture.repo.deployVersion({
          ...valid,
          [field]: value,
        } as never),
      ).rejects.toThrow(`${field} is required`);
    }
    await expect(fixture.repo.getActiveDeployment({
      flowId: fixture.flowId,
      environmentKind: "preview" as never,
      ownerId: "owner-1",
    })).rejects.toThrow("Invalid environment kind: preview");
    await expect(fixture.repo.listDeployments({
      flowId: fixture.flowId,
      ownerId: 42 as never,
    })).rejects.toThrow("ownerId is required");
    await expect(fixture.repo.retireDeployment({
      deploymentId: " ",
      ownerId: "owner-1",
    })).rejects.toThrow("deploymentId is required");
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({
      count: 0,
    });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get()).toEqual({
      count: 1,
    });
  });

  it("fails closed when hydrated environment kind or deployment status is invalid", async () => {
    const fixture = await createFixture();
    const draft = environment(fixture.context, "test");
    const promoted = await fixture.repo.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      versionSemanticHash: fixture.version.semanticHash,
      versionFullHash: fixture.version.fullHash,
      environmentId: draft.id,
      environmentKind: "test",
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST",
      ownerId: "owner-1",
    });
    expect(promoted.status).toBe("deployed");
    if (promoted.status !== "deployed") throw new Error("Expected deployment");
    const deployed = promoted.deployment;
    for (const invalidStatus of ["corrupt", "live"]) {
      fixture.db.prepare("UPDATE deployments SET status = ? WHERE id = ?").run(
        invalidStatus,
        deployed.id,
      );

      expect(await fixture.repo.getActiveDeployment({
        flowId: fixture.flowId,
        environmentKind: "test",
        ownerId: "owner-1",
      })).toBeNull();
      expect(await fixture.repo.listDeployments({
        flowId: fixture.flowId,
        ownerId: "owner-1",
      })).toEqual([]);
      expect(await fixture.repo.retireDeployment({
        deploymentId: deployed.id,
        ownerId: "owner-1",
      })).toBeNull();
    }

    fixture.db.prepare("DELETE FROM deployments WHERE id = ?").run(deployed.id);
    fixture.db.prepare("UPDATE environments SET kind = 'corrupt' WHERE id = ?").run(draft.id);
    expect(await fixture.repo.deployVersion({
      flowId: fixture.flowId,
      versionId: fixture.version.id,
      versionSemanticHash: fixture.version.semanticHash,
      versionFullHash: fixture.version.fullHash,
      environmentId: draft.id,
      environmentKind: "test",
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST",
      ownerId: "owner-1",
    })).toEqual({ status: "not-found" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({
      count: 0,
    });
  });
});
