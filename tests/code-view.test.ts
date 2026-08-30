import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { getCodeViewData } from "@/lib/code-view";
import type { FlowGraph } from "@/lib/flow/types";

const sampleGraph: FlowGraph = {
  id: "cv-test-g1",
  name: "Price Watcher",
  nodes: [
    { id: "n1", type: "input", params: {}, position: { x: 0, y: 0 } },
    { id: "n2", type: "llm", params: { prompt: "Extract the price" }, position: { x: 240, y: 0 } },
    { id: "n3", type: "output", params: {}, position: { x: 480, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
  ],
};

describe("getCodeViewData", () => {
  it("returns source containing defineAgent and the flow name", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "owner-a", name: sampleGraph.name, graph: sampleGraph });
    const result = await getCodeViewData(flow.id, "owner-a", repo);
    expect(result).not.toBeNull();
    expect(result!.source).toContain("defineAgent");
    expect(result!.source).toContain("Price Watcher");
    expect(result!.name).toBe("Price Watcher");
  });

  it("returns null when ownerId does not match", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "owner-a", name: "X", graph: sampleGraph });
    const result = await getCodeViewData(flow.id, "wrong-owner", repo);
    expect(result).toBeNull();
  });

  it("returns null for unknown flowId", async () => {
    const repo = new SqliteRepo(":memory:");
    const result = await getCodeViewData("does-not-exist", "owner-a", repo);
    expect(result).toBeNull();
  });
});
