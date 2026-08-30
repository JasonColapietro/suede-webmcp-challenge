import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { FlowGraph } from "@/lib/flow/types";

const graph: FlowGraph = {
  id: "g",
  name: "G",
  nodes: [{ id: "w", type: "webhook", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

async function seedAgent(repo: SqliteRepo): Promise<string> {
  const flow = await repo.saveFlow({ ownerId: "o", name: "F", graph });
  const agent = await repo.createAgent({ flowId: flow.id, slug: `s-${Math.random()}`, status: "live" });
  return agent.id;
}

describe("webhook endpoint upsert/get", () => {
  it("returns null when no webhook endpoint is registered", async () => {
    const repo = new SqliteRepo(":memory:");
    const agentId = await seedAgent(repo);
    expect(await repo.getWebhookEndpoint(agentId)).toBeNull();
  });

  it("creates a webhook endpoint and reads it back", async () => {
    const repo = new SqliteRepo(":memory:");
    const agentId = await seedAgent(repo);

    const created = await repo.upsertWebhookEndpoint({ agentId, secretHash: "a".repeat(64) });
    expect(created.agentId).toBe(agentId);
    expect(created.secretHash).toBe("a".repeat(64));

    const fetched = await repo.getWebhookEndpoint(agentId);
    expect(fetched?.secretHash).toBe("a".repeat(64));
  });

  it("upserts in place: a second call for the same agent replaces the hash, one row per agent", async () => {
    const repo = new SqliteRepo(":memory:");
    const agentId = await seedAgent(repo);

    await repo.upsertWebhookEndpoint({ agentId, secretHash: "a".repeat(64) });
    await repo.upsertWebhookEndpoint({ agentId, secretHash: "b".repeat(64) });

    const fetched = await repo.getWebhookEndpoint(agentId);
    expect(fetched?.secretHash).toBe("b".repeat(64));
  });

  it("keeps webhook endpoints independent per agent", async () => {
    const repo = new SqliteRepo(":memory:");
    const agentA = await seedAgent(repo);
    const agentB = await seedAgent(repo);

    await repo.upsertWebhookEndpoint({ agentId: agentA, secretHash: "a".repeat(64) });

    expect((await repo.getWebhookEndpoint(agentA))?.secretHash).toBe("a".repeat(64));
    expect(await repo.getWebhookEndpoint(agentB)).toBeNull();
  });
});
