/**
 * SQLite bulk aggregates behind the buyer shelf:
 * - lastAgentCallAt: one MAX(started_at) GROUP BY agent_id read, optional
 *   trigger filter so scheduled self-runs never fake external recency.
 * - countSettledRunsByAgent: settled means settled_at IS NOT NULL; dry-runs
 *   and merely-finished runs never count.
 */
import { describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

async function seedAgent(
  repo: SqliteRepo,
  suffix: string,
): Promise<{ flowId: string; agentId: string }> {
  const flow = await repo.saveFlow({
    ownerId: "owner-1",
    name: `Buyer Shelf ${suffix}`,
    graph: { id: `g-${suffix}`, name: `g-${suffix}`, nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: `buyer-shelf-${suffix}`,
    status: "live",
  });
  return { flowId: flow.id, agentId: agent.id };
}

describe("SqliteRepo.lastAgentCallAt", () => {
  it("returns the max started_at per agent in one bulk read", async () => {
    const repo = new SqliteRepo(":memory:");
    const a = await seedAgent(repo, "a");
    const b = await seedAgent(repo, "b");
    const first = await repo.createRun({ flowId: a.flowId, agentId: a.agentId, trigger: "agent" });
    const second = await repo.createRun({ flowId: a.flowId, agentId: a.agentId, trigger: "agent" });
    const other = await repo.createRun({ flowId: b.flowId, agentId: b.agentId, trigger: "agent" });

    const out = await repo.lastAgentCallAt([a.agentId, b.agentId]);
    expect(out[a.agentId]).toBe(Math.max(first.startedAt, second.startedAt));
    expect(out[b.agentId]).toBe(other.startedAt);
  });

  it("filters by trigger so scheduled self-runs never count as external recency", async () => {
    const repo = new SqliteRepo(":memory:");
    const a = await seedAgent(repo, "a");
    await repo.createRun({ flowId: a.flowId, agentId: a.agentId, trigger: "schedule" });

    await expect(repo.lastAgentCallAt([a.agentId], "agent")).resolves.toEqual({});
    const scheduled = await repo.lastAgentCallAt([a.agentId], "schedule");
    expect(scheduled[a.agentId]).toBeTypeOf("number");
  });

  it("returns an empty record for no ids and for never-called agents", async () => {
    const repo = new SqliteRepo(":memory:");
    const a = await seedAgent(repo, "a");
    await expect(repo.lastAgentCallAt([])).resolves.toEqual({});
    await expect(repo.lastAgentCallAt([a.agentId])).resolves.toEqual({});
  });
});

describe("SqliteRepo.countSettledRunsByAgent", () => {
  it("counts only runs stamped settled, never merely-finished dry-runs", async () => {
    const repo = new SqliteRepo(":memory:");
    const a = await seedAgent(repo, "a");
    const settled = await repo.createRun({ flowId: a.flowId, agentId: a.agentId, trigger: "agent" });
    const dry = await repo.createRun({ flowId: a.flowId, agentId: a.agentId, trigger: "agent" });
    await repo.finishRun(settled.id, "done", 0.01);
    await repo.finishRun(dry.id, "done", 0);
    await repo.stampRunSettled(settled.id, new Date().toISOString());

    await expect(repo.countSettledRunsByAgent([a.agentId])).resolves.toEqual({
      [a.agentId]: 1,
    });
  });
});
