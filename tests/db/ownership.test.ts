import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { summarizeGraph } from "@/lib/catalog";
import type { FlowGraph } from "@/lib/flow/types";

const graph = (id: string): FlowGraph => ({
  id,
  name: `Flow ${id}`,
  nodes: [
    { id: "i", type: "input", params: {}, position: { x: 0, y: 0 } },
    { id: "s", type: "suede.generateSong", params: {}, position: { x: 1, y: 0 } },
    { id: "o", type: "output", params: {}, position: { x: 2, y: 0 } },
  ],
  edges: [],
});

describe("owner scoping + lifecycle", () => {
  it("scopes lists per owner and deletes only the owner's flow", async () => {
    const repo = new SqliteRepo(":memory:");
    const mine = await repo.saveFlow({ ownerId: "owner-a", name: "Mine", graph: graph("a") });
    await repo.saveFlow({ ownerId: "owner-b", name: "Theirs", graph: graph("b") });

    expect(await repo.listFlows("owner-a")).toHaveLength(1);
    expect(await repo.listFlows("owner-b")).toHaveLength(1);

    // A stranger cannot delete it…
    expect(await repo.deleteFlow(mine.id, "owner-b")).toBe(false);
    expect(await repo.getFlow(mine.id)).not.toBeNull();

    // …the owner can, and dependents go with it.
    const agent = await repo.createAgent({ flowId: mine.id, slug: "mine-x", status: "live" });
    const run = await repo.createRun({ flowId: mine.id, agentId: agent.id, trigger: "agent" });
    await repo.appendStep({ runId: run.id, nodeId: "i", nodeType: "input", status: "done", costUsdc: 0 });
    expect(await repo.deleteFlow(mine.id, "owner-a")).toBe(true);
    expect(await repo.getFlow(mine.id)).toBeNull();
    expect(await repo.getAgentBySlug("mine-x")).toBeNull();
    expect(await repo.listRunSteps(run.id)).toHaveLength(0);
  });

  it("relaunch support: finds agent by flow id and updates price/status in place", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "o", name: "F", graph: graph("f") });
    const created = await repo.createAgent({ flowId: flow.id, slug: "f-1", priceUsdc: 0 });

    const found = await repo.getAgentByFlowId(flow.id);
    expect(found?.id).toBe(created.id);

    const updated = await repo.updateAgent(created.id, { status: "live", priceUsdc: 0.25 });
    expect(updated?.status).toBe("live");
    expect(updated?.priceUsdc).toBeCloseTo(0.25, 5);
    expect(updated?.slug).toBe("f-1");
  });

  it("aggregates the public/dashboard views: live agents, owner agents, owner runs, call counts", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "o", name: "F", graph: graph("f") });
    const live = await repo.createAgent({ flowId: flow.id, slug: "live-1", status: "live" });
    const other = await repo.saveFlow({ ownerId: "p", name: "G", graph: graph("g") });
    await repo.createAgent({ flowId: other.id, slug: "draft-1", status: "draft" });

    expect((await repo.listLiveAgents()).map((a) => a.slug)).toEqual(["live-1"]);
    expect((await repo.listAgentsByOwner("o")).map((a) => a.slug)).toEqual(["live-1"]);

    await repo.createRun({ flowId: flow.id, agentId: live.id, trigger: "agent" });
    await repo.createRun({ flowId: flow.id, agentId: live.id, trigger: "agent" });
    await repo.createRun({ flowId: flow.id, trigger: "manual" });

    const counts = await repo.countRunsByAgent([live.id]);
    expect(counts[live.id]).toBe(2);

    const runs = await repo.listRunsByOwner("o", 10);
    expect(runs).toHaveLength(3);
    expect(await repo.listRunsByOwner("p", 10)).toHaveLength(0);
  });
});

describe("summarizeGraph", () => {
  it("renders a readable node chain", () => {
    expect(summarizeGraph(graph("x"))).toBe("Input › Generate Song › Output");
  });

  it("handles empty graphs", () => {
    expect(summarizeGraph({ id: "e", name: "E", nodes: [], edges: [] })).toBe("Empty flow");
  });
});
