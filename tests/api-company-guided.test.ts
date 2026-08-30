/**
 * Tests for the company guided brain (src/lib/company/guided.ts) — the
 * description-first founding path mirrored from src/lib/guided/draft.ts at
 * company scope.
 *
 * Two groups:
 *   1. Fallback brain (ANTHROPIC_API_KEY absent): deterministic slot walk
 *      against COMPANY_TEMPLATES — asks name, then departments, then drafts.
 *   2. Real-brain manifest-validation guard (ANTHROPIC_API_KEY present,
 *      "ai" and "@ai-sdk/anthropic" mocked): any invalid or
 *      out-of-catalog employee manifest must fall back to the deterministic
 *      brain instead of surfacing the bad draft.
 */

import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { _resetEligibilityCache } from "@/lib/gateway/eligibility";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { MAX_COMPANY_DRAFT_EMPLOYEES } from "@/lib/company/draft-limits";

const { generateObjectMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6" }))),
}));

import {
  runCompanyGuidedTurn,
  CompanyDraftZod,
  CompanyGuidedResponseSchema,
  type CompanyGuidedResponse,
} from "@/lib/company/guided";
import type { ConversationTurn } from "@/lib/guided/draft";

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


// Prompt heavily overlaps rights-precheck-shop's slug/name/mission/pitch
// ("precheck", "split", "sheet", "paperwork", "release", "teams") and
// shares nothing distinctive with the other three templates, so the
// word-overlap matcher picks it deterministically.
const RIGHTS_PROMPT = "I need rights precheck and split-sheet paperwork for release teams";

function draftWithEmployeeCount(employeeCount: number): unknown {
  const template = COMPANY_TEMPLATES[0]!;
  const sourceDepartment = template.departments[0]!;
  const sourceEmployee = sourceDepartment.employees[0]!;
  const departments = Array.from(
    { length: Math.ceil(employeeCount / 16) },
    (_, departmentIndex) => ({
      name: `Department ${departmentIndex + 1}`,
      monthlyBudgetUsdc: null,
      employees: Array.from(
        { length: Math.min(16, employeeCount - departmentIndex * 16) },
        (_, employeeIndex) => {
          const sequence = departmentIndex * 16 + employeeIndex + 1;
          return {
            slug: `employee-${sequence}`,
            jobDescription: `Employee ${sequence}`,
            monthlyBudgetUsdc: null,
            publishGated: false,
            manifest: sourceEmployee.manifest,
          };
        },
      ),
    }),
  );
  return {
    name: "Bounded Company",
    mission: "Exercise the total employee boundary.",
    departments,
  };
}

describe("CompanyDraftZod — total employee limit", () => {
  it("accepts exactly the total employee limit", () => {
    expect(CompanyDraftZod.safeParse(draftWithEmployeeCount(MAX_COMPANY_DRAFT_EMPLOYEES)).success)
      .toBe(true);
  });

  it("rejects one employee above the total limit across departments", () => {
    const parsed = CompanyDraftZod.safeParse(
      draftWithEmployeeCount(MAX_COMPANY_DRAFT_EMPLOYEES + 1),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({
        message: `Company drafts may include at most ${MAX_COMPANY_DRAFT_EMPLOYEES} employees total`,
        path: ["departments"],
      }),
    );
  });
});

/** Walk N turns of conversation through the guided brain, like a real client would. */
async function simulateCompany(messages: string[]): Promise<CompanyGuidedResponse[]> {
  const history: ConversationTurn[] = [];
  const responses: CompanyGuidedResponse[] = [];
  for (const message of messages) {
    const res = await runCompanyGuidedTurn(message, history);
    responses.push(res);
    history.push({ role: "user", content: message });
    if (res.clarifyingQuestion !== null) {
      history.push({ role: "assistant", content: res.clarifyingQuestion });
    }
  }
  return responses;
}

