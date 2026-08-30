/**
 * Tests for Task 10 (company CRUD, approvals, and the live-selling gate):
 * - POST /api/companies founds from a template.
 * - GET /api/companies list shape (employeeCount + status per company).
 * - GET /api/companies/[id] detail (departments/employees/pending
 *   approvals/month spend keys).
 * - PATCH /api/companies/[id] (activation, fireCostThresholdUsdc).
 * - POST /api/companies/[id]/departments.
 * - PATCH department and employee monthly budget caps.
 * - POST /api/companies/[id]/approvals (create / decide).
 * - The live-selling gate in src/lib/cli/settlement-handler.ts.
 *
 * Route tests run against a real SqliteRepo(":memory:") behind a mocked
 * @/lib/db/repo.getRepo, with @/lib/auth.resolveOwnerId fixed to one owner
 * (see tests/api-company-repo.test.ts and tests/api-company-founding.test.ts
 * for the same real-repo convention used at the lib layer). The
 * settlement-handler assertions call handleSettlementToggle directly
 * against a real repo — no route needed, per the plan's Task 10 note.
 *
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { materializeCompanyDraft, templateToDraft } from "@/lib/company/founding";
import { handleSettlementToggle } from "@/lib/cli/settlement-handler";

const OWNER = "sb:company-gov-owner";

const repoState = vi.hoisted(() => ({ repo: null as unknown, getRepo: vi.fn() }));
const authState = vi.hoisted(() => ({ owner: "sb:company-gov-owner" }));
const activationState = vi.hoisted(() => ({ activate: vi.fn() }));

vi.mock("@/lib/db/repo", () => ({
  getRepo: (...args: unknown[]) => repoState.getRepo(...args),
}));

vi.mock("@/lib/projects/provider", () => ({
  getProjectRepo: async () => ({}),
}));

vi.mock("@/lib/company/activation", () => ({
  activateCompany: activationState.activate,
}));

vi.mock("@/lib/auth", () => ({
  resolveOwnerId: async () => authState.owner,
  SUEDE_OWNER_PREFIX: "sb:",
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error {
    status = 401;
  },
}));

import { GET as companiesGet, POST as companiesPost } from "@/app/api/companies/route";
import { GET as companyGet, PATCH as companyPatch } from "@/app/api/companies/[id]/route";
import { POST as departmentsPost } from "@/app/api/companies/[id]/departments/route";
import { PATCH as departmentBudgetPatch } from "@/app/api/companies/[id]/departments/[departmentId]/route";
import { PATCH as employeeBudgetPatch } from "@/app/api/companies/[id]/employees/[agentId]/route";
import { POST as approvalsPost } from "@/app/api/companies/[id]/approvals/route";

function repo(): SqliteRepo {
  return repoState.repo as SqliteRepo;
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function departmentParams(id: string, departmentId: string) {
  return { params: Promise.resolve({ id, departmentId }) };
}

function employeeParams(id: string, agentId: string) {
  return { params: Promise.resolve({ id, agentId }) };
}

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string): Request {
  return new Request(url);
}

/** Founds a template directly against the repo (bypassing the route) for
 *  fixtures that don't themselves test the founding POST. */
async function foundCompany(templateSlug: string, ownerId = OWNER) {
  const draft = templateToDraft(templateSlug);
  if (!draft) throw new Error(`bad fixture template: ${templateSlug}`);
  return materializeCompanyDraft(ownerId, draft, repo());
}

beforeEach(() => {
  repoState.repo = new SqliteRepo(":memory:");
  repoState.getRepo.mockReset().mockImplementation(async () => repoState.repo);
  authState.owner = OWNER;
  activationState.activate.mockReset().mockImplementation(async (input: {
    companyId: string;
    companyRepo: SqliteRepo;
  }) => {
    const company = await input.companyRepo.updateCompany(input.companyId, { status: "active" });
    return company ? { status: "activated", company } : { status: "not-found" };
  });
});

