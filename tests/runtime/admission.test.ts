import { describe, expect, it, vi } from "vitest";
import {
  DURABLE_GRAPH_LIMITS,
  DURABLE_NODE_ADMISSION,
  admitDurableGraph,
} from "@/lib/runtime/admission";
import { NODE_DEFS } from "@/lib/flow/registry";
import { hashCallableInterface, sha256Utf8 } from "@/lib/flow/subflow-reference";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  FlowNode,
  NodeType,
  SubflowReference,
  SupportedFlowGraph,
} from "@/lib/flow/types";

const directTypes = [
  "schedule", "input", "output", "transform", "branch",
  "docs.extractText", "docs.extractDocx", "docs.knowledgeSearch",
  "data.parseSpreadsheet", "finance.generateInvoicePdf",
  "logic.switch", "logic.aggregate",
] as const;
const closureTypes = ["subflow", "loop"] as const;
const refusedTypes = [
  "webhook",
  "resource.query",
  "llm",
  "ai.classify",
  "ai.extract",
      "api.operation",
      "http",
  "suede.styleCoach",
  "suede.lyrics",
  "suede.generateSong",
  "suede.analyze",
  "suede.stems",
  "suede.midi",
  "suede.mastering",
  "suede.rightsLookup",
  "suede.registerIp",
  "suede.royaltySplit",
  "suede.chainChat",
  "suede.promo",
  "suede.promoClaims",
  "comms.slackMessage",
  "comms.crmWebhook",
  "devops.githubIssue",
  "devops.githubRead",
  "devops.githubWorkflowDispatch",
  "docs.generateReportPdf",
  "data.filterRows",
  "data.generateSpreadsheet",
  "web.fetchUrl",
] as const;

function graphWith(type: NodeType, params: Record<string, unknown> = {}): SupportedFlowGraph {
  const node: FlowNode = { id: "node-1", type, params, position: { x: 0, y: 0 } };
  return { id: "root", name: "root", nodes: [node], edges: [] };
}

const validParams: Readonly<Record<(typeof directTypes)[number], Record<string, unknown>>> = {
  schedule: { cron: "0 * * * *" },
  input: {},
  output: {},
  transform: { expression: "in" },
  branch: {},
  "docs.extractText": {},
  "docs.extractDocx": {},
  "docs.knowledgeSearch": {},
  "data.parseSpreadsheet": {},
  "logic.switch": { field: "status", cases: { urgent: "a" } },
  "logic.aggregate": { op: "sum", field: "amount" },
  "finance.generateInvoicePdf": {
    invoiceNumber: "INV-1",
    sellerName: "Acme",
    buyerName: "Client",
    lineItems: [{ description: "Item", quantity: 1, unitPrice: 1 }],
  },
};

function directGraph(type: (typeof directTypes)[number]): SupportedFlowGraph {
  return graphWith(type, { ...validParams[type] });
}

