import { describe, expect, it, vi } from "vitest";
import {
  PersistedRunPreflightError,
  preflightPersistedRun,
} from "@/lib/flow/run-subflow-preflight";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { hashFlowGraph } from "@/lib/projects/hash";
import type {
  FlowCallableInterface,
  FlowGraph,
  FlowGraphV2,
  FlowNodeV2,
  SubflowReference,
  SupportedFlowGraph,
} from "@/lib/flow/types";

const emptyInterface: FlowCallableInterface = { inputs: [], outputs: [] };
const changedInterface: FlowCallableInterface = {
  inputs: [{
    id: "value", label: "Value", schema: {}, required: false, cardinality: "one",
    target: { kind: "trigger", path: "/value" },
  }],
  outputs: [],
};

function child(id: string, callableInterface = emptyInterface, nodes: readonly FlowNodeV2[] = []): FlowGraphV2 {
  return {
    schemaVersion: 2, id, name: id, callableInterface, nodes, edges: [],
    variables: [], groups: [], annotations: [],
  };
}

function draft(flowId: string, callableInterface = emptyInterface): SubflowReference {
  return { kind: "draft", flowId, interface: callableInterface, interfaceHash: hashCallableInterface(callableInterface) };
}

function wrapper(id: string, reference: SubflowReference): FlowNodeV2 {
  return {
    id, type: "subflow", params: { reference } as never, bindings: {}, position: { x: 0, y: 0 },
  };
}

function root(nodes: readonly FlowNodeV2[]): FlowGraphV2 {
  return {
    schemaVersion: 2, id: "root-graph", name: "Root", nodes, edges: [],
    variables: [], groups: [], annotations: [],
  };
}

function harness(flows: Readonly<Record<string, SupportedFlowGraph>>, versions: Readonly<Record<string, SupportedFlowGraph>> = {}) {
  const getOwnedFlow = vi.fn(async (flowId: string, ownerId: string) => {
    const graph = ownerId === "owner" ? flows[flowId] : undefined;
    return graph ? { id: flowId, ownerId, name: graph.name, graph, updatedAt: 1 } : null;
  });
  const getFlowVersion = vi.fn(async ({ flowId, versionId, ownerId }: {
    flowId: string; versionId: string; ownerId: string;
  }) => {
    const graph = ownerId === "owner" ? versions[`${flowId}:${versionId}`] : undefined;
    return graph ? {
      id: versionId, flowId, graph, semanticHash: hashFlowGraph(graph, { semantic: true }),
      dependencies: [],
    } as never : null;
  });
  return { getOwnedFlow, getFlowVersion };
}

async function expectPrivateRefusal(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "PersistedRunPreflightError",
    status: 409,
    publicError: "reusable flow unavailable",
  });
}

