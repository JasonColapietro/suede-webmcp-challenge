import { describe, expect, it } from "vitest";
import { flowSaveFingerprint } from "@/lib/flow/save-queue";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { recoveryDisposition } from "@/lib/flow/studio-recovery";
import type { SupportedFlowGraph } from "@/lib/flow/types";

/**
 * The studio compares fingerprints of graphs that took different routes: one
 * straight from the editor, one rebuilt by zod on its way through the server.
 * If key order can change the fingerprint, the recovery dialog reports a
 * conflict on every load and the unsaved-changes guard never goes quiet.
 */

const editorOrder = {
  schemaVersion: 2,
  id: "flow-1",
  name: "Promo Watch",
  nodes: [
    {
      id: "trigger",
      type: "schedule",
      params: { cron: "*/10 * * * *" },
      bindings: {},
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
} as unknown as SupportedFlowGraph;

// Same graph, keys emitted in a different order — what a server round-trip or a
// differently-built editor object produces.
const serverOrder = {
  name: "Promo Watch",
  nodes: [
    {
      position: { y: 0, x: 0 },
      params: { cron: "*/10 * * * *" },
      type: "schedule",
      bindings: {},
      id: "trigger",
    },
  ],
  annotations: [],
  groups: [],
  variables: [],
  edges: [],
  id: "flow-1",
  schemaVersion: 2,
} as unknown as SupportedFlowGraph;

describe("flowSaveFingerprint", () => {
  it("is independent of object key order", () => {
    expect(flowSaveFingerprint(editorOrder)).toBe(flowSaveFingerprint(serverOrder));
  });

  it("survives the zod rebuild the server applies on save", () => {
    // flow-mutation-service stores parseSupportedFlowGraph(graph), not the bytes it was sent.
    const asStored = parseSupportedFlowGraph(editorOrder) as SupportedFlowGraph;
    expect(flowSaveFingerprint(asStored)).toBe(flowSaveFingerprint(editorOrder));
  });

  it("matches after a node is added the way the reducer adds one", () => {
    // graph-command-reducer builds an added node as `{ ...node, bindings: {} }`,
    // so `bindings` lands after `position`. The schema declares `bindings`
    // before `position`, so the stored graph serializes in a different order.
    // This is the exact divergence that made the studio permanently dirty.
    const asAdded = {
      ...(editorOrder as unknown as Record<string, unknown>),
      nodes: [
        {
          id: "added",
          type: "schedule",
          params: { cron: "0 9 * * *" },
          position: { x: 40, y: 80 },
          bindings: {},
        },
      ],
    } as unknown as SupportedFlowGraph;
    const asStored = parseSupportedFlowGraph(asAdded) as SupportedFlowGraph;
    expect(flowSaveFingerprint(asStored)).toBe(flowSaveFingerprint(asAdded));
  });

  it("still distinguishes graphs that actually differ", () => {
    const edited = {
      ...(editorOrder as unknown as Record<string, unknown>),
      name: "Promo Watch (renamed)",
    } as unknown as SupportedFlowGraph;
    expect(flowSaveFingerprint(edited)).not.toBe(flowSaveFingerprint(editorOrder));
  });

  it("treats node order as meaningful", () => {
    const twoNodes = (order: readonly string[]): SupportedFlowGraph => ({
      ...(editorOrder as unknown as Record<string, unknown>),
      nodes: order.map((id) => ({
        id,
        type: "schedule",
        params: { cron: "*/10 * * * *" },
        bindings: {},
        position: { x: 0, y: 0 },
      })),
    }) as unknown as SupportedFlowGraph;
    expect(flowSaveFingerprint(twoNodes(["a", "b"]))).not.toBe(
      flowSaveFingerprint(twoNodes(["b", "a"])),
    );
  });
});

describe("recoveryDisposition with canonical fingerprints", () => {
  it("clears a browser copy that matches the saved graph despite key order", () => {
    const authoritative = flowSaveFingerprint(parseSupportedFlowGraph(editorOrder) as SupportedFlowGraph);
    const envelope = {
      graphFingerprint: flowSaveFingerprint(serverOrder),
      baseSavedFingerprint: authoritative,
    };
    // Before the fix these two hashes differed and this returned "conflict".
    expect(recoveryDisposition(envelope, authoritative)).toBe("clear");
  });

  it("still reports a genuine conflict when the saved graph moved on", () => {
    const envelope = {
      graphFingerprint: flowSaveFingerprint(editorOrder),
      baseSavedFingerprint: "0".repeat(64),
    };
    expect(recoveryDisposition(envelope, "1".repeat(64))).toBe("conflict");
  });
});
