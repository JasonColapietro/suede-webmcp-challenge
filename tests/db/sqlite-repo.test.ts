import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";

const sampleGraph: FlowGraph = {
  id: "g1",
  name: "Sample",
  nodes: [{ id: "a", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

describe("SqliteRepo", () => {
  it("round-trips v2 graph data and fails closed on a future stored version", async () => {
    const repo = new SqliteRepo(":memory:");
    const v2: FlowGraphV2 = {
      schemaVersion: 2,
      id: "v2",
      name: "v2",
      nodes: [{
        id: "output",
        type: "output",
        params: {},
        bindings: { token: { kind: "secret", connectionId: "connection-ref", field: "token" } },
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [{ id: "region", name: "Region", scope: "run", schema: {} }],
      groups: [],
      annotations: [],
    };
    const saved = await repo.saveFlow({ ownerId: "v2-owner", name: v2.name, graph: v2 });
    expect((await repo.getFlow(saved.id))?.graph).toEqual(v2);

    const db = (repo as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE flows SET graph = ? WHERE id = ?").run(JSON.stringify({ ...v2, schemaVersion: 3 }), saved.id);
    await expect(repo.getFlow(saved.id)).rejects.toThrow(/schemaVersion|version/i);
  });

  it("round-trips a flow, run, steps, and ledger total", async () => {
    const repo = new SqliteRepo(":memory:");

    const flow = await repo.saveFlow({ ownerId: "u1", name: "Sample", graph: sampleGraph });
    expect(flow.id).toBeTruthy();
    const loaded = await repo.getFlow(flow.id);
    expect(loaded?.graph.nodes).toHaveLength(1);

    const run = await repo.createRun({ flowId: flow.id, trigger: "manual" });
    await repo.appendStep({ runId: run.id, nodeId: "a", nodeType: "input", status: "done", costUsdc: 0.2 });
    await repo.appendStep({ runId: run.id, nodeId: "b", nodeType: "llm", status: "done", costUsdc: 0.04 });
    await repo.finishRun(run.id, "done", 0.24);

    const steps = await repo.listRunSteps(run.id);
    expect(steps).toHaveLength(2);
    const total = steps.reduce((sum, s) => sum + s.costUsdc, 0);
    expect(total).toBeCloseTo(0.24, 5);

    const finished = await repo.getRun(run.id);
    expect(finished?.status).toBe("done");
    expect(finished?.totalCostUsdc).toBeCloseTo(0.24, 5);
  });

  it("round-trips a run's trigger input and run variables, and stores null when none is given", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "u1", name: "Sample", graph: sampleGraph });

    const withInput = await repo.createRun({
      flowId: flow.id,
      trigger: "manual",
      triggerInput: { prompt: "hi", nested: { a: 1 } },
      runVariables: { budget: 5 },
    });
    expect(withInput.triggerInput).toEqual({ prompt: "hi", nested: { a: 1 } });
    expect(withInput.runVariables).toEqual({ budget: 5 });
    const reloaded = await repo.getRun(withInput.id);
    expect(reloaded?.triggerInput).toEqual({ prompt: "hi", nested: { a: 1 } });
    expect(reloaded?.runVariables).toEqual({ budget: 5 });

    const withoutInput = await repo.createRun({ flowId: flow.id, trigger: "manual" });
    expect(withoutInput.triggerInput).toBeNull();
    expect(withoutInput.runVariables).toBeNull();
    const reloadedWithout = await repo.getRun(withoutInput.id);
    expect(reloadedWithout?.triggerInput).toBeNull();
    expect(reloadedWithout?.runVariables).toBeNull();
  });

  it("persists a caller-supplied durable run identity and refuses a duplicate", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "u1", name: "Sample", graph: sampleGraph });
    const id = "00000000-0000-5000-8000-000000000001";

    const created = await repo.createRun({ id, flowId: flow.id, trigger: "agent" });

    expect(created.id).toBe(id);
    await expect(repo.createRun({ id, flowId: flow.id, trigger: "agent" })).rejects.toThrow();
  });

  it("lists flows for an owner and finds agents by slug", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "u2", name: "F", graph: sampleGraph });
    await repo.createAgent({ flowId: flow.id, slug: "my-agent", status: "live", priceUsdc: 1.99 });

    const flows = await repo.listFlows("u2");
    expect(flows).toHaveLength(1);
    const agent = await repo.getAgentBySlug("my-agent");
    expect(agent?.priceUsdc).toBeCloseTo(1.99, 5);
  });

  describe("sumAgentCostSince — durable daily-cost-cap source of truth", () => {
    it("sums total_cost_usdc across finished runs for the agent within the window", async () => {
      const repo = new SqliteRepo(":memory:");
      const flow = await repo.saveFlow({ ownerId: "u3", name: "F", graph: sampleGraph });
      const agent = await repo.createAgent({ flowId: flow.id, slug: "cap-agent", status: "live" });

      const runA = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
      await repo.finishRun(runA.id, "done", 2.5);
      const runB = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
      await repo.finishRun(runB.id, "done", 1.25);

      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      const spent = await repo.sumAgentCostSince(agent.id, sinceMs);
      expect(spent).toBeCloseTo(3.75, 5);
    });

    it("excludes runs started before the window", async () => {
      const repo = new SqliteRepo(":memory:");
      const flow = await repo.saveFlow({ ownerId: "u4", name: "F", graph: sampleGraph });
      const agent = await repo.createAgent({ flowId: flow.id, slug: "cap-agent-old", status: "live" });
      const run = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
      await repo.finishRun(run.id, "done", 10);

      // Window starts strictly after this run's started_at.
      const sinceMs = Date.now() + 1000;
      const spent = await repo.sumAgentCostSince(agent.id, sinceMs);
      expect(spent).toBe(0);
    });

    it("does not mix spend across different agents", async () => {
      const repo = new SqliteRepo(":memory:");
      const flow = await repo.saveFlow({ ownerId: "u5", name: "F", graph: sampleGraph });
      const agentA = await repo.createAgent({ flowId: flow.id, slug: "cap-agent-a", status: "live" });
      const agentB = await repo.createAgent({ flowId: flow.id, slug: "cap-agent-b", status: "live" });
      const runA = await repo.createRun({ flowId: flow.id, agentId: agentA.id, trigger: "agent" });
      await repo.finishRun(runA.id, "done", 8);

      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      expect(await repo.sumAgentCostSince(agentA.id, sinceMs)).toBeCloseTo(8, 5);
      expect(await repo.sumAgentCostSince(agentB.id, sinceMs)).toBe(0);
    });

    it("returns 0 for an agent with no runs", async () => {
      const repo = new SqliteRepo(":memory:");
      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      expect(await repo.sumAgentCostSince("no-such-agent", sinceMs)).toBe(0);
    });
  });
});
