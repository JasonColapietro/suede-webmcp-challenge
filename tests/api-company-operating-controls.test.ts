import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { materializeCompanyDraft, templateToDraft } from "@/lib/company/founding";

const state = vi.hoisted(() => ({
  owner: "owner-company-operating",
  getRepo: vi.fn(),
  resolveOwnerId: vi.fn(),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: (...args: unknown[]) => state.getRepo(...args),
}));

vi.mock("@/lib/auth", () => ({
  resolveOwnerId: (...args: unknown[]) => state.resolveOwnerId(...args),
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error {
    status = 401;
  },
}));

let repo: SqliteRepo;

beforeEach(() => {
  vi.clearAllMocks();
  state.owner = "owner-company-operating";
  repo = new SqliteRepo(":memory:");
  state.getRepo.mockImplementation(async () => repo);
  state.resolveOwnerId.mockImplementation(async () => state.owner);
});

async function seedCompany(): Promise<{
  companyId: string;
  departmentId: string;
  agentId: string;
  flowId: string;
}> {
  const draft = templateToDraft("rights-precheck-shop");
  if (!draft) throw new Error("rights-precheck-shop template missing");
  const { companyId } = await materializeCompanyDraft(state.owner, draft, repo);
  const employee = (await repo.listEmployees(companyId))[0];
  if (!employee) throw new Error("founded employee missing");
  const agent = await repo.getAgent(employee.agentId);
  if (!agent) throw new Error("founded agent missing");
  return {
    companyId,
    departmentId: employee.departmentId,
    agentId: employee.agentId,
    flowId: agent.flowId,
  };
}

function companyContext(companyId: string) {
  return { params: Promise.resolve({ id: companyId }) };
}

