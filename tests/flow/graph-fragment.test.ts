import { describe, expect, it } from "vitest";
import {
  GraphFragmentDisabledError,
  commandForPaste,
  parseGraphFragment,
  serializeGraphFragment,
  type GraphFragmentV1,
} from "@/lib/flow/graph-fragment";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import { parseGraphCommand } from "@/lib/flow/graph-command-schema";
import type { GraphSelection } from "@/lib/flow/graph-command-types";
import type { FlowGraph } from "@/lib/flow/types";

const selection = (...nodeIds: string[]): GraphSelection => ({ nodeIds, edgeIds: [], primaryNodeId: nodeIds[0] ?? null });

function credentialGraph(): FlowGraph {
  return {
    id: "g",
    name: "Credentials",
    nodes: [
      {
        id: "z",
        type: "http",
        position: { x: 130, y: 80 },
        params: {
          url: "https://example.test",
          headers: { Authorization: "Bearer clip-fixture-token", Accept: "application/json" },
          cookie: "session=clip-fixture-cookie",
          nested: {
            password: "clip-fixture-password",
            apiKey: "clip-fixture-api-key",
            token: "clip-fixture-token",
            secret: "clip-fixture-secret",
            privateKey: "-----BEGIN PRIVATE KEY-----\nclip-fixture-key\n-----END PRIVATE KEY-----",
            service_role_key: "clip-fixture-service-role",
            signingKey: "clip-fixture-signing-key",
          },
          list: ["public", "Bearer clip-fixture-array-token"],
          connection: { kind: "secret", connectionId: "conn_public_reference", field: "apiKey" },
          apiKey: { kind: "secret", connectionId: "conn_nested_reference", field: "token" },
        },
        futureNode: { public: true, signing_secret: "clip-fixture-future-secret" },
      },
      { id: "a", type: "input", position: { x: 30, y: 20 }, params: { label: "safe" } },
      { id: "outside", type: "output", position: { x: 500, y: 500 }, params: {} },
    ],
    edges: [
      { id: "z-out", source: "z", target: "outside" },
      { id: "z-a", source: "a", target: "z", targetHandle: "other", futureEdge: { cookie: "clip-fixture-edge-cookie", safe: true } },
      { id: "a-z", source: "a", target: "z", targetHandle: "in" },
    ],
  } as unknown as FlowGraph;
}

