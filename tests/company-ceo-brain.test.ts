/**
 * Tests for the CEO brain (src/lib/company/ceo.ts). Two groups:
 *   1. Fallback brain (no ANTHROPIC_API_KEY): deterministic parsing of
 *      hire/fireEmployee/budget requests, and the confirm/cancel gate
 *      against a pending proposal.
 *   2. Real-brain guard (ANTHROPIC_API_KEY present, "ai" and
 *      "@ai-sdk/anthropic" mocked): an invalid or out-of-catalog proposal,
 *      or one referencing an id outside the given context, must fall back
 *      to the deterministic brain instead of surfacing the bad draft.
 */
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { _resetEligibilityCache } from "@/lib/gateway/eligibility";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CompanyRecord, DepartmentRecord, EmployeeRecord } from "@/lib/company/types";
import type { CeoMessageRecord } from "@/lib/db/repo";

const { generateObjectMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6" }))),
}));

import { runCeoTurn, CeoActionProposalZod, type CeoActionProposal, type CeoCompanyContext } from "@/lib/company/ceo";

/**
 * The real brain now requires a workspace entitled to model spend — "has paid
 * at least once" (src/lib/gateway/model-spend.ts). These guards exercise the
 * real brain, so they must supply a paid billing context; without one the
 * entry point correctly answers from the deterministic brain instead.
 */
async function paidBilling(): Promise<{ ownerId: string; repo: SqliteRepo }> {
  const repo = new SqliteRepo(":memory:");
  const ownerId = `real-brain-${Math.random().toString(36).slice(2, 8)}`;
  await repo.createCredit({ ownerId, deltaUsdc: 5, reason: "topup", tx: `0x${ownerId}` });
  _resetEligibilityCache();
  return { ownerId, repo };
}


const COMPANY: CompanyRecord = {
  id: "company-1",
  ownerId: "owner-1",
  name: "Test Co",
  mission: "Test the CEO brain.",
  status: "active",
  fireCostThresholdUsdc: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const MARKETING: DepartmentRecord = {
  id: "dept-marketing",
  companyId: COMPANY.id,
  name: "Marketing",
  monthlyBudgetUsdc: null,
};

const OPERATIONS: DepartmentRecord = {
  id: "dept-operations",
  companyId: COMPANY.id,
  name: "Operations",
  monthlyBudgetUsdc: 100,
};

const CAMPAIGN_WRITER: EmployeeRecord = {
  agentId: "agent-campaign-writer",
  companyId: COMPANY.id,
  departmentId: MARKETING.id,
  jobDescription: "Writes campaign copy and social posts for every product launch.",
  publishGated: false,
  monthlyBudgetUsdc: null,
  payTo: null,
};

const PROMOTER: EmployeeRecord = {
  agentId: "agent-promoter",
  companyId: COMPANY.id,
  departmentId: MARKETING.id,
  jobDescription: "Publishes approved promotions to the storefront.",
  publishGated: true,
  monthlyBudgetUsdc: null,
  payTo: null,
};

function context(overrides: Partial<CeoCompanyContext> = {}): CeoCompanyContext {
  return {
    company: COMPANY,
    departments: [MARKETING, OPERATIONS],
    employees: [CAMPAIGN_WRITER, PROMOTER],
    ...overrides,
  };
}

function assistantTurnWithProposal(proposal: CeoActionProposal): CeoMessageRecord {
  return {
    id: "msg-assistant-1",
    companyId: COMPANY.id,
    role: "assistant",
    content: "Proposal pending confirmation.",
    proposal,
    createdAt: "2026-01-01T00:01:00.000Z",
  };
}

describe("runCeoTurn — fallback brain (no ANTHROPIC_API_KEY)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    generateObjectMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("proposes a hire in the named department", async () => {
    const result = await runCeoTurn("hire another writer in Marketing", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal?.kind).toBe("hire");
    if (result.proposal?.kind !== "hire") return;
    expect(result.proposal.departmentId).toBe(MARKETING.id);
    expect(CeoActionProposalZod.safeParse(result.proposal).success).toBe(true);
  });

  it("asks which department when none is named", async () => {
    const result = await runCeoTurn("hire someone great", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal).toBeNull();
    expect(result.reply).toMatch(/which department/i);
  });

  it("proposes firing the best-matching employee", async () => {
    const result = await runCeoTurn(
      "fire the person who writes campaign copy and social posts for every product launch",
      [],
      context(),
    );
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal?.kind).toBe("fireEmployee");
    if (result.proposal?.kind !== "fireEmployee") return;
    expect(result.proposal.agentId).toBe(CAMPAIGN_WRITER.agentId);
  });

  it("asks for clarification when no employee matches", async () => {
    const result = await runCeoTurn("fire someone", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal).toBeNull();
  });

  it("proposes a department budget change", async () => {
    const result = await runCeoTurn("bump Marketing's budget to $200", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal?.kind).toBe("budget");
    if (result.proposal?.kind !== "budget") return;
    expect(result.proposal.target).toBe("department");
    expect(result.proposal.targetId).toBe(MARKETING.id);
    expect(result.proposal.monthlyBudgetUsdc).toBe(200);
  });

  it("asks for an amount when none is given", async () => {
    const result = await runCeoTurn("change Marketing's budget", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal).toBeNull();
  });

  it("falls through to the generic reply for unrelated messages", async () => {
    const result = await runCeoTurn("how's the weather", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal).toBeNull();
    expect(result.reply).toMatch(/hire|let someone go|budget/i);
  });

  it("proposes creating a named department with an optional budget", async () => {
    const result = await runCeoTurn("add a Licensing department with a $50 budget", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal?.kind).toBe("createDepartment");
    if (result.proposal?.kind !== "createDepartment") return;
    expect(result.proposal.name).toBe("Licensing");
    expect(result.proposal.monthlyBudgetUsdc).toBe(50);
    expect(CeoActionProposalZod.safeParse(result.proposal).success).toBe(true);
  });

  it("asks for a name when a department request has none", async () => {
    const result = await runCeoTurn("create a new department", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal).toBeNull();
    expect(result.reply).toMatch(/called/i);
  });

  it("refuses to duplicate an existing department name", async () => {
    const result = await runCeoTurn("add a Marketing department", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal).toBeNull();
    expect(result.reply).toMatch(/already exists/i);
  });

  it("executes on an affirmative reply to a pending proposal", async () => {
    const proposal: CeoActionProposal = {
      kind: "fireEmployee",
      agentId: CAMPAIGN_WRITER.agentId,
      employeeSummary: CAMPAIGN_WRITER.jobDescription,
    };
    const history = [assistantTurnWithProposal(proposal)];
    const result = await runCeoTurn("yes", history, context());
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.proposal).toEqual(proposal);
  });

  it("cancels on a negative reply to a pending proposal", async () => {
    const proposal: CeoActionProposal = {
      kind: "fireEmployee",
      agentId: CAMPAIGN_WRITER.agentId,
      employeeSummary: CAMPAIGN_WRITER.jobDescription,
    };
    const history = [assistantTurnWithProposal(proposal)];
    const result = await runCeoTurn("no, don't do that", history, context());
    expect(result.kind).toBe("cancelled");
  });

  it("treats an unrelated reply as a fresh instruction, abandoning the pending proposal", async () => {
    const proposal: CeoActionProposal = {
      kind: "fireEmployee",
      agentId: CAMPAIGN_WRITER.agentId,
      employeeSummary: CAMPAIGN_WRITER.jobDescription,
    };
    const history = [assistantTurnWithProposal(proposal)];
    const result = await runCeoTurn("actually, bump Operations budget to $50", history, context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal?.kind).toBe("budget");
  });

  it("never calls the real LLM brain while ANTHROPIC_API_KEY is unset", async () => {
    await runCeoTurn("hire another writer in Marketing", [], context());
    expect(generateObjectMock).not.toHaveBeenCalled();
  });
});

