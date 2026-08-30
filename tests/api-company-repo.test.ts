/**
 * Tests for the company domain repo methods (SqliteRepo) — company,
 * department, employee, and approval CRUD, budget cost summation, and
 * settlement-window listing. See src/lib/company/types.ts and the company
 * section of FlowRepo in src/lib/db/repo.ts for the contract each method
 * must satisfy.
 */

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

/** A real flow + agent pair — company_employees/runs have no FK on agent_id,
 *  but seeding real rows keeps these tests representative of production. */
async function seedAgent(
  repo: SqliteRepo,
  ownerId: string,
): Promise<{ flowId: string; agentId: string }> {
  const flow = await repo.saveFlow({
    ownerId,
    name: "Company Test Flow",
    graph: { id: "g-company-test", name: "test", nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: "company-test-" + Math.random().toString(36).slice(2, 8),
    status: "live",
    priceUsdc: 0.25,
  });
  return { flowId: flow.id, agentId: agent.id };
}

async function seedCompanyWithEmployee(
  repo: SqliteRepo,
  ownerId: string,
): Promise<{ companyId: string; departmentId: string; agentId: string }> {
  const company = await repo.createCompany({ ownerId, name: "Test Co", mission: "Ship things" });
  const department = await repo.createDepartment({ companyId: company.id, name: "Ops" });
  const { agentId } = await seedAgent(repo, ownerId);
  await repo.addEmployee({
    agentId,
    companyId: company.id,
    departmentId: department.id,
    jobDescription: "Does the thing",
    publishGated: false,
    monthlyBudgetUsdc: null,
    payTo: null,
  });
  return { companyId: company.id, departmentId: department.id, agentId };
}

describe("company repo — companies", () => {
  it("round-trips create → get → listCompaniesByOwner → updateCompany", async () => {
    const repo = makeRepo();
    const created = await repo.createCompany({
      ownerId: "owner-1",
      name: "Rights Precheck Shop",
      mission: "Clear rights fast",
    });
    expect(created.status).toBe("draft");
    expect(created.fireCostThresholdUsdc).toBeNull();
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();

    const fetched = await repo.getCompany(created.id);
    expect(fetched).toEqual(created);
    expect(await repo.getCompany("no-such-company")).toBeNull();

    const listed = await repo.listCompaniesByOwner("owner-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
    // Owner isolation: a different owner sees nothing.
    expect(await repo.listCompaniesByOwner("owner-other")).toHaveLength(0);

    const updated = await repo.updateCompany(created.id, {
      name: "Rights Precheck Co",
      mission: "Clear rights faster",
      status: "active",
      fireCostThresholdUsdc: 5,
    });
    expect(updated?.name).toBe("Rights Precheck Co");
    expect(updated?.mission).toBe("Clear rights faster");
    expect(updated?.status).toBe("active");
    expect(updated?.fireCostThresholdUsdc).toBe(5);
    expect(updated?.id).toBe(created.id);
    expect(updated?.ownerId).toBe("owner-1");
    expect(updated?.createdAt).toBe(created.createdAt);

    // A partial update omitting a field preserves its prior value.
    const untouched = await repo.updateCompany(created.id, { name: "Rights Precheck Co v2" });
    expect(untouched?.status).toBe("active");
    expect(untouched?.fireCostThresholdUsdc).toBe(5);
    expect(untouched?.mission).toBe("Clear rights faster");

    // Explicit null clears the threshold — distinct from "not provided".
    const cleared = await repo.updateCompany(created.id, { fireCostThresholdUsdc: null });
    expect(cleared?.fireCostThresholdUsdc).toBeNull();
    expect(cleared?.name).toBe("Rights Precheck Co v2");

    expect(await repo.updateCompany("no-such-company", { name: "x" })).toBeNull();
  });
});

describe("company repo — departments", () => {
  it("creates, lists, and budgets departments", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-2", name: "Co", mission: "M" });

    const dept1 = await repo.createDepartment({
      companyId: company.id,
      name: "Operations",
      monthlyBudgetUsdc: 100,
    });
    const dept2 = await repo.createDepartment({ companyId: company.id, name: "Marketing" });
    expect(dept1.monthlyBudgetUsdc).toBe(100);
    expect(dept2.monthlyBudgetUsdc).toBeNull(); // omitted budget defaults to null
    expect(dept1.companyId).toBe(company.id);

    const listed = await repo.listDepartments(company.id);
    expect(listed).toHaveLength(2);
    expect(listed.map((d) => d.name).sort()).toEqual(["Marketing", "Operations"]);
    expect(await repo.listDepartments("no-such-company")).toHaveLength(0);

    await repo.setDepartmentBudget(dept2.id, 250);
    let afterBudget = (await repo.listDepartments(company.id)).find((d) => d.id === dept2.id);
    expect(afterBudget?.monthlyBudgetUsdc).toBe(250);

    await repo.setDepartmentBudget(dept1.id, null);
    afterBudget = (await repo.listDepartments(company.id)).find((d) => d.id === dept1.id);
    expect(afterBudget?.monthlyBudgetUsdc).toBeNull();
  });
});

describe("company repo — employees", () => {
  it("addEmployee is idempotent on agentId — the first write wins", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-3", name: "Co", mission: "M" });
    const department = await repo.createDepartment({ companyId: company.id, name: "Ops" });
    const { agentId } = await seedAgent(repo, "owner-3");

    await repo.addEmployee({
      agentId,
      companyId: company.id,
      departmentId: department.id,
      jobDescription: "First description",
      publishGated: false,
      monthlyBudgetUsdc: 10,
      payTo: null,
    });
    // Second add with a different jobDescription (and different everything
    // else) must be a no-op — the first write wins.
    await repo.addEmployee({
      agentId,
      companyId: company.id,
      departmentId: department.id,
      jobDescription: "Second description — should be ignored",
      publishGated: true,
      payTo: null,
      monthlyBudgetUsdc: 999,
    });

    const employee = await repo.getEmployeeByAgent(agentId);
    expect(employee?.jobDescription).toBe("First description");
    expect(employee?.publishGated).toBe(false);
    expect(employee?.monthlyBudgetUsdc).toBe(10);

    const listed = await repo.listEmployees(company.id);
    expect(listed).toHaveLength(1);
  });

  it("getEmployeeByAgent, removeEmployee, and updateEmployee behave as documented", async () => {
    const repo = makeRepo();
    const { companyId, departmentId, agentId } = await seedCompanyWithEmployee(repo, "owner-4");

    expect(await repo.getEmployeeByAgent("no-such-agent")).toBeNull();
    const before = await repo.getEmployeeByAgent(agentId);
    expect(before?.companyId).toBe(companyId);
    expect(before?.departmentId).toBe(departmentId);
    expect(before?.publishGated).toBe(false);

    // Partial update: only jobDescription changes, budget/department survive.
    await repo.updateEmployee(agentId, { jobDescription: "Updated job" });
    let after = await repo.getEmployeeByAgent(agentId);
    expect(after?.jobDescription).toBe("Updated job");
    expect(after?.monthlyBudgetUsdc).toBeNull();
    expect(after?.departmentId).toBe(departmentId);

    // Explicit null clears the budget — distinct from "not provided".
    await repo.updateEmployee(agentId, { monthlyBudgetUsdc: 42 });
    after = await repo.getEmployeeByAgent(agentId);
    expect(after?.monthlyBudgetUsdc).toBe(42);
    await repo.updateEmployee(agentId, { monthlyBudgetUsdc: null });
    after = await repo.getEmployeeByAgent(agentId);
    expect(after?.monthlyBudgetUsdc).toBeNull();
    expect(after?.jobDescription).toBe("Updated job"); // untouched field survives

    // updateEmployee on an unknown agent is a silent no-op.
    await expect(repo.updateEmployee("no-such-agent", { jobDescription: "x" })).resolves.toBeUndefined();

    expect(await repo.removeEmployee(agentId)).toBe(true);
    expect(await repo.getEmployeeByAgent(agentId)).toBeNull();
    expect(await repo.removeEmployee(agentId)).toBe(false); // already gone
  });
});