describe("POST /api/companies — founds from a template", () => {
  it("rejects an anonymous workspace owner before opening the repository", async () => {
    authState.owner = "anonymous-workspace";

    const response = await companiesPost(
      jsonRequest("https://agents.suedeai.ai/api/companies", { templateSlug: "audit-shop" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(repoState.getRepo).not.toHaveBeenCalled();
  });

  it("founds a company and its employees from a known template slug", async () => {
    const response = await companiesPost(
      jsonRequest("https://agents.suedeai.ai/api/companies", { templateSlug: "audit-shop" }),
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { companyId: string };
    expect(json.companyId).toBeTruthy();

    const company = await repo().getCompany(json.companyId);
    expect(company).not.toBeNull();
    expect(company?.status).toBe("draft");
    expect(company?.ownerId).toBe(OWNER);
    expect(company?.name).toBe("Audit Shop");

    const employees = await repo().listEmployees(json.companyId);
    expect(employees.length).toBeGreaterThan(0);
    for (const employee of employees) {
      const agent = await repo().getAgent(employee.agentId);
      expect(agent).not.toBeNull();
      expect(agent?.status).toBe("draft");
    }
  });

  it("returns 400 unknown_template for an unknown slug", async () => {
    const response = await companiesPost(
      jsonRequest("https://agents.suedeai.ai/api/companies", { templateSlug: "no-such-template" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown_template" });
  });

  it("returns 400 for a malformed body", async () => {
    const response = await companiesPost(
      jsonRequest("https://agents.suedeai.ai/api/companies", { templateSlug: 5 }),
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /api/companies — list shape", () => {
  it("rejects an anonymous workspace owner before opening the repository", async () => {
    authState.owner = "anonymous-workspace";

    const response = await companiesGet();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(repoState.getRepo).not.toHaveBeenCalled();
  });

  it("returns the owner's companies with employeeCount and status, excluding other owners", async () => {
    const { companyId } = await foundCompany("audit-shop");
    await foundCompany("content-studio", "some-other-owner");

    const response = await companiesGet();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      companies: Array<{ id: string; status: string; employeeCount: number }>;
    };
    expect(json.companies).toHaveLength(1);
    const listed = json.companies[0]!;
    expect(listed.id).toBe(companyId);
    expect(listed.status).toBe("draft");
    expect(listed.employeeCount).toBe((await repo().listEmployees(companyId)).length);
    expect(listed.employeeCount).toBeGreaterThan(0);
  });

  it("returns an empty list for an owner with no companies", async () => {
    const response = await companiesGet();
    const json = (await response.json()) as { companies: unknown[] };
    expect(json.companies).toEqual([]);
  });
});

describe("GET /api/companies/[id] — detail shape", () => {
  it("includes departments, employees (joined to their agent), pending approvals, and month-spend keys", async () => {
    const { companyId } = await foundCompany("rights-precheck-shop");

    // Add a pending approval so pendingApprovals is exercised too.
    const employees = await repo().listEmployees(companyId);
    const publishGatedEmployee = employees.find((e) => e.publishGated);
    expect(publishGatedEmployee).toBeTruthy();
    await repo().createApproval({
      companyId,
      kind: "fire_publish_gated",
      subjectId: publishGatedEmployee!.agentId,
    });

    const response = await companyGet(getRequest(`https://agents.suedeai.ai/api/companies/${companyId}`), idParams(companyId));
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      company: { id: string; status: string };
      departments: Array<{
        id: string;
        name: string;
        monthSpendUsdc: number;
        employees: Array<{
          agentId: string;
          monthSpendUsdc: number;
          publishGated: boolean;
          agent: {
            flowId: string;
            slug: string;
            status: string;
            priceUsdc: number;
            settlementLive: boolean;
          } | null;
        }>;
      }>;
      pendingApprovals: Array<{ kind: string; subjectId: string; status: string }>;
    };

    expect(json.company.id).toBe(companyId);
    expect(json.departments.length).toBeGreaterThan(0);

    const allEmployeesOut = json.departments.flatMap((d) => d.employees);
    expect(allEmployeesOut.length).toBe(employees.length);

    for (const department of json.departments) {
      expect(typeof department.monthSpendUsdc).toBe("number");
      for (const employeeOut of department.employees) {
        expect(typeof employeeOut.monthSpendUsdc).toBe("number");
        expect(employeeOut.agent).not.toBeNull();
        expect(employeeOut.agent?.flowId).toBeTruthy();
        expect(employeeOut.agent?.slug).toBeTruthy();
        expect(["draft", "live"]).toContain(employeeOut.agent?.status);
        expect(typeof employeeOut.agent?.priceUsdc).toBe("number");
        expect(typeof employeeOut.agent?.settlementLive).toBe("boolean");
      }
    }

    expect(json.pendingApprovals).toHaveLength(1);
    expect(json.pendingApprovals[0]?.kind).toBe("fire_publish_gated");
    expect(json.pendingApprovals[0]?.status).toBe("pending");
  });

  it("keeps removed employee spend in the department total without returning them as active", async () => {
    const { companyId } = await foundCompany("content-studio");
    const employees = await repo().listEmployees(companyId);
    const removed = employees[0]!;
    const agent = await repo().getAgent(removed.agentId);
    if (!agent) throw new Error("employee agent missing");
    const run = await repo().createRun({ flowId: agent.flowId, agentId: removed.agentId, trigger: "agent" });
    await repo().finishRun(run.id, "done", 0.75);
    expect(await repo().removeEmployee(removed.agentId)).toBe(true);

    const response = await companyGet(
      getRequest(`https://agents.suedeai.ai/api/companies/${companyId}`),
      idParams(companyId),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      departments: Array<{ id: string; monthSpendUsdc: number; employees: Array<{ agentId: string }> }>;
    };
    const department = json.departments.find((candidate) => candidate.id === removed.departmentId);
    expect(department?.monthSpendUsdc).toBeCloseTo(0.75, 6);
    expect(department?.employees.some((employee) => employee.agentId === removed.agentId)).toBe(false);
  });

  it("returns 404 when the company does not exist", async () => {
    const response = await companyGet(
      getRequest("https://agents.suedeai.ai/api/companies/no-such-company"),
      idParams("no-such-company"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the company belongs to a different owner", async () => {
    const { companyId } = await foundCompany("audit-shop", "some-other-owner");
    const response = await companyGet(
      getRequest(`https://agents.suedeai.ai/api/companies/${companyId}`),
      idParams(companyId),
    );
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/companies/[id]", () => {
  it("renames an owned company and rejects an empty name", async () => {
    const { companyId } = await foundCompany("audit-shop");

    const renamed = await companyPatch(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}`, { name: "  Signal Works  " }, "PATCH"),
      idParams(companyId),
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ company: { id: companyId, name: "Signal Works" } });
    expect((await repo().getCompany(companyId))?.name).toBe("Signal Works");

    const empty = await companyPatch(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}`, { name: "   " }, "PATCH"),
      idParams(companyId),
    );
    expect(empty.status).toBe(400);
    expect((await repo().getCompany(companyId))?.name).toBe("Signal Works");
  });

  it("activates a draft company and sets fireCostThresholdUsdc", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const before = await repo().getCompany(companyId);
    expect(before?.status).toBe("draft");

    const response = await companyPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}`,
        { status: "active", fireCostThresholdUsdc: 12.5 },
        "PATCH",
      ),
      idParams(companyId),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { company: { status: string; fireCostThresholdUsdc: number } };
    expect(json.company.status).toBe("active");
    expect(json.company.fireCostThresholdUsdc).toBe(12.5);
    expect(activationState.activate).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      ownerId: OWNER,
      companyRepo: repo(),
    }));

    const after = await repo().getCompany(companyId);
    expect(after?.status).toBe("active");
    expect(after?.fireCostThresholdUsdc).toBe(12.5);
  });

  it("returns 503 and leaves the company draft when immutable activation fails", async () => {
    const { companyId } = await foundCompany("audit-shop");
    activationState.activate.mockResolvedValueOnce({
      status: "activation-failed",
      stage: "test-deployment",
      agentId: "employee-1",
    });

    const response = await companyPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}`,
        { status: "active" },
        "PATCH",
      ),
      idParams(companyId),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "company_activation_failed",
      stage: "test-deployment",
      agentId: "employee-1",
    });
    expect((await repo().getCompany(companyId))?.status).toBe("draft");
  });

  it("resumes a paused company without rebuilding immutable deployments", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const employees = await repo().listEmployees(companyId);
    for (const employee of employees) {
      await repo().updateAgent(employee.agentId, { status: "live" });
    }
    await repo().updateCompany(companyId, { status: "paused" });

    const response = await companyPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}`,
        { status: "active" },
        "PATCH",
      ),
      idParams(companyId),
    );

    expect(response.status).toBe(200);
    expect(activationState.activate).not.toHaveBeenCalled();
    expect((await repo().getCompany(companyId))?.status).toBe("active");
  });

  it("rejects draft to paused and refuses a paused legacy draft without live deployment proof", async () => {
    const { companyId } = await foundCompany("audit-shop");

    const pauseDraft = await companyPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}`,
        { status: "paused" },
        "PATCH",
      ),
      idParams(companyId),
    );
    expect(pauseDraft.status).toBe(409);
    expect((await repo().getCompany(companyId))?.status).toBe("draft");

    await repo().updateCompany(companyId, { status: "paused" });
    const resumeLegacyDraft = await companyPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}`,
        { status: "active" },
        "PATCH",
      ),
      idParams(companyId),
    );
    expect(resumeLegacyDraft.status).toBe(409);
    expect((await repo().getCompany(companyId))?.status).toBe("paused");
    expect(activationState.activate).not.toHaveBeenCalled();
  });

  it("returns 404 for a company that does not exist or isn't owned by the caller", async () => {
    const missing = await companyPatch(
      jsonRequest("https://agents.suedeai.ai/api/companies/no-such-company", { status: "active" }, "PATCH"),
      idParams("no-such-company"),
    );
    expect(missing.status).toBe(404);

    const { companyId } = await foundCompany("audit-shop", "some-other-owner");
    const notOwned = await companyPatch(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}`, { status: "active" }, "PATCH"),
      idParams(companyId),
    );
    expect(notOwned.status).toBe(404);
  });
});

