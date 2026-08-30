/**
 * Tests for the fire guardrails (src/lib/company/guardrails.ts): the month
 * window helper, the approval-matching helper, and every check
 * fireBlocksForEmployee runs — in order — before an employee may fire. See
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md, Task 8.
 */

import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { fireBlocksForEmployee, findConsumableApproval, monthWindowStartUtc } from "@/lib/company/guardrails";
import type { ApprovalRecord } from "@/lib/company/types";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A real flow + agent pair, same pattern as tests/api-company-repo.test.ts. */
async function seedFlowAndAgent(
  repo: SqliteRepo,
  ownerId: string,
): Promise<{ flowId: string; agentId: string }> {
  const flow = await repo.saveFlow({
    ownerId,
    name: "Guardrail Test Flow",
    graph: { id: "g-guardrail-" + Math.random().toString(36).slice(2, 8), name: "test", nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: "guardrail-" + Math.random().toString(36).slice(2, 8),
    status: "live",
    priceUsdc: 0.25,
  });
  return { flowId: flow.id, agentId: agent.id };
}

/** Seeds a flow + agent + company_employees row for it. */
async function seedEmployee(
  repo: SqliteRepo,
  ownerId: string,
  companyId: string,
  departmentId: string,
  overrides: { publishGated?: boolean; monthlyBudgetUsdc?: number | null } = {},
): Promise<{ agentId: string; flowId: string }> {
  const { flowId, agentId } = await seedFlowAndAgent(repo, ownerId);
  await repo.addEmployee({
    agentId,
    companyId,
    departmentId,
    jobDescription: "Does the thing",
    publishGated: overrides.publishGated ?? false,
    monthlyBudgetUsdc: overrides.monthlyBudgetUsdc ?? null,
    payTo: null,
  });
  return { agentId, flowId };
}

/** Creates a run and immediately finishes it with the given cost. */
async function seedCompletedRun(
  repo: SqliteRepo,
  flowId: string,
  agentId: string,
  costUsdc: number,
): Promise<void> {
  const run = await repo.createRun({ flowId, agentId, trigger: "agent" });
  await repo.finishRun(run.id, "done", costUsdc);
}

describe("monthWindowStartUtc", () => {
  it("returns epoch ms for the 1st of the UTC month at 00:00:00.000", () => {
    const now = new Date("2026-07-17T15:42:33.123Z");
    const start = monthWindowStartUtc(now);
    expect(start).toBe(Date.UTC(2026, 6, 1, 0, 0, 0, 0));
    expect(new Date(start).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("is a no-op (still returns the same instant) when now is already month start", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(monthWindowStartUtc(now)).toBe(now.getTime());
  });

  it("uses the UTC month/year, not local wall-clock fields, across a year boundary", () => {
    const now = new Date("2026-12-31T23:59:59.999Z");
    expect(monthWindowStartUtc(now)).toBe(Date.UTC(2026, 11, 1, 0, 0, 0, 0));
    expect(new Date(monthWindowStartUtc(now)).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("findConsumableApproval", () => {
  it("returns the first APPROVED approval matching kind + subjectId, ignoring everything else", () => {
    const approvals: ApprovalRecord[] = [
      {
        id: "a1",
        companyId: "co",
        kind: "fire_publish_gated",
        subjectId: "agent-1",
        status: "pending", // wrong status
        reason: null,
        actionSummary: null,
        costSnapshot: null,
        createdAt: "t",
        decidedAt: null,
      },
      {
        id: "a2",
        companyId: "co",
        kind: "fire_publish_gated",
        subjectId: "agent-2", // wrong subject
        status: "approved",
        reason: null,
        actionSummary: null,
        costSnapshot: null,
        createdAt: "t",
        decidedAt: "t",
      },
      {
        id: "a3",
        companyId: "co",
        kind: "fire_over_threshold", // wrong kind
        subjectId: "agent-1",
        status: "approved",
        reason: null,
        actionSummary: null,
        costSnapshot: null,
        createdAt: "t",
        decidedAt: "t",
      },
      {
        id: "a4",
        companyId: "co",
        kind: "fire_publish_gated",
        subjectId: "agent-1",
        status: "rejected", // wrong status
        reason: "no",
        actionSummary: null,
        costSnapshot: null,
        createdAt: "t",
        decidedAt: "t",
      },
      {
        id: "a5", // the match
        companyId: "co",
        kind: "fire_publish_gated",
        subjectId: "agent-1",
        status: "approved",
        reason: null,
        actionSummary: null,
        costSnapshot: null,
        createdAt: "t",
        decidedAt: "t",
      },
      {
        id: "a6",
        companyId: "co",
        kind: "fire_publish_gated",
        subjectId: "agent-1",
        status: "consumed", // wrong status — already spent
        reason: null,
        actionSummary: null,
        costSnapshot: null,
        createdAt: "t",
        decidedAt: "t",
      },
    ];

    expect(findConsumableApproval(approvals, "fire_publish_gated", "agent-1")?.id).toBe("a5");
  });

  it("returns null when nothing matches, including an empty list", () => {
    expect(findConsumableApproval([], "fire_publish_gated", "agent-1")).toBeNull();
  });
});

describe("fireBlocksForEmployee — each block firing", () => {
  it("blocks with employee_budget_exhausted when month-to-date spend meets or exceeds the employee's cap", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-emp-budget", name: "Co", mission: "M" });
    const department = await repo.createDepartment({ companyId: company.id, name: "Ops" });
    const { agentId, flowId } = await seedEmployee(repo, "owner-emp-budget", company.id, department.id, {
      monthlyBudgetUsdc: 5,
    });
    await seedCompletedRun(repo, flowId, agentId, 5); // spent === cap → blocked ("meets or exceeds")

    const employee = await repo.getEmployeeByAgent(agentId);
    expect(employee).not.toBeNull();

    const result = await fireBlocksForEmployee({
      repo,
      company,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toEqual({ code: "employee_budget_exhausted", agentId });
  });

  it("blocks with department_budget_exhausted using the shared department agent id list, not just this employee", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-dept-budget", name: "Co", mission: "M" });
    const department = await repo.createDepartment({
      companyId: company.id,
      name: "Ops",
      monthlyBudgetUsdc: 10,
    });
    const { agentId: agentA, flowId: flowA } = await seedEmployee(repo, "owner-dept-budget", company.id, department.id);
    const { agentId: agentB, flowId: flowB } = await seedEmployee(repo, "owner-dept-budget", company.id, department.id);

    // agentA's own spend is small; agentB's sibling spend is what tips the department over its cap.
    await seedCompletedRun(repo, flowA, agentA, 3);
    await seedCompletedRun(repo, flowB, agentB, 8); // 3 + 8 = 11 >= 10

    const employee = await repo.getEmployeeByAgent(agentA); // monthlyBudgetUsdc null → employee gate doesn't apply
    const result = await fireBlocksForEmployee({
      repo,
      company,
      department,
      employee: employee!,
      departmentAgentIds: [agentA, agentB],
      now: new Date(),
    });

    expect(result).toEqual({ code: "department_budget_exhausted", departmentId: department.id });
  });

  it("blocks with approval_required_publish_gated when publishGated and no APPROVED fire_publish_gated approval exists", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-publish-block", name: "Co", mission: "M" });
    const department = await repo.createDepartment({ companyId: company.id, name: "Marketing" });
    const { agentId } = await seedEmployee(repo, "owner-publish-block", company.id, department.id, {
      publishGated: true,
    });

    // A merely pending approval must not satisfy the gate.
    await repo.createApproval({ companyId: company.id, kind: "fire_publish_gated", subjectId: agentId });

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toEqual({ code: "approval_required_publish_gated", agentId });
  });

  it("blocks with approval_required_over_threshold using only the most recent COMPLETED run's cost", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-threshold-block", name: "Co", mission: "M" });
    const withThreshold = await repo.updateCompany(company.id, { fireCostThresholdUsdc: 1 });
    const department = await repo.createDepartment({ companyId: company.id, name: "Ops" });
    const { agentId, flowId } = await seedEmployee(repo, "owner-threshold-block", company.id, department.id);

    // Older completed run: cheap, under threshold — must NOT be the one evaluated.
    await seedCompletedRun(repo, flowId, agentId, 0.1);
    await sleep(5);
    // Most recent completed run: over threshold — this is the one that matters.
    await seedCompletedRun(repo, flowId, agentId, 5);
    await sleep(5);
    // Started after both, never finished — must be ignored (finishedAt is null).
    await repo.createRun({ flowId, agentId, trigger: "agent" });

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company: withThreshold!,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toEqual({ code: "approval_required_over_threshold", agentId });
  });
});

describe("fireBlocksForEmployee — each gate passing", () => {
  it("passes the employee budget gate when month-to-date spend is under the cap", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-emp-under", name: "Co", mission: "M" });
    const department = await repo.createDepartment({ companyId: company.id, name: "Ops" });
    const { agentId, flowId } = await seedEmployee(repo, "owner-emp-under", company.id, department.id, {
      monthlyBudgetUsdc: 10,
    });
    await seedCompletedRun(repo, flowId, agentId, 3); // well under the $10 cap

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toBeNull();
  });

  it("passes the department budget gate when month-to-date spend is under the cap", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-dept-under", name: "Co", mission: "M" });
    const department = await repo.createDepartment({
      companyId: company.id,
      name: "Ops",
      monthlyBudgetUsdc: 100,
    });
    const { agentId, flowId } = await seedEmployee(repo, "owner-dept-under", company.id, department.id);
    await seedCompletedRun(repo, flowId, agentId, 3); // well under the $100 cap

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toBeNull();
  });

  it("passes the publish gate when an APPROVED fire_publish_gated approval exists for the agent", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-publish-ok", name: "Co", mission: "M" });
    const department = await repo.createDepartment({ companyId: company.id, name: "Marketing" });
    const { agentId } = await seedEmployee(repo, "owner-publish-ok", company.id, department.id, {
      publishGated: true,
    });

    const approval = await repo.createApproval({
      companyId: company.id,
      kind: "fire_publish_gated",
      subjectId: agentId,
    });
    await repo.decideApproval(approval.id, "approved");

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toBeNull();
  });

  it("passes the threshold gate when an APPROVED fire_over_threshold approval exists despite the cost breach", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-threshold-ok", name: "Co", mission: "M" });
    const withThreshold = await repo.updateCompany(company.id, { fireCostThresholdUsdc: 1 });
    const department = await repo.createDepartment({ companyId: company.id, name: "Ops" });
    const { agentId, flowId } = await seedEmployee(repo, "owner-threshold-ok", company.id, department.id);
    await seedCompletedRun(repo, flowId, agentId, 5); // over the $1 threshold

    const approval = await repo.createApproval({
      companyId: company.id,
      kind: "fire_over_threshold",
      subjectId: agentId,
    });
    await repo.decideApproval(approval.id, "approved");

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company: withThreshold!,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toBeNull();
  });

  it("disables the threshold gate entirely when fireCostThresholdUsdc is null, regardless of run cost", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-threshold-null", name: "Co", mission: "M" });
    expect(company.fireCostThresholdUsdc).toBeNull();
    const department = await repo.createDepartment({ companyId: company.id, name: "Ops" });
    const { agentId, flowId } = await seedEmployee(repo, "owner-threshold-null", company.id, department.id);
    await seedCompletedRun(repo, flowId, agentId, 999); // would breach any real threshold

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toBeNull();
  });
});

describe("fireBlocksForEmployee — check order (first hit wins)", () => {
  it("reports employee_budget_exhausted first when the employee is over budget AND publish-gated", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-order-1", name: "Co", mission: "M" });
    const withThreshold = await repo.updateCompany(company.id, { fireCostThresholdUsdc: 1 });
    const department = await repo.createDepartment({
      companyId: company.id,
      name: "Ops",
      monthlyBudgetUsdc: 1,
    });
    const { agentId, flowId } = await seedEmployee(repo, "owner-order-1", company.id, department.id, {
      monthlyBudgetUsdc: 2,
      publishGated: true,
    });
    // One run breaches the employee budget, the department budget, AND the
    // threshold at once; publishGated has no approval either. Every later
    // gate would also fire — only the first (employee budget) may report.
    await seedCompletedRun(repo, flowId, agentId, 5);

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company: withThreshold!,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toEqual({ code: "employee_budget_exhausted", agentId });
  });

  it("reports department_budget_exhausted before the publish and threshold gates when the employee budget gate does not apply", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-order-2", name: "Co", mission: "M" });
    const withThreshold = await repo.updateCompany(company.id, { fireCostThresholdUsdc: 1 });
    const department = await repo.createDepartment({
      companyId: company.id,
      name: "Ops",
      monthlyBudgetUsdc: 1,
    });
    const { agentId, flowId } = await seedEmployee(repo, "owner-order-2", company.id, department.id, {
      monthlyBudgetUsdc: null, // employee gate does not apply
      publishGated: true,
    });
    // Breaches the department budget (>=1) and the threshold (>1); publishGated has no approval.
    await seedCompletedRun(repo, flowId, agentId, 5);

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company: withThreshold!,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toEqual({ code: "department_budget_exhausted", departmentId: department.id });
  });

  it("reports approval_required_publish_gated before the threshold gate when both budgets pass", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-order-3", name: "Co", mission: "M" });
    const withThreshold = await repo.updateCompany(company.id, { fireCostThresholdUsdc: 1 });
    const department = await repo.createDepartment({ companyId: company.id, name: "Ops" }); // no dept cap
    const { agentId, flowId } = await seedEmployee(repo, "owner-order-3", company.id, department.id, {
      publishGated: true,
    });
    await seedCompletedRun(repo, flowId, agentId, 5); // breaches the threshold (>1); no publish approval

    const employee = await repo.getEmployeeByAgent(agentId);
    const result = await fireBlocksForEmployee({
      repo,
      company: withThreshold!,
      department,
      employee: employee!,
      departmentAgentIds: [agentId],
      now: new Date(),
    });

    expect(result).toEqual({ code: "approval_required_publish_gated", agentId });
  });
});