describe("company repo — approvals", () => {
  it("runs the create → decide → consume lifecycle with correct guard rails", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-5", name: "Co", mission: "M" });

    const approval = await repo.createApproval({
      companyId: company.id,
      kind: "fire_publish_gated",
      subjectId: "agent-xyz",
      actionSummary: "Run campaign publisher for the reviewed launch",
      costSnapshot: {
        basis: "estimated",
        amountUsdc: 0.42,
        note: "Estimate from the current immutable execution plan.",
      },
    });
    expect(approval.status).toBe("pending");
    expect(approval.reason).toBeNull();
    expect(approval.actionSummary).toBe("Run campaign publisher for the reviewed launch");
    expect(approval.costSnapshot).toEqual({
      basis: "estimated",
      amountUsdc: 0.42,
      note: "Estimate from the current immutable execution plan.",
    });
    expect(approval.decidedAt).toBeNull();

    expect(await repo.getApproval(approval.id)).toEqual(approval);
    expect(await repo.getApproval("no-such-approval")).toBeNull();

    const pendingOnly = await repo.listApprovals(company.id, "pending");
    expect(pendingOnly).toHaveLength(1);
    expect(await repo.listApprovals(company.id, "approved")).toHaveLength(0);
    expect(await repo.listApprovals(company.id)).toHaveLength(1); // no filter → all statuses

    const decided = await repo.decideApproval(approval.id, "approved", "looks good");
    expect(decided?.status).toBe("approved");
    expect(decided?.reason).toBe("looks good");
    expect(decided?.decidedAt).toBeTruthy();

    // A second decide on an already-decided approval returns null.
    expect(await repo.decideApproval(approval.id, "rejected", "too late")).toBeNull();
    // ...and leaves the row unchanged.
    const stillApproved = await repo.getApproval(approval.id);
    expect(stillApproved?.status).toBe("approved");
    expect(stillApproved?.reason).toBe("looks good");

    expect(await repo.listApprovals(company.id, "approved")).toHaveLength(1);

    // consumeApproval only succeeds from approved.
    expect(await repo.consumeApproval(approval.id)).toBe(true);
    const consumed = await repo.getApproval(approval.id);
    expect(consumed?.status).toBe("consumed");

    // Consuming again fails — no longer approved.
    expect(await repo.consumeApproval(approval.id)).toBe(false);

    // Compensation can restore only an approval this action consumed.
    expect(await repo.restoreApproval(approval.id)).toBe(true);
    expect((await repo.getApproval(approval.id))?.status).toBe("approved");
    expect(await repo.restoreApproval(approval.id)).toBe(false);
  });

  it("refuses decide/consume on a still-pending approval and handles unknown ids", async () => {
    const repo = makeRepo();
    const company = await repo.createCompany({ ownerId: "owner-6", name: "Co", mission: "M" });
    const approval = await repo.createApproval({
      companyId: company.id,
      kind: "enable_live_selling",
      subjectId: "agent-abc",
    });
    expect(approval.actionSummary).toBeNull();
    expect(approval.costSnapshot).toBeNull();

    // consumeApproval before any decision: still pending, must fail.
    expect(await repo.consumeApproval(approval.id)).toBe(false);
    const stillPending = await repo.getApproval(approval.id);
    expect(stillPending?.status).toBe("pending");

    // decideApproval with no reason argument stores null.
    const rejected = await repo.decideApproval(approval.id, "rejected");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.reason).toBeNull();

    // rejected is a dead end too — consumeApproval only accepts approved.
    expect(await repo.consumeApproval(approval.id)).toBe(false);

    // Unknown approval id.
    expect(await repo.decideApproval("no-such-id", "approved")).toBeNull();
    expect(await repo.consumeApproval("no-such-id")).toBe(false);
    expect(await repo.restoreApproval(approval.id)).toBe(false);
    expect(await repo.restoreApproval("no-such-id")).toBe(false);
  });

  it("reads pre-snapshot approval rows with null optional fields", async () => {
    const db = new Database(":memory:");
    runSqliteMigrations(db);
    const repo = new SqliteRepo(db);
    const company = await repo.createCompany({ ownerId: "owner-legacy", name: "Co", mission: "M" });
    db.prepare(
      `INSERT INTO company_approvals
       (id, company_id, kind, subject_id, status, reason, created_at, decided_at)
       VALUES ('approval-legacy', ?, 'fire_over_threshold', 'agent-legacy', 'pending', NULL, ?, NULL)`,
    ).run(company.id, new Date().toISOString());

    await expect(repo.getApproval("approval-legacy")).resolves.toMatchObject({
      id: "approval-legacy",
      actionSummary: null,
      costSnapshot: null,
    });
  });
});

