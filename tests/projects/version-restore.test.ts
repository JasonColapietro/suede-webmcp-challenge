import { describe, expect, it } from "vitest";
import {
  createGraphHistory,
  dispatchGraphCommand,
  redoGraphCommand,
  undoGraphCommand,
} from "@/lib/flow/graph-history";
import { flowSaveFingerprint } from "@/lib/flow/save-queue";
import type { FlowGraphV1, FlowGraphV2, SupportedFlowGraph } from "@/lib/flow/types";
import type { DependencyPin, FlowVersionRecord } from "@/lib/projects/types";

async function loadRestore() {
  try {
    return await import("@/lib/projects/version-restore");
  } catch {
    return null;
  }
}

function dependency(versionId: string): DependencyPin {
  return {
    id: "pin-1",
    flowVersionId: versionId,
    kind: "skill",
    resourceId: "skill-1",
    version: "3",
    contentHash: "content-hash",
    createdAt: 11,
  };
}

function version(graph: SupportedFlowGraph, overrides: Partial<FlowVersionRecord> = {}): FlowVersionRecord {
  const id = overrides.id ?? "version-3";
  return {
    id,
    flowId: "row-1",
    versionNumber: 3,
    schemaVersion: "schemaVersion" in graph ? graph.schemaVersion : 1,
    graph,
    semanticHash: "semantic-hash",
    fullHash: "full-hash",
    createdBy: "workspace-owner",
    createdAt: 10,
    dependencies: [dependency(id)],
    ...overrides,
  };
}

const draft: FlowGraphV1 = {
  id: "draft-graph",
  name: "Current draft",
  nodes: [{ id: "draft-input", type: "input", params: { order: [2, 1] }, position: { x: 7, y: 4 } }],
  edges: [],
};

describe("stale-safe immutable version restore", () => {
  it("exposes the pure restore command boundary", async () => {
    expect(await loadRestore()).not.toBeNull();
  });

  it("restores exact v1 bytes and supports exact undo and redo", async () => {
    const restore = await loadRestore();
    expect(restore).not.toBeNull();
    if (!restore) return;
    const source: FlowGraphV1 = {
      id: "legacy",
      name: "Legacy checkpoint",
      nodes: [
        { id: "b", type: "output", params: { z: 1, a: 2 }, position: { x: 2, y: 0 } },
        { id: "a", type: "input", params: {}, position: { x: 1, y: 0 } },
      ],
      edges: [{ id: "edge", source: "a", target: "b" }],
    };
    const immutable = version(source);
    const before = JSON.stringify(immutable);

    const command = restore.buildVersionRestoreCommand({
      currentGraph: draft,
      version: immutable,
      expectedDraftFingerprint: flowSaveFingerprint(draft),
      commandId: "restore:v3",
    });
    const restored = dispatchGraphCommand(createGraphHistory(draft), command, { label: "Restore v3" });

    expect(JSON.stringify(restored.graph)).toBe(JSON.stringify(source));
    expect(undoGraphCommand(restored).graph).toEqual(draft);
    expect(JSON.stringify(redoGraphCommand(undoGraphCommand(restored)).graph)).toBe(JSON.stringify(source));
    expect(JSON.stringify(immutable)).toBe(before);
  });

  it("restores exact v2 bytes from a clone without mutating the version or dependencies", async () => {
    const restore = await loadRestore();
    expect(restore).not.toBeNull();
    if (!restore) return;
    const source: FlowGraphV2 = {
      schemaVersion: 2,
      id: "v2",
      name: "V2 checkpoint",
      nodes: [],
      edges: [],
      variables: [{ id: "topic", name: "Topic", scope: "run", schema: { type: "string" }, default: "jazz" }],
      groups: [],
      annotations: [],
      meta: { second: 2, first: 1 },
    };
    const immutable = version(source);
    const before = JSON.stringify(immutable);

    const command = restore.buildVersionRestoreCommand({
      currentGraph: draft,
      version: immutable,
      expectedDraftFingerprint: flowSaveFingerprint(draft),
      commandId: "restore:v3",
    });

    expect(command).toEqual({ v: 1, id: "restore:v3", kind: "graph.replace", graph: source });
    expect(command.graph).not.toBe(source);
    expect(command.graph.nodes).not.toBe(source.nodes);
    (command.graph as unknown as { name: string }).name = "Changed command clone";
    expect(JSON.stringify(immutable)).toBe(before);
    expect(immutable.dependencies).toEqual([dependency("version-3")]);
  });

  it("refuses a stale draft fingerprint with a fixed non-echoing error", async () => {
    const restore = await loadRestore();
    expect(restore).not.toBeNull();
    if (!restore) return;
    const secret = "secret-stale-fingerprint";
    expect(() => restore.buildVersionRestoreCommand({
      currentGraph: draft,
      version: version(draft),
      expectedDraftFingerprint: secret,
      commandId: "restore:v3",
    })).toThrow("The draft changed before restore.");
    try {
      restore.buildVersionRestoreCommand({
        currentGraph: draft,
        version: version(draft),
        expectedDraftFingerprint: secret,
        commandId: "restore:v3",
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("refuses invalid current, version, and command data with fixed non-echoing errors", async () => {
    const restore = await loadRestore();
    expect(restore).not.toBeNull();
    if (!restore) return;
    const secret = "secret-invalid-restore-data";
    const invalidGraph = { ...draft, nodes: [{ ...draft.nodes[0], id: secret, type: "unknown" }] };
    expect(() => restore.buildVersionRestoreCommand({
      currentGraph: invalidGraph as unknown as SupportedFlowGraph,
      version: version(draft),
      expectedDraftFingerprint: flowSaveFingerprint(invalidGraph as unknown as SupportedFlowGraph),
      commandId: "restore:v3",
    })).toThrow("The current draft is invalid.");
    expect(() => restore.buildVersionRestoreCommand({
      currentGraph: draft,
      version: version(invalidGraph as unknown as SupportedFlowGraph),
      expectedDraftFingerprint: flowSaveFingerprint(draft),
      commandId: "restore:v3",
    })).toThrow("The saved version is invalid.");
    expect(() => restore.buildVersionRestoreCommand({
      currentGraph: draft,
      version: version(draft),
      expectedDraftFingerprint: flowSaveFingerprint(draft),
      commandId: " ",
    })).toThrow("The restore command is invalid.");
  });
});
