/**
 * Founding service — the single write path that turns a company blueprint
 * (a `CompanyDraft`) into real rows: a company, its departments, and one
 * agent per employee (flow + agent + schedule, when the manifest carries
 * one), wired together with `repo.addEmployee`. Both founding paths share
 * this: template founding (`templateToDraft`) and, at company scope, the
 * description-first guided brain (src/lib/company/guided.ts) build a
 * `CompanyDraft` and hand it to `materializeCompanyDraft`.
 *
 * Founded companies always start in `status: "draft"` (repo.createCompany's
 * contract) and every schedule-triggered employee starts disabled — a draft
 * company must never enter `dueSchedules`, even once the heartbeat that
 * drives scheduled runs returns.
 *
 * See docs/superpowers/plans/2026-07-17-autonomous-company-prd.md and
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md (Task 7).
 */

import type { AgentManifest } from "@/lib/manifest/schema";
import type { FlowRepo } from "@/lib/db/repo";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { assertCompanyDraftEmployeeLimit } from "@/lib/company/draft-limits";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import { uniqueSlug } from "@/lib/slug";

export interface CompanyDraft {
  name: string;
  mission: string;
  departments: Array<{
    name: string;
    monthlyBudgetUsdc: number | null;
    employees: Array<{
      slug: string;
      jobDescription: string;
      monthlyBudgetUsdc: number | null;
      publishGated: boolean;
      manifest: AgentManifest;
    }>;
  }>;
}

/** Looks up a first-party template and maps it to a foundable draft, or null for an unknown slug. */
export function templateToDraft(slug: string): CompanyDraft | null {
  const template = COMPANY_TEMPLATES.find((candidate) => candidate.slug === slug);
  if (!template) return null;
  return {
    name: template.name,
    mission: template.mission,
    departments: template.departments.map((department) => ({
      name: department.name,
      monthlyBudgetUsdc: department.monthlyBudgetUsdc,
      employees: department.employees.map((employee) => ({
        slug: employee.slug,
        jobDescription: employee.jobDescription,
        monthlyBudgetUsdc: employee.monthlyBudgetUsdc ?? null,
        publishGated: employee.publishGated ?? false,
        manifest: employee.manifest,
      })),
    })),
  };
}

/** The manifest's paidCall price, or 0 when the only trigger is a schedule (or manual/webhook). */
function priceUsdcFromManifest(manifest: AgentManifest): number {
  for (const trigger of manifest.triggers) {
    if (trigger.kind === "paidCall") return trigger.priceUsdc;
  }
  return 0;
}

/** The manifest's schedule cron, or null when it has no schedule trigger. */
function scheduleCronFromManifest(manifest: AgentManifest): string | null {
  for (const trigger of manifest.triggers) {
    if (trigger.kind === "schedule") return trigger.cron;
  }
  return null;
}

interface EmployeeToMaterialize {
  slug: string;
  jobDescription: string;
  monthlyBudgetUsdc: number | null;
  publishGated: boolean;
  manifest: AgentManifest;
}

/**
 * The per-employee write sequence shared by whole-company founding
 * (materializeCompanyDraft) and a single post-founding hire
 * (hireEmployeeIntoCompany): manifestToFlow → saveFlow → createAgent →
 * updateAgent (evaluation mode) → addEmployee → optional disabled schedule.
 */
async function materializeEmployee(
  ownerId: string,
  companyId: string,
  departmentId: string,
  employee: EmployeeToMaterialize,
  repo: FlowRepo,
): Promise<{ agentId: string }> {
  const graph = manifestToFlow(employee.manifest);
  const flow = await repo.saveFlow({
    ownerId,
    name: employee.manifest.name,
    graph,
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: uniqueSlug(employee.slug),
    status: "draft",
    priceUsdc: priceUsdcFromManifest(employee.manifest),
  });
  const nonLiveAgent = await repo.updateAgent(agent.id, { settlementLive: false });
  if (!nonLiveAgent) {
    throw new Error("employee agent could not be placed in evaluation mode");
  }
  await repo.addEmployee({
    agentId: nonLiveAgent.id,
    companyId,
    departmentId,
    jobDescription: employee.jobDescription,
    publishGated: employee.publishGated,
    monthlyBudgetUsdc: employee.monthlyBudgetUsdc,
    // New hires settle to the founder's wallet until the founder assigns
    // this employee their own (PATCH employees payTo).
    payTo: null,
  });

  const cron = scheduleCronFromManifest(employee.manifest);
  if (cron !== null) {
    // Disabled is load-bearing: draft companies must never enter
    // dueSchedules, even after the heartbeat fast-follow returns.
    await repo.upsertSchedule({ agentId: nonLiveAgent.id, cron, enabled: false });
  }

  return { agentId: nonLiveAgent.id };
}

/**
 * Materializes a `CompanyDraft` into a real company: `createCompany` (status
 * stays the repo's default "draft"), then per department `createDepartment`,
 * then per employee `materializeEmployee`.
 */
export async function materializeCompanyDraft(
  ownerId: string,
  draft: CompanyDraft,
  repo: FlowRepo,
): Promise<{ companyId: string }> {
  assertCompanyDraftEmployeeLimit(draft);

  const company = await repo.createCompany({
    ownerId,
    name: draft.name,
    mission: draft.mission,
  });

  for (const department of draft.departments) {
    const departmentRecord = await repo.createDepartment({
      companyId: company.id,
      name: department.name,
      monthlyBudgetUsdc: department.monthlyBudgetUsdc,
    });

    for (const employee of department.employees) {
      await materializeEmployee(ownerId, company.id, departmentRecord.id, employee, repo);
    }
  }

  return { companyId: company.id };
}

export interface HireEmployeeInput {
  companyId: string;
  departmentId: string;
  slug: string;
  jobDescription: string;
  monthlyBudgetUsdc: number | null;
  manifest: AgentManifest;
}

/**
 * Hires exactly one employee into an existing, already-founded company's
 * department. Reuses the same materializeEmployee steps as founding — the
 * only difference from materializeCompanyDraft is that the company and
 * department already exist. publishGated always starts false; there is no
 * chat surface to set it in phase 1 (matches the least-privileged default).
 */
export async function hireEmployeeIntoCompany(
  ownerId: string,
  input: HireEmployeeInput,
  repo: FlowRepo,
): Promise<{ agentId: string }> {
  return materializeEmployee(
    ownerId,
    input.companyId,
    input.departmentId,
    {
      slug: input.slug,
      jobDescription: input.jobDescription,
      monthlyBudgetUsdc: input.monthlyBudgetUsdc,
      publishGated: false,
      manifest: input.manifest,
    },
    repo,
  );
}
