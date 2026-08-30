import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseTestBoundaryPinKey,
  parseTestRunRequest,
  validateAndCompileTestRunRequest,
} from "@/lib/flow/test-run-contract";

const FORBIDDEN_TEST_RUN_CONTRACT_IMPORT_SEGMENTS = new Set([
  "db",
  "gateway",
  "projects",
  "rails",
  "runtime",
]);

const FORBIDDEN_TEST_RUN_CONTRACT_IMPORT_LEAVES = new Set([
  "engine",
  "executor",
  "provider",
  "registry",
  "run-service",
]);

function isForbiddenTestRunContractImport(specifier: string): boolean {
  const segments = specifier.split("/").filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  const leaf = segments.at(-1)?.replace(/\.[cm]?[jt]sx?$/u, "") ?? "";
  if (FORBIDDEN_TEST_RUN_CONTRACT_IMPORT_LEAVES.has(leaf)) return true;
  if (segments.some((segment) => FORBIDDEN_TEST_RUN_CONTRACT_IMPORT_SEGMENTS.has(segment))) return true;
  return segments.some((segment, index) => segment === "app" && segments[index + 1] === "api");
}

function sourceImportSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]!);
}
import type { FlowEdgeV2, FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";

const node = (id: string, type: FlowNodeV2["type"] = "transform", bindings: FlowNodeV2["bindings"] = {}): FlowNodeV2 => ({
  id, type, params: type === "transform" ? { expression: "input" } : {}, bindings, position: { x: 0, y: 0 },
});

const edge = (id: string, source: string, target: string, condition?: FlowEdgeV2["condition"]): FlowEdgeV2 => ({
  id, source, sourceHandle: "result", target, targetHandle: "in",
  ...(condition === undefined ? {} : { condition }),
});

function graph(overrides: Partial<FlowGraphV2> = {}): FlowGraphV2 {
  return {
    schemaVersion: 2, id: "test-graph", name: "Test graph", nodes: [], edges: [],
    variables: [], groups: [], annotations: [], ...overrides,
  };
}

const boundaryKey = JSON.stringify(["edge-input", "a-b", "a", "result", "b", "in"]);

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    graph: graph({ nodes: [node("a", "input"), node("b")], edges: [edge("a-b", "a", "b")] }),
    scope: { kind: "node", nodeId: "b" },
    pinnedInputs: { [boundaryKey]: { value: "fixture" } },
    mode: "test",
    environmentId: "environment-test",
    ...overrides,
  };
}

