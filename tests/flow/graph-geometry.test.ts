import { describe, expect, it } from "vitest";
import { alignSelection, distributeSelection } from "@/lib/flow/graph-geometry";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import type { NodeBounds } from "@/lib/flow/graph-command-types";
import type { FlowGraph } from "@/lib/flow/types";

const bounds = (): Record<string, NodeBounds> => ({
  a: { x: 100, y: 20, width: 40, height: 30 },
  b: { x: 220, y: 80, width: 80, height: 50 },
  c: { x: 400, y: 170, width: 20, height: 70 },
});

describe("graph selection geometry", () => {
  it.each([
    ["x", "start", { a: { x: 100, y: 20 }, b: { x: 100, y: 80 }, c: { x: 100, y: 170 } }],
    ["x", "center", { a: { x: 240, y: 20 }, b: { x: 220, y: 80 }, c: { x: 250, y: 170 } }],
    ["x", "end", { a: { x: 380, y: 20 }, b: { x: 340, y: 80 }, c: { x: 400, y: 170 } }],
    ["y", "start", { a: { x: 100, y: 20 }, b: { x: 220, y: 20 }, c: { x: 400, y: 20 } }],
    ["y", "center", { a: { x: 100, y: 115 }, b: { x: 220, y: 105 }, c: { x: 400, y: 95 } }],
    ["y", "end", { a: { x: 100, y: 210 }, b: { x: 220, y: 190 }, c: { x: 400, y: 170 } }],
  ] as const)("aligns %s to %s with mixed dimensions", (axis, mode, expected) => {
    const input = bounds();
    const before = structuredClone(input);
    expect(alignSelection(input, ["a", "b", "c"], axis, mode)).toEqual(expected);
    expect(input).toEqual(before);
  });

  it("distributes visual bounds with equal gaps and preserves the outer nodes", () => {
    const input = bounds();
    expect(distributeSelection(input, ["c", "a", "b"], "x")).toEqual({
      a: { x: 100, y: 20 },
      b: { x: 230, y: 80 },
      c: { x: 400, y: 170 },
    });
    expect(distributeSelection(input, ["a", "b", "c"], "y")).toEqual({
      a: { x: 100, y: 20 },
      b: { x: 220, y: 85 },
      c: { x: 400, y: 170 },
    });
  });

  it("uses code-unit ID order to break identical visual-position ties", () => {
    const tied = {
      z: { x: 0, y: 0, width: 10, height: 10 },
      a: { x: 0, y: 50, width: 10, height: 10 },
      m: { x: 100, y: 100, width: 10, height: 10 },
    };
    expect(distributeSelection(tied, ["z", "m", "a"], "x")).toEqual({
      a: { x: 0, y: 50 },
      z: { x: 50, y: 0 },
      m: { x: 100, y: 100 },
    });
  });

  it("rejects invalid selection sizes, coverage, and bounds", () => {
    expect(() => alignSelection(bounds(), ["a"], "x", "start")).toThrow(/two/i);
    expect(() => distributeSelection(bounds(), ["a", "b"], "x")).toThrow(/three/i);
    expect(() => alignSelection(bounds(), ["a", "missing"], "x", "start")).toThrow(/cover|missing/i);
    expect(() => alignSelection({ ...bounds(), extra: bounds().a }, ["a", "b", "c"], "x", "start")).toThrow(/cover/i);
    expect(() => alignSelection({ ...bounds(), a: { ...bounds().a, width: Number.NaN } }, ["a", "b", "c"], "x", "start")).toThrow(/finite/i);
  });

  it("applies high-level geometry through the reducer with an exact move inverse", () => {
    const source: FlowGraph = {
      id: "geometry",
      name: "Geometry",
      nodes: Object.entries(bounds()).map(([id, value]) => ({ id, type: "input", params: { keep: id }, position: { x: value.x, y: value.y } })),
      edges: [{ id: "a-b", source: "a", target: "b" }],
      meta: { keep: true },
    };
    const before = structuredClone(source);
    const result = applyGraphCommand(source, {
      v: 1,
      id: "align",
      kind: "selection.align",
      nodeIds: ["a", "b", "c"],
      bounds: bounds(),
      axis: "x",
      mode: "end",
    });
    expect(result.graph.nodes.map((value) => value.position)).toEqual([
      { x: 380, y: 20 }, { x: 340, y: 80 }, { x: 400, y: 170 },
    ]);
    expect(result.inverse).toMatchObject({ kind: "selection.move" });
    expect(applyGraphCommand(result.graph, result.inverse).graph).toEqual(source);
    expect(source).toEqual(before);
  });
});