describe("runCompanyGuidedTurn — fallback brain (no ANTHROPIC_API_KEY)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    generateObjectMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("turn 1 asks for the company name", async () => {
    const res = await runCompanyGuidedTurn(RIGHTS_PROMPT, []);
    expect(res.clarifyingQuestion).toBe("What would you like to name this company?");
    expect(res.company).toBeNull();
    expect(res.notIncluded).toEqual([]);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("turn 2 asks which departments to keep", async () => {
    const responses = await simulateCompany([RIGHTS_PROMPT, "Precheck Collective"]);
    const second = responses[1]!;
    expect(second.clarifyingQuestion).toBe(
      "Keep all departments, or only some? (name them, or say all)",
    );
    expect(second.company).toBeNull();
    expect(second.notIncluded).toEqual([]);
  });

  it("turn 3 drafts the company, applying the chosen name", async () => {
    const responses = await simulateCompany([RIGHTS_PROMPT, "Precheck Collective", "all"]);
    const third = responses[2]!;
    expect(third.clarifyingQuestion).toBeNull();
    expect(third.company).not.toBeNull();
    expect(third.company!.name).toBe("Precheck Collective");
    expect(third.notIncluded).toEqual([]);
  });

  it("drafted company matches the matched template's department/employee shape", async () => {
    const responses = await simulateCompany([RIGHTS_PROMPT, "Precheck Collective", "all"]);
    const draft = responses[2]!.company!;
    const matched = COMPANY_TEMPLATES.find((t) => t.slug === "rights-precheck-shop")!;

    expect(draft.mission).toBe(matched.mission);
    expect(draft.departments).toHaveLength(matched.departments.length);
    expect(draft.departments.map((d) => d.name)).toEqual(matched.departments.map((d) => d.name));
    for (let i = 0; i < matched.departments.length; i++) {
      const draftDept = draft.departments[i]!;
      const templateDept = matched.departments[i]!;
      expect(draftDept.monthlyBudgetUsdc).toBe(templateDept.monthlyBudgetUsdc);
      expect(draftDept.employees.map((e) => e.slug)).toEqual(
        templateDept.employees.map((e) => e.slug),
      );
      expect(draftDept.employees.map((e) => e.monthlyBudgetUsdc)).toEqual(
        templateDept.employees.map((e) => e.monthlyBudgetUsdc ?? null),
      );
      expect(draftDept.employees.map((e) => e.publishGated)).toEqual(
        templateDept.employees.map((e) => e.publishGated ?? false),
      );
    }
  });

  it("filters departments to the named subset (case-insensitive substring match)", async () => {
    const responses = await simulateCompany([
      RIGHTS_PROMPT,
      "Precheck Collective",
      "just marketing please",
    ]);
    const draft = responses[2]!.company!;
    expect(draft.departments.map((d) => d.name)).toEqual(["Marketing"]);
  });

  it("matching is case-insensitive and works for the other department too", async () => {
    const responses = await simulateCompany([
      RIGHTS_PROMPT,
      "Precheck Collective",
      "OPERATIONS only",
    ]);
    const draft = responses[2]!.company!;
    expect(draft.departments.map((d) => d.name)).toEqual(["Operations"]);
  });

  it("keeps all departments when the answer names no recognizable department", async () => {
    const responses = await simulateCompany([
      RIGHTS_PROMPT,
      "Precheck Collective",
      "banana pancake",
    ]);
    const draft = responses[2]!.company!;
    const matched = COMPANY_TEMPLATES.find((t) => t.slug === "rights-precheck-shop")!;
    expect(draft.departments).toHaveLength(matched.departments.length);
  });

  it("keeps all departments when the answer says 'all'", async () => {
    const responses = await simulateCompany([RIGHTS_PROMPT, "Precheck Collective", "keep all"]);
    const draft = responses[2]!.company!;
    const matched = COMPANY_TEMPLATES.find((t) => t.slug === "rights-precheck-shop")!;
    expect(draft.departments).toHaveLength(matched.departments.length);
  });

  it("still drafts (never re-asks) once more than 3 user turns accumulate", async () => {
    const responses = await simulateCompany([
      RIGHTS_PROMPT,
      "Precheck Collective",
      "all",
      "please also add a fourth department",
    ]);
    const fourth = responses[3]!;
    expect(fourth.clarifyingQuestion).toBeNull();
    expect(fourth.company).not.toBeNull();
    expect(fourth.notIncluded).toEqual([]);
  });

  it("every fallback response satisfies CompanyGuidedResponseSchema (question and draft turns)", async () => {
    const responses = await simulateCompany([
      "found a sync pitch business for music supervisors",
      "Pitch Collective",
      "all",
    ]);
    expect(responses).toHaveLength(3);
    for (const res of responses) {
      const parsed = CompanyGuidedResponseSchema.safeParse(res);
      expect(parsed.success).toBe(true);
    }
  });

  it("never calls the real LLM brain while ANTHROPIC_API_KEY is unset", async () => {
    await simulateCompany([RIGHTS_PROMPT, "Precheck Collective", "all"]);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });
});