describe("test run request contract", () => {
  it("parses the strict v2 request and compiles exact detached dry-run data", () => {
    const source = request();
    const before = structuredClone(source);
    const parsed = parseTestRunRequest(source);
    expect(parsed).toMatchObject({ ok: true, request: { mode: "test", environmentId: "environment-test" } });
    const compiled = validateAndCompileTestRunRequest(source);
    expect(compiled).toMatchObject({
      ok: true,
      value: {
        mode: "test", dryRun: true,
        plan: { status: "planned", executionOrder: ["b"], boundaryPins: [{ key: boundaryKey }] },
        pinnedInputs: { [boundaryKey]: { value: "fixture" } },
      },
    });
    expect(source).toEqual(before);
    if (compiled.ok) {
      expect(compiled.value.graph).not.toBe(source.graph);
      expect(Object.isFrozen(compiled.value)).toBe(true);
      expect(Object.isFrozen(compiled.value.graph.nodes)).toBe(true);
      expect(() => (compiled.value.pinnedInputs[boundaryKey] as { value: string }).value = "changed").toThrow();
    }
  });

  it("returns one generic non-echoing refusal for malformed top-level, scope, mode, and IDs", () => {
    const invalid = [
      { ...request(), extra: "secret-marker" },
      request({ graph: { id: "v1", name: "v1", nodes: [], edges: [] } }),
      request({ scope: { kind: "future", nodeId: "b" } }),
      request({ scope: { kind: "node", nodeId: " b" } }),
      request({ scope: { kind: "node", nodeId: `n${"x".repeat(128)}` } }),
      request({ mode: "live" }),
      request({ environmentId: " environment-test" }),
      request({ environmentId: `e${"x".repeat(512)}` }),
      request({ environmentId: "bad\u0000id" }),
    ];
    for (const value of invalid) {
      const result = parseTestRunRequest(value);
      expect(result).toEqual({ ok: false, code: "invalid-request", message: "Test run request is invalid." });
      expect(JSON.stringify(result)).not.toContain("secret-marker");
    }
  });

  it("generically refuses stateful and throwing proxies without rereading untrusted input", () => {
    const safe = request();
    const credentialGraph = graph({
      nodes: [{ ...node("b"), params: { apiKey: "secret-marker" } }],
    });
    const swapping = new Proxy(safe, {
      get(target, property, receiver) {
        if (property === "graph") return credentialGraph;
        return Reflect.get(target, property, receiver);
      },
    });
    const throwing = new Proxy(safe, {
      get(target, property, receiver) {
        if (property === "graph") throw new Error("secret-marker");
        return Reflect.get(target, property, receiver);
      },
    });
    for (const value of [swapping, throwing]) {
      expect(() => parseTestRunRequest(value)).not.toThrow();
      const result = parseTestRunRequest(value);
      expect(result).toEqual({ ok: false, code: "invalid-request", message: "Test run request is invalid." });
      expect(JSON.stringify(result)).not.toContain("secret-marker");
    }
  });

  it("caps every graph collection before planning", () => {
    const collections: Array<Partial<FlowGraphV2>> = [
      { nodes: Array.from({ length: 501 }, (_, index) => node(`n${index}`)) },
      { edges: Array.from({ length: 2_001 }, (_, index) => edge(`e${index}`, "a", "b")) },
      { variables: Array.from({ length: 257 }, (_, index) => ({ id: `v${index}`, name: `V${index}`, scope: "run" as const, schema: {} })) },
      { groups: Array.from({ length: 257 }, (_, index) => ({ id: `g${index}`, label: "G", nodeIds: [] })) },
      { annotations: Array.from({ length: 501 }, (_, index) => ({ id: `a${index}`, text: "A", position: { x: 0, y: 0 } })) },
    ];
    for (const collection of collections) {
      const result = parseTestRunRequest(request({ graph: graph(collection) }));
      expect(result).toMatchObject({ ok: false, code: "invalid-request" });
    }
  });

  it("exempts exact graph secret references only at node bindings and edge conditions", () => {
    const secret = { kind: "secret", connectionId: "connection-id", field: "credential-field" } as const;
    const safeGraph = graph({
      nodes: [node("a", "input"), node("b", "transform", { credential: secret })],
      edges: [edge("a-b", "a", "b", secret)],
    });
    expect(parseTestRunRequest(request({ graph: safeGraph })).ok).toBe(true);
    for (const unsafe of [
      request({ graph: graph({ nodes: [{ ...node("b"), params: { credential: secret } }] }) }),
      request({ pinnedInputs: { [boundaryKey]: secret } }),
      request({ pinnedInputs: { [boundaryKey]: { password: "placeholder" } } }),
      request({ pinnedInputs: { [boundaryKey]: "Bearer abcdefghijklmnop" } }),
    ]) {
      expect(parseTestRunRequest(unsafe)).toMatchObject({ ok: false, code: "invalid-request" });
    }
  });

  const tooManyPins = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [
      JSON.stringify(["edge-input", `e${index}`, "a", "result", "b", "in"]), true,
    ]));
  const deepPin: unknown[] = [];
  let deepCursor = deepPin;
  for (let index = 0; index < 17; index += 1) {
    const next: unknown[] = [];
    deepCursor.push(next);
    deepCursor = next;
  }
  const unsafePinCases: Array<[string, Record<string, unknown>]> = [
      ["count", tooManyPins],
      ["per-value bytes", { [boundaryKey]: Array.from({ length: 1_024 }, () => "x".repeat(65)) }],
      ["depth", { [boundaryKey]: deepPin }],
      ["value count", { [boundaryKey]: Array.from({ length: 10_001 }, () => null) }],
      ["aggregate bytes", Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
        JSON.stringify(["edge-input", `aggregate-${index}`, "a", "result", "b", "in"]),
        Array.from({ length: 900 }, () => "x".repeat(64)),
      ]))],
  ];

  it.each(unsafePinCases)("enforces the %s pin budget", (_name, pins) => {
    expect(parseTestRunRequest(request({ pinnedInputs: pins }))).toMatchObject({ ok: false, code: "invalid-request" });
  });

  it("parses only the three exact canonical planner boundary tuples", () => {
    const tuples = [
      ["edge-input", "edge", "source", "out", "target", "in"],
      ["node-binding", "target", "field", "source", "out", null],
      ["edge-condition", "edge", "target", "source", "out", "/ok"],
    ] as const;
    for (const tuple of tuples) expect(parseTestBoundaryPinKey(JSON.stringify(tuple))).toEqual(tuple);
    expect(parseTestBoundaryPinKey(JSON.stringify([
      "node-binding", "target", "field", "source", "out", "",
    ]))).toEqual(["node-binding", "target", "field", "source", "out", ""]);
    expect(parseTestBoundaryPinKey(JSON.stringify([
      "edge-condition", "edge", "target", "source", "out", "",
    ]))).toEqual(["edge-condition", "edge", "target", "source", "out", ""]);
    for (const key of [
      ' ["edge-input","edge","source","out","target","in"]',
      '[ "edge-input", "edge", "source", "out", "target", "in" ]',
      '["edge-input","edge","source","out","target"]',
      '["node-binding","target","field","source","out",false]',
      '["edge-condition","edge","target","source","out",null,"extra"]',
      '["unknown","edge","source","out","target","in"]',
    ]) expect(parseTestBoundaryPinKey(key)).toBeNull();
  });

  it("parses graph secret references but refuses to compile any relevant secret resolution", () => {
    const secret = { kind: "secret", connectionId: "connection-id", field: "credential-field" } as const;
    const selectedSecret = request({
      graph: graph({ nodes: [node("b", "transform", { credential: secret })] }),
      scope: { kind: "node", nodeId: "b" }, pinnedInputs: {},
    });
    expect(parseTestRunRequest(selectedSecret).ok).toBe(true);
    expect(validateAndCompileTestRunRequest(selectedSecret)).toMatchObject({ ok: false, code: "invalid-request" });

    const conditionSecret = request({
      graph: graph({
        nodes: [node("a", "input"), node("b")],
        edges: [edge("a-b", "a", "b", secret)],
      }),
    });
    expect(parseTestRunRequest(conditionSecret).ok).toBe(true);
    expect(validateAndCompileTestRunRequest(conditionSecret)).toMatchObject({ ok: false, code: "invalid-request" });
  });

  it("bounds graph identities, handles, references, group members, and binding keys without normalization", () => {
    const long = `x${"y".repeat(128)}`;
    const badGraphs: FlowGraphV2[] = [
      graph({ nodes: [node(" bad")] }),
      graph({ nodes: [node("bad\u0000node")] }),
      graph({ nodes: [node(long)] }),
      graph({ nodes: [node("a"), node("b")], edges: [{ ...edge(" bad", "a", "b") }] }),
      graph({ nodes: [node("a"), node("b")], edges: [{ ...edge("e", "a", "b"), sourceHandle: long }] }),
      graph({ nodes: [node("a", "transform", { [long]: { kind: "literal", value: true } })] }),
      graph({ nodes: [node("a", "transform", { value: { kind: "port", nodeId: long, portId: "result" } })] }),
      graph({ nodes: [node("a"), node("b")], edges: [edge("e", "a", "b", { kind: "variable", variableId: long })] }),
      graph({ variables: [{ id: long, name: "V", scope: "run", schema: {} }] }),
      graph({ groups: [{ id: "g", label: "G", nodeIds: [long] }] }),
      graph({ annotations: [{ id: long, text: "A", position: { x: 0, y: 0 } }] }),
      graph({ nodes: [{ ...node("wrapper", "subflow"), params: { flowId: long } }] }),
    ];
    for (const badGraph of badGraphs) {
      expect(parseTestRunRequest(request({ graph: badGraph })), JSON.stringify(badGraph)).toMatchObject({ ok: false, code: "invalid-request" });
    }
  });

  it("refuses disabled plans and requires exact missing-free extra-free boundary keys", () => {
    expect(validateAndCompileTestRunRequest(request({ pinnedInputs: {} }))).toMatchObject({ ok: false, code: "invalid-request" });
    expect(validateAndCompileTestRunRequest(request({ pinnedInputs: {
      [boundaryKey]: true,
      [JSON.stringify(["edge-input", "extra", "a", "result", "b", "in"])]: false,
    } }))).toMatchObject({ ok: false, code: "invalid-request" });
    expect(validateAndCompileTestRunRequest(request({
      graph: graph({ nodes: [node("a")] }), scope: { kind: "node", nodeId: "missing" }, pinnedInputs: {},
    }))).toMatchObject({ ok: false, code: "invalid-request" });
  });

  it("requires boolean values for edge-condition boundary pins", () => {
    const conditionKey = JSON.stringify(["edge-condition", "a-b", "b", "c", "result", null]);
    const conditional = request({
      graph: graph({
        nodes: [node("a", "input"), node("b"), node("c", "input")],
        edges: [edge("a-b", "a", "b", { kind: "port", nodeId: "c", portId: "result" })],
      }),
      pinnedInputs: { [boundaryKey]: { value: "fixture" }, [conditionKey]: "true" },
    });
    expect(validateAndCompileTestRunRequest(conditional)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(validateAndCompileTestRunRequest({
      ...conditional,
      pinnedInputs: { [boundaryKey]: { value: "fixture" }, [conditionKey]: true },
    })).toMatchObject({ ok: true, value: { pinnedInputs: { [conditionKey]: true } } });
  });

  it("distinguishes safe local API contracts from route, runtime, and provider boundaries", () => {
    for (const safe of [
      "./api-operation-contract",
      "./graph-schema",
      "./test-scope",
    ]) {
      expect(isForbiddenTestRunContractImport(safe), safe).toBe(false);
    }
    for (const dangerous of [
      "../../app/api/v2/flows/route",
      "@/lib/runtime/worker",
      "@/lib/connections/provider",
      "./engine",
      "./executor",
      "./registry",
      "./run-service",
      "@/lib/db/provider",
      "@/lib/projects/repo",
      "@/lib/rails/x402-client",
      "@/lib/gateway/run-handler",
    ]) {
      expect(isForbiddenTestRunContractImport(dangerous), dangerous).toBe(true);
    }
  });

  it("is deterministic across pin insertion order and imports no route/runtime/provider boundary", () => {
    const first = validateAndCompileTestRunRequest(request());
    const second = validateAndCompileTestRunRequest(request({ pinnedInputs: Object.fromEntries([
      [boundaryKey, { value: "fixture" }],
    ]) }));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const source = readFileSync("src/lib/flow/test-run-contract.ts", "utf8");
    expect(sourceImportSpecifiers(source).filter(isForbiddenTestRunContractImport)).toEqual([]);
    expect(source).not.toMatch(/\b(?:fetch|resolveSecretReference|resolveValueBinding|runFlow)\b/);
  });
});
