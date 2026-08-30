import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeFirstSaveSessionHandoff,
  firstSaveSessionHandoffMatches,
  readFirstSaveSessionHandoff,
  resetFirstSaveSessionHandoffsForTest,
  storeFirstSaveSessionHandoff,
  takeMatchingFirstSaveSessionHandoff,
  type FirstSaveSessionHandoff,
} from "@/lib/studio/first-save-session-handoff";
import { createGraphHistory, dispatchGraphCommand } from "@/lib/flow/graph-history";
import type { SupportedFlowGraph } from "@/lib/flow/types";

const graph: SupportedFlowGraph = {
  id: "draft-graph",
  name: "Draft",
  nodes: [],
  edges: [],
};

function handoff(createdAt = 1_000): FirstSaveSessionHandoff {
  const history = dispatchGraphCommand(createGraphHistory(graph), {
    v: 1,
    id: "rename",
    kind: "graph.rename",
    name: "Saved draft",
  });
  return {
    rowId: "row-1",
    persistedFingerprint: "persisted",
    currentFingerprint: "current",
    acceptedAuthoritativeFingerprints: [
      "persisted",
      "intermediate",
      "current",
    ],
    history,
    selection: {
      nodeIds: [],
      edgeIds: [],
      primaryNodeId: null,
    },
    measuredBounds: {},
    viewport: { x: 12, y: -8, zoom: 1.25 },
    createdAt,
  };
}

afterEach(() => resetFirstSaveSessionHandoffsForTest());

describe("first-save session handoff", () => {
  it("is cloned, row-scoped, and consumed exactly once after a repeatable read", () => {
    const source = handoff();
    storeFirstSaveSessionHandoff(source, 1_000);

    expect(readFirstSaveSessionHandoff("another-row", 1_001)).toBeNull();
    const restored = readFirstSaveSessionHandoff("row-1", 1_001);
    expect(restored).toEqual(source);
    expect(restored).not.toBe(source);
    expect(restored?.history).not.toBe(source.history);
    expect(readFirstSaveSessionHandoff("row-1", 1_002)).toEqual(source);
    expect(consumeFirstSaveSessionHandoff(restored!, 1_003)).toBe(true);
    expect(readFirstSaveSessionHandoff("row-1", 1_004)).toBeNull();
    expect(consumeFirstSaveSessionHandoff(restored!, 1_005)).toBe(false);
  });

  it("expires instead of replaying stale editor state", () => {
    storeFirstSaveSessionHandoff(handoff(), 1_000);
    const restored = readFirstSaveSessionHandoff("row-1", 1_001);
    expect(readFirstSaveSessionHandoff("row-1", 31_001)).toBeNull();
    expect(consumeFirstSaveSessionHandoff(restored!, 31_001)).toBe(false);
    expect(
      takeMatchingFirstSaveSessionHandoff("row-1", "persisted", 31_001),
    ).toBeNull();
  });

  it("accepts only a graph snapshot in the known route-transition lineage", () => {
    const source = handoff();
    expect(firstSaveSessionHandoffMatches(source, "persisted")).toBe(true);
    expect(firstSaveSessionHandoffMatches(source, "intermediate")).toBe(true);
    expect(firstSaveSessionHandoffMatches(source, "current")).toBe(true);
    expect(firstSaveSessionHandoffMatches(source, "unexpected")).toBe(false);
  });

  it("atomically takes a matching handoff and discards a mismatch", () => {
    const source = handoff();
    storeFirstSaveSessionHandoff(source, 1_000);
    expect(
      takeMatchingFirstSaveSessionHandoff("row-1", "intermediate", 1_001),
    ).toEqual(source);
    expect(readFirstSaveSessionHandoff("row-1", 1_002)).toBeNull();

    storeFirstSaveSessionHandoff(source, 1_003);
    expect(
      takeMatchingFirstSaveSessionHandoff("row-1", "unexpected", 1_004),
    ).toBeNull();
    expect(readFirstSaveSessionHandoff("row-1", 1_005)).toBeNull();
  });

  it("does not let a stale read consume a refreshed route handoff", () => {
    const source = handoff();
    storeFirstSaveSessionHandoff(source, 1_000);
    const stale = readFirstSaveSessionHandoff("row-1", 1_001);
    const refreshed = {
      ...source,
      currentFingerprint: "later",
      acceptedAuthoritativeFingerprints: [
        ...source.acceptedAuthoritativeFingerprints,
        "later",
      ],
      createdAt: 1_002,
    };
    storeFirstSaveSessionHandoff(refreshed, 1_002);

    expect(consumeFirstSaveSessionHandoff(stale!, 1_003)).toBe(false);
    expect(readFirstSaveSessionHandoff("row-1", 1_003)).toEqual(refreshed);
  });
});

describe("first-save handoff integration", () => {
  const buildPage = readFileSync(
    join(process.cwd(), "src/app/build/[flowId]/builder.tsx"),
    "utf8",
  );
  const flowCanvas = readFileSync(
    join(process.cwd(), "src/components/canvas/FlowCanvas.tsx"),
    "utf8",
  );

  it("stores transient state before replacing the new-flow route", () => {
    expect(buildPage).toMatch(
      /snapshotFirstSaveHandoff\(outgoingHandoff\);[\s\S]*?router\.replace\(`\/build\/\$\{encodeURIComponent\(migration\.rowId\)\}`\)/,
    );
    expect(buildPage).toContain("takeMatchingFirstSaveSessionHandoff(");
    expect(buildPage).toMatch(
      /return \(\) => \{[\s\S]*?snapshotFirstSaveHandoff\(outgoingHandoff\);[\s\S]*?saveCoordinatorRef\.current\?\.dispose\(\)/,
    );
  });

  it("restores the settled viewport without a competing fit-to-graph pass", () => {
    expect(flowCanvas).toContain("onMoveEnd={(_event, viewport: Viewport)");
    expect(flowCanvas).toContain("defaultViewport={initialViewport}");
    expect(flowCanvas).toContain("fitView={initialViewport === undefined}");
  });

  it("routes a raced post-remount save through the reusable-flow gate", () => {
    expect(buildPage).toMatch(
      /const restored = restoredFirstSaveGraphRef\.current;[\s\S]{0,900}?scheduleSave\(history\.graph\);/,
    );
    expect(buildPage).not.toMatch(
      /const restored = restoredFirstSaveGraphRef\.current;[\s\S]{0,900}?saveCoordinatorRef\.current!\.schedule\(history\.graph\);/,
    );
  });
});
