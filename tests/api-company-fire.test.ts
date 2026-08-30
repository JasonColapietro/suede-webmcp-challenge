/**
 * Tests for the company fire endpoint
 * (src/app/api/companies/[id]/fire/route.ts): scope resolution
 * (company/department/employee), guardrail skip reasons, approval
 * consumption on a passing gate, the paused-company 409, and draft-company
 * dry-run enforcement. The founding service and guardrails run for real
 * against a real SqliteRepo(":memory:") instance (module-mock pattern from
 * tests/api-agent-connection-live.test.ts) so the whole orchestration is
 * exercised — only the network-adjacent boundaries (run-service,
 * rate-limit, auth) are mocked. See
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md, Task 9.
 *
 * The run-route paused-company gate is covered separately in
 * tests/api-company-fire-rungate.test.ts — that route needs a conflicting
 * @/lib/db/repo and @/lib/run-service mock shape (synthetic fakes, not a
 * real repo instance), which fights vitest's per-file module mock caching
 * if combined here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { materializeCompanyDraft, templateToDraft } from "@/lib/company/founding";
import type { EmployeeRecord } from "@/lib/company/types";

const state = vi.hoisted(() => ({
  owner: "owner-fire-test",
  getRepo: vi.fn(),
  resolveOwnerId: vi.fn(),
  checkRateLimit: vi.fn(),
  runToCompletion: vi.fn(),
  runPublishedLiveToCompletion: vi.fn(),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: (...args: unknown[]) => state.getRepo(...args),
}));
vi.mock("@/lib/auth", () => ({
  resolveOwnerId: (...args: unknown[]) => state.resolveOwnerId(...args),
  SUEDE_OWNER_PREFIX: "sb:",
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error {
    status = 401;
    constructor() {
      super("Authentication required");
      this.name = "UnauthenticatedOwnerError";
    }
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => state.checkRateLimit(...args),
}));
vi.mock("@/lib/run-service", () => ({
  runToCompletion: (...args: unknown[]) => state.runToCompletion(...args),
  runPublishedLiveToCompletion: (...args: unknown[]) => state.runPublishedLiveToCompletion(...args),
}));

let repo: SqliteRepo;

beforeEach(() => {
  vi.clearAllMocks();
  repo = new SqliteRepo(":memory:");
  state.getRepo.mockImplementation(async () => repo);
  state.resolveOwnerId.mockImplementation(async () => state.owner);
  state.checkRateLimit.mockReturnValue({ allowed: true, retryAfterSec: 0 });
  state.runToCompletion.mockImplementation(
    async (_graph: unknown, opts: { agentId?: string | null }) => ({
      runId: `dry-${opts.agentId ?? "unknown"}`,
      status: "done",
      totalCostUsdc: 0,
      outputs: {},
    }),
  );
  state.runPublishedLiveToCompletion.mockImplementation(
    async (opts: { agentId?: string | null }) => ({
      runId: `live-${opts.agentId ?? "unknown"}`,
      status: "done",
      totalCostUsdc: 0,
      outputs: {},
    }),
  );
});

async function fireRoute() {
  return import("@/app/api/companies/[id]/fire/route");
}

function fireRequest(companyId: string, body: Record<string, unknown>): Request {
  return new Request(`https://agents.suedeai.ai/api/companies/${companyId}/fire`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://agents.suedeai.ai",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function fireContext(companyId: string) {
  return { params: Promise.resolve({ id: companyId }) };
}

/**
 * Founds a content-studio company (Operations: a scheduled, free
 * "daily-brief" and a paidCall "doc-to-json"; Marketing: a publishGated
 * "promoter" and a plain "campaign-writer") for state.owner. Status stays
 * "draft" (founding never activates a company).
 */
async function foundContentStudio(): Promise<{ companyId: string; employees: EmployeeRecord[] }> {
  const draft = templateToDraft("content-studio");
  if (!draft) throw new Error("content-studio template missing");
  const { companyId } = await materializeCompanyDraft(state.owner, draft, repo);
  const employees = await repo.listEmployees(companyId);
  return { companyId, employees };
}