describe("company repo — sumCostByAgents", () => {
  it("returns 0 for an empty agent list without querying", async () => {
    const repo = makeRepo();
    expect(await repo.sumCostByAgents([], 0)).toBe(0);
    expect(await repo.sumCostByAgents([], 0, Date.now())).toBe(0);
  });

  it("sums exactly the given agents' runs within [sinceMs, untilMs)", async () => {
    const repo = makeRepo();
    const { agentId: agentA, flowId: flowA } = await seedAgent(repo, "owner-7");
    const { agentId: agentB, flowId: flowB } = await seedAgent(repo, "owner-7");
    const { agentId: agentC, flowId: flowC } = await seedAgent(repo, "owner-7"); // excluded from the query

    const runA = await repo.createRun({ flowId: flowA, agentId: agentA, trigger: "agent" });
    await repo.finishRun(runA.id, "done", 1.5);
    const runB = await repo.createRun({ flowId: flowB, agentId: agentB, trigger: "agent" });
    await repo.finishRun(runB.id, "done", 2.25);
    const runC = await repo.createRun({ flowId: flowC, agentId: agentC, trigger: "agent" });
    await repo.finishRun(runC.id, "done", 100); // must never be summed — agentC not in the query

    const wideFuture = Date.now() + 10_000;

    // sinceMs=0, untilMs=wideFuture → the whole window, both agents.
    expect(await repo.sumCostByAgents([agentA, agentB], 0, wideFuture)).toBe(1.5 + 2.25);

    // untilMs=0 excludes everything: no run can have started_at < 0.
    expect(await repo.sumCostByAgents([agentA, agentB], 0, 0)).toBe(0);

    // sinceMs in the far future excludes every run that already happened.
    expect(await repo.sumCostByAgents([agentA, agentB], wideFuture)).toBe(0);

    // untilMs omitted → open-ended upper bound, still respects sinceMs=0.
    expect(await repo.sumCostByAgents([agentA, agentB], 0)).toBe(1.5 + 2.25);

    // Only the requested agent is summed when given alone.
    expect(await repo.sumCostByAgents([agentA], 0, wideFuture)).toBe(1.5);
  });
});

