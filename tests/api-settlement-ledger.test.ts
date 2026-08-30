/**
 * Tests for the settlements ledger (recordSettlement / getSettlementByRun).
 *
 * The ledger records what ACTUALLY routed on-chain per settled call — see
 * SettlementRecord in src/lib/db/repo.ts. Verifies:
 * - Roundtrip: a recorded settlement reads back with identical facts.
 * - Idempotency: a repeat recordSettlement for the same run is a no-op
 *   (first write wins — settlement facts are immutable once recorded).
 * - Platform-fallback settlements record the full gross to the platform.
 * - Unknown run ids return null.
 */

import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

const CREATOR_WALLET = "0x1111111111111111111111111111111111111111";
const PLATFORM_WALLET = "0x2222222222222222222222222222222222222222";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

async function seedRun(repo: SqliteRepo, ownerId: string): Promise<{ runId: string; agentId: string }> {
  const flow = await repo.saveFlow({
    ownerId,
    name: "Ledger Test Flow",
    graph: { id: "g-ledger-test", name: "test", nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: "ledger-test-" + Math.random().toString(36).slice(2, 6),
    status: "live",
    priceUsdc: 0.25,
  });
  const run = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
  await repo.finishRun(run.id, "done", 0);
  return { runId: run.id, agentId: agent.id };
}

describe("settlements ledger", () => {
  it("records and reads back a creator-routed settlement", async () => {
    const repo = makeRepo();
    const { runId, agentId } = await seedRun(repo, "ledger-owner-1");

    await repo.recordSettlement({
      runId,
      agentId,
      ownerId: "ledger-owner-1",
      grossUsdc: 0.25,
      creatorUsdc: 0.25,
      platformUsdc: 0,
      payTo: CREATOR_WALLET,
      payoutSource: "creator",
      payer: "0x3333333333333333333333333333333333333333",
      tx: "0xabc",
    });

    const row = await repo.getSettlementByRun(runId);
    expect(row).not.toBeNull();
    expect(row?.agentId).toBe(agentId);
    expect(row?.ownerId).toBe("ledger-owner-1");
    expect(row?.grossUsdc).toBe(0.25);
    expect(row?.creatorUsdc).toBe(0.25);
    expect(row?.platformUsdc).toBe(0);
    expect(row?.payTo).toBe(CREATOR_WALLET);
    expect(row?.payoutSource).toBe("creator");
    expect(row?.payer).toBe("0x3333333333333333333333333333333333333333");
    expect(row?.tx).toBe("0xabc");
    expect(row?.createdAt).toBeTruthy();
  });

  it("is idempotent on runId — the first write wins", async () => {
    const repo = makeRepo();
    const { runId, agentId } = await seedRun(repo, "ledger-owner-2");

    const base = {
      runId,
      agentId,
      ownerId: "ledger-owner-2",
      grossUsdc: 0.25,
      creatorUsdc: 0.25,
      platformUsdc: 0,
      payTo: CREATOR_WALLET,
      payoutSource: "creator" as const,
      payer: null,
      tx: "0xfirst",
    };
    await repo.recordSettlement(base);
    await repo.recordSettlement({ ...base, grossUsdc: 99, tx: "0xsecond" });

    const row = await repo.getSettlementByRun(runId);
    expect(row?.grossUsdc).toBe(0.25);
    expect(row?.tx).toBe("0xfirst");
  });

  it("records a platform-fallback settlement as full gross to the platform", async () => {
    const repo = makeRepo();
    const { runId, agentId } = await seedRun(repo, "ledger-owner-3");

    await repo.recordSettlement({
      runId,
      agentId,
      ownerId: "ledger-owner-3",
      grossUsdc: 0.1,
      creatorUsdc: 0,
      platformUsdc: 0.1,
      payTo: PLATFORM_WALLET,
      payoutSource: "platform",
      payer: null,
      tx: null,
    });

    const row = await repo.getSettlementByRun(runId);
    expect(row?.creatorUsdc).toBe(0);
    expect(row?.platformUsdc).toBe(0.1);
    expect(row?.payoutSource).toBe("platform");
    expect(row?.payer).toBeNull();
    expect(row?.tx).toBeNull();
  });

  it("returns null for a run with no settlement row", async () => {
    const repo = makeRepo();
    const { runId } = await seedRun(repo, "ledger-owner-4");
    expect(await repo.getSettlementByRun(runId)).toBeNull();
    expect(await repo.getSettlementByRun("no-such-run")).toBeNull();
  });
});