/**
 * jobDescription is unique per template employee and preserved verbatim by
 * addEmployee — the same correlation key tests/api-company-founding.test.ts
 * uses to map a founded row back to its template employee.
 */
function findEmployee(employees: EmployeeRecord[], jobDescriptionSubstring: string): EmployeeRecord {
  const match = employees.find((e) => e.jobDescription.includes(jobDescriptionSubstring));
  if (!match) throw new Error(`no employee with jobDescription containing "${jobDescriptionSubstring}"`);
  return match;
}

interface FireResultBody {
  results: Array<{ agentId: string; ran: boolean; dryRun?: boolean; runId?: string; reason?: string }>;
}

describe("POST /api/companies/[id]/fire", () => {
  it.each([
    [{ "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, 403],
    [{ "content-type": "text/plain", origin: "https://agents.suedeai.ai", "sec-fetch-site": "same-origin" }, 415],
    [{ "content-type": "application/json", origin: "https://agents.suedeai.ai" }, 403],
  ] as const)("rejects invalid session mutation headers before auth", async (headers, status) => {
    const { POST } = await fireRoute();
    const request = new Request("https://agents.suedeai.ai/api/companies/company/fire", {
      method: "POST",
      headers,
      body: JSON.stringify({ scope: "company" }),
    });

    const response = await POST(request, fireContext("company"));

    expect(response.status).toBe(status);
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("allows a valid anonymous Bearer client without browser origin headers", async () => {
    const { POST } = await fireRoute();
    const { companyId } = await foundContentStudio();
    state.resolveOwnerId.mockClear();
    const request = new Request(`https://agents.suedeai.ai/api/companies/${companyId}/fire`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.owner}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "company" }),
    });

    const response = await POST(request, fireContext(companyId));

    expect(response.status).toBe(200);
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
  });

  it("dry-runs a draft company's whole scope and never calls the live run path", async () => {
    const { POST } = await fireRoute();
    const { companyId } = await foundContentStudio();

    const response = await POST(fireRequest(companyId, { scope: "company" }), fireContext(companyId));

    expect(response.status).toBe(200);
    const body = (await response.json()) as FireResultBody;
    // promoter is publishGated with no approval yet, so it is blocked — the
    // other three (daily-brief, doc-to-json, campaign-writer) run dry.
    const ran = body.results.filter((r) => r.ran);
    expect(ran).toHaveLength(3);
    for (const r of ran) expect(r.dryRun).toBe(true);
    expect(state.runToCompletion).toHaveBeenCalled();
    expect(state.runPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.checkRateLimit).toHaveBeenCalledWith(`fire:${state.owner}`, {
      capacity: 4,
      refillPerSec: 0.05,
    });
  });

  it("returns 409 company_paused for a paused company and calls no run-service path", async () => {
    const { POST } = await fireRoute();
    const { companyId } = await foundContentStudio();
    await repo.updateCompany(companyId, { status: "paused" });

    const response = await POST(fireRequest(companyId, { scope: "company" }), fireContext(companyId));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "company_paused" });
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.runPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("skips a budget-exhausted employee with employee_budget_exhausted while a sibling still runs", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const docToJson = findEmployee(employees, "structured JSON");
    const campaignWriter = findEmployee(employees, "without publishing");

    await repo.updateEmployee(docToJson.agentId, { monthlyBudgetUsdc: 0.000001 });
    const agent = await repo.getAgent(docToJson.agentId);
    if (!agent) throw new Error("doc-to-json agent missing");
    const priorRun = await repo.createRun({ flowId: agent.flowId, agentId: docToJson.agentId, trigger: "agent" });
    await repo.finishRun(priorRun.id, "done", 0.05); // > the 0.000001 cap

    const response = await POST(fireRequest(companyId, { scope: "company" }), fireContext(companyId));

    expect(response.status).toBe(200);
    const body = (await response.json()) as FireResultBody;
    expect(body.results.find((r) => r.agentId === docToJson.agentId)).toEqual({
      agentId: docToJson.agentId,
      ran: false,
      reason: "employee_budget_exhausted",
    });
    expect(body.results.find((r) => r.agentId === campaignWriter.agentId)?.ran).toBe(true);
  });

  it("keeps a removed employee's spend against the department budget", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const removed = findEmployee(employees, "structured JSON");
    const sibling = employees.find(
      (employee) => employee.departmentId === removed.departmentId && employee.agentId !== removed.agentId,
    );
    if (!sibling) throw new Error("department sibling missing");
    await repo.setDepartmentBudget(removed.departmentId, 0.01);
    const agent = await repo.getAgent(removed.agentId);
    if (!agent) throw new Error("removed agent missing");
    const priorRun = await repo.createRun({ flowId: agent.flowId, agentId: removed.agentId, trigger: "agent" });
    await repo.finishRun(priorRun.id, "done", 0.05);
    expect(await repo.removeEmployee(removed.agentId)).toBe(true);

    const response = await POST(
      fireRequest(companyId, { scope: "department", targetId: removed.departmentId }),
      fireContext(companyId),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as FireResultBody;
    expect(body.results.find((result) => result.agentId === sibling.agentId)).toEqual({
      agentId: sibling.agentId,
      ran: false,
      reason: "department_budget_exhausted",
    });
    expect(body.results.some((result) => result.agentId === removed.agentId)).toBe(false);
  });

  it("blocks a publish-gated employee without an approval, then fires and consumes it once approved", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const promoter = findEmployee(employees, "after approval");
    expect(promoter.publishGated).toBe(true);

    const blocked = await POST(
      fireRequest(companyId, { scope: "employee", targetId: promoter.agentId }),
      fireContext(companyId),
    );
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toEqual({
      results: [{ agentId: promoter.agentId, ran: false, reason: "approval_required_publish_gated" }],
    });
    expect(state.runToCompletion).not.toHaveBeenCalled();

    const approval = await repo.createApproval({
      companyId,
      kind: "fire_publish_gated",
      subjectId: promoter.agentId,
    });
    await repo.decideApproval(approval.id, "approved");

    const fired = await POST(
      fireRequest(companyId, { scope: "employee", targetId: promoter.agentId }),
      fireContext(companyId),
    );
    expect(fired.status).toBe(200);
    const firedBody = (await fired.json()) as FireResultBody;
    expect(firedBody.results).toEqual([
      { agentId: promoter.agentId, ran: true, dryRun: true, runId: `dry-${promoter.agentId}` },
    ]);

    const decided = await repo.getApproval(approval.id);
    expect(decided?.status).toBe("consumed");
  });

  it("does not fire when another request wins approval consumption", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const promoter = findEmployee(employees, "after approval");
    const approval = await repo.createApproval({
      companyId,
      kind: "fire_publish_gated",
      subjectId: promoter.agentId,
    });
    await repo.decideApproval(approval.id, "approved");
    vi.spyOn(repo, "consumeApproval").mockResolvedValueOnce(false);

    const response = await POST(
      fireRequest(companyId, { scope: "employee", targetId: promoter.agentId }),
      fireContext(companyId),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{
        agentId: promoter.agentId,
        ran: false,
        reason: "approval_required_publish_gated",
      }],
    });
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.runPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect((await repo.getAgent(promoter.agentId))?.settlementLive).toBe(false);
  });

  it("restores a publish approval when the same fire loses threshold approval consumption", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const promoter = findEmployee(employees, "after approval");
    await repo.updateCompany(companyId, { fireCostThresholdUsdc: 1 });
    const agent = await repo.getAgent(promoter.agentId);
    if (!agent) throw new Error("promoter agent missing");
    const priorRun = await repo.createRun({ flowId: agent.flowId, agentId: promoter.agentId, trigger: "agent" });
    await repo.finishRun(priorRun.id, "done", 5);

    const publishApproval = await repo.createApproval({
      companyId,
      kind: "fire_publish_gated",
      subjectId: promoter.agentId,
    });
    const thresholdApproval = await repo.createApproval({
      companyId,
      kind: "fire_over_threshold",
      subjectId: promoter.agentId,
    });
    await repo.decideApproval(publishApproval.id, "approved");
    await repo.decideApproval(thresholdApproval.id, "approved");

    const realConsume = repo.consumeApproval.bind(repo);
    vi.spyOn(repo, "consumeApproval")
      .mockImplementationOnce((id) => realConsume(id))
      .mockResolvedValueOnce(false);

    const response = await POST(
      fireRequest(companyId, { scope: "employee", targetId: promoter.agentId }),
      fireContext(companyId),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{
        agentId: promoter.agentId,
        ran: false,
        reason: "approval_required_over_threshold",
      }],
    });
    expect((await repo.getApproval(publishApproval.id))?.status).toBe("approved");
    expect((await repo.getApproval(thresholdApproval.id))?.status).toBe("approved");
    expect(state.runToCompletion).not.toHaveBeenCalled();
  });

  it("restores consumed fire authority when execution fails before completing", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const promoter = findEmployee(employees, "after approval");
    const approval = await repo.createApproval({
      companyId,
      kind: "fire_publish_gated",
      subjectId: promoter.agentId,
    });
    await repo.decideApproval(approval.id, "approved");
    state.runToCompletion.mockRejectedValueOnce(new Error("runner unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(
      fireRequest(companyId, { scope: "employee", targetId: promoter.agentId }),
      fireContext(companyId),
    );

    expect(response.status).toBe(500);
    expect((await repo.getApproval(approval.id))?.status).toBe("approved");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("scope employee fires exactly the targeted employee", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const campaignWriter = findEmployee(employees, "without publishing");

    const response = await POST(
      fireRequest(companyId, { scope: "employee", targetId: campaignWriter.agentId }),
      fireContext(companyId),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as FireResultBody;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.agentId).toBe(campaignWriter.agentId);
    expect(body.results[0]?.ran).toBe(true);
    expect(state.runToCompletion).toHaveBeenCalledTimes(1);
  });

  // Bonus coverage beyond the six assigned behaviors: the fire route
  // independently re-derives "did the last completed run breach the
  // threshold" (guardrails.ts does not export that predicate) to decide
  // whether to consume the fire_over_threshold approval. This is the
  // trickiest piece of route-only logic Task 9 adds, so it gets its own
  // direct assertion rather than relying only on the guardrails unit tests.
  it("consumes the fire_over_threshold approval only when the last completed run actually breached the threshold", async () => {
    const { POST } = await fireRoute();
    const { companyId, employees } = await foundContentStudio();
    const docToJson = findEmployee(employees, "structured JSON");
    await repo.updateCompany(companyId, { fireCostThresholdUsdc: 1 });
    const agent = await repo.getAgent(docToJson.agentId);
    if (!agent) throw new Error("doc-to-json agent missing");
    const priorRun = await repo.createRun({ flowId: agent.flowId, agentId: docToJson.agentId, trigger: "agent" });
    await repo.finishRun(priorRun.id, "done", 5); // breaches the $1 threshold

    const approval = await repo.createApproval({
      companyId,
      kind: "fire_over_threshold",
      subjectId: docToJson.agentId,
    });
    await repo.decideApproval(approval.id, "approved");

    const response = await POST(
      fireRequest(companyId, { scope: "employee", targetId: docToJson.agentId }),
      fireContext(companyId),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as FireResultBody;
    expect(body.results[0]?.ran).toBe(true);

    const decided = await repo.getApproval(approval.id);
    expect(decided?.status).toBe("consumed");
  });
});
