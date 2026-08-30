import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";
import { FlowSaveCoordinator } from "@/lib/flow/save-queue";
import { saveBeforeWorkbookNavigation } from "@/lib/projects/ui-model";

const v1: FlowGraph = { id: "graph-v1", name: "V1", nodes: [], edges: [] };
const v2: FlowGraphV2 = {
  schemaVersion: 2,
  id: "graph-v2",
  name: "V2",
  nodes: [],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
};

describe("saveBeforeWorkbookNavigation", () => {
  it.each([v1, v2])("saves a supported graph before navigating", async (graph) => {
    const order: string[] = [];
    const saveNow = vi.fn(async () => { order.push("save"); });
    const navigate = vi.fn((path: string) => { order.push(`navigate:${path}`); });

    await saveBeforeWorkbookNavigation({
      currentGraph: graph,
      targetFlowId: "flow:opaque row@v2",
      saveNow,
      navigate,
    });

    expect(saveNow).toHaveBeenCalledWith(graph);
    expect(navigate).toHaveBeenCalledWith("/build/flow%3Aopaque%20row%40v2");
    expect(order).toEqual(["save", "navigate:/build/flow%3Aopaque%20row%40v2"]);
  });

  it("refuses navigation when the current draft cannot save", async () => {
    const navigate = vi.fn();
    await expect(saveBeforeWorkbookNavigation({
      currentGraph: v1,
      targetFlowId: "row-next",
      saveNow: vi.fn(async () => { throw new Error("private transport detail"); }),
      navigate,
    })).rejects.toThrow("private transport detail");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses a bound real coordinator for the current authoritative row", async () => {
    const update = vi.fn(async () => undefined);
    const coordinator = new FlowSaveCoordinator(
      "row-current",
      { create: vi.fn(), update },
      {},
      0,
    );
    const navigate = vi.fn();

    await saveBeforeWorkbookNavigation({
      currentGraph: v2,
      targetFlowId: "row-next",
      saveNow: (current) => coordinator.saveNow(current),
      navigate,
    });

    expect(update).toHaveBeenCalledWith("row-current", v2);
    expect(navigate).toHaveBeenCalledWith("/build/row-next");
  });

  it("keeps the current route when a real coordinator update rejects", async () => {
    const coordinator = new FlowSaveCoordinator(
      "row-current",
      { create: vi.fn(), update: vi.fn(async () => { throw new Error("offline"); }) },
      {},
      0,
    );
    const navigate = vi.fn();

    await expect(saveBeforeWorkbookNavigation({
      currentGraph: v1,
      targetFlowId: "row-next",
      saveNow: (current) => coordinator.saveNow(current),
      navigate,
    })).rejects.toThrow("offline");
    expect(navigate).not.toHaveBeenCalled();
  });
});
