/**
 * Tests for settlement toggle (src/lib/cli/settlement-handler.ts)
 * and the settlement gate in the run route.
 *
 * Verifies:
 * - Toggle flips settlement_live for agent owned by caller.
 * - Toggle returns not_owner for wrong owner.
 * - Toggle returns not_found for unknown agent.
 * - settlement_live defaults to FALSE for NEW agents (2026-07-20): a fresh
 *   launch cannot settle real money until the owner opts in. Pre-existing
 *   NULL rows still read as LIVE (Phase 9 migration safety).
 * - Run route settles only after the owner opts in with live: true.
 * - The deploy baseline keeps BOTH settlement_live defaults (2026-07-26):
 *   TRUE at ADD time (backfill safety) and FALSE ongoing (money safety).
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import {
  handleSettlementToggle,
} from "@/lib/cli/settlement-handler";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

async function seedAgent(repo: SqliteRepo, ownerId: string): Promise<{
  flowId: string;
  agentId: string;
  slug: string;
}> {
  const flow = await repo.saveFlow({
    ownerId,
    name: "Settlement Test Flow",
    graph: { id: "g-settle-test", name: "test", nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: "settlement-test-" + Math.random().toString(36).slice(2, 6),
    status: "live",
    priceUsdc: 0.25,
  });
  return { flowId: flow.id, agentId: agent.id, slug: agent.slug };
}

describe("handleSettlementToggle", () => {
  let repo: SqliteRepo;
  const OWNER = "settle-owner-" + Math.random().toString(36).slice(2, 6);
  const OTHER = "settle-other-" + Math.random().toString(36).slice(2, 6);

  beforeEach(() => {
    repo = makeRepo();
  });

  it("new agents default to settlement_live=false (owner opts in)", async () => {
    const { agentId } = await seedAgent(repo, OWNER);
    const agent = await repo.getAgent(agentId);
    expect(agent?.settlementLive).toBe(false);
  });

  it("owner can flip settlement_live to true by slug", async () => {
    const { slug } = await seedAgent(repo, OWNER);
    const result = await handleSettlementToggle(slug, OWNER, { live: true }, repo);
    expect(result).not.toHaveProperty("kind");
    if (!("kind" in result)) {
      expect(result.settlementLive).toBe(true);
    }
  });

  it("owner can flip settlement_live to true by id", async () => {
    const { agentId } = await seedAgent(repo, OWNER);
    const result = await handleSettlementToggle(agentId, OWNER, { live: true }, repo);
    expect(result).not.toHaveProperty("kind");
    if (!("kind" in result)) {
      expect(result.settlementLive).toBe(true);
    }
  });

  it("owner can flip settlement_live back to false", async () => {
    const { slug } = await seedAgent(repo, OWNER);
    await handleSettlementToggle(slug, OWNER, { live: true }, repo);
    const result = await handleSettlementToggle(slug, OWNER, { live: false }, repo);
    expect(result).not.toHaveProperty("kind");
    if (!("kind" in result)) {
      expect(result.settlementLive).toBe(false);
    }
  });

  it("wrong owner returns not_owner", async () => {
    const { slug } = await seedAgent(repo, OWNER);
    const result = await handleSettlementToggle(slug, OTHER, { live: true }, repo);
    expect(result).toMatchObject({ kind: "not_owner" });
  });

  it("unknown slug returns not_found", async () => {
    const result = await handleSettlementToggle("does-not-exist", OWNER, { live: true }, repo);
    expect(result).toMatchObject({ kind: "not_found" });
  });

  it("flip is durable — getAgent returns updated value", async () => {
    const { agentId } = await seedAgent(repo, OWNER);
    await handleSettlementToggle(agentId, OWNER, { live: true }, repo);
    const agent = await repo.getAgent(agentId);
    expect(agent?.settlementLive).toBe(true);
  });
});

describe("settlement_live gate in run path", () => {
  it("settlement is skipped for a new agent by default", async () => {
    const repo = makeRepo();
    const ownerId = "settle-run-" + Math.random().toString(36).slice(2, 6);
    const flow = await repo.saveFlow({
      ownerId,
      name: "Settle Gate Test",
      graph: { id: "g-sg", name: "test", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "settle-gate-" + Math.random().toString(36).slice(2, 6),
      status: "live",
      priceUsdc: 0.1,
    });
    // Default: settlementLive is FALSE for new agents (owner opts in).
    expect(agent.settlementLive).toBe(false);

    // Run route logic: settle iff globalLive AND agent.settlementLive.
    const globalLive = true; // simulating X402_SKIP_SETTLEMENT === "false"
    const shouldSettle = globalLive && agent.settlementLive;
    expect(shouldSettle).toBe(false); // default-off wins until the owner opts in
  });

  it("settlement IS triggered after the owner opts in and X402_SKIP_SETTLEMENT=false", async () => {
    const repo = makeRepo();
    const ownerId = "settle-run2-" + Math.random().toString(36).slice(2, 6);
    const flow = await repo.saveFlow({
      ownerId,
      name: "Settle Gate ON",
      graph: { id: "g-sg2", name: "test", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "settle-gate-on-" + Math.random().toString(36).slice(2, 6),
      status: "live",
      priceUsdc: 0.1,
    });
    // Owner opts in to live settlement.
    await repo.updateAgent(agent.id, { settlementLive: true });
    const updated = await repo.getAgent(agent.id);
    expect(updated?.settlementLive).toBe(true);

    const prevEnv = process.env.X402_SKIP_SETTLEMENT;
    process.env.X402_SKIP_SETTLEMENT = "false";
    try {
      const globalLive = process.env.X402_SKIP_SETTLEMENT === "false";
      const shouldSettle = globalLive && (updated?.settlementLive ?? false);
      expect(shouldSettle).toBe(true);
    } finally {
      if (prevEnv === undefined) delete process.env.X402_SKIP_SETTLEMENT;
      else process.env.X402_SKIP_SETTLEMENT = prevEnv;
    }
  });

  it("stampRunSettled writes settledAt on a run", async () => {
    const repo = makeRepo();
    const ownerId = "stamp-test";
    const flow = await repo.saveFlow({
      ownerId,
      name: "Stamp Test",
      graph: { id: "g-stamp", name: "t", nodes: [], edges: [] },
    });
    const run = await repo.createRun({ flowId: flow.id, trigger: "agent" });
    await repo.finishRun(run.id, "done", 0.1);

    const before = await repo.getRun(run.id);
    expect(before?.settledAt).toBeNull();

    const settledAt = new Date().toISOString();
    await repo.stampRunSettled(run.id, settledAt);
    const after = await repo.getRun(run.id);
    expect(after?.settledAt).toBe(settledAt);
  });

  it("countSettledRunsByAgent counts only settled runs", async () => {
    const repo = makeRepo();
    const ownerId = "count-settled";
    const flow = await repo.saveFlow({
      ownerId,
      name: "Count Test",
      graph: { id: "g-count", name: "t", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({ flowId: flow.id, slug: "count-" + Math.random().toString(36).slice(2, 5), status: "live", priceUsdc: 0.1 });

    // Create 3 runs — settle 2 of them.
    const run1 = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
    const run2 = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
    const run3 = await repo.createRun({ flowId: flow.id, agentId: agent.id, trigger: "agent" });
    await repo.finishRun(run1.id, "done", 0);
    await repo.finishRun(run2.id, "done", 0);
    await repo.finishRun(run3.id, "done", 0);
    await repo.stampRunSettled(run1.id, new Date().toISOString());
    await repo.stampRunSettled(run2.id, new Date().toISOString());
    // run3 not settled

    const counts = await repo.countSettledRunsByAgent([agent.id]);
    expect(counts[agent.id]).toBe(2);
  });
});

/**
 * The two settlement_live column defaults protect against OPPOSITE failures
 * and the deploy baseline must keep both. Neither has a runtime surface a
 * unit test can exercise — createAgent always writes the column explicitly,
 * so a default is only ever reached by an insert path that omits it — which
 * is exactly why they are pinned here.
 */
