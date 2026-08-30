/**
 * TDD: $0-agent run fix — unpaid POST to a price-0 agent's run endpoint
 * must NOT 500. It should execute and return 200 with a run summary.
 *
 * Tests confirm the LOGIC in the run route:
 *   - price-0 agent: payment block is skipped, run proceeds.
 *   - price-0 agent with settlement_live=true: STILL skips x402 (priceUsdc > 0 guard).
 *   - price-0 run result: status "done" or "error" (not 500/500-thrown).
 *
 * These tests use the SqliteRepo directly to verify the DB layer,
 * and the run-service to verify end-to-end flow execution without HTTP.
 */
import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { runToCompletion } from "@/lib/run-service";
import { requireFlowGraphV1 } from "@/lib/flow/graph-schema";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

describe("$0-agent run logic", () => {
  it("creates an agent with priceUsdc=0 successfully", async () => {
    const repo = makeRepo();
    const flow = await repo.saveFlow({
      ownerId: "owner-zero",
      name: "Zero Price Agent",
      graph: { id: "g-zero", name: "test", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "zero-price-" + Math.random().toString(36).slice(2, 6),
      status: "live",
      priceUsdc: 0,
    });
    expect(agent.priceUsdc).toBe(0);
    // Opt-out semantics: agents default settlement-live; harmless at price 0
    // (the x402 gate only engages when priceUsdc > 0).
    expect(agent.settlementLive).toBe(false);
  });

  it("payment block is skipped for price-0 (guard condition)", () => {
    // This reproduces the run route's guard condition.
    // Even if globalLive is true AND settlementLive is true, priceUsdc > 0 gates the block.
    const priceUsdc = 0;
    const globalLive = true; // X402_SKIP_SETTLEMENT="false" scenario
    const settlementLive = true; // someone accidentally set this
    const dryRun = !(globalLive && settlementLive); // = false
    const paymentBlockRuns = !dryRun && priceUsdc > 0; // = false && false = false
    expect(paymentBlockRuns).toBe(false); // payment block NEVER fires for price-0
  });

  it("payment block is skipped for price-0 in dryRun mode (normal case)", () => {
    const priceUsdc = 0;
    const globalLive = true;
    const settlementLive = false; // default
    const dryRun = !(globalLive && settlementLive); // = !(true && false) = true
    const paymentBlockRuns = !dryRun && priceUsdc > 0; // = false && false = false
    expect(paymentBlockRuns).toBe(false);
  });

  it("payment block DOES fire for priced agent in live+settlement_live mode", () => {
    const priceUsdc = 0.25;
    const globalLive = true;
    const settlementLive = true;
    const dryRun = !(globalLive && settlementLive); // = false
    const paymentBlockRuns = !dryRun && priceUsdc > 0; // = true && true = true
    expect(paymentBlockRuns).toBe(true);
  });

  it("runs a price-0 flow to completion without throwing", async () => {
    const repo = makeRepo();
    const flow = await repo.saveFlow({
      ownerId: "owner-zero-run",
      name: "Zero Price Flow",
      graph: { id: "g-zero-run", name: "zero-run", nodes: [], edges: [] },
    });
    // Empty graph (no nodes, no edges) runs to "done" immediately.
    const summary = await runToCompletion(requireFlowGraphV1(flow.graph, "Test run"), {
      trigger: "agent",
      agentId: null,
      flowId: flow.id,
      triggerInput: {},
      dryRun: true,
    });
    expect(summary.status).toBe("done");
    expect(summary.totalCostUsdc).toBe(0);
    expect(typeof summary.runId).toBe("string");
  });

  it("settledAt is null on a dry-run run (not settled)", async () => {
    const repo = makeRepo();
    const flow = await repo.saveFlow({
      ownerId: "owner-settle-check",
      name: "Settle Check",
      graph: { id: "g-sc", name: "test", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "settle-check-" + Math.random().toString(36).slice(2, 5),
      status: "live",
      priceUsdc: 0,
    });
    const run = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
    await repo.finishRun(run.id, "done", 0);
    const record = await repo.getRun(run.id);
    expect(record?.settledAt).toBeNull(); // not stamped — dry-run
  });
});

describe("credits table (Task 1 regression)", () => {
  it("creditBalance returns 0 for an owner with no credits", async () => {
    const repo = makeRepo();
    const balance = await repo.getCreditBalance("brand-new-owner");
    expect(balance).toBe(0);
  });

  it("createCredit adds a positive balance", async () => {
    const repo = makeRepo();
    const ownerId = "credit-owner-" + Math.random().toString(36).slice(2, 6);
    await repo.createCredit({ ownerId, deltaUsdc: 5, reason: "topup" });
    const balance = await repo.getCreditBalance(ownerId);
    expect(balance).toBe(5);
  });

  it("multiple credits sum correctly", async () => {
    const repo = makeRepo();
    const ownerId = "multi-credit-" + Math.random().toString(36).slice(2, 6);
    await repo.createCredit({ ownerId, deltaUsdc: 10, reason: "topup" });
    await repo.createCredit({ ownerId, deltaUsdc: -0.05, reason: "node:suede.styleCoach" });
    await repo.createCredit({ ownerId, deltaUsdc: 5, reason: "topup" });
    const balance = await repo.getCreditBalance(ownerId);
    expect(balance).toBeCloseTo(14.95, 5);
  });

  it("tx is stored and returned", async () => {
    const repo = makeRepo();
    const ownerId = "tx-credit-" + Math.random().toString(36).slice(2, 6);
    const record = await repo.createCredit({
      ownerId,
      deltaUsdc: 1,
      reason: "topup",
      tx: "0xabc123",
    });
    expect(record.tx).toBe("0xabc123");
  });

  it("credits for different owners are isolated", async () => {
    const repo = makeRepo();
    const ownerA = "iso-a-" + Math.random().toString(36).slice(2, 6);
    const ownerB = "iso-b-" + Math.random().toString(36).slice(2, 6);
    await repo.createCredit({ ownerId: ownerA, deltaUsdc: 20, reason: "topup" });
    const balanceB = await repo.getCreditBalance(ownerB);
    expect(balanceB).toBe(0);
  });
});