describe("company repo — listSettlementsByAgents", () => {
  it("returns [] for an empty agent list without querying", async () => {
    const repo = makeRepo();
    expect(
      await repo.listSettlementsByAgents([], "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("respects [fromIso, toIso) window bounds and maps rows like getSettlementByRun", async () => {
    const repo = makeRepo();
    const { agentId: agentA, flowId: flowA } = await seedAgent(repo, "owner-8");
    const { agentId: agentB, flowId: flowB } = await seedAgent(repo, "owner-8");
    const { agentId: agentC, flowId: flowC } = await seedAgent(repo, "owner-8"); // excluded from the query

    const runA = await repo.createRun({ flowId: flowA, agentId: agentA, trigger: "agent" });
    await repo.finishRun(runA.id, "done", 0.25);
    await repo.recordSettlement({
      runId: runA.id,
      agentId: agentA,
      ownerId: "owner-8",
      grossUsdc: 0.25,
      creatorUsdc: 0.25,
      platformUsdc: 0,
      payTo: "0x1111111111111111111111111111111111111111",
      payoutSource: "creator",
      payer: "0x2222222222222222222222222222222222222222",
      tx: "0xabc",
    });

    const runB = await repo.createRun({ flowId: flowB, agentId: agentB, trigger: "agent" });
    await repo.finishRun(runB.id, "done", 0.5);
    await repo.recordSettlement({
      runId: runB.id,
      agentId: agentB,
      ownerId: "owner-8",
      grossUsdc: 0.5,
      creatorUsdc: 0.5,
      platformUsdc: 0,
      payTo: "0x1111111111111111111111111111111111111111",
      payoutSource: "creator",
      payer: null,
      tx: null,
    });

    const runC = await repo.createRun({ flowId: flowC, agentId: agentC, trigger: "agent" });
    await repo.finishRun(runC.id, "done", 5);
    await repo.recordSettlement({
      runId: runC.id,
      agentId: agentC,
      ownerId: "owner-8",
      grossUsdc: 5,
      creatorUsdc: 5,
      platformUsdc: 0,
      payTo: "0x1111111111111111111111111111111111111111",
      payoutSource: "creator",
      payer: null,
      tx: null,
    });

    const past = "2000-01-01T00:00:00.000Z";
    const pastEnd = "2000-06-01T00:00:00.000Z"; // still well before real data
    const future = new Date(Date.now() + 10_000).toISOString();
    const futureEnd = new Date(Date.now() + 20_000).toISOString();

    // A window spanning past → future returns exactly agentA and agentB's
    // settlements — never agentC's, which was excluded from the id list.
    const wide = await repo.listSettlementsByAgents([agentA, agentB], past, futureEnd);
    expect(wide).toHaveLength(2);
    expect(wide.map((s) => s.runId).sort()).toEqual([runA.id, runB.id].sort());
    expect(wide.some((s) => s.agentId === agentC)).toBe(false);

    // A window entirely before any real data (toIso bound excludes).
    expect(await repo.listSettlementsByAgents([agentA, agentB], past, pastEnd)).toHaveLength(0);

    // A window entirely after any real data (fromIso bound excludes).
    expect(await repo.listSettlementsByAgents([agentA, agentB], future, futureEnd)).toHaveLength(0);

    // Row mapping matches getSettlementByRun field-for-field.
    const direct = await repo.getSettlementByRun(runA.id);
    const viaList = wide.find((s) => s.runId === runA.id);
    expect(viaList).toEqual(direct);
  });
});
