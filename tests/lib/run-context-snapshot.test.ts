import { describe, expect, it, vi } from "vitest";
import { buildRunContext } from "@/lib/run-context";
import { RunLogger } from "@/lib/log";
import type { FlowGraph, SubflowReference } from "@/lib/flow/types";
import type { ResolvedSubflow } from "@/lib/flow/subflow-resolver";

describe("buildRunContext reusable-flow snapshot", () => {
  it("uses the preflighted request snapshot instead of live repositories", async () => {
    const graph: FlowGraph = { id: "snapshot", name: "Snapshot", nodes: [], edges: [] };
    const resolved = {
      graph, flowId: "child", semanticHash: "a".repeat(64),
      callableInterface: { inputs: [], outputs: [] },
    } as ResolvedSubflow;
    const loadSubflow = vi.fn(async () => graph);
    const resolveSubflow = vi.fn(async () => resolved);
    const ctx = buildRunContext({
      runId: "run", logger: new RunLogger(), ownerId: "owner",
      subflowSnapshot: { loadSubflow, resolveSubflow },
    });
    const reference = {
      kind: "draft", flowId: "child", interface: { inputs: [], outputs: [] },
      interfaceHash: "b".repeat(64),
    } as SubflowReference;

    await expect(ctx.loadSubflow("child")).resolves.toBe(graph);
    await expect(ctx.resolveSubflow(reference)).resolves.toBe(resolved);
    expect(loadSubflow).toHaveBeenCalledWith("child");
    expect(resolveSubflow).toHaveBeenCalledWith(reference);
  });
});
