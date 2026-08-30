import { describe, expect, it } from "vitest";
import {
  abandonSimulationLease,
  assertActiveSimulationLease,
  consumeSimulationAuthority,
  createSimulationAuthority,
  finalizeSimulationLease,
  readSimulationRuntimeLease,
} from "@/lib/connectors/simulation-authority";

function facts(signal = new AbortController().signal) {
  const reference = {
    connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000001",
    operationVersionId: "00000000-0000-4000-8000-000000000002",
    operationId: "operation",
    connectorProjectionHash: "a".repeat(64), operationProjectionHash: "b".repeat(64), schemaHash: "c".repeat(64),
  };
  const graph = { schemaVersion: 2 as const, id: "flow-a", name: "Flow", nodes: [], edges: [], variables: [], groups: [], annotations: [] };
  const plan = { status: "planned" as const, scope: { kind: "node" as const, nodeId: "api" }, executionOrder: [], nodeIds: [], edgeIds: [], boundaryPins: [], boundaryNodeIds: [], unreachableNodeIds: [], disabledNodeIds: [] };
  return {
    ownerId: "owner-a",
    actorId: "owner-a",
    flowId: "flow-a",
    flowUpdatedAt: 10,
    environmentId: "environment-test",
    context: { bindingCreatedAt: 1, environmentCreatedAt: 1, organizationId: "org", workspaceId: "workspace", projectId: "project", projectUpdatedAt: 1, workbookId: "workbook" },
    nodeId: "api",
    scope: { kind: "node" as const, nodeId: "api" },
    signal,
    deadlineGeneration: 1,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
    graph, plan, pinnedInputs: {}, reference,
    closure: {} as never, lifecycleRevision: 1, archivedAt: null, dependencyPins: [],
    portProjection: { reference, requestSchema: { type: "null" as const }, resultSchema: { type: "null" as const } },
    requestSchema: { type: "null" as const }, resultSchema: { type: "null" as const },
    systemPolicy: { effects: ["write"] as const, retry: "unsafe" as const, cost: "unknown" as const, idempotency: "none" as const },
  };
}

describe("simulation authority", () => {
  it("is non-forgeable, one-use, owner-bound, and signal-bound", () => {
    const signal = new AbortController().signal;
    const bound = facts(signal);
    const authority = createSimulationAuthority(bound);
    expect(() => consumeSimulationAuthority(JSON.parse(JSON.stringify(authority)))).toThrow("Invalid simulation authority");
    expect(() => consumeSimulationAuthority(structuredClone(authority))).toThrow("Invalid simulation authority");
    const lease = consumeSimulationAuthority(authority);
    expect(() => consumeSimulationAuthority(authority)).toThrow("Invalid simulation authority");
    expect(() => assertActiveSimulationLease(lease, { ...bound, ownerId: "owner-b" })).toThrow();
    expect(() => assertActiveSimulationLease(lease, { ...bound, signal: new AbortController().signal })).toThrow();
    expect(() => assertActiveSimulationLease(lease, { ...bound, deadlineGeneration: 2 })).toThrow();
    expect(assertActiveSimulationLease(lease, bound).ownerId).toBe("owner-a");
  });

  it("refuses finalized and abandoned leases", () => {
    const firstSignal = new AbortController().signal;
    const firstFacts = facts(firstSignal);
    const first = consumeSimulationAuthority(createSimulationAuthority(firstFacts));
    finalizeSimulationLease(first);
    expect(() => assertActiveSimulationLease(first, firstFacts)).toThrow("Invalid simulation lease");

    const signal = new AbortController().signal;
    const secondFacts = facts(signal);
    const second = consumeSimulationAuthority(createSimulationAuthority(secondFacts));
    abandonSimulationLease(second);
    expect(() => assertActiveSimulationLease(second, secondFacts)).toThrow("Invalid simulation lease");
  });

  it("projects only the frozen capability-free runtime facts and refuses proxy/accessor authority", () => {
    const pin = JSON.stringify(["node-binding", "api", "request", "source", "result", null]);
    const bound = { ...facts(), pinnedInputs: { [pin]: { safe: true } } };
    const lease = consumeSimulationAuthority(createSimulationAuthority(bound));
    const runtime = readSimulationRuntimeLease(lease);
    expect(Object.keys(runtime).sort()).toEqual([
      "deadlineAtMs", "graph", "nodeId", "pinnedInputs", "plan", "requestSchema", "resultSchema", "signal",
    ]);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.pinnedInputs)).toBe(true);
    expect(Object.isFrozen(runtime.pinnedInputs[pin])).toBe(true);
    for (const excluded of ["ownerId", "actorId", "context", "closure", "reference", "dependencyPins", "systemPolicy"]) {
      expect(Object.hasOwn(runtime, excluded)).toBe(false);
    }

    let traps = 0;
    const proxy = new Proxy(facts(), { getPrototypeOf: () => { traps += 1; return Object.prototype; } });
    expect(() => createSimulationAuthority(proxy)).toThrow("Invalid simulation authority");
    expect(traps).toBe(0);
    const accessor = facts();
    Object.defineProperty(accessor, "ownerId", { enumerable: true, get: () => "owner-a" });
    expect(() => createSimulationAuthority(accessor)).toThrow("Invalid simulation authority");
  });
});
