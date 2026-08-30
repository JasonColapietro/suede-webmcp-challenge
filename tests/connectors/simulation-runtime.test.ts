import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSimulationAuthority, consumeSimulationAuthority } from "@/lib/connectors/simulation-authority";
import { runLocalApiOperationSimulation } from "@/lib/connectors/simulation-runtime";
import type { PlannedFlowTestScope } from "@/lib/flow/test-scope";
import type { FlowGraphV2, JsonValue } from "@/lib/flow/types";

const requestSchema = {
  type: "object" as const,
  properties: {
    path: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
    query: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
    headers: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
  },
  required: ["path", "query", "headers"],
  additionalProperties: false as const,
};

const resultSchema = {
  type: "object" as const,
  properties: {
    status: { type: "integer" as const, minimum: 200, maximum: 200 },
    body: {
      type: "object" as const,
      properties: { ok: { type: "boolean" as const } },
      required: ["ok"],
      additionalProperties: false as const,
    },
  },
  required: ["status", "body"],
  additionalProperties: false as const,
};

function dependencyGraph(entries: readonly string[]): ReadonlyMap<string, string> {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const pending = entries.map((entry) => join(root, entry));
  const visited = new Map<string, string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    const source = readFileSync(file, "utf8");
    visited.set(file, source);
    const imports = source.matchAll(/(?:import|export)\s+(type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu);
    for (const match of imports) {
      if (match[1]) continue;
      const specifier = match[2] ?? match[3];
      if (!specifier || (!specifier.startsWith("@/") && !specifier.startsWith("."))) continue;
      const base = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2)) : resolve(dirname(file), specifier);
      const candidate = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
        .find((path) => existsSync(path) && statSync(path).isFile());
      if (candidate) pending.push(candidate);
    }
  }
  return visited;
}

function graph(type: "transform" | "subflow" = "transform"): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "flow-a",
    name: "Simulation",
    nodes: [
      {
        id: "api", type: "api.operation", position: { x: 0, y: 0 }, bindings: {
          request: { kind: "literal", value: { path: {}, query: {}, headers: {} } },
        }, params: {
          connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000010",
          operationVersionId: "00000000-0000-4000-8000-000000000011",
          operationId: "getWidget",
          connectorProjectionHash: "a".repeat(64),
          operationProjectionHash: "b".repeat(64),
          schemaHash: "c".repeat(64),
        },
      },
      {
        id: "next", type, position: { x: 100, y: 0 }, bindings: {},
        params: type === "transform" ? { expression: "in.status == 200 ? in.body.ok : true" } : {},
      },
      { id: "out", type: "output", position: { x: 200, y: 0 }, bindings: {}, params: {} },
    ],
    edges: [
      { id: "e1", source: "api", sourceHandle: "result", target: "next", targetHandle: "in" },
      { id: "e2", source: "next", sourceHandle: "result", target: "out", targetHandle: "in" },
    ],
    variables: [], groups: [], annotations: [],
  };
}

