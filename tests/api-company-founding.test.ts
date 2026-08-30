/**
 * Tests for the founding service (src/lib/company/founding.ts) —
 * templateToDraft mapping and materializeCompanyDraft's full write path,
 * against a real SqliteRepo(":memory:") like tests/api-company-repo.test.ts.
 * See src/lib/company/types.ts, src/lib/company/templates.ts, and the
 * company section of FlowRepo in src/lib/db/repo.ts for the contracts each
 * assertion below is grounded in.
 */

import { describe, it, expect, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { templateToDraft, materializeCompanyDraft } from "@/lib/company/founding";
import { MAX_COMPANY_DRAFT_EMPLOYEES } from "@/lib/company/draft-limits";
import type { AgentManifest } from "@/lib/manifest/schema";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

/** Mirrors founding.ts's private priceUsdcFromManifest for test-side expectations. */
function expectedPriceUsdc(manifest: AgentManifest): number {
  for (const trigger of manifest.triggers) {
    if (trigger.kind === "paidCall") return trigger.priceUsdc;
  }
  return 0;
}

function expectedCron(manifest: AgentManifest): string | null {
  for (const trigger of manifest.triggers) {
    if (trigger.kind === "schedule") return trigger.cron;
  }
  return null;
}

function draftWithEmployeeCount(employeeCount: number) {
  const draft = templateToDraft("audit-shop");
  if (!draft) throw new Error("audit-shop template is required for founding boundary tests");
  const sourceDepartment = draft.departments[0]!;
  const sourceEmployee = sourceDepartment.employees[0]!;
  return {
    ...draft,
    departments: Array.from(
      { length: Math.ceil(employeeCount / 16) },
      (_, departmentIndex) => ({
        ...sourceDepartment,
        name: `Department ${departmentIndex + 1}`,
        employees: Array.from(
          { length: Math.min(16, employeeCount - departmentIndex * 16) },
          (_, employeeIndex) => {
            const sequence = departmentIndex * 16 + employeeIndex + 1;
            return {
              ...sourceEmployee,
              slug: `employee-${sequence}`,
              jobDescription: `Employee ${sequence}`,
            };
          },
        ),
      }),
    ),
  };
}

describe("templateToDraft", () => {
  it("returns null for an unknown slug", () => {
    expect(templateToDraft("no-such-template")).toBeNull();
  });

  it("maps every COMPANY_TEMPLATES entry field-for-field, defaulting employee policy fields", () => {
    expect(COMPANY_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of COMPANY_TEMPLATES) {
      const draft = templateToDraft(template.slug);
      expect(draft).not.toBeNull();
      if (!draft) continue;

      expect(draft.name).toBe(template.name);
      expect(draft.mission).toBe(template.mission);
      expect(draft.departments).toHaveLength(template.departments.length);

      template.departments.forEach((templateDepartment, i) => {
        const department = draft.departments[i]!;
        expect(department.name).toBe(templateDepartment.name);
        expect(department.monthlyBudgetUsdc).toBe(templateDepartment.monthlyBudgetUsdc);
        expect(department.employees).toHaveLength(templateDepartment.employees.length);

        templateDepartment.employees.forEach((templateEmployee, j) => {
          const employee = department.employees[j]!;
          expect(employee.slug).toBe(templateEmployee.slug);
          expect(employee.jobDescription).toBe(templateEmployee.jobDescription);
          expect(employee.monthlyBudgetUsdc).toBe(templateEmployee.monthlyBudgetUsdc ?? null);
          expect(employee.publishGated).toBe(templateEmployee.publishGated ?? false);
          expect(employee.manifest).toBe(templateEmployee.manifest);
        });
      });
    }
  });

  it("keeps Content Studio copy manual-fire honest while its schedule is disabled", () => {
    const template = COMPANY_TEMPLATES.find((candidate) => candidate.slug === "content-studio");
    expect(template).toBeTruthy();
    if (!template) return;

    const publicCopy = [
      template.mission,
      template.pitch,
      ...template.departments.flatMap((department) =>
        department.employees.flatMap((employee) => [
          employee.jobDescription,
          employee.manifest.description,
        ]),
      ),
    ].join(" ");
    expect(publicCopy).not.toMatch(/every day|09:00 UTC|runs automatically|overnight/iu);
    expect(publicCopy).toMatch(/founder (fires|requests)|founder's request/iu);
  });
});

describe("materializeCompanyDraft", () => {
  it("materializes exactly the total employee limit", async () => {
    const repo = makeRepo();
    const draft = draftWithEmployeeCount(MAX_COMPANY_DRAFT_EMPLOYEES);

    const { companyId } = await materializeCompanyDraft("owner-at-limit", draft, repo);

    expect(await repo.listEmployees(companyId)).toHaveLength(MAX_COMPANY_DRAFT_EMPLOYEES);
  });

  it("rejects one employee above the total limit before the first write", async () => {
    const repo = makeRepo();
    const createCompany = vi.spyOn(repo, "createCompany");
    const draft = draftWithEmployeeCount(MAX_COMPANY_DRAFT_EMPLOYEES + 1);

    await expect(materializeCompanyDraft("owner-over-limit", draft, repo)).rejects.toThrow(
      `Company drafts may include at most ${MAX_COMPANY_DRAFT_EMPLOYEES} employees total`,
    );

    expect(createCompany).not.toHaveBeenCalled();
    expect(await repo.listCompaniesByOwner("owner-over-limit")).toEqual([]);
  });

  it("materializes every COMPANY_TEMPLATES entry into a full draft company", async () => {
    const repo = makeRepo();

    for (const template of COMPANY_TEMPLATES) {
      const draft = templateToDraft(template.slug);
      expect(draft).not.toBeNull();
      if (!draft) continue;

      const { companyId } = await materializeCompanyDraft(`owner-${template.slug}`, draft, repo);

      const company = await repo.getCompany(companyId);
      expect(company).not.toBeNull();
      expect(company?.status).toBe("draft");
      expect(company?.name).toBe(template.name);
      expect(company?.mission).toBe(template.mission);
      expect(company?.ownerId).toBe(`owner-${template.slug}`);

      const departments = await repo.listDepartments(companyId);
      expect(departments).toHaveLength(template.departments.length);

      const employees = await repo.listEmployees(companyId);
      const totalEmployees = template.departments.reduce((sum, d) => sum + d.employees.length, 0);
      expect(employees).toHaveLength(totalEmployees);

      for (const templateDepartment of template.departments) {
        const departmentRecord = departments.find((d) => d.name === templateDepartment.name);
        expect(departmentRecord).toBeTruthy();
        expect(departmentRecord?.monthlyBudgetUsdc).toBe(templateDepartment.monthlyBudgetUsdc);

        for (const templateEmployee of templateDepartment.employees) {
          // jobDescription is preserved verbatim by addEmployee and is unique
          // per employee within a template, so it is a reliable correlation
          // key back to the template employee that produced this row.
          const employeeRecord = employees.find(
            (e) =>
              e.departmentId === departmentRecord?.id &&
              e.jobDescription === templateEmployee.jobDescription,
          );
          expect(employeeRecord).toBeTruthy();
          expect(employeeRecord?.companyId).toBe(companyId);
          expect(employeeRecord?.publishGated).toBe(templateEmployee.publishGated ?? false);
          expect(employeeRecord?.monthlyBudgetUsdc).toBe(
            templateEmployee.monthlyBudgetUsdc ?? null,
          );

          const agent = employeeRecord ? await repo.getAgent(employeeRecord.agentId) : null;
          expect(agent).toBeTruthy();
          expect(agent?.status).toBe("draft");
          expect(agent?.settlementLive).toBe(false);
          expect(agent?.priceUsdc).toBe(expectedPriceUsdc(templateEmployee.manifest));
          // uniqueSlug(employee.slug) = `${slugify(employee.slug)}-${suffix}`;
          // every template employee slug is already slug-shaped, so slugify
          // is a no-op and the prefix must survive intact.
          expect(agent?.slug.startsWith(`${templateEmployee.slug}-`)).toBe(true);

          const cron = expectedCron(templateEmployee.manifest);
          const schedules = agent ? await repo.listSchedulesByAgents([agent.id]) : [];
          if (cron !== null) {
            expect(schedules).toHaveLength(1);
            expect(schedules[0]?.cron).toBe(cron);
            // Disabled is load-bearing — draft companies must never fire
            // unattended, even once the heartbeat fast-follow lands.
            expect(schedules[0]?.enabled).toBe(false);
          } else {
            expect(schedules).toHaveLength(0);
          }
        }
      }
    }
  });

  it("materializes a reviewed per-employee monthly budget exactly", async () => {
    const repo = makeRepo();
    const draft = templateToDraft("audit-shop");
    expect(draft).not.toBeNull();
    if (!draft) return;
    const employee = draft.departments[0]?.employees[0];
    expect(employee).toBeTruthy();
    if (!employee) return;
    employee.monthlyBudgetUsdc = 17.25;

    const { companyId } = await materializeCompanyDraft("owner-employee-budget", draft, repo);
    const employees = await repo.listEmployees(companyId);

    expect(employees).toHaveLength(
      draft.departments.reduce((total, department) => total + department.employees.length, 0),
    );
    expect(
      employees.find((record) => record.jobDescription === employee.jobDescription)
        ?.monthlyBudgetUsdc,
    ).toBe(17.25);
  });

  it("never lets a founded schedule enter dueSchedules, even far in the future", async () => {
    const repo = makeRepo();
    // content-studio is the template with a schedule-triggered employee
    // (daily-brief, cron "0 9 * * *").
    const draft = templateToDraft("content-studio");
    expect(draft).not.toBeNull();
    if (!draft) return;

    await materializeCompanyDraft("owner-schedule-check", draft, repo);

    const fiftyYearsOut = Date.now() + 1000 * 60 * 60 * 24 * 365 * 50;
    const due = await repo.dueSchedules(fiftyYearsOut);
    expect(due).toHaveLength(0);
  });

  it("materializing the same template twice produces two distinct companies with distinct agent slugs", async () => {
    const repo = makeRepo();
    const draft1 = templateToDraft("rights-precheck-shop");
    const draft2 = templateToDraft("rights-precheck-shop");
    expect(draft1).not.toBeNull();
    expect(draft2).not.toBeNull();
    if (!draft1 || !draft2) return;

    // Two materializations must not collide on the agents.slug UNIQUE
    // constraint — that is exactly the bug uniqueSlug's random suffix
    // exists to avoid (createAgent would otherwise throw).
    const first = await materializeCompanyDraft("owner-dup", draft1, repo);
    const second = await materializeCompanyDraft("owner-dup", draft2, repo);

    expect(first.companyId).not.toBe(second.companyId);

    const firstEmployees = await repo.listEmployees(first.companyId);
    const secondEmployees = await repo.listEmployees(second.companyId);
    expect(firstEmployees.length).toBeGreaterThan(0);
    expect(firstEmployees).toHaveLength(secondEmployees.length);

    const firstAgents = await Promise.all(firstEmployees.map((e) => repo.getAgent(e.agentId)));
    const secondAgents = await Promise.all(secondEmployees.map((e) => repo.getAgent(e.agentId)));
    const firstSlugs = firstAgents.map((a) => a?.slug);
    const secondSlugs = secondAgents.map((a) => a?.slug);

    expect(firstSlugs.every((slug) => typeof slug === "string")).toBe(true);
    expect(secondSlugs.every((slug) => typeof slug === "string")).toBe(true);
    for (const slug of firstSlugs) {
      expect(secondSlugs).not.toContain(slug);
    }
  });
});