describe("POST /api/companies/[id]/departments", () => {
  it("creates a department for an owned company", async () => {
    const { companyId } = await foundCompany("audit-shop");

    const response = await departmentsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/departments`, {
        name: "Sales",
        monthlyBudgetUsdc: 50,
      }),
      idParams(companyId),
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { department: { id: string; name: string; monthlyBudgetUsdc: number } };
    expect(json.department.name).toBe("Sales");
    expect(json.department.monthlyBudgetUsdc).toBe(50);

    const departments = await repo().listDepartments(companyId);
    expect(departments.some((d) => d.id === json.department.id)).toBe(true);
  });

  it("omitted monthlyBudgetUsdc defaults to null", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const response = await departmentsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/departments`, { name: "Support" }),
      idParams(companyId),
    );
    const json = (await response.json()) as { department: { monthlyBudgetUsdc: number | null } };
    expect(json.department.monthlyBudgetUsdc).toBeNull();
  });

  it("returns 404 for a company not owned by the caller", async () => {
    const { companyId } = await foundCompany("audit-shop", "some-other-owner");
    const response = await departmentsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/departments`, { name: "Sales" }),
      idParams(companyId),
    );
    expect(response.status).toBe(404);
  });
});

describe("PATCH company budget caps", () => {
  it("updates and clears an owned department's monthly cap", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const department = (await repo().listDepartments(companyId))[0]!;

    const set = await departmentBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}/departments/${department.id}`,
        { monthlyBudgetUsdc: 75 },
        "PATCH",
      ),
      departmentParams(companyId, department.id),
    );
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      department: { id: department.id, monthlyBudgetUsdc: 75 },
    });
    expect((await repo().listDepartments(companyId))[0]?.monthlyBudgetUsdc).toBe(75);

    const clear = await departmentBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}/departments/${department.id}`,
        { monthlyBudgetUsdc: null },
        "PATCH",
      ),
      departmentParams(companyId, department.id),
    );
    expect(clear.status).toBe(200);
    expect((await repo().listDepartments(companyId))[0]?.monthlyBudgetUsdc).toBeNull();
  });

  it("updates and clears an owned employee's monthly cap", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const employee = (await repo().listEmployees(companyId))[0]!;

    const set = await employeeBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}/employees/${employee.agentId}`,
        { monthlyBudgetUsdc: 12.5 },
        "PATCH",
      ),
      employeeParams(companyId, employee.agentId),
    );
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      employee: { agentId: employee.agentId, monthlyBudgetUsdc: 12.5 },
    });
    expect((await repo().getEmployeeByAgent(employee.agentId))?.monthlyBudgetUsdc).toBe(12.5);

    const clear = await employeeBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}/employees/${employee.agentId}`,
        { monthlyBudgetUsdc: null },
        "PATCH",
      ),
      employeeParams(companyId, employee.agentId),
    );
    expect(clear.status).toBe(200);
    expect((await repo().getEmployeeByAgent(employee.agentId))?.monthlyBudgetUsdc).toBeNull();
  });

  it("sets, routes to, and clears an owned employee's own payout wallet", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const employee = (await repo().listEmployees(companyId))[0]!;
    const founderWallet = "0x2222222222222222222222222222222222222222";
    const ownWallet = "0x1111111111111111111111111111111111111111";

    await repo().saveWallet({ ownerId: OWNER, address: founderWallet });
    const agent = await repo().getAgent(employee.agentId);
    expect(agent).not.toBeNull();
    const { resolvePayout } = await import("@/lib/payout");

    // No override: settlement resolves to the founder's owner wallet.
    await expect(resolvePayout(agent!)).resolves.toEqual({ payTo: founderWallet, source: "creator" });

    const set = await employeeBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}/employees/${employee.agentId}`,
        { payTo: ownWallet },
        "PATCH",
      ),
      employeeParams(companyId, employee.agentId),
    );
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      employee: { agentId: employee.agentId, payTo: ownWallet },
    });
    expect((await repo().getEmployeeByAgent(employee.agentId))?.payTo).toBe(ownWallet);
    // Override set: the employee's own wallet wins, still creator-side money.
    await expect(resolvePayout(agent!)).resolves.toEqual({ payTo: ownWallet, source: "creator" });

    const invalid = await employeeBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}/employees/${employee.agentId}`,
        { payTo: "not-an-address" },
        "PATCH",
      ),
      employeeParams(companyId, employee.agentId),
    );
    expect(invalid.status).toBe(400);

    const clear = await employeeBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${companyId}/employees/${employee.agentId}`,
        { payTo: null },
        "PATCH",
      ),
      employeeParams(companyId, employee.agentId),
    );
    expect(clear.status).toBe(200);
    expect((await repo().getEmployeeByAgent(employee.agentId))?.payTo).toBeNull();
    await expect(resolvePayout(agent!)).resolves.toEqual({ payTo: founderWallet, source: "creator" });
  });

  it("rejects negative caps and child ids that do not belong to the path company", async () => {
    const first = await foundCompany("audit-shop");
    const second = await foundCompany("content-studio");
    const firstDepartment = (await repo().listDepartments(first.companyId))[0]!;
    const firstEmployee = (await repo().listEmployees(first.companyId))[0]!;

    const negative = await departmentBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${first.companyId}/departments/${firstDepartment.id}`,
        { monthlyBudgetUsdc: -1 },
        "PATCH",
      ),
      departmentParams(first.companyId, firstDepartment.id),
    );
    expect(negative.status).toBe(400);

    const wrongDepartment = await departmentBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${second.companyId}/departments/${firstDepartment.id}`,
        { monthlyBudgetUsdc: 5 },
        "PATCH",
      ),
      departmentParams(second.companyId, firstDepartment.id),
    );
    expect(wrongDepartment.status).toBe(404);

    const wrongEmployee = await employeeBudgetPatch(
      jsonRequest(
        `https://agents.suedeai.ai/api/companies/${second.companyId}/employees/${firstEmployee.agentId}`,
        { monthlyBudgetUsdc: 5 },
        "PATCH",
      ),
      employeeParams(second.companyId, firstEmployee.agentId),
    );
    expect(wrongEmployee.status).toBe(404);
  });
});