describe("settlement_live column defaults in the deploy baseline", () => {
  const schema = readFileSync("src/lib/db/schema.deploy.sql", "utf8")
    .replace(/\s+/gu, " ")
    .toLowerCase();

  it("adds the column with default TRUE so rows predating it backfill LIVE", () => {
    // Phase 9 SETTLEMENT-GATE HOTFIX: prod ran live before this column
    // existed. Adding it with a false default would silently make every
    // pre-existing priced agent free to call.
    expect(schema).toContain(
      "alter table agents add column if not exists settlement_live boolean not null default true;",
    );
  });

  it("sets the ongoing default to FALSE so a later insert cannot mint a live agent", () => {
    // Without this, the "a fresh launch cannot settle real money" guarantee
    // lives only in createAgent() while the column default says the opposite.
    // Three agents created 2026-07-20 20:17 UTC hit exactly that gap.
    expect(schema).toContain("alter table agents alter column settlement_live set default false;");
  });

  it("orders them so the backfill runs before the ongoing default takes effect", () => {
    // Reversed, the ADD would re-establish default true and undo the fix on
    // any database where the column does not exist yet.
    const addAt = schema.indexOf("add column if not exists settlement_live");
    const setAt = schema.indexOf("alter column settlement_live set default false");
    expect(addAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(addAt);
  });
});
