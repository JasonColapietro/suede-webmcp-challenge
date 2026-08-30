/**
 * GET /api/companies/[id] — company detail: departments (each with its
 * employees joined to their agent's slug/status/price/settlementLive, plus
 * per-department and per-employee month-to-date spend) and pending
 * approvals.
 * PATCH /api/companies/[id] — update name/mission/status/fireCostThresholdUsdc.
 * Activating a draft company (status: "active") IS the "review and approve
 * the draft" act from the spec — drafts stay dry-run only; activation just
 * makes live fire eligibility possible, nothing more.
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 10 ("create company CRUD, approvals, and the live-selling gate").
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { activateCompany } from "@/lib/company/activation";
import { getRepo } from "@/lib/db/repo";
import { monthWindowStartUtc } from "@/lib/company/guardrails";
import type { EmployeeRecord } from "@/lib/company/types";
import { getProjectRepo } from "@/lib/projects/provider";
import {
  invalidRequestResponse,
  notFoundResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";

export const runtime = "nodejs";

const UpdateCompanyRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  mission: z.string().min(1).optional(),
  status: z.enum(["draft", "active", "paused"]).optional(),
  fireCostThresholdUsdc: z.number().nonnegative().nullable().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (!company || company.ownerId !== owner) return notFoundResponse();

    const [departments, employees, employeeHistory, pendingApprovals] = await Promise.all([
      repo.listDepartments(id),
      repo.listEmployees(id),
      repo.listCompanyEmployeeHistory(id),
      repo.listApprovals(id, "pending"),
    ]);

    const employeesByDepartment = new Map<string, EmployeeRecord[]>();
    for (const employee of employees) {
      const list = employeesByDepartment.get(employee.departmentId);
      if (list) list.push(employee);
      else employeesByDepartment.set(employee.departmentId, [employee]);
    }
    const historicalAgentIdsByDepartment = new Map<string, string[]>();
    for (const employee of employeeHistory) {
      const list = historicalAgentIdsByDepartment.get(employee.departmentId) ?? [];
      list.push(employee.agentId);
      historicalAgentIdsByDepartment.set(employee.departmentId, list);
    }

    const monthStart = monthWindowStartUtc(new Date());

    const departmentsOut = await Promise.all(
      departments.map(async (department) => {
        const departmentEmployees = employeesByDepartment.get(department.id) ?? [];
        const departmentAgentIds = historicalAgentIdsByDepartment.get(department.id) ?? [];

        const [monthSpendUsdc, employeesOut] = await Promise.all([
          repo.sumCostByAgents(departmentAgentIds, monthStart),
          Promise.all(
            departmentEmployees.map(async (employee) => {
              const [agent, employeeMonthSpendUsdc] = await Promise.all([
                repo.getAgent(employee.agentId),
                repo.sumCostByAgents([employee.agentId], monthStart),
              ]);
              return {
                agentId: employee.agentId,
                companyId: employee.companyId,
                departmentId: employee.departmentId,
                jobDescription: employee.jobDescription,
                publishGated: employee.publishGated,
                monthlyBudgetUsdc: employee.monthlyBudgetUsdc,
                payTo: employee.payTo,
                role: employee.role ?? null,
                reportsTo: employee.reportsTo ?? null,
                lifecycleStatus: employee.lifecycleStatus ?? "idle",
                heartbeatEnabled: employee.heartbeatEnabled ?? false,
                heartbeatIntervalSeconds: employee.heartbeatIntervalSeconds ?? null,
                lastHeartbeatAt: employee.lastHeartbeatAt ?? null,
                monthSpendUsdc: employeeMonthSpendUsdc,
                agent: agent
                  ? {
                      id: agent.id,
                      flowId: agent.flowId,
                      slug: agent.slug,
                      status: agent.status,
                      priceUsdc: agent.priceUsdc,
                      settlementLive: agent.settlementLive,
                    }
                  : null,
              };
            }),
          ),
        ]);

        return {
          id: department.id,
          companyId: department.companyId,
          name: department.name,
          monthlyBudgetUsdc: department.monthlyBudgetUsdc,
          monthSpendUsdc,
          employees: employeesOut,
        };
      }),
    );

    return privateJson({ company, departments: departmentsOut, pendingApprovals });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function PATCH(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const existing = await repo.getCompany(id);
    if (!existing || existing.ownerId !== owner) return notFoundResponse();

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const parsed = UpdateCompanyRequestSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();

    const requestedStatus = parsed.data.status;
    if (
      (existing.status === "draft" && requestedStatus === "paused") ||
      (existing.status !== "draft" && requestedStatus === "draft")
    ) {
      return privateJson({ error: "company_invalid_state" }, 409);
    }
    if (existing.status === "paused" && requestedStatus === "active") {
      const employees = await repo.listEmployees(id);
      const agents = await Promise.all(employees.map((employee) => repo.getAgent(employee.agentId)));
      if (employees.length === 0 || agents.some((agent) => agent?.status !== "live")) {
        return privateJson({ error: "company_invalid_state" }, 409);
      }
    }

    let activatedCompany = existing;
    if (existing.status === "draft" && requestedStatus === "active") {
      const activation = await activateCompany({
        companyId: id,
        ownerId: owner,
        companyRepo: repo,
        projectRepo: await getProjectRepo(),
      });
      if (activation.status === "not-found") return notFoundResponse();
      if (activation.status === "invalid-state") {
        return privateJson({ error: "company_invalid_state" }, 409);
      }
      if (activation.status === "activation-failed") {
        return privateJson({
          error: "company_activation_failed",
          stage: activation.stage,
          agentId: activation.agentId,
        }, 503);
      }
      activatedCompany = activation.company;
    }

    const { status: _requestedStatus, ...otherUpdates } = parsed.data;
    const update = existing.status === "draft" && requestedStatus === "active"
      ? otherUpdates
      : parsed.data;
    const updated = Object.keys(update).length === 0
      ? activatedCompany
      : await repo.updateCompany(id, update);
    if (!updated) return notFoundResponse();

    return privateJson({ company: updated });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: error.message }, error.status);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