function lease(
  value = graph(),
  signal = new AbortController().signal,
  plan: PlannedFlowTestScope = { status: "planned", scope: { kind: "from-node", nodeId: "api" }, executionOrder: ["api", "next", "out"], nodeIds: ["api", "next", "out"], edgeIds: ["e1", "e2"], boundaryPins: [], boundaryNodeIds: [], unreachableNodeIds: [], disabledNodeIds: [] },
  pinnedInputs: Readonly<Record<string, JsonValue>> = {},
) {
  const reference = value.nodes[0]!.params as never;
  return consumeSimulationAuthority(createSimulationAuthority({
    ownerId: "owner-a", actorId: "owner-a", flowId: "flow-a", flowUpdatedAt: 1,
    environmentId: "environment-test", nodeId: "api", scope: { kind: "from-node", nodeId: "api" },
    context: { bindingCreatedAt: 1, environmentCreatedAt: 1, organizationId: "org", workspaceId: "workspace", projectId: "project", projectUpdatedAt: 1, workbookId: "workbook" },
    signal, deadlineGeneration: 1, deadlineAtMs: Number.MAX_SAFE_INTEGER, graph: value,
    plan,
    pinnedInputs, requestSchema, resultSchema,
    reference, closure: {} as never, lifecycleRevision: 1, archivedAt: null, dependencyPins: [],
    portProjection: { reference, requestSchema, resultSchema },
    systemPolicy: { effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" },
  }));
}

describe("private API operation simulation runtime", () => {
  it("propagates the trusted sentinel through local transform and output without returning values", async () => {
    const result = await runLocalApiOperationSimulation(lease());
    expect(result).toEqual({ ok: true, plannedNodeCount: 3, completedNodeCount: 3, egressCount: 0, costUsdc: 0 });
    expect(JSON.stringify(result)).not.toContain("status");
    expect(JSON.stringify(result)).not.toContain("body");
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("refuses unsupported nodes and a second api operation with fixed value-opaque output", async () => {
    await expect(runLocalApiOperationSimulation(lease(graph("subflow")))).resolves.toEqual({ ok: false, code: "SIMULATION_REFUSED" });
    const base = graph();
    const duplicate = {
      ...base,
      nodes: [base.nodes[0]!, { ...base.nodes[1]!, type: "api.operation" as const, params: base.nodes[0]!.params }, base.nodes[2]!],
    };
    await expect(runLocalApiOperationSimulation(lease(duplicate))).resolves.toEqual({ ok: false, code: "SIMULATION_REFUSED" });
  });

  it("observes cancellation before and between nodes", async () => {
    const controller = new AbortController();
    const cancelled = lease(graph(), controller.signal);
    controller.abort();
    await expect(runLocalApiOperationSimulation(cancelled)).resolves.toEqual({ ok: false, code: "SIMULATION_CANCELLED" });
  });

  it("stops after the current local node when cancellation arrives mid-runtime", async () => {
    const controller = new AbortController();
    const running = runLocalApiOperationSimulation(lease(graph(), controller.signal));
    controller.abort();
    await expect(running).resolves.toEqual({ ok: false, code: "SIMULATION_CANCELLED" });
  });

  it("consumes an exact frozen boundary pin without exposing authority metadata", async () => {
    const value = graph();
    const api = value.nodes[0]!;
    const projected = {
      ...value,
      nodes: [{ ...api, bindings: { request: { kind: "port" as const, nodeId: "outside", portId: "result" } } }, ...value.nodes.slice(1)],
    };
    const key = JSON.stringify(["node-binding", "api", "request", "outside", "result", null]);
    const plan = {
      status: "planned" as const,
      scope: { kind: "from-node" as const, nodeId: "api" },
      executionOrder: ["api", "next", "out"], nodeIds: ["api", "next", "out"], edgeIds: ["e1", "e2"],
      boundaryPins: [{ kind: "node-binding" as const, key, sourceNodeId: "outside", sourcePortId: "result", targetNodeId: "api", bindingKey: "request" }],
      boundaryNodeIds: ["outside"], unreachableNodeIds: [], disabledNodeIds: ["outside"],
    };
    await expect(runLocalApiOperationSimulation(lease(projected, new AbortController().signal, plan, {
      [key]: { path: {}, query: {}, headers: {} },
    }))).resolves.toEqual({ ok: true, plannedNodeCount: 3, completedNodeCount: 3, egressCount: 0, costUsdc: 0 });
  });

  it("skips the inactive branch arm and counts only executed nodes", async () => {
    const base = graph();
    const api = base.nodes[0]!;
    const branchGraph: FlowGraphV2 = {
      ...base,
      nodes: [
        api,
        { id: "branch", type: "branch", position: { x: 100, y: 0 }, bindings: {}, params: { field: "status", equals: 200 } },
        { id: "yes", type: "output", position: { x: 200, y: -50 }, bindings: {}, params: {} },
        { id: "no", type: "output", position: { x: 200, y: 50 }, bindings: {}, params: {} },
      ],
      edges: [
        { id: "to-branch", source: "api", sourceHandle: "result", target: "branch", targetHandle: "in" },
        { id: "yes-edge", source: "branch", sourceHandle: "true", target: "yes", targetHandle: "in" },
        { id: "no-edge", source: "branch", sourceHandle: "false", target: "no", targetHandle: "in" },
      ],
    };
    const plan = {
      status: "planned" as const, scope: { kind: "from-node" as const, nodeId: "api" },
      executionOrder: ["api", "branch", "no", "yes"], nodeIds: ["api", "branch", "no", "yes"],
      edgeIds: ["to-branch", "no-edge", "yes-edge"], boundaryPins: [], boundaryNodeIds: [], unreachableNodeIds: [], disabledNodeIds: [],
    };
    await expect(runLocalApiOperationSimulation(lease(branchGraph, new AbortController().signal, plan)))
      .resolves.toEqual({ ok: true, plannedNodeCount: 4, completedNodeCount: 3, egressCount: 0, costUsdc: 0 });
  });

  it("has a recursively capability-free contract, authority, and runtime dependency graph", () => {
    const graph = dependencyGraph([
      "src/lib/connectors/simulation-contract.ts",
      "src/lib/connectors/simulation-authority.ts",
      "src/lib/connectors/simulation-runtime.ts",
    ]);
    const paths = [...graph.keys()].join("\n");
    const sources = [...graph.values()].join("\n");
    for (const forbidden of [
      "/lib/connections/", "/lib/rails/", "/lib/llm.ts", "/lib/run-context.ts", "/lib/run-service.ts",
      "/flow/nodes/index.ts", "/connections/provider", "/connections/crypto", "/connections/resolver",
    ]) expect(paths).not.toContain(forbidden);
    expect(sources).not.toMatch(/["']node:(?:http|https|net|tls|dns(?:\/promises)?|dgram|child_process|fs|worker_threads)["']/u);
    expect(sources).not.toMatch(/\bfetch\s*\(|\bnew\s+WebSocket\b|\b(?:resolveSecret|decryptCredential)\s*\(|\bprocess\.env\b/iu);
    expect(sources).not.toMatch(/\b(?:provider|model|payment|wallet)\s*\./iu);
    expect(sources).not.toMatch(/\b(?:get|create|resolve|load|invoke|call|run|execute|charge|settle|decrypt)[A-Za-z0-9_]*(?:Provider|Model|Payment|Wallet|Credential|Secret)\s*\(/u);
  });

  it("completes while hostile ambient network seams remain at zero calls", async () => {
    const originalFetch = globalThis.fetch;
    const hostileFetch = vi.fn(async () => { throw new Error("network canary"); });
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: hostileFetch });
    try {
      await expect(runLocalApiOperationSimulation(lease())).resolves.toMatchObject({ ok: true, egressCount: 0, costUsdc: 0 });
      expect(hostileFetch).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: originalFetch });
    }
  });
});
