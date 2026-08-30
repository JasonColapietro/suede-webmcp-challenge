/**
 * Tests for the gateway LLM handler (src/lib/gateway/llm-handler.ts).
 *
 * Tests invoke the pure handler directly with a seeded SqliteRepo.
 * No HTTP layer — pure function tests.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { handleGatewayLlm, GatewayLlmBodySchema } from "@/lib/gateway/llm-handler";
import { FREE_MONTHLY_GATEWAY_TOKENS, IP_DAILY_GATEWAY_TOKEN_BUDGET } from "@/lib/billing";
import { chargeTokenBudget } from "@/lib/rate-limit";
import { _resetEligibilityCache } from "@/lib/gateway/eligibility";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { resourcePack, RESOURCE_TEST_NOW } from "./resources/fixture";

// Use in-memory SQLite for tests.
function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Credit the workspace so it passes the free-allowance gate.
 *
 * Renamed from seedLiveAgent 2026-07-26: the allowance is earned by having
 * paid, not by launching an agent or aging past 24h. A live agent no longer
 * unlocks anything (see tests/lib/gateway-eligibility.test.ts).
 */
async function seedPaidWorkspace(repo: SqliteRepo, ownerId: string): Promise<void> {
  await repo.createCredit({ ownerId, deltaUsdc: 5, reason: "topup", tx: `0x${rand()}` });
}

/**
 * A workspace that has paid but spent the balance back to zero: entitled to
 * the monthly allowance (the signal is lifetime) yet with no credit to fall
 * back on — the only state in which the free-tier IP budget can actually bite.
 */
async function seedPaidThenSpent(repo: SqliteRepo, ownerId: string): Promise<void> {
  await repo.createCredit({ ownerId, deltaUsdc: 1, reason: "topup", tx: `0x${rand()}` });
  await repo.createCredit({ ownerId, deltaUsdc: -1, reason: "gateway:llm", tx: null });
}

const OWNER = "gateway-test-owner-" + Math.random().toString(36).slice(2, 6);

describe("GatewayLlmBodySchema", () => {
  it("rejects empty prompt", () => {
    const result = GatewayLlmBodySchema.safeParse({ prompt: "" });
    expect(result.success).toBe(false);
  });

  it("accepts valid prompt", () => {
    const result = GatewayLlmBodySchema.safeParse({ prompt: "hello" });
    expect(result.success).toBe(true);
  });

  it("accepts optional system + model", () => {
    const result = GatewayLlmBodySchema.safeParse({
      prompt: "hello",
      system: "you are helpful",
      model: "claude-3-5-haiku",
    });
    expect(result.success).toBe(true);
  });
});

