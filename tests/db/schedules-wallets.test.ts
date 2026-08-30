import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { FlowGraph } from "@/lib/flow/types";

const graph: FlowGraph = {
  id: "g",
  name: "G",
  nodes: [{ id: "s", type: "schedule", params: { cron: "0 9 * * *" }, position: { x: 0, y: 0 } }],
  edges: [],
};

const T = (h: number, m: number, day = 10): number => Date.UTC(2026, 5, day, h, m);

async function seedAgent(repo: SqliteRepo): Promise<string> {
  const flow = await repo.saveFlow({ ownerId: "o", name: "F", graph });
  const agent = await repo.createAgent({ flowId: flow.id, slug: `s-${Math.random()}`, status: "live" });
  return agent.id;
}

describe("schedule upsert + due semantics", () => {
  it("upserts one schedule per agent: create, replace cron in place, preserve lastRunAt", async () => {
    const repo = new SqliteRepo(":memory:");
    const agentId = await seedAgent(repo);

    const created = await repo.upsertSchedule({ agentId, cron: "0 9 * * *", enabled: true });
    expect(created.cron).toBe("0 9 * * *");
    await repo.markScheduleRun(created.id, T(9, 5));

    const replaced = await repo.upsertSchedule({ agentId, cron: "0 13 * * 1", enabled: true });
    expect(replaced.cron).toBe("0 13 * * 1");
    expect(replaced.lastRunAt).toBe(T(9, 5));

    const all = await repo.listSchedulesByAgents([agentId]);
    expect(all).toHaveLength(1);
    expect(all[0].cron).toBe("0 13 * * 1");
  });

  it("disables in place when the schedule node is gone", async () => {
    const repo = new SqliteRepo(":memory:");
    const agentId = await seedAgent(repo);
    await repo.upsertSchedule({ agentId, cron: "0 9 * * *", enabled: true });
    const disabled = await repo.upsertSchedule({ agentId, cron: "0 9 * * *", enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(await repo.dueSchedules(T(14, 30))).toHaveLength(0);
  });

  it("dueSchedules honors the cron expression instead of returning every enabled row", async () => {
    const repo = new SqliteRepo(":memory:");
    const ranToday = await seedAgent(repo);
    const neverRan = await seedAgent(repo);

    const ranSchedule = await repo.upsertSchedule({ agentId: ranToday, cron: "0 9 * * *", enabled: true });
    await repo.markScheduleRun(ranSchedule.id, T(9, 5));
    await repo.upsertSchedule({ agentId: neverRan, cron: "0 9 * * *", enabled: true });

    // Hourly tick at 14:30: the daily that already ran today must NOT refire.
    const due = await repo.dueSchedules(T(14, 30));
    expect(due.map((s) => s.agentId)).toEqual([neverRan]);
  });
});

describe("wallets", () => {
  it("returns null for unknown owners and upserts by owner", async () => {
    const repo = new SqliteRepo(":memory:");
    expect(await repo.getWallet("o")).toBeNull();

    const first = await repo.saveWallet({ ownerId: "o", address: "0x1111111111111111111111111111111111111111" });
    expect(first.address).toBe("0x1111111111111111111111111111111111111111");
    expect(first.network).toBe("base-mainnet");

    await repo.saveWallet({ ownerId: "o", address: "0x2222222222222222222222222222222222222222" });
    const wallet = await repo.getWallet("o");
    expect(wallet?.address).toBe("0x2222222222222222222222222222222222222222");
  });
});

describe("countRunsByAgent trigger filter", () => {
  it("counts only the requested trigger so schedule self-runs don't inflate calls", async () => {
    const repo = new SqliteRepo(":memory:");
    const flow = await repo.saveFlow({ ownerId: "o", name: "F", graph });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "c-1", status: "live" });

    await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
    await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
    await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "schedule" });

    expect((await repo.countRunsByAgent([agent.id]))[agent.id]).toBe(3);
    expect((await repo.countRunsByAgent([agent.id], "agent"))[agent.id]).toBe(2);
    expect((await repo.countRunsByAgent([agent.id], "schedule"))[agent.id]).toBe(1);
  });
});