describe("POST /api/companies/[id]/approvals", () => {
  it("runs create → decide approved, and a second decide returns 404 not_pending", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const employees = await repo().listEmployees(companyId);
    const agentId = employees[0]!.agentId;

    const createResponse = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        create: {
          kind: "enable_live_selling",
          subjectId: agentId,
          actionSummary: "Enable live selling for audit clerk",
          costSnapshot: {
            basis: "quoted",
            amountUsdc: 0,
            note: "This setting change does not execute a paid run.",
          },
        },
      }),
      idParams(companyId),
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      approval: {
        id: string;
        status: string;
        actionSummary: string | null;
        costSnapshot: { basis: string; amountUsdc: number | null; note: string | null } | null;
      };
    };
    expect(created.approval.status).toBe("pending");
    expect(created.approval.actionSummary).toBe("Enable live selling for audit clerk");
    expect(created.approval.costSnapshot).toEqual({
      basis: "quoted",
      amountUsdc: 0,
      note: "This setting change does not execute a paid run.",
    });

    const decideResponse = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        decide: { approvalId: created.approval.id, decision: "approved" },
      }),
      idParams(companyId),
    );
    expect(decideResponse.status).toBe(200);
    const decided = (await decideResponse.json()) as { approval: { status: string } };
    expect(decided.approval.status).toBe("approved");

    const secondDecide = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        decide: { approvalId: created.approval.id, decision: "rejected" },
      }),
      idParams(companyId),
    );
    expect(secondDecide.status).toBe(404);
    expect(await secondDecide.json()).toEqual({ error: "not_pending" });
  });

  it("captures an explicit unavailable snapshot when a caller has no pre-action cost", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const [employee] = await repo().listEmployees(companyId);

    const response = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        create: {
          kind: "fire_over_threshold",
          subjectId: employee!.agentId,
          actionSummary: "Run the audit clerk above the threshold",
          costSnapshot: {
            basis: "unavailable",
            amountUsdc: null,
            note: "Execution cost is not quoted before this run.",
          },
        },
      }),
      idParams(companyId),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      approval: {
        actionSummary: "Run the audit clerk above the threshold",
        costSnapshot: {
          basis: "unavailable",
          amountUsdc: null,
          note: "Execution cost is not quoted before this run.",
        },
      },
    });
  });

  it("fills honest fallback text and rejects estimates without an amount", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const [employee] = await repo().listEmployees(companyId);

    const fallback = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        create: { kind: "fire_publish_gated", subjectId: employee!.agentId },
      }),
      idParams(companyId),
    );
    expect(fallback.status).toBe(201);
    expect(await fallback.json()).toMatchObject({
      approval: {
        actionSummary: `Run publish-gated employee ${employee!.agentId}`,
        costSnapshot: {
          basis: "unavailable",
          amountUsdc: null,
          note: "No pre-action quote or estimate was supplied.",
        },
      },
    });

    const invalid = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        create: {
          kind: "fire_publish_gated",
          subjectId: employee!.agentId,
          costSnapshot: { basis: "estimated", note: "Missing amount" },
        },
      }),
      idParams(companyId),
    );
    expect(invalid.status).toBe(400);
  });

  it("stores the reason when rejecting", async () => {
    const { companyId } = await foundCompany("audit-shop");
    const employees = await repo().listEmployees(companyId);
    const agentId = employees[0]!.agentId;

    const created = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        create: { kind: "fire_over_threshold", subjectId: agentId },
      }),
      idParams(companyId),
    );
    const { approval } = (await created.json()) as { approval: { id: string } };

    const decideResponse = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        decide: { approvalId: approval.id, decision: "rejected", reason: "not ready yet" },
      }),
      idParams(companyId),
    );
    expect(decideResponse.status).toBe(200);
    const json = (await decideResponse.json()) as { approval: { status: string; reason: string | null } };
    expect(json.approval.status).toBe("rejected");
    expect(json.approval.reason).toBe("not ready yet");

    const stored = await repo().getApproval(approval.id);
    expect(stored?.reason).toBe("not ready yet");
  });

  it("returns 404 creating an approval for a company not owned by the caller", async () => {
    const { companyId } = await foundCompany("audit-shop", "some-other-owner");
    const response = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        create: { kind: "enable_live_selling", subjectId: "agent-x" },
      }),
      idParams(companyId),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 deciding an approval that belongs to a company not owned by the caller", async () => {
    const { companyId } = await foundCompany("audit-shop", "some-other-owner");
    const approval = await repo().createApproval({
      companyId,
      kind: "enable_live_selling",
      subjectId: "agent-x",
    });

    const response = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${companyId}/approvals`, {
        decide: { approvalId: approval.id, decision: "approved" },
      }),
      idParams(companyId),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when an owned approval is submitted through another owned company's URL", async () => {
    const first = await foundCompany("audit-shop");
    const second = await foundCompany("rights-precheck-shop");
    const approval = await repo().createApproval({
      companyId: first.companyId,
      kind: "enable_live_selling",
      subjectId: first.companyId,
    });

    const response = await approvalsPost(
      jsonRequest(`https://agents.suedeai.ai/api/companies/${second.companyId}/approvals`, {
        decide: { approvalId: approval.id, decision: "approved" },
      }),
      idParams(second.companyId),
    );

    expect(response.status).toBe(404);
    expect((await repo().getApproval(approval.id))?.status).toBe("pending");
  });
});

