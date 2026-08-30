import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";
import type { ConnectorOperationClosure } from "@/lib/connectors/repository";
import { SqliteConnectorRepository } from "@/lib/connectors/sqlite-repository";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";
import { API_OPERATION_LIVE_UNAVAILABLE } from "@/lib/connectors/operation-closure";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type { FlowVersionRecord } from "@/lib/projects/types";
import { VersionService } from "@/lib/projects/version-service";

const root = mkdtempSync(join(tmpdir(), "suede-deployments-v2-"));
const sqlitePath = join(root, "deployments.db");
const db = new Database(sqlitePath);
runSqliteMigrations(db);
const repo = new SqliteProjectRepo(db);
let currentOwner: string | null = "owner-api";
const authCalls = vi.hoisted(() => ({
  mutation: vi.fn(),
  readOnly: vi.fn(),
}));

vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("DB_DRIVER", "sqlite");
vi.stubEnv("SQLITE_PATH", sqlitePath);
vi.mock("@/lib/auth", () => {
  class UnauthenticatedOwnerError extends Error {}
  return {
    UnauthenticatedOwnerError,
    resolveOwnerId: async () => {
      authCalls.mutation();
      if (currentOwner === null) throw new UnauthenticatedOwnerError();
      return currentOwner;
    },
    resolveReadOnlyOwnerId: async () => {
      authCalls.readOnly();
      if (currentOwner === null) throw new UnauthenticatedOwnerError();
      return currentOwner;
    },
  };
});
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (key: string) => key === "x-owner-id" ? currentOwner : null }),
  cookies: async () => ({ get: () => undefined }),
}));

afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  currentOwner = "owner-api";
  authCalls.mutation.mockClear();
  authCalls.readOnly.mockClear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DB_DRIVER", "sqlite");
  vi.stubEnv("SQLITE_PATH", sqlitePath);
});

function graph(id: string): FlowGraph {
  return { id, name: id, nodes: [], edges: [] };
}

const API_OPERATION_IDS = {
  connector: "00000000-0000-4000-8000-000000000600",
  definition: "00000000-0000-4000-8000-000000000601",
  operation: "00000000-0000-4000-8000-000000000602",
} as const;