describe("runCeoTurn — real-brain guard", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    generateObjectMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back deterministically when the proposed hire manifest uses an out-of-catalog node type", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reply: "I'll hire someone.",
        proposal: {
          kind: "hire",
          departmentId: MARKETING.id,
          departmentName: MARKETING.name,
          slug: "bad-hire",
          jobDescription: "Does a thing.",
          monthlyBudgetUsdc: null,
          manifest: {
            manifestVersion: 1,
            name: "Bad Hire",
            description: "Does a thing.",
            triggers: [{ kind: "manual" }],
            steps: [{ id: "n1", type: "totally.unavailable.node", config: {}, after: [] }],
            meta: { createdBy: "guided" },
          },
        },
      },
    });

    const result = await runCeoTurn("hire someone in Marketing", [], context(), await paidBilling());
    expect(generateObjectMock).toHaveBeenCalled();
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    // Deterministic fallback proposes its own valid hire instead of surfacing the bad one.
    expect(result.proposal?.kind).toBe("hire");
    if (result.proposal?.kind !== "hire") return;
    expect(result.proposal.manifest.steps.every((s) => s.type === "llm" || s.type === "output")).toBe(true);
  });

  it("falls back deterministically when the proposal references an id outside the given context", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reply: "Removing them.",
        proposal: {
          kind: "fireEmployee",
          agentId: "agent-does-not-exist",
          employeeSummary: "Ghost employee",
        },
      },
    });

    const result = await runCeoTurn("fire the ghost", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal?.kind === "fireEmployee" ? result.proposal.agentId : null).not.toBe(
      "agent-does-not-exist",
    );
  });

  it("accepts a schema-valid, in-catalog, id-matching proposal (positive control)", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        reply: "I'll set Marketing's monthly budget to $200. Reply yes to confirm.",
        proposal: {
          kind: "budget",
          target: "department",
          targetId: MARKETING.id,
          targetName: MARKETING.name,
          monthlyBudgetUsdc: 200,
        },
      },
    });

    const result = await runCeoTurn("bump Marketing's budget to $200", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal).toEqual({
      kind: "budget",
      target: "department",
      targetId: MARKETING.id,
      targetName: MARKETING.name,
      monthlyBudgetUsdc: 200,
    });
    expect(result.reply).toMatch(/confirm/i);
  });

  it("falls back to the deterministic brain when generateObject throws", async () => {
    generateObjectMock.mockRejectedValue(new Error("network error"));
    const result = await runCeoTurn("hire another writer in Marketing", [], context());
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.proposal?.kind).toBe("hire");
  });
});