describe("settlement-handler live-selling gate", () => {
  /** Seeds a real flow + agent, registered as a company employee. */
  async function seedEmployeeAgent(): Promise<{ companyId: string; agentId: string; slug: string }> {
    const company = await repo().createCompany({ ownerId: OWNER, name: "Gate Co", mission: "M" });
    const department = await repo().createDepartment({ companyId: company.id, name: "Ops" });
    const flow = await repo().saveFlow({
      ownerId: OWNER,
      name: "Gate Test Flow",
      graph: { id: "g-gate-" + Math.random().toString(36).slice(2, 8), name: "test", nodes: [], edges: [] },
    });
    const agent = await repo().createAgent({
      flowId: flow.id,
      slug: "gate-employee-" + Math.random().toString(36).slice(2, 8),
      status: "live",
      priceUsdc: 0.25,
    });
    await repo().addEmployee({
      agentId: agent.id,
      companyId: company.id,
      departmentId: department.id,
      jobDescription: "Sells things",
      publishGated: false,
      monthlyBudgetUsdc: null,
      payTo: null,
    });
    return { companyId: company.id, agentId: agent.id, slug: agent.slug };
  }

  /** Seeds a real flow + agent that is NOT a company employee. */
  async function seedNonEmployeeAgent(): Promise<{ agentId: string; slug: string }> {
    const flow = await repo().saveFlow({
      ownerId: OWNER,
      name: "Non-Employee Flow",
      graph: { id: "g-nonemp-" + Math.random().toString(36).slice(2, 8), name: "test", nodes: [], edges: [] },
    });
    const agent = await repo().createAgent({
      flowId: flow.id,
      slug: "non-employee-" + Math.random().toString(36).slice(2, 8),
      status: "live",
      priceUsdc: 0.25,
    });
    return { agentId: agent.id, slug: agent.slug };
  }

  it("blocks an employee agent's flip to live without an approval, leaving settlementLive unchanged", async () => {
    const { agentId, slug } = await seedEmployeeAgent();

    // settlementLive defaults to TRUE (opt-out) for new agents — see
    // tests/api-settlement.test.ts. Toggle it false first so the later
    // true attempt is an actual transition, then confirm the blocked true
    // attempt leaves the agent exactly where the false toggle left it.
    const toOff = await handleSettlementToggle(slug, OWNER, { live: false }, repo());
    expect(toOff).not.toHaveProperty("kind");

    const blocked = await handleSettlementToggle(slug, OWNER, { live: true }, repo());
    expect(blocked).toEqual({ kind: "approval_required" });

    const agent = await repo().getAgent(agentId);
    expect(agent?.settlementLive).toBe(false);
  });

  it("allows the flip once an APPROVED enable_live_selling approval exists, and consumes it", async () => {
    const { companyId, agentId, slug } = await seedEmployeeAgent();
    await handleSettlementToggle(slug, OWNER, { live: false }, repo());

    const approval = await repo().createApproval({
      companyId,
      kind: "enable_live_selling",
      subjectId: agentId,
    });
    await repo().decideApproval(approval.id, "approved");

    const result = await handleSettlementToggle(slug, OWNER, { live: true }, repo());
    expect(result).not.toHaveProperty("kind");
    if (!("kind" in result)) {
      expect(result.settlementLive).toBe(true);
    }

    const agent = await repo().getAgent(agentId);
    expect(agent?.settlementLive).toBe(true);

    const afterApproval = await repo().getApproval(approval.id);
    expect(afterApproval?.status).toBe("consumed");
  });

  it("a pending (not yet approved) enable_live_selling approval does not satisfy the gate", async () => {
    const { companyId, agentId, slug } = await seedEmployeeAgent();
    await handleSettlementToggle(slug, OWNER, { live: false }, repo());
    await repo().createApproval({ companyId, kind: "enable_live_selling", subjectId: agentId });

    const blocked = await handleSettlementToggle(slug, OWNER, { live: true }, repo());
    expect(blocked).toEqual({ kind: "approval_required" });
  });

  it("live: false flips stay ungated for an employee agent", async () => {
    const { slug, agentId } = await seedEmployeeAgent();
    // Default is already true; flipping to false must never require an approval.
    const result = await handleSettlementToggle(slug, OWNER, { live: false }, repo());
    expect(result).not.toHaveProperty("kind");
    const agent = await repo().getAgent(agentId);
    expect(agent?.settlementLive).toBe(false);
  });

  it("regression: a non-employee agent toggles to live exactly as before, ungated", async () => {
    const { agentId, slug } = await seedNonEmployeeAgent();

    const result = await handleSettlementToggle(slug, OWNER, { live: true }, repo());
    expect(result).not.toHaveProperty("kind");
    if (!("kind" in result)) {
      expect(result.settlementLive).toBe(true);
    }
    const agent = await repo().getAgent(agentId);
    expect(agent?.settlementLive).toBe(true);
  });
});