function employeeContext(companyId: string, agentId: string) {
  return { params: Promise.resolve({ id: companyId, agentId }) };
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

describe("company operating controls", () => {
  it("unpublishes a removed employee and preserves agent, flow, and company history", async () => {
    const { DELETE } = await import("@/app/api/companies/[id]/employees/[agentId]/route");
    const seeded = await seedCompany();
    const flowBefore = await repo.getFlow(seeded.flowId);
    await repo.updateAgent(seeded.agentId, { status: "live", settlementLive: true });

    const response = await DELETE(
      new Request(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/employees/${seeded.agentId}`, {
        method: "DELETE",
      }),
      employeeContext(seeded.companyId, seeded.agentId),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true, agentId: seeded.agentId });
    expect(await repo.getEmployeeByAgent(seeded.agentId)).toBeNull();
    expect(await repo.listEmployees(seeded.companyId)).not.toContainEqual(
      expect.objectContaining({ agentId: seeded.agentId }),
    );
    expect(await repo.listCompanyEmployeeHistory(seeded.companyId)).toContainEqual(
      expect.objectContaining({ agentId: seeded.agentId, departmentId: seeded.departmentId }),
    );
    expect(await repo.getAgent(seeded.agentId)).toMatchObject({
      id: seeded.agentId,
      status: "draft",
      settlementLive: false,
    });
    expect(await repo.getFlow(seeded.flowId)).toEqual(flowBefore);
  });

  it("keeps removed employee run identity visible in the company activity stream", async () => {
    const { DELETE } = await import("@/app/api/companies/[id]/employees/[agentId]/route");
    const { GET } = await import("@/app/api/companies/[id]/activity/route");
    const seeded = await seedCompany();
    const run = await repo.createRun({
      flowId: seeded.flowId,
      agentId: seeded.agentId,
      trigger: "company-fire",
    });
    await repo.finishRun(run.id, "done", 0.03);

    expect((await DELETE(
      new Request(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/employees/${seeded.agentId}`, {
        method: "DELETE",
      }),
      employeeContext(seeded.companyId, seeded.agentId),
    )).status).toBe(200);

    const url = new URL(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/activity`);
    url.searchParams.set("month", currentMonth());
    url.searchParams.set("employeeId", seeded.agentId);
    const response = await GET(new Request(url), companyContext(seeded.companyId));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activities: [expect.objectContaining({
        id: `run:${run.id}`,
        employeeId: seeded.agentId,
        departmentId: seeded.departmentId,
      })],
    });
  });

  it("owner-scopes removal and does not remove a foreign membership", async () => {
    const { DELETE } = await import("@/app/api/companies/[id]/employees/[agentId]/route");
    const seeded = await seedCompany();
    state.owner = "owner-someone-else";

    const response = await DELETE(
      new Request(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/employees/${seeded.agentId}`, {
        method: "DELETE",
      }),
      employeeContext(seeded.companyId, seeded.agentId),
    );

    expect(response.status).toBe(404);
    expect(await repo.getEmployeeByAgent(seeded.agentId)).not.toBeNull();
  });

  it("reconstructs run, output, approval, cost, and receipt history from persisted rows", async () => {
    const { GET } = await import("@/app/api/companies/[id]/activity/route");
    const seeded = await seedCompany();
    const run = await repo.createRun({
      flowId: seeded.flowId,
      agentId: seeded.agentId,
      trigger: "company-fire",
    });
    await repo.appendStep({
      runId: run.id,
      nodeId: "output",
      nodeType: "output",
      status: "done",
      costUsdc: 0.04,
      output: { report: "rights check complete" },
    });
    await repo.finishRun(run.id, "done", 0.04);
    await repo.recordSettlement({
      runId: run.id,
      agentId: seeded.agentId,
      ownerId: state.owner,
      grossUsdc: 0.25,
      creatorUsdc: 0.25,
      platformUsdc: 0,
      payTo: "0xCreator",
      payoutSource: "creator",
      payer: "0xPayer",
      tx: "0xReceipt",
    });
    const approval = await repo.createApproval({
      companyId: seeded.companyId,
      kind: "fire_over_threshold",
      subjectId: seeded.agentId,
    });
    await repo.decideApproval(approval.id, "rejected", "Not this month");

    const url = new URL(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/activity`);
    url.searchParams.set("month", currentMonth());
    url.searchParams.set("employeeId", seeded.agentId);
    url.searchParams.set("departmentId", seeded.departmentId);
    const response = await GET(new Request(url), companyContext(seeded.companyId));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      activities: Array<Record<string, unknown>>;
      hasMore: boolean;
    };
    expect(body.hasMore).toBe(false);
    const runEntry = body.activities.find((entry) => entry.id === `run:${run.id}`);
    expect(runEntry).toMatchObject({
      kind: "run",
      employeeId: seeded.agentId,
      departmentId: seeded.departmentId,
      status: "done",
      trigger: "company-fire",
      costUsdc: 0.04,
      receipt: {
        tx: "0xReceipt",
        payer: "0xPayer",
        grossUsdc: 0.25,
        creatorUsdc: 0.25,
      },
    });
    expect(runEntry?.outcome).toMatchObject({ kind: "output", nodeId: "output" });
    expect(JSON.stringify(runEntry?.outcome)).toContain("rights check complete");
    expect(body.activities).toContainEqual(
      expect.objectContaining({
        id: `approval:${approval.id}`,
        kind: "approval",
        status: "rejected",
        reason: "Not this month",
      }),
    );
  });

  it("filters by status, bounds output, and rejects foreign filter ids", async () => {
    const { GET } = await import("@/app/api/companies/[id]/activity/route");
    const seeded = await seedCompany();
    for (const status of ["done", "error"] as const) {
      const run = await repo.createRun({
        flowId: seeded.flowId,
        agentId: seeded.agentId,
        trigger: "company-fire",
      });
      await repo.finishRun(run.id, status, status === "done" ? 0.01 : 0.02);
    }

    const filteredUrl = new URL(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/activity`);
    filteredUrl.searchParams.set("month", currentMonth());
    filteredUrl.searchParams.set("status", "error");
    filteredUrl.searchParams.set("limit", "1");
    const filtered = await GET(new Request(filteredUrl), companyContext(seeded.companyId));
    const filteredBody = await filtered.json() as { activities: Array<{ status: string }> };
    expect(filtered.status).toBe(200);
    expect(filteredBody.activities).toHaveLength(1);
    expect(filteredBody.activities[0]?.status).toBe("error");

    const invalidUrl = new URL(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/activity`);
    invalidUrl.searchParams.set("departmentId", "foreign-department");
    const invalid = await GET(new Request(invalidUrl), companyContext(seeded.companyId));
    expect(invalid.status).toBe(404);
  });

  it("paginates a stable mixed ledger without per-employee all-history reads", async () => {
    const { GET } = await import("@/app/api/companies/[id]/activity/route");
    const seeded = await seedCompany();
    const db = (repo as unknown as { db: Database.Database }).db;
    const [year, month] = currentMonth().split("-").map(Number) as [number, number];
    const base = Date.UTC(year, month - 1, 2);
    const runs = await Promise.all([0, 1, 2].map(async () => {
      const run = await repo.createRun({
        flowId: seeded.flowId,
        agentId: seeded.agentId,
        trigger: "company-fire",
      });
      await repo.finishRun(run.id, "done", 0.01);
      return run;
    }));
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(base + 3_000, runs[0]!.id);
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(base + 2_000, runs[1]!.id);
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(base + 1_000, runs[2]!.id);
    const approval = await repo.createApproval({
      companyId: seeded.companyId,
      kind: "fire_over_threshold",
      subjectId: seeded.agentId,
    });
    db.prepare("UPDATE company_approvals SET created_at = ? WHERE id = ?")
      .run(new Date(base + 2_000).toISOString(), approval.id);
    await repo.decideApproval(approval.id, "approved");

    const listRuns = vi.spyOn(repo, "listRuns");
    const getAgent = vi.spyOn(repo, "getAgent");
    const firstUrl = new URL(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/activity`);
    firstUrl.searchParams.set("month", currentMonth());
    firstUrl.searchParams.set("limit", "2");
    const first = await GET(new Request(firstUrl), companyContext(seeded.companyId));
    const firstBody = await first.json() as {
      activities: Array<{ id: string; occurredAt: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(first.status).toBe(200);
    expect(firstBody.activities.map((entry) => entry.id)).toEqual([
      `run:${runs[0]!.id}`,
      `run:${runs[1]!.id}`,
    ]);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const secondUrl = new URL(firstUrl);
    secondUrl.searchParams.set("cursor", firstBody.nextCursor!);
    const second = await GET(new Request(secondUrl), companyContext(seeded.companyId));
    const secondBody = await second.json() as {
      activities: Array<{ id: string; occurredAt: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(second.status).toBe(200);
    expect(secondBody.activities.map((entry) => entry.id)).toEqual([
      `approval:${approval.id}`,
      `run:${runs[2]!.id}`,
    ]);
    expect(secondBody.activities[0]?.occurredAt).toBe(new Date(base + 2_000).toISOString());
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();
    expect(new Set([...firstBody.activities, ...secondBody.activities].map((entry) => entry.id)).size)
      .toBe(4);
    expect(listRuns).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("rejects malformed cursors and checks company ownership before activity reads", async () => {
    const { GET } = await import("@/app/api/companies/[id]/activity/route");
    const seeded = await seedCompany();
    const invalidUrl = new URL(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/activity`);
    invalidUrl.searchParams.set("month", currentMonth());
    invalidUrl.searchParams.set("cursor", "not-a-canonical-cursor!");
    expect((await GET(new Request(invalidUrl), companyContext(seeded.companyId))).status).toBe(400);

    const activityRead = vi.spyOn(repo, "listCompanyActivity");
    state.owner = "foreign-owner";
    const foreignUrl = new URL(`https://agents.suedeai.ai/api/companies/${seeded.companyId}/activity`);
    foreignUrl.searchParams.set("month", currentMonth());
    expect((await GET(new Request(foreignUrl), companyContext(seeded.companyId))).status).toBe(404);
    expect(activityRead).not.toHaveBeenCalled();
  });
});