function persistApiOperation(ownerId: string): ConnectorOperationClosure {
  const compiled = compileOpenApi310(JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Deployment route fixture", version: "1" },
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
  const connectorRepo = new SqliteConnectorRepository(db);
  const result = connectorRepo.immediate((transaction) => transaction.persistCompiledImport({
    ownerId,
    connectorId: null,
    newConnectorId: API_OPERATION_IDS.connector,
    definitionVersionId: API_OPERATION_IDS.definition,
    operationVersionId: API_OPERATION_IDS.operation,
    displayLabel: "Deployment route fixture",
    connectorProjection: compiled.connectorProjection,
    connectorProjectionHash: compiled.connectorProjectionHash,
    operation: compiled.operations[0]!,
    now: 1,
  }));
  if (result.status !== "ok") throw new Error(result.status);
  const closure = connectorRepo.getOperationClosure(ownerId, result.operation.id);
  if (!closure) throw new Error("Expected API operation fixture closure");
  return closure;
}

function apiGraph(id: string, closure: ConnectorOperationClosure): FlowGraphV2 {
  return {
    schemaVersion: 2, id, name: id,
    nodes: [{ id: "api", type: "api.operation", params: {
      connectorDefinitionVersionId: closure.definition.id,
      operationVersionId: closure.operation.id,
      operationId: closure.operation.operationId,
      connectorProjectionHash: closure.definition.connectorProjectionHash,
      operationProjectionHash: closure.operation.operationProjectionHash,
      schemaHash: closure.operation.schemaHash,
    }, bindings: {}, position: { x: 0, y: 0 } }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

async function seed(ownerId: string, flowId: string) {
  db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(flowId, ownerId, flowId, JSON.stringify(graph(flowId)), Date.now());
  const context = await repo.ensurePersonalContext(ownerId);
  await repo.bindFlow(flowId, context);
  const version = await new VersionService(repo).createFlowVersion({ flowId, ownerId });
  if (!version) throw new Error("Expected version");
  return { context, version };
}

function params(flowId: unknown) {
  return { params: Promise.resolve({ flowId }) } as unknown as { params: Promise<{ flowId: string }> };
}

function body(version: FlowVersionRecord, environmentId: string, overrides = {}) {
  return {
    versionId: version.id,
    versionSemanticHash: version.semanticHash,
    versionFullHash: version.fullHash,
    environmentId,
    environmentKind: "test",
    expectedActiveDeploymentId: null,
    sourceTestDeploymentId: null,
    confirmation: "PROMOTE TEST",
    ...overrides,
  };
}

function request(value: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://agents.suedeai.ai/api/v2/flows/flow/deployments", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

async function route() {
  return import("@/app/api/v2/flows/[flowId]/deployments/route");
}

async function expectPrivate(response: Response, status: number, expected: object): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(expected);
}

describe("v2 deployment promotion route", () => {
  it("returns the fixed api.operation refusal without creating a deployment", async () => {
    const ownerId = "owner-api-operation-refusal";
    const flowId = "flow-api-operation-refusal";
    currentOwner = ownerId;
    const closure = persistApiOperation(ownerId);
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(flowId, ownerId, flowId, JSON.stringify(apiGraph(flowId, closure)), Date.now());
    const context = await repo.ensurePersonalContext(ownerId);
    await repo.bindFlow(flowId, context);
    const version = await new VersionService(repo).createFlowVersion({ flowId, ownerId });
    if (!version) throw new Error("Expected version");
    const test = context.environments.find(({ kind }) => kind === "test");
    if (!test) throw new Error("Expected Test");
    const response = await (await route()).POST(request(body(version, test.id)), params(flowId));
    await expectPrivate(response, 409, { error: API_OPERATION_LIVE_UNAVAILABLE });
    expect(db.prepare("SELECT COUNT(*) count FROM deployments WHERE flow_id = ?").get(flowId)).toEqual({ count: 0 });
  });
  it("uses read-only identity resolution for GET without invoking adoption or repo writes", async () => {
    const ownerId = "owner-api-read-only";
    const flowId = "flow-api-read-only";
    currentOwner = ownerId;
    await seed(ownerId, flowId);
    authCalls.mutation.mockClear();
    authCalls.readOnly.mockClear();
    const before = {
      organizations: db.prepare("SELECT COUNT(*) AS count FROM organizations").get(),
      bindings: db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get(),
      deployments: db.prepare("SELECT COUNT(*) AS count FROM deployments").get(),
    };

    const api = await route();
    const response = await api.GET(new Request("https://agents.suedeai.ai/d"), params(flowId));

    expect(response.status).toBe(200);
    expect(authCalls.readOnly).toHaveBeenCalledTimes(1);
    expect(authCalls.mutation).not.toHaveBeenCalled();
    expect({
      organizations: db.prepare("SELECT COUNT(*) AS count FROM organizations").get(),
      bindings: db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings").get(),
      deployments: db.prepare("SELECT COUNT(*) AS count FROM deployments").get(),
    }).toEqual(before);
  });

  it("supports Test, owner-scoped history, and exact idempotent retry", async () => {
    const ownerId = "owner-api-success";
    const flowId = "flow-api-success";
    currentOwner = ownerId;
    const { context, version } = await seed(ownerId, flowId);
    const test = context.environments.find(({ kind }) => kind === "test");
    if (!test) throw new Error("Expected Test");
    const api = await route();
    const first = await api.POST(request(body(version, test.id)), params(flowId));
    expect(first.status).toBe(200);
    const firstPayload = await first.json() as { deployment: { id: string } };
    const retry = await api.POST(request(body(version, test.id, {
      expectedActiveDeploymentId: firstPayload.deployment.id,
    })), params(flowId));
    expect((await retry.json() as { deployment: { id: string } }).deployment.id)
      .toBe(firstPayload.deployment.id);
    const history = await api.GET(new Request("https://agents.suedeai.ai/d"), params(flowId));
    await expectPrivate(history, 200, { deployments: [expect.objectContaining({
      id: firstPayload.deployment.id,
      status: "test",
    })] });
  });

  it("supports Live only from the current exact Test source", async () => {
    const ownerId = "owner-api-live";
    const flowId = "flow-api-live";
    currentOwner = ownerId;
    const { context, version } = await seed(ownerId, flowId);
    const test = context.environments.find(({ kind }) => kind === "test");
    const live = context.environments.find(({ kind }) => kind === "live");
    if (!test || !live) throw new Error("Expected environments");
    const api = await route();
    const promotedTest = await api.POST(request(body(version, test.id)), params(flowId));
    const testId = (await promotedTest.json() as { deployment: { id: string } }).deployment.id;
    const promotedLive = await api.POST(request(body(version, live.id, {
      environmentKind: "live",
      sourceTestDeploymentId: testId,
      confirmation: "PROMOTE LIVE",
    })), params(flowId));
    expect(promotedLive.status).toBe(200);
  });

  it.each([
    ["malformed", "{"],
    ["extra", { extra: true }],
    ["uppercase hash", { versionSemanticHash: "A".repeat(64) }],
    ["short hash", { versionFullHash: "a".repeat(63) }],
    ["draft", { environmentKind: "draft", confirmation: "PROMOTE DRAFT" }],
    ["wrong confirmation", { confirmation: "promote test" }],
    ["Test source", { sourceTestDeploymentId: "deployment" }],
  ])("returns fixed 400 for %s request", async (_name, mutation) => {
    const api = await route();
    const base = {
      versionId: "version",
      versionSemanticHash: "a".repeat(64),
      versionFullHash: "b".repeat(64),
      environmentId: "environment",
      environmentKind: "test",
      expectedActiveDeploymentId: null,
      sourceTestDeploymentId: null,
      confirmation: "PROMOTE TEST",
    };
    await expectPrivate(
      await api.POST(request(typeof mutation === "string" ? mutation : { ...base, ...mutation }), params("flow")),
      400,
      { error: "invalid request" },
    );
  });

  it("rejects Authorization before owner resolution", async () => {
    currentOwner = null;
    const api = await route();
    await expectPrivate(
      await api.POST(request({}, { authorization: "Bearer secret" }), params("flow")),
      401,
      { error: "Authentication required" },
    );
  });

  it("returns private 404 for absent binding and foreign references", async () => {
    const ownerId = "owner-api-private";
    const flowId = "flow-api-private";
    currentOwner = ownerId;
    db.prepare("INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(flowId, ownerId, flowId, JSON.stringify(graph(flowId)), Date.now());
    const context = await repo.ensurePersonalContext(ownerId);
    const version = await new VersionService(repo).createFlowVersion({ flowId, ownerId });
    if (!version) throw new Error("Expected version");
    const test = context.environments.find(({ kind }) => kind === "test");
    if (!test) throw new Error("Expected Test");
    const api = await route();
    await expectPrivate(await api.POST(request(body(version, test.id)), params(flowId)), 404, {
      error: "not found",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM flow_project_bindings WHERE flow_id = ?")
      .get(flowId)).toEqual({ count: 0 });
  });

  it("returns fixed private 409 for stale expected active and Test source", async () => {
    const ownerId = "owner-api-conflict";
    const flowId = "flow-api-conflict";
    currentOwner = ownerId;
    const { context, version } = await seed(ownerId, flowId);
    const test = context.environments.find(({ kind }) => kind === "test");
    const live = context.environments.find(({ kind }) => kind === "live");
    if (!test || !live) throw new Error("Expected environments");
    const api = await route();
    await expectPrivate(await api.POST(request(body(version, test.id, {
      versionSemanticHash: "0".repeat(64),
    })), params(flowId)), 409, { error: "promotion conflict" });
    const promoted = await api.POST(request(body(version, test.id)), params(flowId));
    const testId = (await promoted.json() as { deployment: { id: string } }).deployment.id;
    await expectPrivate(await api.POST(request(body(version, test.id)), params(flowId)), 409, {
      error: "promotion conflict",
    });
    await expectPrivate(await api.POST(request(body(version, live.id, {
      environmentKind: "live",
      sourceTestDeploymentId: `${testId}-stale`,
      confirmation: "PROMOTE LIVE",
    })), params(flowId)), 409, { error: "promotion conflict" });
  });
});
