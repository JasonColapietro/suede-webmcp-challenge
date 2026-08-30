/**
 * Guided's real brain is a call against the funded model key, so it needs a
 * workspace entitled to model spend — the platform rule being "has paid at
 * least once". Before this, `runGuidedTurn` selected the real brain purely on
 * `process.env.ANTHROPIC_API_KEY` being set: no entitlement, no quota, no
 * per-IP budget and no usage ledger, on a route whose per-owner rate limit a
 * freshly-minted workspace UUID resets.
 *
 * Guided DEGRADES rather than failing: an unpaid visitor still gets the
 * deterministic interview and can still build and launch a real agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { _resetEligibilityCache } from "@/lib/gateway/eligibility";
import { MODEL_SPEND_USAGE_KIND } from "@/lib/gateway/model-spend";
import { runGuidedTurn } from "@/lib/guided/draft";

const generateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateObject }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => "model-handle" }));

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function pay(repo: SqliteRepo, ownerId: string): Promise<void> {
  await repo.createCredit({ ownerId, deltaUsdc: 5, reason: "topup", tx: `0x${rand()}` });
}

/** One contextual question, as the real brain would answer. */
function modelAsks(question: string, tokens = 1_200): void {
  generateObject.mockResolvedValueOnce({
    object: { clarifyingQuestion: question, manifest: null },
    usage: { totalTokens: tokens },
  });
}

const KEY_BEFORE = process.env.ANTHROPIC_API_KEY;

describe("runGuidedTurn model entitlement", () => {
  beforeEach(() => {
    _resetEligibilityCache();
    generateObject.mockReset();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  afterEach(() => {
    if (KEY_BEFORE === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = KEY_BEFORE;
  });

  it("uses the deterministic brain for a workspace that has never paid, and spends nothing", async () => {
    const repo = makeRepo();
    const owner = `unpaid-${rand()}`;

    const result = await runGuidedTurn("watch a product page", [], undefined, { ownerId: owner, repo });

    expect(result.brain).toBe("fallback");
    expect(generateObject).not.toHaveBeenCalled();
    expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(0);
    // Degraded, not broken: it still answers with a real interview question.
    expect(result.clarifyingQuestion).toBeTruthy();
  });

  it("uses the real brain once the workspace has paid, and books the tokens", async () => {
    const repo = makeRepo();
    const owner = `paid-${rand()}`;
    await pay(repo, owner);
    modelAsks("What URL should I watch, and what's the price threshold?", 1_500);

    const result = await runGuidedTurn("watch a product page", [], undefined, { ownerId: owner, repo });

    expect(result.brain).toBe("model");
    expect(result.clarifyingQuestion).toContain("price threshold");
    expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(1_500);
  });

  it("never spends the key when the caller passes no billing context", async () => {
    const result = await runGuidedTurn("watch a product page", []);

    expect(result.brain).toBe("fallback");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("stays deterministic when no model key is configured, even for a paid workspace", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const repo = makeRepo();
    const owner = `nokey-${rand()}`;
    await pay(repo, owner);

    const result = await runGuidedTurn("watch a product page", [], undefined, { ownerId: owner, repo });

    expect(result.brain).toBe("fallback");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("books the tokens even when the model's object fails to parse", async () => {
    const repo = makeRepo();
    const owner = `garbage-${rand()}`;
    await pay(repo, owner);
    generateObject.mockResolvedValueOnce({
      object: { clarifyingQuestion: null, manifest: { nonsense: true } },
      usage: { totalTokens: 900 },
    });

    const result = await runGuidedTurn("do a thing", [], undefined, { ownerId: owner, repo });

    // Falls back for the ANSWER, but the tokens were still burned and must
    // still be charged.
    expect(result.clarifyingQuestion).toBeTruthy();
    expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(900);
  });

  it("falls back to deterministic when the model call throws, and charges nothing", async () => {
    const repo = makeRepo();
    const owner = `boom-${rand()}`;
    await pay(repo, owner);
    generateObject.mockRejectedValueOnce(new Error("upstream 529"));

    const result = await runGuidedTurn("do a thing", [], undefined, { ownerId: owner, repo });

    expect(result.clarifyingQuestion).toBeTruthy();
    expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(0);
  });
});
