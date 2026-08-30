/**
 * Fire guardrails — the budget and approval checks a manual fire (and later
 * the unattended tick) must pass before an employee is allowed to run.
 * Checks run in a fixed order and the first hit blocks the fire. See
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md, Task 8,
 * and the company domain types in ./types.
 */

import type { FlowRepo } from "@/lib/db/repo";
import type {
  ApprovalKind,
  ApprovalRecord,
  CompanyRecord,
  DepartmentRecord,
  EmployeeRecord,
} from "@/lib/company/types";

/** Epoch ms of the 1st of `now`'s UTC month at 00:00:00.000 — the rolling
 *  window start for every monthly budget check (PRD open question 3). */
export function monthWindowStartUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);
}

export type FireBlock =
  | { code: "employee_budget_exhausted"; agentId: string }
  | { code: "department_budget_exhausted"; departmentId: string }
  | { code: "approval_required_publish_gated"; agentId: string }
  | { code: "approval_required_over_threshold"; agentId: string };

export type PublicCallBudgetBlock =
  | { code: "employee_budget_exhausted"; agentId: string }
  | { code: "department_budget_exhausted"; departmentId: string };

/** Budget-only subset used by the public paid-call route. Public callers can
 * never spend an owner approval, but they still share the same durable caps. */
export async function publicCallBudgetBlock(input: {
  repo: FlowRepo;
  department: DepartmentRecord;
  employee: EmployeeRecord;
  departmentAgentIds: string[];
  now: Date;
}): Promise<PublicCallBudgetBlock | null> {
  const { repo, department, employee, departmentAgentIds, now } = input;
  const monthStart = monthWindowStartUtc(now);
  if (employee.monthlyBudgetUsdc !== null) {
    const spent = await repo.sumCostByAgents([employee.agentId], monthStart);
    if (spent >= employee.monthlyBudgetUsdc) {
      return { code: "employee_budget_exhausted", agentId: employee.agentId };
    }
  }
  if (department.monthlyBudgetUsdc !== null) {
    const spent = await repo.sumCostByAgents(departmentAgentIds, monthStart);
    if (spent >= department.monthlyBudgetUsdc) {
      return { code: "department_budget_exhausted", departmentId: department.id };
    }
  }
  return null;
}

/**
 * First APPROVED approval matching `kind` + `subjectId === agentId`, or
 * null when none exists. Callers that act on a passing gate (the fire
 * endpoint) consume this exact approval afterward so one approval buys
 * exactly one fire.
 */
export function findConsumableApproval(
  approvals: ApprovalRecord[],
  kind: ApprovalKind,
  agentId: string,
): ApprovalRecord | null {
  return (
    approvals.find((a) => a.status === "approved" && a.kind === kind && a.subjectId === agentId) ?? null
  );
}

/**
 * Evaluate every fire guard for one employee, in order (first hit wins):
 * 1. employee monthly budget, 2. department monthly budget, 3. publish
 * gate, 4. fire-cost threshold gate. Returns null when the employee is
 * clear to fire.
 *
 * Budget caps compare spend already incurred against the cap, so a cap
 * reached by prior runs is a hard stop for the NEXT run (PRD wording) —
 * this never estimates or inspects the cost of the run about to happen.
 */
export async function fireBlocksForEmployee(input: {
  repo: FlowRepo;
  company: CompanyRecord;
  department: DepartmentRecord;
  employee: EmployeeRecord;
  departmentAgentIds: string[];
  now: Date;
}): Promise<FireBlock | null> {
  const { repo, company, department, employee, departmentAgentIds, now } = input;
  const monthStart = monthWindowStartUtc(now);

  // 1. Employee monthly budget.
  if (employee.monthlyBudgetUsdc !== null) {
    const spent = await repo.sumCostByAgents([employee.agentId], monthStart);
    if (spent >= employee.monthlyBudgetUsdc) {
      return { code: "employee_budget_exhausted", agentId: employee.agentId };
    }
  }

  // 2. Department monthly budget — shared across every employee in the
  // department, so the caller supplies the full department agent id list.
  if (department.monthlyBudgetUsdc !== null) {
    const spent = await repo.sumCostByAgents(departmentAgentIds, monthStart);
    if (spent >= department.monthlyBudgetUsdc) {
      return { code: "department_budget_exhausted", departmentId: department.id };
    }
  }

  // Both gates below consume from the same approved-approvals snapshot.
  const approvedApprovals = await repo.listApprovals(company.id, "approved");

  // 3. Publish gate — firing a publish-gated employee (promo publishers)
  // requires an approved fire_publish_gated approval for this agent.
  if (employee.publishGated) {
    const approval = findConsumableApproval(approvedApprovals, "fire_publish_gated", employee.agentId);
    if (!approval) {
      return { code: "approval_required_publish_gated", agentId: employee.agentId };
    }
  }

  // 4. Fire-cost threshold gate — a company-wide cap on the employee's most
  // recent COMPLETED run cost, made deterministic via last-completed-run
  // cost (PRD open question 4's stated assumption).
  if (company.fireCostThresholdUsdc !== null) {
    const agent = await repo.getAgent(employee.agentId);
    if (agent) {
      const runs = await repo.listRuns(agent.flowId);
      const completed = runs.filter((r) => r.finishedAt !== null && r.agentId === employee.agentId);
      const mostRecent = [...completed].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
      if (mostRecent && mostRecent.totalCostUsdc > company.fireCostThresholdUsdc) {
        const approval = findConsumableApproval(approvedApprovals, "fire_over_threshold", employee.agentId);
        if (!approval) {
          return { code: "approval_required_over_threshold", agentId: employee.agentId };
        }
      }
    }
  }

  return null;
}
