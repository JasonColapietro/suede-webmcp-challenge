import { describe, expect, it } from "vitest";
import { parseGraphCommand } from "@/lib/flow/graph-command-schema";
import { GraphCommandError, type GraphCommand } from "@/lib/flow/graph-command-types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";

const COMMAND_KINDS = [
  "node.add",
  "node.remove",
  "node.patch",
  "edge.add",
  "edge.remove",
  "selection.move",
  "selection.duplicate",
  "selection.align",
  "selection.distribute",
  "layout.apply",
  "graph.rename",
  "callable-interface.set",
  "callable-interface.remove",
  "subflow-reference.set",
  "variable.add",
  "variable.patch",
  "variable.remove",
  "binding.set",
  "binding.remove",
  "graph.batch",
  "graph.replace",
] as const satisfies readonly GraphCommand["kind"][];
type MissingCommandKind = Exclude<GraphCommand["kind"], (typeof COMMAND_KINDS)[number]>;
const ALL_COMMAND_KINDS_ARE_COVERED: MissingCommandKind extends never ? true : false = true;

const duplicate: GraphCommand = {
  v: 1,
  id: "duplicate-1",
  kind: "selection.duplicate",
  nodeIds: ["a", "b"],
  offset: { x: 40, y: 40 },
  nodeIdMap: { a: "copy-a", b: "copy-b" },
  edgeIdMap: { "a-b": "copy-a-b" },
};