describe("runCompanyGuidedTurn — real-brain manifest-validation guard", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
    generateObjectMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back deterministically when the drafted employee manifest is schema-invalid (empty triggers/steps)", async () => {
    // AgentManifestSchema requires triggers.min(1) and steps.min(1) — both
    // empty here, so this manifest is definitely invalid.
    generateObjectMock.mockResolvedValue({
      object: {
        clarifyingQuestion: null,
        company: {
          name: "X",
          mission: "m",
          departments: [
            {
              name: "d",
              monthlyBudgetUsdc: null,
              employees: [
                {
                  slug: "e",
                  jobDescription: "j",
                  monthlyBudgetUsdc: null,
                  publishGated: false,
                  manifest: {
                    manifestVersion: 1,
                    name: "bad",
                    description: "d",
                    triggers: [],
                    steps: [],
                    meta: {},
                  },
                },
              ],
            },
          ],
        },
        notIncluded: [],
      },
    });

    const res = await runCompanyGuidedTurn("found me a one-employee company called X", [], await paidBilling());

    expect(generateObjectMock).toHaveBeenCalled();
    // The invalid draft must never be surfaced as-is.
    expect(res.company === null || res.company!.name !== "X").toBe(true);
    // With empty history, the deterministic fallback's first turn always
    // asks for the company name — that's the observable proof of fallback.
    expect(res.clarifyingQuestion).toBe("What would you like to name this company?");
    expect(res.company).toBeNull();
    expect(res.notIncluded).toEqual([]);
    expect(CompanyGuidedResponseSchema.safeParse(res).success).toBe(true);
  });

  it("falls back deterministically when a schema-valid manifest uses a step type outside the available node catalog", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        clarifyingQuestion: null,
        company: {
          name: "Y",
          mission: "A mission.",
          departments: [
            {
              name: "d",
              monthlyBudgetUsdc: null,
              employees: [
                {
                  slug: "e",
                  jobDescription: "j",
                  monthlyBudgetUsdc: null,
                  publishGated: false,
                  manifest: {
                    manifestVersion: 1,
                    name: "ok-shape",
                    description: "d",
                    triggers: [{ kind: "manual" }],
                    steps: [
                      { id: "n1", type: "totally.unavailable.node", config: {}, after: [] },
                    ],
                    meta: {},
                  },
                },
              ],
            },
          ],
        },
        notIncluded: [],
      },
    });

    const res = await runCompanyGuidedTurn("found me company Y", [], await paidBilling());

    expect(res.company === null || res.company!.name !== "Y").toBe(true);
    expect(res.clarifyingQuestion).toBe("What would you like to name this company?");
    expect(CompanyGuidedResponseSchema.safeParse(res).success).toBe(true);
  });

  it("accepts a schema-valid draft that uses only available node types (positive control)", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        clarifyingQuestion: null,
        company: {
          name: "Valid Co",
          mission: "A valid mission.",
          departments: [
            {
              name: "Operations",
              monthlyBudgetUsdc: null,
              employees: [
                {
                  slug: "valid-employee",
                  jobDescription: "Does a valid thing.",
                  monthlyBudgetUsdc: 25,
                  publishGated: false,
                  manifest: {
                    manifestVersion: 1,
                    name: "Valid Employee",
                    description: "Does a valid thing.",
                    triggers: [{ kind: "paidCall", priceUsdc: 0.1 }],
                    steps: [
                      { id: "n1", type: "llm", config: { prompt: "hi" }, after: [] },
                      { id: "n2", type: "output", config: {}, after: ["n1"] },
                    ],
                    meta: { createdBy: "guided" },
                  },
                },
              ],
            },
          ],
        },
        notIncluded: ["subscription billing"],
      },
    });

    const res = await runCompanyGuidedTurn("found me a valid company", [], await paidBilling());

    expect(res.clarifyingQuestion).toBeNull();
    expect(res.company).not.toBeNull();
    expect(res.company!.name).toBe("Valid Co");
    expect(res.company!.departments[0]?.employees[0]?.monthlyBudgetUsdc).toBe(25);
    expect(res.notIncluded).toEqual(["subscription billing"]);
    expect(CompanyGuidedResponseSchema.safeParse(res).success).toBe(true);
  });

  it("falls back to the deterministic brain when generateObject throws", async () => {
    generateObjectMock.mockRejectedValue(new Error("network error"));

    const res = await runCompanyGuidedTurn(RIGHTS_PROMPT, []);

    expect(res.clarifyingQuestion).toBe("What would you like to name this company?");
    expect(res.company).toBeNull();
    expect(CompanyGuidedResponseSchema.safeParse(res).success).toBe(true);
  });
});