describe("persisted run reusable-flow preflight", () => {
  it("preserves v1 behavior without resolving its legacy closure", async () => {
    const v1: FlowGraph = {
      id: "legacy", name: "Legacy",
      nodes: [{ id: "sub", type: "subflow", params: { flowId: "missing" }, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const stores = harness({});
    await expect(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: v1,
      flowRepo: stores, versionRepo: stores,
    })).resolves.toEqual({ graph: v1 });
    expect(stores.getOwnedFlow).not.toHaveBeenCalled();
  });

  it("validates a complete mixed draft, pinned, and legacy closure before returning", async () => {
    const leaf = child("leaf");
    const pinnedLeaf = child("pinned-leaf");
    const legacyLeaf: FlowGraph = {
      id: "legacy", name: "Legacy",
      nodes: [{ id: "deep", type: "subflow", params: { flowId: "deep-legacy" }, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const deepLegacy: FlowGraph = { id: "deep-legacy", name: "Deep legacy", nodes: [], edges: [] };
    const nested = child("nested", emptyInterface, [wrapper("nested-leaf", draft("leaf"))]);
    const pinnedReference: SubflowReference = {
      kind: "pinned", flowId: "pinned", versionId: "v1",
      interface: emptyInterface, interfaceHash: hashCallableInterface(emptyInterface),
      contentHash: hashFlowGraph(pinnedLeaf, { semantic: true }),
    };
    const legacyWrapper: FlowNodeV2 = {
      id: "legacy-wrapper", type: "subflow", params: { flowId: "legacy" }, bindings: {}, position: { x: 0, y: 0 },
    };
    const graph = root([wrapper("nested", draft("nested")), wrapper("pinned", pinnedReference), legacyWrapper]);
    const stores = harness({ nested, leaf, legacy: legacyLeaf, "deep-legacy": deepLegacy }, { "pinned:v1": pinnedLeaf });

    await expect(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph,
      flowRepo: stores, versionRepo: stores,
    })).resolves.toMatchObject({ graph });
    expect(stores.getOwnedFlow).toHaveBeenCalledWith("nested", "owner");
    expect(stores.getOwnedFlow).toHaveBeenCalledWith("leaf", "owner");
    expect(stores.getOwnedFlow).toHaveBeenCalledWith("legacy", "owner");
    expect(stores.getOwnedFlow).toHaveBeenCalledWith("deep-legacy", "owner");
    expect(stores.getFlowVersion).toHaveBeenCalledWith({ flowId: "pinned", versionId: "v1", ownerId: "owner" });
  });

  it("returns one private reference class for missing, foreign, draft drift, and pinned drift", async () => {
    const driftedChild = child("drift", changedInterface);
    const pinnedChild = child("pinned");
    const cases: Array<{ graph: FlowGraphV2; stores: ReturnType<typeof harness> }> = [
      { graph: root([wrapper("missing", draft("missing"))]), stores: harness({}) },
      { graph: root([wrapper("foreign", draft("foreign"))]), stores: harness({}) },
      { graph: root([wrapper("drift", draft("drift"))]), stores: harness({ drift: driftedChild }) },
      {
        graph: root([wrapper("pinned", {
          kind: "pinned", flowId: "pinned", versionId: "v1",
          interface: emptyInterface, interfaceHash: hashCallableInterface(emptyInterface), contentHash: "0".repeat(64),
        })]),
        stores: harness({}, { "pinned:v1": pinnedChild }),
      },
    ];
    for (const value of cases) {
      await expectPrivateRefusal(preflightPersistedRun({
        rootFlowId: "root", ownerId: "owner", graph: value.graph,
        flowRepo: value.stores, versionRepo: value.stores,
      }));
    }
  });

  it("revalidates distinct receipts for the same child while memoizing identical receipts", async () => {
    const actual = child("same-child");
    const stores = harness({ "same-child": actual });
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner",
      graph: root([
        wrapper("valid", draft("same-child")),
        wrapper("stale", draft("same-child", changedInterface)),
      ]),
      flowRepo: stores, versionRepo: stores,
    }));
    expect(stores.getOwnedFlow).toHaveBeenCalledTimes(2);
  });

  it("refuses unresolved wrappers and transitive recursion privately", async () => {
    const unresolved = root([{
      id: "empty", type: "subflow", params: {}, bindings: {}, position: { x: 0, y: 0 },
    }]);
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: unresolved,
      flowRepo: harness({}), versionRepo: harness({}),
    }));

    const nested = child("nested", emptyInterface, [wrapper("back", draft("root"))]);
    const stores = harness({ nested, root: root([]) });
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: root([wrapper("nested", draft("nested"))]),
      flowRepo: stores, versionRepo: stores,
    }));
  });

  it("memoizes repeated references while refusing cycles and closure bounds privately", async () => {
    const leaf = child("leaf");
    const stores = harness({ leaf });
    await expect(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner",
      graph: root([wrapper("one", draft("leaf")), wrapper("two", draft("leaf"))]),
      flowRepo: stores, versionRepo: stores,
    })).resolves.toMatchObject({ graph: expect.any(Object), subflowSnapshot: expect.any(Object) });
    expect(stores.getOwnedFlow).toHaveBeenCalledTimes(1);

    const cycleA = child("a", emptyInterface, [wrapper("to-b", draft("b"))]);
    const cycleB = child("b", emptyInterface, [wrapper("to-a", draft("a"))]);
    const cyclicStores = harness({ a: cycleA, b: cycleB });
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: root([wrapper("to-a", draft("a"))]),
      flowRepo: cyclicStores, versionRepo: cyclicStores,
    }));

    const longFlows: Record<string, SupportedFlowGraph> = {};
    for (let index = 0; index < 70; index += 1) {
      const next = `depth-${index + 1}`;
      longFlows[`depth-${index}`] = child(
        `depth-${index}`,
        emptyInterface,
        index === 69 ? [] : [wrapper(`to-${next}`, draft(next))],
      );
    }
    const longStores = harness(longFlows);
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: root([wrapper("deep", draft("depth-0"))]),
      flowRepo: longStores, versionRepo: longStores,
    }));

    const tooManyNodes = Array.from({ length: 20_001 }, (_, index): FlowNodeV2 => ({
      id: `node-${index}`, type: "transform", params: {}, bindings: {}, position: { x: 0, y: 0 },
    }));
    const large = child("large", emptyInterface, tooManyNodes);
    const largeStores = harness({ large });
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: root([wrapper("large", draft("large"))]),
      flowRepo: largeStores, versionRepo: largeStores,
    }));
  });

  it("recomputes pinned content and validates callable output source ports", async () => {
    const pinnedGraph = child("pinned");
    const reference: SubflowReference = {
      kind: "pinned", flowId: "pinned", versionId: "v1",
      interface: emptyInterface, interfaceHash: hashCallableInterface(emptyInterface),
      contentHash: "0".repeat(64),
    };
    const forgedVersionRepo = {
      getFlowVersion: vi.fn(async () => ({
        id: "v1", flowId: "pinned", graph: pinnedGraph,
        semanticHash: reference.contentHash,
        dependencies: [],
      }) as never),
    };
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: root([wrapper("pinned", reference)]),
      flowRepo: harness({}), versionRepo: forgedVersionRepo,
    }));

    const dependency = { kind: "skill" as const, resourceId: "skill", version: "1", contentHash: "abc" };
    const dependencyHash = hashFlowGraph(pinnedGraph, { semantic: true }, [dependency]);
    const dependencyReference: SubflowReference = {
      ...reference,
      contentHash: dependencyHash,
    };
    const dependencyVersionRepo = {
      getFlowVersion: vi.fn(async () => ({
        id: "v1", flowId: "pinned", graph: pinnedGraph, semanticHash: dependencyHash,
        dependencies: [{
          id: "pin", flowVersionId: "v1", createdAt: 123, ...dependency,
        }],
      }) as never),
    };
    await expect(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner",
      graph: root([wrapper("pinned", dependencyReference)]),
      flowRepo: harness({}), versionRepo: dependencyVersionRepo,
    })).resolves.toMatchObject({ graph: expect.any(Object), subflowSnapshot: expect.any(Object) });

    const forgedDependencyRepo = {
      getFlowVersion: vi.fn(async () => ({
        id: "v1", flowId: "pinned", graph: pinnedGraph, semanticHash: dependencyHash,
        dependencies: [{
          id: "pin", flowVersionId: "v1", createdAt: 123,
          ...dependency, version: "forged",
        }],
      }) as never),
    };
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner",
      graph: root([wrapper("pinned", dependencyReference)]),
      flowRepo: harness({}), versionRepo: forgedDependencyRepo,
    }));

    const callableWithBadPort: FlowCallableInterface = {
      inputs: [],
      outputs: [{
        id: "result", label: "Result", schema: {}, required: false, cardinality: "one",
        source: { nodeId: "work", portId: "not-an-output" },
      }],
    };
    const malformed = child("malformed", callableWithBadPort, [{
      id: "work", type: "transform", params: {}, bindings: {}, position: { x: 0, y: 0 },
    }]);
    const malformedStores = harness({ malformed });
    await expectPrivateRefusal(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner",
      graph: root([wrapper("malformed", draft("malformed", callableWithBadPort))]),
      flowRepo: malformedStores, versionRepo: malformedStores,
    }));
  });

  it("returns a resolver snapshot that cannot race a later draft save", async () => {
    const reference = draft("mutable");
    const before = child("before");
    let current: SupportedFlowGraph = before;
    const getOwnedFlow = vi.fn(async (flowId: string, ownerId: string) =>
      flowId === "mutable" && ownerId === "owner"
        ? { id: flowId, ownerId, name: current.name, graph: current, updatedAt: 1 }
        : null,
    );
    const versionRepo = harness({});
    const preflighted = await preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner", graph: root([wrapper("mutable", reference)]),
      flowRepo: { getOwnedFlow }, versionRepo,
    });
    (before as { name: string }).name = "mutated after preflight";
    current = child("after", changedInterface);

    const resolved = await preflighted.subflowSnapshot?.resolveSubflow(reference);
    expect(resolved?.graph.name).toBe("before");
    expect(Object.isFrozen(resolved?.graph)).toBe(true);
    expect(getOwnedFlow).toHaveBeenCalledTimes(1);
  });

  it("classifies an invalid root graph as stable 422 without reading children", async () => {
    const stores = harness({});
    await expect(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner",
      graph: { ...root([]), nodes: [{ id: "bad", type: "not-real", params: {}, bindings: {}, position: { x: 0, y: 0 } }] } as never,
      flowRepo: stores, versionRepo: stores,
    })).rejects.toBeInstanceOf(PersistedRunPreflightError);
    await expect(preflightPersistedRun({
      rootFlowId: "root", ownerId: "owner",
      graph: { ...root([]), nodes: [{ id: "bad", type: "not-real", params: {}, bindings: {}, position: { x: 0, y: 0 } }] } as never,
      flowRepo: stores, versionRepo: stores,
    })).rejects.toMatchObject({ status: 422, publicError: "flow is not runnable" });
    expect(stores.getOwnedFlow).not.toHaveBeenCalled();
  });
});