describe("GraphCommand v1 boundary", () => {
  it("keeps the compile-time command-kind enumeration exhaustive", () => {
    expect(ALL_COMMAND_KINDS_ARE_COVERED).toBe(true);
    expect(new Set(COMMAND_KINDS).size).toBe(COMMAND_KINDS.length);
  });

  it("accepts every command family and preserves JSON data", () => {
    const commands: GraphCommand[] = [
      { v: 1, id: "add-node", kind: "node.add", node: { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } } },
      { v: 1, id: "remove-node", kind: "node.remove", nodeId: "a" },
      { v: 1, id: "patch-node", kind: "node.patch", nodeId: "a", patch: [{ op: "replace", path: "/prompt", value: "new" }] },
      { v: 1, id: "add-edge", kind: "edge.add", edge: { id: "a-b", source: "a", target: "b" }, index: 0 },
      { v: 1, id: "remove-edge", kind: "edge.remove", edgeId: "a-b" },
      { v: 1, id: "move", kind: "selection.move", positions: { a: { x: 1, y: 2 } } },
      duplicate,
      { v: 1, id: "align", kind: "selection.align", nodeIds: ["a", "b"], bounds: { a: { x: 0, y: 0, width: 100, height: 50 }, b: { x: 200, y: 0, width: 100, height: 50 } }, axis: "x", mode: "center" },
      { v: 1, id: "distribute", kind: "selection.distribute", nodeIds: ["a", "b"], bounds: { a: { x: 0, y: 0, width: 100, height: 50 }, b: { x: 200, y: 0, width: 100, height: 50 } }, axis: "x" },
      { v: 1, id: "layout", kind: "layout.apply", positions: { a: { x: 10, y: 20 } } },
      { v: 1, id: "rename", kind: "graph.rename", name: "New name" },
      { v: 1, id: "interface-set", kind: "callable-interface.set", interface: { inputs: [], outputs: [] } },
      { v: 1, id: "interface-remove", kind: "callable-interface.remove" },
      { v: 1, id: "reference-set", kind: "subflow-reference.set", nodeId: "child", reference: { kind: "draft", flowId: "flow", interface: { inputs: [], outputs: [] }, interfaceHash: hashCallableInterface({ inputs: [], outputs: [] }) } },
      { v: 1, id: "batch", kind: "graph.batch", commands: [{ v: 1, id: "nested", kind: "graph.rename", name: "Nested" }] },
      { v: 1, id: "replace", kind: "graph.replace", graph: { id: "g", name: "Graph", nodes: [], edges: [], future: { kept: true } } as never },
    ];

    for (const command of commands) expect(parseGraphCommand(command)).toEqual(command);
  });

  it("rejects unknown versions, kinds, blank ids, and extra command properties", () => {
    expect(() => parseGraphCommand({ ...duplicate, v: 2 })).toThrow(/version|command/i);
    expect(() => parseGraphCommand({ ...duplicate, kind: "selection.clone" })).toThrow();
    expect(() => parseGraphCommand({ ...duplicate, id: "  " })).toThrow(/id/i);
    expect(() => parseGraphCommand({ ...duplicate, surprise: true })).toThrow();
    expect(parseGraphCommand({ v: 1, id: " spaced ", kind: "graph.rename", name: "Name" }).id).toBe(" spaced ");
  });

  it("requires deterministic, complete, collision-free duplicate maps", () => {
    expect(() => parseGraphCommand({ ...duplicate, nodeIds: ["a", "a"] })).toThrow(/unique/i);
    expect(() => parseGraphCommand({ ...duplicate, nodeIdMap: { a: "copy-a" } })).toThrow(/map|cover/i);
    expect(() => parseGraphCommand({ ...duplicate, nodeIdMap: { a: "same", b: "same" } })).toThrow(/unique/i);
    expect(() => parseGraphCommand({ ...duplicate, nodeIdMap: { a: "a", b: "copy-b" } })).toThrow(/collid/i);
    expect(() => parseGraphCommand({ ...duplicate, edgeIdMap: { one: "same", two: "same" } })).toThrow(/unique/i);
    expect(() => parseGraphCommand({ ...duplicate, nodeIds: ["b", "a"], nodeIdMap: { a: "copy-a", b: "copy-b" } })).toThrow(/sorted/i);
    expect(() => parseGraphCommand({ ...duplicate, nodeIdMap: { a: "shared", b: "copy-b" }, edgeIdMap: { "a-b": "shared" } })).toThrow(/across maps|unique/i);
  });

  it("rejects non-finite geometry, invalid indices, and mismatched bounds", () => {
    expect(() => parseGraphCommand({ ...duplicate, offset: { x: Number.NaN, y: 0 } })).toThrow(/finite/i);
    expect(() => parseGraphCommand({ v: 1, id: "bad-index", kind: "node.add", index: -1, node: { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } } })).toThrow(/index|greater/i);
    expect(() => parseGraphCommand({ v: 1, id: "bad-bounds", kind: "selection.align", nodeIds: ["a", "b"], bounds: { a: { x: 0, y: 0, width: 1, height: 1 } }, axis: "x", mode: "start" })).toThrow(/bounds|cover/i);
    expect(() => parseGraphCommand({ v: 1, id: "blank-position-id", kind: "selection.move", positions: { "": { x: 0, y: 0 } } })).toThrow(/id|blank/i);
    expect(() => parseGraphCommand({ v: 1, id: "whitespace-position-id", kind: "layout.apply", positions: { "   ": { x: 0, y: 0 } } })).toThrow(/id|blank/i);
    expect(() => parseGraphCommand({ ...duplicate, edgeIdMap: { "": "copy-edge" } })).toThrow(/id|blank/i);
  });

  it("rejects empty, over-wide, and over-deep batches", () => {
    expect(() => parseGraphCommand({ v: 1, id: "empty", kind: "graph.batch", commands: [] })).toThrow(/empty|command/i);
    const children = Array.from({ length: 501 }, (_, index) => ({ v: 1, id: `c-${index}`, kind: "graph.rename", name: String(index) }));
    expect(() => parseGraphCommand({ v: 1, id: "wide", kind: "graph.batch", commands: children })).toThrow(/500|limit/i);
    const wrapperChildren = Array.from({ length: 251 }, (_, index) => ({
      v: 1,
      id: `wrapper-${index}`,
      kind: "graph.batch",
      commands: [{ v: 1, id: `wrapped-${index}`, kind: "graph.rename", name: String(index) }],
    }));
    expect(() => parseGraphCommand({ v: 1, id: "too-many-wrappers", kind: "graph.batch", commands: wrapperChildren })).toThrow(/500|limit/i);
    let nested: unknown = { v: 1, id: "leaf", kind: "graph.rename", name: "leaf" };
    for (let depth = 0; depth < 11; depth += 1) nested = { v: 1, id: `depth-${depth}`, kind: "graph.batch", commands: [nested] };
    expect(() => parseGraphCommand(nested)).toThrow(/depth|10/i);
    let hostileDepth: unknown = { v: 1, id: "hostile-leaf", kind: "graph.rename", name: "leaf" };
    for (let depth = 0; depth < 2_000; depth += 1) hostileDepth = { v: 1, id: `hostile-${depth}`, kind: "graph.batch", commands: [hostileDepth] };
    expect(() => parseGraphCommand(hostileDepth)).toThrow(/depth|10/i);
    expect(() => parseGraphCommand({
      v: 1,
      id: "duplicate-command-ids",
      kind: "graph.batch",
      commands: [
        { v: 1, id: "same", kind: "graph.rename", name: "A" },
        { v: 1, id: "same", kind: "graph.rename", name: "B" },
      ],
    })).toThrow(/command ids.*unique/i);
  });

  it("rejects unsafe keys and non-JSON command payloads", () => {
    expect(() => parseGraphCommand({ v: 1, id: "unsafe", kind: "node.patch", nodeId: "a", patch: [{ op: "add", path: "/constructor/polluted", value: true }] })).toThrow(/unsafe|prototype/i);
    expect(() => parseGraphCommand({ v: 1, id: "function", kind: "node.add", node: { id: "a", type: "input", params: { value: () => true }, position: { x: 0, y: 0 } } })).toThrow(/json/i);
    const sparse = Array(1);
    expect(() => parseGraphCommand({ v: 1, id: "sparse", kind: "node.add", node: { id: "a", type: "input", params: { value: sparse }, position: { x: 0, y: 0 } } })).toThrow(/sparse|json/i);
    const decorated = [1] as number[] & { label?: string };
    decorated.label = "ignored by JSON";
    expect(() => parseGraphCommand({ v: 1, id: "decorated", kind: "node.add", node: { id: "a", type: "input", params: { value: decorated }, position: { x: 0, y: 0 } } })).toThrow(/array|json/i);
    const hidden = {} as Record<string, unknown>;
    Object.defineProperty(hidden, "secret", { value: true, enumerable: false });
    expect(() => parseGraphCommand({ v: 1, id: "hidden", kind: "node.add", node: { id: "a", type: "input", params: { value: hidden }, position: { x: 0, y: 0 } } })).toThrow(/enumerable|json/i);
    const symbolKeyed = { [Symbol("hidden")]: true };
    expect(() => parseGraphCommand({ v: 1, id: "symbol", kind: "node.add", node: { id: "a", type: "input", params: { value: symbolKeyed }, position: { x: 0, y: 0 } } })).toThrow(/symbol|json/i);
    let deepParams: Record<string, unknown> = {};
    for (let depth = 0; depth < 101; depth += 1) deepParams = { child: deepParams };
    expect(() => parseGraphCommand({ v: 1, id: "deep-json", kind: "node.add", node: { id: "a", type: "input", params: deepParams, position: { x: 0, y: 0 } } })).toThrow(/depth limit/i);
  });

  it("does not execute accessors or custom iterators during raw batch preflight", () => {
    let getterCalls = 0;
    const accessorKind = { v: 1, id: "accessor-kind", name: "Name" } as Record<string, unknown>;
    Object.defineProperty(accessorKind, "kind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("kind getter executed");
      },
    });
    expect(() => parseGraphCommand(accessorKind)).toThrow(GraphCommandError);
    expect(getterCalls).toBe(0);

    const commands = [{ v: 1, id: "child", kind: "graph.rename", name: "Name" }];
    let iteratorCalls = 0;
    Object.defineProperty(commands, Symbol.iterator, {
      value() {
        iteratorCalls += 1;
        throw new Error("iterator executed");
      },
    });
    expect(() => parseGraphCommand({ v: 1, id: "iterator", kind: "graph.batch", commands })).toThrow(GraphCommandError);
    expect(iteratorCalls).toBe(0);

    const accessorCommands = Array(1);
    Object.defineProperty(accessorCommands, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("array getter executed");
      },
    });
    expect(() => parseGraphCommand({ v: 1, id: "array-getter", kind: "graph.batch", commands: accessorCommands })).toThrow(GraphCommandError);
    expect(getterCalls).toBe(0);
  });
});