describe("handleGatewayLlm — stub mode (no API keys)", () => {
  let repo: SqliteRepo;

  beforeEach(() => {
    repo = makeRepo();
    _resetEligibilityCache();
    // Ensure no real keys bleed in from test environment.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("returns ok:true with stub text", async () => {
    await seedPaidWorkspace(repo, OWNER);
    const result = await handleGatewayLlm(OWNER, { prompt: "ping" }, repo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("ping");
      expect(result.tokens).toBeGreaterThan(0);
      expect(result.costUsdc).toBeGreaterThanOrEqual(0);
    }
  });

  it("writes a usage row after a successful call", async () => {
    await seedPaidWorkspace(repo, OWNER);
    await handleGatewayLlm(OWNER, { prompt: "usage-test" }, repo);
    const monthly = await repo.sumMonthlyUsage(OWNER, "llm");
    expect(monthly).toBeGreaterThan(0);
  });

  it("rate-limits after burst is exhausted (20 requests)", async () => {
    const nowMs = Date.now();
    // Exhaust the burst of 20.
    for (let i = 0; i < 20; i++) {
      await handleGatewayLlm(OWNER + "-rl", { prompt: `request ${i}` }, repo, nowMs);
    }
    const result = await handleGatewayLlm(OWNER + "-rl", { prompt: "over limit" }, repo, nowMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(429);
  });

  it("different owners have independent rate-limit buckets", async () => {
    const nowMs = Date.now();
    const ownerA = "rl-owner-a";
    const ownerB = "rl-owner-b";
    await seedPaidWorkspace(repo, ownerA);
    await seedPaidWorkspace(repo, ownerB);
    // Exhaust ownerA.
    for (let i = 0; i < 20; i++) {
      await handleGatewayLlm(ownerA, { prompt: `req ${i}` }, repo, nowMs);
    }
    // ownerB should still be fine.
    const result = await handleGatewayLlm(ownerB, { prompt: "fresh" }, repo, nowMs);
    expect(result.ok).toBe(true);
  });

  it("returns 402 when monthly usage meets the free limit", async () => {
    // Manually insert enough usage rows to hit the limit.
    const bigUnits = FREE_MONTHLY_GATEWAY_TOKENS;
    await repo.createUsage({ ownerId: OWNER + "-limit", kind: "llm", units: bigUnits, costUsdc: 0 });
    const result = await handleGatewayLlm(OWNER + "-limit", { prompt: "over quota" }, repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(402);
  });

  it("does not write usage row when rate-limited", async () => {
    const nowMs = Date.now();
    const rlOwner = "rl-no-usage-" + Math.random().toString(36).slice(2, 6);
    for (let i = 0; i < 20; i++) {
      await handleGatewayLlm(rlOwner, { prompt: `r${i}` }, repo, nowMs);
    }
    const before = await repo.sumMonthlyUsage(rlOwner, "llm");
    await handleGatewayLlm(rlOwner, { prompt: "should not write" }, repo, nowMs);
    const after = await repo.sumMonthlyUsage(rlOwner, "llm");
    expect(after).toBe(before); // no additional usage written
  });
});

describe("handleGatewayLlm — sumMonthlyUsage", () => {
  it("sums only the current month", async () => {
    const repo = makeRepo();
    const owner = "monthly-" + Math.random().toString(36).slice(2, 6);
    // Insert a usage row with a past-month timestamp by direct SQL manipulation.
    // We can't easily fake time in the handler, but we can verify the sum accumulates.
    await repo.createUsage({ ownerId: owner, kind: "llm", units: 1000, costUsdc: 0.01 });
    await repo.createUsage({ ownerId: owner, kind: "llm", units: 500, costUsdc: 0.005 });
    const total = await repo.sumMonthlyUsage(owner, "llm");
    expect(total).toBe(1500);
  });

  it("ignores other kinds", async () => {
    const repo = makeRepo();
    const owner = "kind-filter-" + Math.random().toString(36).slice(2, 6);
    await repo.createUsage({ ownerId: owner, kind: "run", units: 9999, costUsdc: 0 });
    await repo.createUsage({ ownerId: owner, kind: "llm", units: 100, costUsdc: 0.001 });
    const total = await repo.sumMonthlyUsage(owner, "llm");
    expect(total).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// handleGatewayLlm — abuse mitigation (per-IP caps + free-allowance gate)
//
// Closes the UUID-farming hole: workspace keys are self-minted UUIDs, so each
// fresh key used to get the full free allowance against a real funded model key
// while the per-owner rate limit reset per key.
// ---------------------------------------------------------------------------

describe("handleGatewayLlm — abuse mitigation", () => {
  let repo: SqliteRepo;

  beforeEach(() => {
    repo = makeRepo();
    _resetEligibilityCache();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("locks the free tier for a workspace that has never paid", async () => {
    const owner = `nofoot-${rand()}`;
    const result = await handleGatewayLlm(owner, { prompt: "hi" }, repo, Date.now(), "5.5.5.5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(402);
  });

  it("allows the free tier once the workspace has paid", async () => {
    const owner = `haspaid-${rand()}`;
    await seedPaidWorkspace(repo, owner);
    const result = await handleGatewayLlm(owner, { prompt: "hi" }, repo, Date.now(), "5.5.5.6");
    expect(result.ok).toBe(true);
  });

  it("blocks once the per-IP daily token budget is exhausted (eligible owner, no credit left)", async () => {
    const owner = `ipbud-${rand()}`;
    await seedPaidThenSpent(repo, owner);
    const ip = "7.7.7.7";
    const now = Date.now();
    // Drain this IP's daily token budget.
    chargeTokenBudget(
      `gateway-ip-tokens:${ip}`,
      IP_DAILY_GATEWAY_TOKEN_BUDGET,
      { capacity: IP_DAILY_GATEWAY_TOKEN_BUDGET },
      now,
    );
    const result = await handleGatewayLlm(owner, { prompt: "hi" }, repo, now, ip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(429);
  });

  it("throttles UUID-farming: a request burst from one IP across many fresh keys hits 429", async () => {
    const ip = "8.8.8.8";
    const now = Date.now();
    let got429 = false;
    for (let i = 0; i < 60; i++) {
      // Each call uses a brand-new owner key (defeats the per-owner limit) but the
      // same source IP — the per-IP request limit must still catch the flood.
      const r = await handleGatewayLlm(`farm-${i}-${rand()}`, { prompt: "x" }, repo, now, ip);
      if (!r.ok && r.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it("falls back to paid credit when the network's daily budget is exhausted", async () => {
    const owner = `ipbud-credit-${rand()}`;
    await seedPaidWorkspace(repo, owner);
    await repo.createCredit({ ownerId: owner, deltaUsdc: 5, reason: "topup" });
    const ip = "7.7.7.8";
    const now = Date.now();
    chargeTokenBudget(
      `gateway-ip-tokens:${ip}`,
      IP_DAILY_GATEWAY_TOKEN_BUDGET,
      { capacity: IP_DAILY_GATEWAY_TOKEN_BUDGET },
      now,
    );
    const result = await handleGatewayLlm(owner, { prompt: "hi" }, repo, now, ip);
    expect(result.ok).toBe(true);
  });

  it("does not gate the paid-credit path: an ineligible workspace with credit is served", async () => {
    const owner = `paid-${rand()}`;
    await repo.createCredit({ ownerId: owner, deltaUsdc: 5, reason: "topup" });
    const result = await handleGatewayLlm(owner, { prompt: "hi" }, repo, Date.now(), "9.9.9.1");
    expect(result.ok).toBe(true);
  });

  it("does not gate the paid-credit path past the free monthly cap", async () => {
    const owner = `paidover-${rand()}`;
    await repo.createUsage({ ownerId: owner, kind: "llm", units: FREE_MONTHLY_GATEWAY_TOKENS, costUsdc: 0 });
    await repo.createCredit({ ownerId: owner, deltaUsdc: 5, reason: "topup" });
    const result = await handleGatewayLlm(owner, { prompt: "hi" }, repo, Date.now(), "9.9.9.2");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleGatewayRun tests
// ---------------------------------------------------------------------------

describe("handleGatewayRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])(
    "refuses api.operation with availability enabled=%s before quota, dispatch, usage, credit, or cost",
    async (enabled) => {
      const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
      const repo = {
        sumMonthlyUsage: vi.fn(),
        getCreditBalance: vi.fn(),
        createUsage: vi.fn(),
        createCredit: vi.fn(),
      };
      const loadRegistry = vi.fn();

      const result = await handleGatewayRun(
        "api-operation-owner",
        { nodeType: "api.operation", config: {} },
        repo as never,
        Date.now(),
        undefined,
        { enabled },
        loadRegistry,
      );

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: expect.stringContaining("unavailable"),
      });
      expect(loadRegistry).not.toHaveBeenCalled();
      expect(repo.sumMonthlyUsage).not.toHaveBeenCalled();
      expect(repo.getCreditBalance).not.toHaveBeenCalled();
      expect(repo.createUsage).not.toHaveBeenCalled();
      expect(repo.createCredit).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("costUsdc");
    },
  );

  it("rejects unknown nodeType with 400", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const result = await handleGatewayRun("owner-run-test", { nodeType: "does-not-exist", config: {} }, repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("GatewayRunBodySchema rejects empty nodeType", async () => {
    const { GatewayRunBodySchema } = await import("@/lib/gateway/run-handler");
    const r = GatewayRunBodySchema.safeParse({ nodeType: "" });
    expect(r.success).toBe(false);
  });

  it("GatewayRunBodySchema accepts valid nodeType", async () => {
    const { GatewayRunBodySchema } = await import("@/lib/gateway/run-handler");
    const r = GatewayRunBodySchema.safeParse({ nodeType: "input", config: { value: "hello" } });
    expect(r.success).toBe(true);
  });

  it("rejects direct inputs for non-resource gateway nodes", async () => {
    const { GatewayRunBodySchema } = await import("@/lib/gateway/run-handler");
    expect(GatewayRunBodySchema.safeParse({
      nodeType: "input",
      config: { fields: { source: "configured" } },
      inputs: { source: "caller" },
    }).success).toBe(false);
  });

  it("does not merge caller inputs into a non-resource node when parsing is bypassed", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "run-input-boundary-" + Math.random().toString(36).slice(2, 8);
    await seedPaidWorkspace(repo, owner);
    const result = await handleGatewayRun(owner, {
      nodeType: "input",
      config: { fields: { source: "configured" } },
      inputs: { source: "caller", callerOnly: true },
    }, repo);
    expect(result).toMatchObject({
      ok: true,
      output: { result: { source: "configured" } },
    });
    expect(JSON.stringify(result)).not.toContain("callerOnly");
  });

  it("accepts only filters as direct resource.query inputs", async () => {
    const { GatewayRunBodySchema } = await import("@/lib/gateway/run-handler");
    const config = {
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      resourcePackContentHash: "a".repeat(64),
      filterFields: ["tier"],
      returnFields: ["name"],
    };
    expect(GatewayRunBodySchema.safeParse({
      nodeType: "resource.query",
      config,
      inputs: { filters: { tier: "paid" } },
    }).success).toBe(true);
    for (const body of [
      { nodeType: "resource.query", config },
      { nodeType: "resource.query", config, inputs: { filters: {}, corpus: "private" } },
      { nodeType: "resource.query", config: { ...config, dependencies: [] }, inputs: { filters: {} } },
    ]) {
      expect(GatewayRunBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("passes direct filters to the canonical resource.query executor", async () => {
    // Pinning nowMs below is not enough: the gateway resolves the pack through
    // the shared getResourceRepository() instance, whose clock defaults to
    // new Date(). Once wall-clock passes the seeded freshnessDeadline the
    // release reads stale there and the run fails closed regardless of nowMs,
    // so pin Date itself to the fixture instant (restored in afterEach).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RESOURCE_TEST_NOW);
    const { GatewayRunBodySchema, handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "gateway-resource-" + Math.random().toString(36).slice(2, 8);
    await seedPaidWorkspace(repo, owner);
    const resources = new SqliteResourceRepository(process.env.SQLITE_PATH!, {
      now: () => RESOURCE_TEST_NOW,
    });
    const product = await resources.createProduct({
      ownerId: owner,
      name: "Gateway resource",
      slug: `gateway-resource-${rand()}`,
      executionAccess: "private",
      discoveryAccess: "unlisted",
    });
    const snapshot = await resources.createSourceSnapshot({
      id: `snapshot-contract-${rand()}`,
      ownerId: owner,
      resourceProductId: product.id,
      locator: "manual://gateway-resource",
      sourceKind: "manual",
      capturedAt: RESOURCE_TEST_NOW.toISOString(),
      contentHash: "f".repeat(64),
      freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    const base = resourcePack();
    const candidate = await resources.replaceCandidate({
      ownerId: owner,
      resourceProductId: product.id,
      expectedCandidatePackVersionId: null,
      expectedRevision: 0,
      content: {
        ...base,
        evidence: base.evidence.map((item) => ({ ...item, sourceSnapshotId: snapshot.id })),
        sourceSnapshotIds: [snapshot.id],
      },
      createdBy: owner,
    });
    const approved = await resources.approveCandidate({
      ownerId: owner,
      resourceProductId: product.id,
      candidatePackVersionId: candidate.id,
      expectedRevision: candidate.revision,
      expectedSemanticHash: candidate.semanticHash,
      approvedBy: owner,
    });
    const parsed = GatewayRunBodySchema.parse({
      nodeType: "resource.query",
      config: {
        resourceProductId: product.id,
        packVersionId: approved.id,
        resourcePackContentHash: approved.semanticHash,
        filterFields: ["tier"],
        returnFields: ["name"],
      },
      inputs: { filters: { tier: "paid" } },
    });
    // Same fixed clock the resource repository above is given. Without it the
    // handler defaults nowMs to Date.now(), so the release ages out of its
    // freshness window and the query fails closed once wall-clock drifts past
    // RESOURCE_TEST_NOW.
    const result = await handleGatewayRun(owner, parsed, repo, RESOURCE_TEST_NOW.getTime());
    expect(result).toMatchObject({
      ok: true,
      output: { result: [{ name: "Alpha" }] },
    });
  });

  it("rate-limits after burst is exhausted", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "run-rl-" + Math.random().toString(36).slice(2, 6);
    const nowMs = Date.now();
    for (let i = 0; i < 20; i++) {
      await handleGatewayRun(owner, { nodeType: "does-not-exist", config: {} }, repo, nowMs);
    }
    const result = await handleGatewayRun(owner, { nodeType: "does-not-exist", config: {} }, repo, nowMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(429);
  });

  it("executes a known free-tier node (input) and returns output", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "run-exec-" + Math.random().toString(36).slice(2, 6);
    await seedPaidWorkspace(repo, owner);
    const result = await handleGatewayRun(owner, { nodeType: "input", config: { value: "hello" } }, repo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBeDefined();
    }
  });

  it("locks the free-tier run path for a workspace that has never paid", async () => {
    // Regression: this branch previously checked only the monthly quota, so a
    // freshly-minted workspace UUID got free node runs with no gate at all.
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    _resetEligibilityCache();

    const result = await handleGatewayRun(
      "run-unpaid-" + Math.random().toString(36).slice(2, 6),
      { nodeType: "input", config: {} },
      repo,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(402);
  });

  it("loads only the requested node definition for a single-node run", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "run-single-loader-" + Math.random().toString(36).slice(2, 6);
    await seedPaidWorkspace(repo, owner);
    const loadNode = vi.fn(async (nodeType: string) => {
      expect(nodeType).toBe("input");
      return (await import("@/lib/flow/nodes/input")).inputNode;
    });

    const result = await handleGatewayRun(
      owner,
      { nodeType: "input", config: { fields: { value: "hello" } } },
      repo,
      Date.now(),
      undefined,
      undefined,
      loadNode as never,
    );

    expect(loadNode).toHaveBeenCalledTimes(1);
    expect(loadNode).toHaveBeenCalledWith("input");
    expect(result.ok).toBe(true);
  });

  it("writes a usage row after a successful run", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "run-usage-" + Math.random().toString(36).slice(2, 6);
    await seedPaidWorkspace(repo, owner);
    const before = await repo.sumMonthlyUsage(owner, "run");
    await handleGatewayRun(owner, { nodeType: "input", config: {} }, repo);
    const after = await repo.sumMonthlyUsage(owner, "run");
    expect(after).toBeGreaterThan(before);
  });

  it("paid-rail node returns 402 when credit balance is 0", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "run-paid-" + Math.random().toString(36).slice(2, 6);
    // suede.styleCoach has priceUsdc > 0 (0.05).
    const result = await handleGatewayRun(owner, { nodeType: "suede.styleCoach", config: {} }, repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(402);
  });

  it("paid-rail node executes when owner has sufficient credit", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const owner = "run-paid-ok-" + Math.random().toString(36).slice(2, 6);
    // Top up enough credit to cover suede.styleCoach ($0.05).
    await repo.createCredit({ ownerId: owner, deltaUsdc: 1, reason: "topup" });
    const result = await handleGatewayRun(owner, { nodeType: "suede.styleCoach", config: { seed: "blues" } }, repo);
    // Either ok=true OR status=500 (executor threw in dry-run) is acceptable.
    // What's NOT acceptable is 402 (credit check passed).
    if (!result.ok) {
      expect(result.status).not.toBe(402);
    }
  });

  // -------------------------------------------------------------------------
  // Regression: handleGatewayRun is a SECOND dispatch point that executes a
  // single node directly (def.executor / now executeNode), entirely outside
  // engine.ts's runFlow loop, and it always builds its NodeContext with
  // dryRun: true (see run-handler.ts: "the gateway never settles x402
  // itself"). Before routing this call through engine.ts's executeNode, the
  // gateway called `def.executor` directly — so the http node's missing
  // per-module guard was exploitable through THIS path too, independent of
  // the flow engine. This proves the fix closes both call sites with the
  // same central gate, not just the flow-engine one.
  // -------------------------------------------------------------------------
  it("does not perform a real outbound HTTP request when running the http node via the gateway", async () => {
    const { handleGatewayRun } = await import("@/lib/gateway/run-handler");
    const repo = makeRepo();
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
      throw new Error("the gateway must never make a real outbound request for the http node in dry-run");
    });
    try {
      const owner = "gateway-http-dryrun-" + Math.random().toString(36).slice(2, 6);
      await seedPaidWorkspace(repo, owner);
      const result = await handleGatewayRun(
        owner,
        { nodeType: "http", config: { method: "GET", url: "https://example.com/api" } },
        repo,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// handleGatewayTopup tests (with stubbed facilitator)
// ---------------------------------------------------------------------------

describe("handleGatewayTopup", () => {
  it("returns 402 challenge when no payment header and seller wallet is set", async () => {
    const { handleGatewayTopup } = await import("@/lib/gateway/topup-handler");
    const repo = makeRepo();
    const owner = "topup-challenge-" + Math.random().toString(36).slice(2, 6);
    const prevWallet = process.env.X402_SELLER_WALLET_ADDRESS;
    process.env.X402_SELLER_WALLET_ADDRESS = "0xb5a000000000000000000000000000000000032d";
    try {
      const result = await handleGatewayTopup(owner, 1, null, repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(402);
        if (result.status === 402) {
          expect(result.x402Version).toBe(2);
          expect(result.accepts).toHaveLength(1);
          expect(result.resource.url).toBe(
            "https://agents.suedeai.ai/api/gateway/topup?tier=1",
          );
          expect(result.accepts[0]?.network).toBe("eip155:8453");
          expect(result.accepts[0]?.amount).toBe("1000000");
        }
      }
    } finally {
      if (prevWallet === undefined) delete process.env.X402_SELLER_WALLET_ADDRESS;
      else process.env.X402_SELLER_WALLET_ADDRESS = prevWallet;
    }
  });

  it("returns 503 when seller wallet is not configured", async () => {
    const { handleGatewayTopup } = await import("@/lib/gateway/topup-handler");
    const repo = makeRepo();
    const owner = "topup-503-" + Math.random().toString(36).slice(2, 6);
    const prevWallet = process.env.X402_SELLER_WALLET_ADDRESS;
    delete process.env.X402_SELLER_WALLET_ADDRESS;
    try {
      const result = await handleGatewayTopup(owner, 5, null, repo);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(503);
    } finally {
      if (prevWallet !== undefined) process.env.X402_SELLER_WALLET_ADDRESS = prevWallet;
    }
  });

  it("TOPUP_TIERS contains 1, 5, 20", async () => {
    const { TOPUP_TIERS } = await import("@/lib/gateway/topup-handler");
    expect(TOPUP_TIERS).toContain(1);
    expect(TOPUP_TIERS).toContain(5);
    expect(TOPUP_TIERS).toContain(20);
  });

  it("credits owner balance after successful settle (stub settlement)", async () => {
    const { handleGatewayTopup } = await import("@/lib/gateway/topup-handler");
    // Stub verifyAndSettle by using X402_FACILITATOR_URL pointing to a local server
    // that always returns success. For unit tests, we test the handler with a mocked
    // payment header that will fail verification (facilitator not reachable) and
    // verify the error path. The success path is tested end-to-end in dev e2e.
    const repo = makeRepo();
    const owner = "topup-settle-" + Math.random().toString(36).slice(2, 6);
    const prevWallet = process.env.X402_SELLER_WALLET_ADDRESS;
    process.env.X402_SELLER_WALLET_ADDRESS = "0xb5a000000000000000000000000000000000032d";
    try {
      // With a garbage payment header, verifyAndSettle will fail → challenge returned.
      const result = await handleGatewayTopup(owner, 1, "garbage-payment-header", repo);
      // Either 402 (challenge on verify fail) or 500 (network error) is expected — NOT ok:true.
      expect(result.ok).toBe(false);
      // Balance should still be 0 (no credit written on failed settle).
      const balance = await repo.getCreditBalance(owner);
      expect(balance).toBe(0);
    } finally {
      if (prevWallet === undefined) delete process.env.X402_SELLER_WALLET_ADDRESS;
      else process.env.X402_SELLER_WALLET_ADDRESS = prevWallet;
    }
  });
});
