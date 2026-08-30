import { describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { buildOperatingSystemSnapshot } from "@/lib/company/operating-system/snapshot";

async function seedCompany(repo: SqliteRepo, ownerId: string): Promise<string> {
  const company = await repo.createCompany({
    ownerId,
    name: "Evidence Company",
    mission: "Produce one governed proof receipt.",
  });
  const department = await repo.createDepartment({
    companyId: company.id,
    name: "Operations",
  });
  const flow = await repo.saveFlow({
    ownerId,
    name: "Evidence flow",
    graph: { id: "graph-evidence", name: "Evidence flow", nodes: [], edges: [] },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: "evidence-agent",
    status: "live",
    priceUsdc: 0,
  });
  await repo.addEmployee({
    agentId: agent.id,
    companyId: company.id,
    departmentId: department.id,
    jobDescription: "Produces an evidence receipt",
    publishGated: false,
    monthlyBudgetUsdc: null,
    payTo: null,
  });
  await repo.updateCompany(company.id, { status: "active" });
  await repo.createApproval({
    companyId: company.id,
    kind: "enable_live_selling",
    subjectId: agent.id,
    actionSummary: "Enable live selling for the evidence agent",
    costSnapshot: {
      basis: "quoted",
      amountUsdc: 0,
      note: "No paid run is executed by this setting change.",
    },
  });
  return company.id;
}

describe("Suede Operating System snapshot", () => {
  it("combines the estate fixture with current owner-scoped Company evidence", async () => {
    const ownerId = "sb:operating-owner";
    const repo = new SqliteRepo(":memory:");
    const companyId = await seedCompany(repo, ownerId);

    const snapshot = await buildOperatingSystemSnapshot({
      ownerId,
      companyRepo: repo,
      projectRepo: null,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(snapshot.projects.some((project) => project.id === "estate:agent-studio")).toBe(true);
    expect(snapshot.projects.find((project) => project.id === `company:${companyId}`)).toMatchObject({
      name: "Evidence Company",
      status: "live",
      lastVerifiedAt: "2026-07-29T12:00:00.000Z",
      productionClaim: false,
    });
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.findings.some((finding) => finding.rule === "unresolved-approval")).toBe(true);
    expect(snapshot.adapters.find((adapter) => adapter.adapterId === "company-runtime")?.status).toBe("partial");
    expect(JSON.stringify(snapshot)).not.toContain(ownerId);
  });

  it("compares a fresh review with the prior bounded baseline", async () => {
    const ownerId = "sb:operating-diff-owner";
    const repo = new SqliteRepo(":memory:");
    const companyId = await seedCompany(repo, ownerId);
    const first = await buildOperatingSystemSnapshot({
      ownerId,
      companyRepo: repo,
      projectRepo: null,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    await repo.updateCompany(companyId, { status: "paused" });
    const second = await buildOperatingSystemSnapshot({
      ownerId,
      companyRepo: repo,
      projectRepo: null,
      baseline: first.baseline,
      now: new Date("2026-07-29T12:05:00.000Z"),
    });

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.projects.find((project) => project.id === `company:${companyId}`)?.status).toBe("paused");
    expect(second.executive.changed).toContainEqual({
      kind: "status",
      projectId: `company:${companyId}`,
      summary: `company:${companyId} moved from live to paused.`,
    });
  });

  it("does not report a state change when only the review time advances", async () => {
    const ownerId = "sb:operating-stable-owner";
    const repo = new SqliteRepo(":memory:");
    await seedCompany(repo, ownerId);
    const first = await buildOperatingSystemSnapshot({
      ownerId,
      companyRepo: repo,
      projectRepo: null,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    const second = await buildOperatingSystemSnapshot({
      ownerId,
      companyRepo: repo,
      projectRepo: null,
      baseline: first.baseline,
      now: new Date("2026-07-29T12:05:00.000Z"),
    });

    expect(second.executive.changed).toEqual([]);
  });

  it("does not compare a client baseline from a different owner scope", async () => {
    const repo = new SqliteRepo(":memory:");
    const first = await buildOperatingSystemSnapshot({
      ownerId: "sb:first-owner",
      companyRepo: repo,
      projectRepo: null,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    const second = await buildOperatingSystemSnapshot({
      ownerId: "sb:second-owner",
      companyRepo: repo,
      projectRepo: null,
      baseline: first.baseline,
      now: new Date("2026-07-29T12:05:00.000Z"),
    });

    expect(second.baseline.scopeId).not.toBe(first.baseline.scopeId);
    expect(second.executive.changed).toEqual([{
      kind: "finding",
      projectId: null,
      summary: "Initial review established; no prior snapshot was supplied for comparison.",
    }]);
  });
});
