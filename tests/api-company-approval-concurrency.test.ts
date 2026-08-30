import { describe, expect, it, vi } from "vitest";
import { handleSettlementToggle } from "@/lib/cli/settlement-handler";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

async function seedGatedEmployee() {
  const repo = new SqliteRepo(":memory:");
  const ownerId = "approval-concurrency-owner";
  const company = await repo.createCompany({
    ownerId,
    name: "Concurrency Co",
    mission: "Keep one-use approvals one-use.",
  });
  const department = await repo.createDepartment({
    companyId: company.id,
    name: "Operations",
  });
  const flow = await repo.saveFlow({
    ownerId,
    name: "Approval concurrency flow",
    graph: { id: "approval-concurrency-graph", name: "test", nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: `approval-concurrency-agent-${Math.random().toString(36).slice(2, 8)}`,
    status: "live",
    priceUsdc: 0.25,
  });
  await repo.addEmployee({
    agentId: agent.id,
    companyId: company.id,
    departmentId: department.id,
    jobDescription: "Sell only with founder approval.",
    publishGated: false,
    monthlyBudgetUsdc: null,
    payTo: null,
  });
  await handleSettlementToggle(agent.slug, ownerId, { live: false }, repo);
  const approval = await repo.createApproval({
    companyId: company.id,
    kind: "enable_live_selling",
    subjectId: agent.id,
  });
  await repo.decideApproval(approval.id, "approved");
  return { repo, ownerId, agent, approval };
}

describe("company approval consumption concurrency", () => {
  it("does not enable live selling when another request wins approval consumption", async () => {
    const { repo, ownerId, agent, approval } = await seedGatedEmployee();
    vi.spyOn(repo, "consumeApproval").mockResolvedValueOnce(false);

    const result = await handleSettlementToggle(agent.slug, ownerId, { live: true }, repo);

    expect(result).toEqual({ kind: "approval_required" });
    expect((await repo.getAgent(agent.id))?.settlementLive).toBe(false);
    expect((await repo.getApproval(approval.id))?.status).toBe("approved");
  });

  it("restores live-selling approval when the final agent update definitely fails", async () => {
    const { repo, ownerId, agent, approval } = await seedGatedEmployee();
    vi.spyOn(repo, "updateAgent").mockResolvedValueOnce(null);

    const result = await handleSettlementToggle(agent.slug, ownerId, { live: true }, repo);

    expect(result).toEqual({ kind: "not_found" });
    expect((await repo.getAgent(agent.id))?.settlementLive).toBe(false);
    expect((await repo.getApproval(approval.id))?.status).toBe("approved");
  });
});