describe("GraphFragmentV1", () => {
  it("serializes sorted internal graph data with normalized positions and no credential values", () => {
    const fragment = serializeGraphFragment(credentialGraph(), selection("z", "a"));
    const text = JSON.stringify(fragment);

    const leaked = [
      "clip-fixture-token",
      "clip-fixture-cookie",
      "clip-fixture-password",
      "clip-fixture-api-key",
      "clip-fixture-secret",
      "clip-fixture-key",
      "clip-fixture-service-role",
      "clip-fixture-signing-key",
      "Bearer",
      "PRIVATE KEY",
    ].some((marker) => text.includes(marker));
    expect(leaked).toBe(false);
    expect(fragment.redactionCount).toBeGreaterThan(0);
    expect(fragment.nodes.map((node) => node.id)).toEqual(["a", "z"]);
    expect(fragment.edges.map((edge) => edge.id)).toEqual(["a-z", "z-a"]);
    expect(fragment.nodes.map((node) => node.position)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 60 }]);
    expect(fragment.nodes[1]?.params).toMatchObject({
      url: "https://example.test",
      headers: { Accept: "application/json" },
      list: ["public"],
      connection: { kind: "secret", connectionId: "conn_public_reference", field: "apiKey" },
      apiKey: { kind: "secret", connectionId: "conn_nested_reference", field: "token" },
    });
    expect((fragment.nodes[1] as unknown as { futureNode: unknown }).futureNode).toEqual({ public: true });
    expect((fragment.edges[1] as unknown as { futureEdge: unknown }).futureEdge).toEqual({ safe: true });
    expect(parseGraphFragment(text)).toEqual(fragment);
  });

  it("sanitizes hostile clipboard content and adds new redactions to the declared count", () => {
    const text = JSON.stringify({
      kind: "suede.graph-fragment",
      version: 1,
      redactionCount: 2,
      nodes: [{ id: "a", type: "input", params: { safe: true, password: "do-not-return" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const parsed = parseGraphFragment(text);
    expect(parsed.redactionCount).toBe(3);
    expect(parsed.nodes[0]?.params).toEqual({ safe: true });
    expect(JSON.stringify(parsed).includes("do-not-return")).toBe(false);
  });

  it("returns a typed disabled reason instead of an empty artifact", () => {
    try {
      serializeGraphFragment(credentialGraph(), selection());
      throw new Error("expected disabled error");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphFragmentDisabledError);
      expect(error).toMatchObject({ code: "NO_NODES_SELECTED", reason: "Select at least one node to copy." });
    }
  });

  it("rejects unsafe keys, excessive depth, oversized text, and unknown versions without echoing content", () => {
    const base = { kind: "suede.graph-fragment", version: 1, redactionCount: 0, nodes: [], edges: [] };
    const unsafe = '{"kind":"suede.graph-fragment","version":1,"redactionCount":0,"nodes":[],"edges":[],"__proto__":{"polluted":true}}';
    expect(() => parseGraphFragment(unsafe)).toThrow(/unsafe|prototype/i);

    let deep: unknown = "leaf";
    for (let index = 0; index < 51; index += 1) deep = { child: deep };
    expect(() => parseGraphFragment(JSON.stringify({ ...base, future: deep }))).toThrow(/depth|50/i);
    expect(() => parseGraphFragment(`${" ".repeat(1_048_577)}${JSON.stringify(base)}`)).toThrow(/1 mib|size/i);
    expect(() => parseGraphFragment(JSON.stringify({ ...base, version: 2 }))).toThrow(/version/i);
  });

  it("rejects fragment count limits, invalid geometry, duplicate IDs, and non-internal endpoints", () => {
    const node = (id: string) => ({ id, type: "input", params: {}, position: { x: 0, y: 0 } });
    const base = { kind: "suede.graph-fragment", version: 1, redactionCount: 0, edges: [] };
    expect(() => parseGraphFragment(JSON.stringify({ ...base, nodes: Array.from({ length: 501 }, (_, index) => node(String(index))) }))).toThrow(/500|node/i);
    const nodes = [node("a"), node("b")];
    expect(() => parseGraphFragment(JSON.stringify({ ...base, nodes, edges: Array.from({ length: 2_001 }, (_, index) => ({ id: String(index), source: "a", target: "b", targetHandle: String(index) })) }))).toThrow(/2000|edge/i);
    expect(() => parseGraphFragment(JSON.stringify({ ...base, nodes: [{ ...node("a"), position: { x: "NaN", y: 0 } }] }))).toThrow(/finite|position/i);
    expect(() => parseGraphFragment(JSON.stringify({ ...base, nodes: [node("a"), node("a")] }))).toThrow(/duplicate|unique/i);
    expect(() => parseGraphFragment(JSON.stringify({ ...base, nodes: [node("a")], edges: [{ id: "e", source: "a", target: "missing" }] }))).toThrow(/endpoint|internal/i);
  });

  it("rejects invalid source selections and unsafe source object shapes without mutation", () => {
    const graph = credentialGraph();
    const before = structuredClone(graph);
    expect(() => serializeGraphFragment(graph, selection("missing"))).toThrow(/selected|missing/i);
    expect(() => serializeGraphFragment(graph, selection("a", "a"))).toThrow(/duplicate|unique/i);
    expect(graph).toEqual(before);

    const hostile = credentialGraph();
    Object.defineProperty(hostile.nodes[0]?.params, "getter", { enumerable: true, get: () => "must-not-run" });
    expect(() => serializeGraphFragment(hostile, selection("z"))).toThrow(/data|accessor|json/i);
  });

  it("compiles deterministic paste IDs and target-origin positions into one validated batch", () => {
    const fragment = serializeGraphFragment(credentialGraph(), selection("z", "a"));
    const target = { id: "target", name: "Target", nodes: [], edges: [] };
    const command = commandForPaste(fragment, "paste_7", { x: 400, y: 300 }, target);
    expect(parseGraphCommand(command)).toEqual(command);
    expect(command.kind).toBe("graph.batch");
    if (command.kind !== "graph.batch") throw new Error("expected batch");
    expect(command.commands.map((child) => child.id)).toEqual([
      "paste_7:node:0", "paste_7:node:1", "paste_7:edge:0", "paste_7:edge:1",
    ]);
    expect(command.commands.filter((child) => child.kind === "node.add").map((child) => child.node)).toMatchObject([
      { id: "node_paste_7_0", position: { x: 400, y: 300 } },
      { id: "node_paste_7_1", position: { x: 500, y: 360 } },
    ]);
    const result = applyGraphCommand(target, command);
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["node_paste_7_0", "node_paste_7_1"]);
    expect(result.graph.edges.map((edge) => [edge.id, edge.source, edge.target])).toEqual([
      ["edge_paste_7_0", "node_paste_7_0", "node_paste_7_1"],
      ["edge_paste_7_1", "node_paste_7_0", "node_paste_7_1"],
    ]);
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual({ id: "target", name: "Target", nodes: [], edges: [] });
  });

  it("rejects invalid paste IDs, origins, and forged fragment objects", () => {
    const fragment = serializeGraphFragment(credentialGraph(), selection("a"));
    const target = { id: "target", name: "Target", nodes: [], edges: [] };
    expect(() => commandForPaste(fragment, "bad id", { x: 0, y: 0 }, target)).toThrow(/command id/i);
    expect(() => commandForPaste(fragment, "paste", { x: Number.POSITIVE_INFINITY, y: 0 }, target)).toThrow(/finite|origin/i);
    expect(() => commandForPaste({ ...fragment, version: 2 } as unknown as GraphFragmentV1, "paste", { x: 0, y: 0 }, target)).toThrow(/version/i);
  });
});
