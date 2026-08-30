/**
 * Company's two model paths — the founding interview and the CEO chat — are
 * calls against the funded model key, so each needs a workspace entitled to
 * model spend ("has paid at least once"). Before this, both selected the real
 * brain purely on `process.env.ANTHROPIC_API_KEY` being set: no entitlement,
 * no quota, no per-IP budget, no usage ledger.
 *
 * Both DEGRADE rather than failing: an unpaid workspace still founds a company
 * and still runs it through the deterministic brain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { _resetEligibilityCache } from "@/lib/gateway/eligibility";
import { MODEL_SPEND_USAGE_KIND } from "@/lib/gateway/model-spend";
import { runCompanyGuidedTurn } from "@/lib/company/guided";
import { runCeoTurn } from "@/lib/company/ceo";
import type { CompanyRecord } from "@/lib/company/types";

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

const COMPANY: CompanyRecord = {
  id: "co-1",
  ownerId: "owner",
  name: "Acme",
  mission: "Move things",
  status: "draft",
  fireCostThresholdUsdc: null,
  createdAt: "2026-08-14T00:00:00.000Z",
};

const CEO_CONTEXT = { company: COMPANY, departments: [], employees: [] };

const KEY_BEFORE = process.env.ANTHROPIC_API_KEY;

describe("company model entitlement", () => {
  beforeEach(() => {
    _resetEligibilityCache();
    generateObject.mockReset();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  afterEach(() => {
    if (KEY_BEFORE === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = KEY_BEFORE;
  });

  describe("founding (runCompanyGuidedTurn)", () => {
    it("stays deterministic for a workspace that has never paid, and spends nothing", async () => {
      const repo = makeRepo();
      const owner = `unpaid-${rand()}`;

      const result = await runCompanyGuidedTurn("a moving company", [], { ownerId: owner, repo });

      expect(result.brain).toBe("fallback");
      expect(generateObject).not.toHaveBeenCalled();
      expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(0);
      // Degraded, not broken.
      expect(result.clarifyingQuestion ?? result.company).toBeTruthy();
    });

    it("uses the real brain once the workspace has paid, and books the tokens", async () => {
      const repo = makeRepo();
      const owner = `paid-${rand()}`;
      await pay(repo, owner);
      generateObject.mockResolvedValueOnce({
        object: { clarifyingQuestion: "Which city do you operate in?", company: null, notIncluded: [] },
        usage: { totalTokens: 1_400 },
      });

      const result = await runCompanyGuidedTurn("a moving company", [], { ownerId: owner, repo });

      expect(result.brain).toBe("model");
      expect(result.clarifyingQuestion).toContain("city");
      expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(1_400);
    });

    it("never spends the key when the caller passes no billing context", async () => {
      const result = await runCompanyGuidedTurn("a moving company", []);

      expect(result.brain).toBe("fallback");
      expect(generateObject).not.toHaveBeenCalled();
    });

    it("books the tokens even when the draft is rejected and it falls back", async () => {
      const repo = makeRepo();
      const owner = `reject-${rand()}`;
      await pay(repo, owner);
      generateObject.mockResolvedValueOnce({
        object: { clarifyingQuestion: null, company: { not: "a valid draft" }, notIncluded: [] },
        usage: { totalTokens: 1_100 },
      });

      await runCompanyGuidedTurn("a moving company", [], { ownerId: owner, repo });

      expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(1_100);
    });
  });

  describe("CEO chat (runCeoTurn)", () => {
    it("stays deterministic for a workspace that has never paid, and spends nothing", async () => {
      const repo = makeRepo();
      const owner = `ceo-unpaid-${rand()}`;

      const turn = await runCeoTurn("hire a writer", [], CEO_CONTEXT, { ownerId: owner, repo });

      expect(turn.kind).toBe("response");
      if (turn.kind === "response") expect(turn.brain).toBe("fallback");
      expect(generateObject).not.toHaveBeenCalled();
      expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(0);
    });

    it("uses the real brain once the workspace has paid, and books the tokens", async () => {
      const repo = makeRepo();
      const owner = `ceo-paid-${rand()}`;
      await pay(repo, owner);
      generateObject.mockResolvedValueOnce({
        object: { reply: "Here's what I'd do.", proposal: null },
        usage: { totalTokens: 2_000 },
      });

      const turn = await runCeoTurn("what should we do next", [], CEO_CONTEXT, {
        ownerId: owner,
        repo,
      });

      expect(turn.kind).toBe("response");
      if (turn.kind === "response") {
        expect(turn.brain).toBe("model");
        expect(turn.reply).toContain("what I'd do");
      }
      expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(2_000);
    });

    it("never spends the key when the caller passes no billing context", async () => {
      const turn = await runCeoTurn("hire a writer", [], CEO_CONTEXT);

      expect(turn.kind).toBe("response");
      if (turn.kind === "response") expect(turn.brain).toBe("fallback");
      expect(generateObject).not.toHaveBeenCalled();
    });

    it("books the tokens even when the proposal is rejected and it falls back", async () => {
      const repo = makeRepo();
      const owner = `ceo-reject-${rand()}`;
      await pay(repo, owner);
      generateObject.mockResolvedValueOnce({
        object: { reply: "hiring", proposal: { kind: "nonsense" } },
        usage: { totalTokens: 1_700 },
      });

      await runCeoTurn("hire a writer", [], CEO_CONTEXT, { ownerId: owner, repo });

      expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(1_700);
    });
  });
});