function v2Graph(input: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "v2-root",
    name: "v2-root",
    nodes: [{ id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    ...input,
  };
}

const EMPTY_CALLABLE: FlowCallableInterface = { inputs: [], outputs: [] };
const INTERFACE_HASH = hashCallableInterface(EMPTY_CALLABLE);

function typedReference(kind: "draft" | "pinned", flowId: string): SubflowReference {
  return kind === "draft"
    ? { kind, flowId, interface: EMPTY_CALLABLE, interfaceHash: INTERFACE_HASH }
    : {
        kind,
        flowId,
        versionId: `${flowId}-version`,
        interface: EMPTY_CALLABLE,
        interfaceHash: INTERFACE_HASH,
        contentHash: "a".repeat(64),
      };
}

function expectRefusal(
  result: Awaited<ReturnType<typeof admitDurableGraph>>,
  code?: string,
): void {
  expect(result).toMatchObject({ ok: false, ...(code ? { code } : {}) });
}

describe("durable complete-closure admission", () => {
  it("classifies every canonical node explicitly and admits only the direct replay-safe set", async () => {
    expect(Object.keys(DURABLE_NODE_ADMISSION).sort()).toEqual(
      NODE_DEFS.map((definition) => definition.type).sort(),
    );
    expect(Object.entries(DURABLE_NODE_ADMISSION).filter(([, value]) => value === "direct").map(([type]) => type).sort())
      .toEqual([...directTypes].sort());
    expect(Object.entries(DURABLE_NODE_ADMISSION).filter(([, value]) => value === "closure").map(([type]) => type).sort())
      .toEqual([...closureTypes].sort());
    expect(Object.entries(DURABLE_NODE_ADMISSION).filter(([, value]) => value === "refuse").map(([type]) => type).sort())
      .toEqual([...refusedTypes].sort());

    for (const type of directTypes) {
      await expect(admitDurableGraph(directGraph(type))).resolves.toMatchObject({ ok: true });
    }
    for (const type of refusedTypes) {
      await expect(admitDurableGraph(graphWith(type))).resolves.toMatchObject({
        ok: false,
        code: "unsafe-node",
      });
    }
  });

  it("admits resolved subflow and bounded loop closures only when every descendant is safe", async () => {
    const safeChild = directGraph("transform");
    const loadSubflow = vi.fn(async (flowId: string) => {
      if (flowId === "safe-child") return safeChild;
      if (flowId === "unsafe-child") return graphWith("llm");
      throw new Error("not found");
    });

    await expect(admitDurableGraph(
      {
        id: "root",
        name: "root",
        nodes: [
          { id: "sub", type: "subflow", params: { flowId: "safe-child" }, position: { x: 0, y: 0 } },
          { id: "loop", type: "loop", params: { flowId: "safe-child", maxIterations: 10 }, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
      { loadSubflow },
    )).resolves.toMatchObject({ ok: true, graphCount: 2, nodeCount: 3 });
    expect(loadSubflow).toHaveBeenCalledTimes(1);

    await expect(admitDurableGraph(graphWith("subflow", { flowId: "unsafe-child" }), { loadSubflow }))
      .resolves.toMatchObject({ ok: false, code: "unsafe-node" });
  });

  it("fails closed for unknown nodes, unresolved descendants, recursive references, and unbounded loop params", async () => {
    await expect(admitDurableGraph(graphWith("future-node" as NodeType)))
      .resolves.toMatchObject({ ok: false, code: "unknown-node" });
    await expect(admitDurableGraph(graphWith("subflow", { flowId: "missing" })))
      .resolves.toMatchObject({ ok: false, code: "unresolved-reference" });
    await expect(admitDurableGraph(graphWith("loop", { flowId: "child", maxIterations: 0 }), {
      loadSubflow: async () => directGraph("transform"),
    })).resolves.toMatchObject({ ok: false, code: "invalid-node" });
    await expect(admitDurableGraph(graphWith("subflow", { flowId: "root" }), {
      loadSubflow: async () => graphWith("transform"),
    })).resolves.toMatchObject({ ok: false, code: "recursive-reference" });
  });

  it("fails closed for secret bindings anywhere in a v2 closure", async () => {
    const secretGraph: FlowGraphV2 = {
      schemaVersion: 2,
      id: "secret-child",
      name: "secret-child",
      nodes: [{
        id: "transform",
        type: "transform",
        params: { expression: "in" },
        bindings: { token: { kind: "secret", connectionId: "connection", field: "token" } },
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [],
      groups: [],
      annotations: [],
    };
    await expect(admitDurableGraph(graphWith("subflow", { flowId: "secret-child" }), {
      loadSubflow: async () => secretGraph,
    })).resolves.toMatchObject({ ok: false, code: "secret-binding" });
  });

  it("resolves every variable binding and edge condition and refuses sensitive variables in root or child graphs", async () => {
    const base = v2Graph({
      variables: [{ id: "flag", name: "Flag", scope: "run", schema: {} }],
      nodes: [
        { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        {
          id: "branch",
          type: "branch",
          params: {},
          bindings: { truthy: { kind: "variable", variableId: "flag" } },
          position: { x: 1, y: 0 },
        },
      ],
      edges: [{
        id: "edge",
        source: "input",
        sourceHandle: "result",
        target: "branch",
        targetHandle: "in",
        condition: { kind: "variable", variableId: "flag" },
      }],
    });
    await expect(admitDurableGraph(base)).resolves.toMatchObject({ ok: true });

    const nodeMissing = {
      ...base,
      variables: [],
      edges: [{ ...base.edges[0]!, condition: { kind: "literal" as const, value: true } }],
    };
    const edgeMissing = {
      ...base,
      variables: [],
      nodes: base.nodes.map((node) => node.id === "branch"
        ? { ...node, bindings: { truthy: { kind: "literal" as const, value: true } } }
        : node),
    };
    const sensitiveEdge = {
      ...base,
      variables: [{ id: "flag", name: "Flag", scope: "run" as const, schema: {}, sensitive: true }],
      nodes: base.nodes.map((node) => node.id === "branch"
        ? { ...node, bindings: { truthy: { kind: "literal" as const, value: true } } }
        : node),
    };
    for (const candidate of [nodeMissing, edgeMissing, sensitiveEdge]) {
      expectRefusal(await admitDurableGraph(candidate), "variable-binding");
    }

    const child = v2Graph({
      id: "child",
      variables: [{ id: "secret", name: "Secret", scope: "run", schema: {}, sensitive: true }],
    });
    expectRefusal(await admitDurableGraph(graphWith("subflow", { flowId: "child" }), {
      loadSubflow: async () => child,
    }), "variable-binding");
  });

  it("strictly audits frozen graph JSON without invoking accessors or accepting noncanonical values", async () => {
    let getterCalls = 0;
    const accessor = directGraph("input") as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      },
    });
    const cyclic = directGraph("input") as SupportedFlowGraph & { self?: unknown };
    cyclic.self = cyclic;
    const sparse = directGraph("input") as unknown as { nodes: FlowNode[] };
    sparse.nodes = Array(2) as FlowNode[];
    sparse.nodes[1] = { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } };
    const symbolic = directGraph("input") as SupportedFlowGraph & { [key: symbol]: unknown };
    symbolic[Symbol("hidden")] = true;
    const exotic = Object.assign(Object.create(null), directGraph("input")) as SupportedFlowGraph;
    const nonfinite = directGraph("input");
    nonfinite.nodes[0]!.position.x = Number.POSITIVE_INFINITY;
    const undefinedValue = directGraph("input");
    undefinedValue.nodes[0]!.params.value = undefined;

    for (const candidate of [accessor, cyclic, sparse, symbolic, exotic, nonfinite, undefinedValue]) {
      expectRefusal(await admitDurableGraph(candidate as SupportedFlowGraph), "invalid-json");
    }
    const unsafeLiteral = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "unsafe",
    });
    expectRefusal(await admitDurableGraph(v2Graph({
      nodes: [{
        id: "input",
        type: "input",
        params: {},
        bindings: { value: { kind: "literal", value: unsafeLiteral as never } },
        position: { x: 0, y: 0 },
      }],
    })), "invalid-json");
    expectRefusal(await admitDurableGraph(v2Graph({
      variables: [{
        id: "value",
        name: "Value",
        scope: "run",
        schema: {},
        default: Number.NaN,
      }],
    })), "invalid-json");

    const childAccessor = directGraph("input") as unknown as Record<string, unknown>;
    Object.defineProperty(childAccessor, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe child";
      },
    });
    expectRefusal(await admitDurableGraph(graphWith("subflow", { flowId: "unsafe-child" }), {
      loadSubflow: async () => childAccessor as unknown as SupportedFlowGraph,
    }), "invalid-json");
    expect(getterCalls).toBe(0);
  });

  it("enforces aggregate closure JSON, graph, node, edge, string, and nesting bounds", async () => {
    expect(DURABLE_GRAPH_LIMITS).toEqual({
      maxBytes: 1024 * 1024,
      maxJsonDepth: 32,
      maxEntries: 20_000,
      maxStringBytes: 64 * 1024,
      maxStrings: 20_000,
      maxGraphs: 256,
      maxClosureDepth: 16,
      maxNodes: 1_000,
      maxEdges: 2_000,
      maxBindings: 2_000,
      maxVariables: 1_000,
      maxMetadataValues: 5_000,
      maxLiteralValues: 5_000,
    });

    expectRefusal(await admitDurableGraph({
      ...directGraph("input"),
      nodes: Array.from({ length: DURABLE_GRAPH_LIMITS.maxNodes + 1 }, (_, index) => ({
        id: `node-${index}`,
        type: "input" as const,
        params: {},
        position: { x: 0, y: 0 },
      })),
    } as unknown as SupportedFlowGraph), "closure-limit");

    expectRefusal(await admitDurableGraph({
      id: "edges",
      name: "edges",
      nodes: [
        { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } },
        { id: "b", type: "output", params: {}, position: { x: 1, y: 0 } },
      ],
      edges: Array.from({ length: DURABLE_GRAPH_LIMITS.maxEdges + 1 }, (_, index) => ({
        id: `edge-${index}`,
        source: "a",
        target: "b",
      })),
    }), "closure-limit");

    expectRefusal(await admitDurableGraph(graphWith("input", {
      fields: { text: "x".repeat(DURABLE_GRAPH_LIMITS.maxStringBytes + 1) },
    })), "closure-limit");
    expectRefusal(await admitDurableGraph(graphWith("input", {
      fields: { text: "x".repeat(DURABLE_GRAPH_LIMITS.maxBytes + 1) },
    })), "closure-limit");

    let deep: unknown = "leaf";
    for (let index = 0; index <= DURABLE_GRAPH_LIMITS.maxJsonDepth; index += 1) deep = { value: deep };
    expectRefusal(await admitDurableGraph(graphWith("input", { fields: { deep } })), "closure-limit");

    const wide = {
      id: "wide",
      name: "wide",
      nodes: Array.from({ length: DURABLE_GRAPH_LIMITS.maxGraphs + 1 }, (_, index) => ({
        id: `ref-${index}`,
        type: "subflow" as const,
        params: { flowId: `child-${index}` },
        position: { x: index, y: 0 },
      })),
      edges: [],
    };
    expectRefusal(await admitDurableGraph(wide, {
      loadSubflow: async (flowId) => ({ ...directGraph("input"), id: flowId }),
    }), "closure-limit");

    const chain = new Map<string, SupportedFlowGraph>();
    for (let index = 0; index <= DURABLE_GRAPH_LIMITS.maxClosureDepth; index += 1) {
      chain.set(`chain-${index}`, graphWith("subflow", { flowId: `chain-${index + 1}` }));
    }
    chain.set(`chain-${DURABLE_GRAPH_LIMITS.maxClosureDepth + 1}`, directGraph("input"));
    expectRefusal(await admitDurableGraph(graphWith("subflow", { flowId: "chain-0" }), {
      loadSubflow: async (flowId) => chain.get(flowId)!,
    }), "closure-limit");
  });

  it("bounds bindings, variables, metadata, literals/defaults, and aggregate entries", async () => {
    const bindings = Object.fromEntries(Array.from(
      { length: DURABLE_GRAPH_LIMITS.maxBindings + 1 },
      (_, index) => [`binding-${index}`, { kind: "literal", value: index } as const],
    ));
    expectRefusal(await admitDurableGraph(v2Graph({
      nodes: [{ id: "input", type: "input", params: {}, bindings, position: { x: 0, y: 0 } }],
    })), "closure-limit");

    expectRefusal(await admitDurableGraph(v2Graph({
      variables: Array.from({ length: DURABLE_GRAPH_LIMITS.maxVariables + 1 }, (_, index) => ({
        id: `variable-${index}`,
        name: `Variable ${index}`,
        scope: "run" as const,
        schema: {},
      })),
    })), "closure-limit");

    expectRefusal(await admitDurableGraph(v2Graph({
      meta: { values: Array.from({ length: DURABLE_GRAPH_LIMITS.maxMetadataValues + 1 }, () => null) },
    })), "closure-limit");

    expectRefusal(await admitDurableGraph(v2Graph({
      nodes: [{
        id: "input",
        type: "input",
        params: {},
        bindings: {
          value: {
            kind: "literal",
            value: Array.from({ length: DURABLE_GRAPH_LIMITS.maxLiteralValues + 1 }, () => null),
          },
        },
        position: { x: 0, y: 0 },
      }],
    })), "closure-limit");

    expectRefusal(await admitDurableGraph(graphWith("input", {
      fields: Object.fromEntries(Array.from(
        { length: DURABLE_GRAPH_LIMITS.maxEntries + 1 },
        (_, index) => [`key-${index}`, index],
      )),
    })), "closure-limit");
  });

  it("validates authoritative node params without mutating or defaulting the frozen bytes", async () => {
    const missingSchedule = graphWith("schedule", {});
    const malformedTransform = graphWith("transform", { expression: 42 });
    const validBranch = Object.freeze({
      ...graphWith("branch", {}),
      nodes: Object.freeze([Object.freeze({
        id: "node-1",
        type: "branch" as const,
        params: Object.freeze({}),
        position: Object.freeze({ x: 0, y: 0 }),
      })]),
      edges: Object.freeze([]),
    }) as unknown as SupportedFlowGraph;
    const before = JSON.stringify(validBranch);

    expectRefusal(await admitDurableGraph(missingSchedule), "invalid-node");
    expectRefusal(await admitDurableGraph(malformedTransform), "invalid-node");
    await expect(admitDurableGraph(validBranch)).resolves.toMatchObject({ ok: true });
    expect(JSON.stringify(validBranch)).toBe(before);
    expect((validBranch.nodes[0]!.params as Record<string, unknown>).field).toBeUndefined();
  });

  it("admits exact typed draft and pinned closures and verifies their resolved receipts", async () => {
    const draft = typedReference("draft", "draft-child");
    const pinned = typedReference("pinned", "pinned-child");
    const resolveSubflow = vi.fn(async (reference: SubflowReference) => ({
      graph: v2Graph({ id: reference.flowId, callableInterface: EMPTY_CALLABLE }),
      flowId: reference.flowId,
      ...(reference.kind === "pinned" ? { versionId: reference.versionId } : {}),
      semanticHash: reference.kind === "pinned" ? reference.contentHash : "b".repeat(64),
      callableInterface: EMPTY_CALLABLE,
    }));
    const root = {
      id: "root",
      name: "root",
      nodes: [
        { id: "draft", type: "subflow" as const, params: { reference: draft }, position: { x: 0, y: 0 } },
        { id: "pinned", type: "subflow" as const, params: { reference: pinned }, position: { x: 1, y: 0 } },
      ],
      edges: [],
    };
    const typedAdmission = await admitDurableGraph(root, { resolveSubflow });
    expect(typedAdmission).toMatchObject({ ok: true, graphCount: 3 });
    if (!typedAdmission.ok) throw new Error("typed closure should be admitted");
    expect(typedAdmission.executionPackage.graphs.map((entry) => entry.identity.kind).sort())
      .toEqual(["draft", "pinned", "root"]);
    expect(new Set(typedAdmission.executionPackage.graphs.map((entry) => entry.key)).size).toBe(3);
    expect(typedAdmission.executionPackage.rootKey).toBe(JSON.stringify(["root", "root"]));
    expect(resolveSubflow).toHaveBeenCalledTimes(2);

    const lyingResolver = async () => ({
      graph: v2Graph({ id: "other", callableInterface: EMPTY_CALLABLE }),
      flowId: "other",
      versionId: "other-version",
      semanticHash: "c".repeat(64),
      callableInterface: EMPTY_CALLABLE,
    });
    expectRefusal(await admitDurableGraph(graphWith("subflow", { reference: pinned }), {
      resolveSubflow: lyingResolver,
    }), "unresolved-reference");

    const mismatchedInterface: FlowCallableInterface = {
      inputs: [{
        id: "value",
        label: "Value",
        schema: {},
        required: false,
        cardinality: "one",
        target: { kind: "trigger", path: "/value" },
      }],
      outputs: [],
    };
    expectRefusal(await admitDurableGraph(graphWith("subflow", { reference: draft }), {
      resolveSubflow: async () => ({
        graph: v2Graph({ id: draft.flowId, callableInterface: mismatchedInterface }),
        flowId: draft.flowId,
        semanticHash: "d".repeat(64),
        callableInterface: EMPTY_CALLABLE,
      }),
    }), "unresolved-reference");
  });

  it("memoizes duplicate resolved references and refuses multi-hop cycles", async () => {
    const child = directGraph("input");
    const loadSubflow = vi.fn(async () => child);
    const duplicate = {
      id: "root",
      name: "root",
      nodes: [
        { id: "a", type: "subflow" as const, params: { flowId: "child" }, position: { x: 0, y: 0 } },
        { id: "b", type: "subflow" as const, params: { flowId: "child" }, position: { x: 1, y: 0 } },
      ],
      edges: [],
    };
    await expect(admitDurableGraph(duplicate, { loadSubflow })).resolves.toMatchObject({
      ok: true,
      graphCount: 2,
      nodeCount: 3,
    });
    expect(loadSubflow).toHaveBeenCalledTimes(1);

    const closure = new Map<string, SupportedFlowGraph>([
      ["a", graphWith("subflow", { flowId: "b" })],
      ["b", graphWith("subflow", { flowId: "a" })],
    ]);
    expectRefusal(await admitDurableGraph(graphWith("subflow", { flowId: "a" }), {
      loadSubflow: async (flowId) => closure.get(flowId)!,
    }), "recursive-reference");
  });

  it("aborts while a resolver is still pending and never dispatches any executor/provider/network path", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const loadSubflow = vi.fn(() => new Promise<SupportedFlowGraph>((resolve) => {
      release = () => resolve(directGraph("input"));
    }));
    const executorSpies = NODE_DEFS.map((definition) => vi.spyOn(definition, "executor"));
    const pending = admitDurableGraph(graphWith("subflow", { flowId: "child" }), {
      loadSubflow,
      signal: controller.signal,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release?.();
    expect(executorSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    for (const spy of executorSpies) spy.mockRestore();
  });

  it("fails closed when authoritative canonical or runtime metadata drifts", async () => {
    const input = NODE_DEFS.find((definition) => definition.type === "input")!;
    const originalCostBearing = input.costBearing;
    const originalRetry = input.definition.retry;
    try {
      input.costBearing = true;
      expectRefusal(await admitDurableGraph(directGraph("input")), "unsafe-node");
      input.costBearing = originalCostBearing;
      (input.definition as { retry: string }).retry = "unsafe";
      expectRefusal(await admitDurableGraph(directGraph("input")), "unsafe-node");
    } finally {
      input.costBearing = originalCostBearing;
      (input.definition as { retry: string }).retry = originalRetry;
    }

    const loop = NODE_DEFS.find((definition) => definition.type === "loop")!;
    const originalCapability = loop.definition.capabilityMode;
    try {
      (loop.definition as { capabilityMode: string }).capabilityMode = "static";
      expectRefusal(await admitDurableGraph(graphWith("loop", { flowId: "child" }), {
        loadSubflow: async () => directGraph("input"),
      }), "unsafe-node");
    } finally {
      (loop.definition as { capabilityMode: string }).capabilityMode = originalCapability;
    }
  });

  it("snapshots the root into immutable canonical bytes before caller mutation", async () => {
    const root = v2Graph();
    const admission = await admitDurableGraph(root);
    expect(admission).toMatchObject({ ok: true });
    if (!admission.ok) throw new Error("root should be admitted");

    const executionPackage = admission.executionPackage;
    const rootEntry = executionPackage.graphs.find((entry) => entry.key === executionPackage.rootKey)!;
    const exactBytes = rootEntry.canonicalJson;
    const exactHash = rootEntry.contentHash;
    const mutableNode = root.nodes[0] as unknown as {
      type: NodeType;
      bindings: Record<string, unknown>;
    };
    mutableNode.type = "llm";
    mutableNode.bindings.token = { kind: "secret", connectionId: "connection", field: "token" };
    (root.nodes as FlowGraphV2["nodes"][number][]).push({
      id: "late-http",
      type: "http",
      params: { method: "POST", url: "https://example.com" },
      bindings: {},
      position: { x: 1, y: 0 },
    });

    expect(Object.isFrozen(root)).toBe(false);
    expect(root.nodes).toHaveLength(2);
    expect(rootEntry.canonicalJson).toBe(exactBytes);
    expect(rootEntry.contentHash).toBe(exactHash);
    expect(rootEntry.contentHash).toBe(sha256Utf8(rootEntry.canonicalJson));
    expect(JSON.stringify(rootEntry.graph)).toBe(rootEntry.canonicalJson);
    expect(rootEntry.graph.nodes).toHaveLength(1);
    expect(rootEntry.graph.nodes[0]!.type).toBe("input");
    expect(Object.isFrozen(executionPackage)).toBe(true);
    expect(Object.isFrozen(executionPackage.graphs)).toBe(true);
    expect(Object.isFrozen(rootEntry)).toBe(true);
    expect(Object.isFrozen(rootEntry.graph)).toBe(true);
    expect(Object.isFrozen(rootEntry.graph.nodes)).toBe(true);
    expect(() => {
      (rootEntry.graph.nodes as FlowGraphV2["nodes"][number][]).push(root.nodes[1]!);
    }).toThrow(TypeError);
  });

  it("snapshots resolved descendants before resolver-owned objects mutate", async () => {
    const child = v2Graph({ id: "child" });
    const root = graphWith("subflow", { flowId: "child-row" });
    const admission = await admitDurableGraph(root, { loadSubflow: async () => child });
    expect(admission).toMatchObject({ ok: true, graphCount: 2 });
    if (!admission.ok) throw new Error("child closure should be admitted");

    const childEntry = admission.executionPackage.graphs.find(
      (entry) => entry.identity.kind === "legacy",
    )!;
    const exactBytes = childEntry.canonicalJson;
    const mutableNode = child.nodes[0] as unknown as {
      type: NodeType;
      bindings: Record<string, unknown>;
    };
    mutableNode.type = "http";
    mutableNode.bindings.token = { kind: "secret", connectionId: "connection", field: "token" };
    (child.nodes as FlowGraphV2["nodes"][number][]).push({
      id: "late-llm",
      type: "llm",
      params: { prompt: "late" },
      bindings: {},
      position: { x: 1, y: 0 },
    });

    expect(Object.isFrozen(child)).toBe(false);
    expect(child.nodes).toHaveLength(2);
    expect(childEntry.key).toBe(JSON.stringify(["legacy", "child-row"]));
    expect(childEntry.canonicalJson).toBe(exactBytes);
    expect(childEntry.contentHash).toBe(sha256Utf8(exactBytes));
    expect(childEntry.graph.nodes).toHaveLength(1);
    expect(childEntry.graph.nodes[0]!.type).toBe("input");
    expect((childEntry.graph as FlowGraphV2).nodes[0]!.bindings).toEqual({});
    expect(Object.isFrozen(childEntry.graph.nodes)).toBe(true);
  });

  it("snapshots the root before awaiting a pending child resolver", async () => {
    const root = graphWith("subflow", { flowId: "child-row" });
    let release: (() => void) | undefined;
    const loadSubflow = vi.fn(() => new Promise<SupportedFlowGraph>((resolve) => {
      release = () => resolve(directGraph("input"));
    }));
    const pending = admitDurableGraph(root, { loadSubflow });
    await vi.waitFor(() => expect(loadSubflow).toHaveBeenCalledTimes(1));

    root.nodes[0]!.type = "llm";
    (root.nodes as FlowNode[]).push({
      id: "late-http",
      type: "http",
      params: { method: "POST", url: "https://example.com" },
      position: { x: 1, y: 0 },
    });
    release?.();

    const admission = await pending;
    expect(admission).toMatchObject({ ok: true });
    if (!admission.ok) throw new Error("pre-mutation root should be admitted");
    const rootEntry = admission.executionPackage.graphs[0]!;
    expect(rootEntry.key).toBe(admission.executionPackage.rootKey);
    expect(rootEntry.graph.nodes).toHaveLength(1);
    expect(rootEntry.graph.nodes[0]!.type).toBe("subflow");
    expect(rootEntry.canonicalJson).not.toContain("late-http");
    expect(rootEntry.contentHash).toBe(sha256Utf8(rootEntry.canonicalJson));
  });
});
