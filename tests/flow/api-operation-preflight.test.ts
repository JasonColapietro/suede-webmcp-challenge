import { describe, expect, it, vi } from "vitest";
import {
  API_OPERATION_LIVE_UNAVAILABLE,
  ApiOperationLiveUnavailableError,
} from "@/lib/connectors/operation-closure";
import { collectRun, runCompiledTestFlow, runFlow } from "@/lib/flow/engine";
import { getRegistry } from "@/lib/flow/registry";
import { validateAndCompileTestRunRequest } from "@/lib/flow/test-run-contract";
import type { FlowGraphV2 } from "@/lib/flow/types";
import { makeCtx } from "../_helpers";

const params = {
  connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000601",
  operationVersionId: "00000000-0000-4000-8000-000000000602",
  operationId: "createThing",
  connectorProjectionHash: "1".repeat(64),
  operationProjectionHash: "2".repeat(64),
  schemaHash: "3".repeat(64),
  readinessBinding: { kind: "connection" as const, connectionId: "connection_test_1", capability: "http.headers" as const },
};

function graph(
  bindings: FlowGraphV2["nodes"][number]["bindings"] = {},
  nodeParams: unknown = params,
): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "api-graph",
    name: "API graph",
    nodes: [{ id: "api", type: "api.operation", params: nodeParams as never, bindings, position: { x: 0, y: 0 } }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

describe("api.operation execution preflight", () => {
  it("ordinary dry preview uses the fixed zero-network placeholder before bindings", async () => {
    const resolveSecretReference = vi.fn(async () => { throw new Error("must not resolve"); });
    const ctx = makeCtx({ dryRun: true, resolveSecretReference });
    const result = await collectRun(runFlow(graph(), ctx, getRegistry()));
    expect(result.status).toBe("done");
    expect(result.outputs.api).toEqual({ result: { status: 0, body: null } });
    expect(resolveSecretReference).not.toHaveBeenCalled();
  });

  it("manual Live refuses with the typed fixed code before binding resolution or dispatch", async () => {
    const resolveSecretReference = vi.fn(async () => { throw new Error("must not resolve"); });
    const registry = getRegistry();
    const execute = vi.spyOn(registry["api.operation"]!, "executor");
    const ctx = makeCtx({ dryRun: false, resolveSecretReference });
    await expect(collectRun(runFlow(
      graph(),
      ctx,
      registry,
    ))).rejects.toEqual(expect.objectContaining({ code: API_OPERATION_LIVE_UNAVAILABLE }));
    expect(resolveSecretReference).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(new ApiOperationLiveUnavailableError().message).toBe(API_OPERATION_LIVE_UNAVAILABLE);
  });

  it("ordinary scoped Test refuses missing, foreign, drifted, and forged operation pins before dispatch", async () => {
    const runtime = getRegistry()["api.operation"]!;
    const dispatch = vi.spyOn(runtime, "dryRunStub");
    const { operationVersionId: _missing, ...missingOperation } = params;
    const variants: readonly unknown[] = [
      missingOperation,
      { ...params, operationVersionId: "00000000-0000-4000-8000-000000000699" },
      { ...params, connectorProjectionHash: "a".repeat(64) },
      { ...params, operationProjectionHash: "b".repeat(64) },
      { ...params, schemaHash: "c".repeat(64) },
      { ...params, requestSchema: { type: "string" }, resultSchema: { type: "number" } },
    ];
    for (const nodeParams of variants) {
      expect(validateAndCompileTestRunRequest({
        graph: graph({}, nodeParams), scope: { kind: "node", nodeId: "api" }, pinnedInputs: {}, mode: "test", environmentId: "local-test",
      }).ok).toBe(false);
    }
    expect(dispatch).not.toHaveBeenCalled();

    const safe = validateAndCompileTestRunRequest({
      graph: {
        schemaVersion: 2, id: "safe", name: "safe",
        nodes: [{ id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
        edges: [], variables: [], groups: [], annotations: [],
      },
      scope: { kind: "node", nodeId: "input" }, pinnedInputs: {}, mode: "test", environmentId: "local-test",
    });
    expect(safe.ok).toBe(true);
    if (!safe.ok) return;
    const forged = { ...structuredClone(safe.value), graph: graph() } as typeof safe.value;
    await expect(collectRun(runCompiledTestFlow(forged))).rejects.toThrow(/scoped test execution is invalid/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("run service refuses manual Live before opening the run repository", async () => {
    vi.resetModules();
    const getRepo = vi.fn(async () => { throw new Error("must not open"); });
    vi.doMock("@/lib/db/repo", () => ({ getRepo }));
    const service = await import("@/lib/run-service");
    const stream = service.runAndStream(graph(), { trigger: "manual", dryRun: false });
    await expect(stream.next()).rejects.toMatchObject({ code: API_OPERATION_LIVE_UNAVAILABLE });
    expect(getRepo).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/db/repo");
  });

  it("published Live refuses before opening a connection provider", async () => {
    vi.resetModules();
    const getConnectionRepository = vi.fn(async () => { throw new Error("must not open"); });
    const execution = {
      graph: graph(),
      subflowSnapshot: {},
      usesConnections: true,
      receipt: { ownerId: "owner-a", flowId: "flow-a", deploymentId: "deployment-a", environmentId: "live-a", flowVersionId: "version-a", semanticHash: "a".repeat(64), fullHash: "b".repeat(64) },
    };
    vi.doMock("@/lib/projects/provider", () => ({ getProjectRepo: vi.fn(async () => ({})) }));
    vi.doMock("@/lib/projects/live-execution", () => ({ resolveActiveLiveExecution: vi.fn(async () => execution) }));
    vi.doMock("@/lib/connections/provider", () => ({ getConnectionRepository }));
    const service = await import("@/lib/run-service");
    await expect(service.preparePublishedLiveExecution({ flowId: "flow-a", ownerId: "owner-a" }))
      .rejects.toMatchObject({ code: API_OPERATION_LIVE_UNAVAILABLE });
    expect(getConnectionRepository).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/projects/provider");
    vi.doUnmock("@/lib/projects/live-execution");
    vi.doUnmock("@/lib/connections/provider");
  });
});
