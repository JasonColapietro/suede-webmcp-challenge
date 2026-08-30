/**
 * Tests for the books endpoint (src/app/api/companies/[id]/books/route.ts)
 * — the receipts-grounded P&L. Revenue totals derive only from settlement
 * ledger rows (never `price × count`), so an owner editing an agent's price
 * after settlement must never rewrite historical totals. The price-drift
 * test below is this task's core honesty criterion. See
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md, Task 11.
 *
 * getRepo() is mocked to a single real SqliteRepo(":memory:") instance (not
 * a hand-rolled stub) so the route exercises the real SQL in
 * listSettlementsByAgents/sumCostByAgents, matching the convention already
 * used for real-repo route mocks (tests/api-cli-route.test.ts).
 * resolveOwnerId is mocked to a fixed owner; everything else about
 * @/lib/auth is untouched by these tests.
 */
import Database from "better-sqlite3";
import { afterAll, describe, it, expect, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { materializeCompanyDraft, templateToDraft } from "@/lib/company/founding";
import { monthWindowStartUtc } from "@/lib/company/guardrails";

const FIXED_OWNER = "owner-books-test";

vi.mock("@/lib/auth", () => ({
  UnauthenticatedOwnerError: class UnauthenticatedOwnerError extends Error {
    status = 401;
  },
  resolveOwnerId: async () => FIXED_OWNER,
}));

const database = new Database(":memory:");
runSqliteMigrations(database);
const repo = new SqliteRepo(database);

vi.doMock("@/lib/db/repo", async () => ({
  ...await vi.importActual<typeof import("@/lib/db/repo")>("@/lib/db/repo"),
  getRepo: async () => repo,
}));

const { GET } = await import("@/app/api/companies/[id]/books/route");

afterAll(() => database.close());

/**
 * The default (no from/to) window's upper bound is "now" at request time,
 * and listSettlementsByAgents's window is exclusive at the top
 * (created_at < to). A settlement recorded and then immediately read back
 * in the same test can land in the same millisecond as that "now", which
 * would wrongly exclude it. A short sleep after seeding — same pattern as
 * tests/api-company-guardrails.test.ts — guarantees real separation.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paramsFor(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function booksUrl(companyId: string, query?: { from?: string; to?: string }): string {
  const url = new URL(`https://agents.suedeai.ai/api/companies/${companyId}/books`);
  if (query?.from !== undefined) url.searchParams.set("from", query.from);
  if (query?.to !== undefined) url.searchParams.set("to", query.to);
  return url.toString();
}

async function getBooks(companyId: string, query?: { from?: string; to?: string }) {
  const response = await GET(new Request(booksUrl(companyId, query)), paramsFor(companyId));
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

/** Founds a fresh rights-precheck-shop company and returns its first (paid-call) employee. */
async function foundCompany(
  ownerId: string,
): Promise<{ companyId: string; agentId: string; flowId: string }> {
  const draft = templateToDraft("rights-precheck-shop");
  if (!draft) throw new Error("rights-precheck-shop template missing");
  const { companyId } = await materializeCompanyDraft(ownerId, draft, repo);
  const employees = await repo.listEmployees(companyId);
  const employee = employees[0];
  if (!employee) throw new Error("founding produced no employees");
  const agent = await repo.getAgent(employee.agentId);
  if (!agent) throw new Error("founded employee has no agent");
  return { companyId, agentId: employee.agentId, flowId: agent.flowId };
}

/** Creates + finishes a run at `costUsdc`, then records a settlement for it. Returns the run id. */
async function seedSettledRun(
  flowId: string,
  agentId: string,
  ownerId: string,
  costUsdc: number,
  amounts: { grossUsdc: number; creatorUsdc: number; platformUsdc: number },
  overrides: { tx?: string | null; payer?: string | null } = {},
): Promise<string> {
  const run = await repo.createRun({ flowId, agentId, trigger: "agent" });
  await repo.finishRun(run.id, "done", costUsdc);
  await repo.recordSettlement({
    runId: run.id,
    agentId,
    ownerId,
    grossUsdc: amounts.grossUsdc,
    creatorUsdc: amounts.creatorUsdc,
    platformUsdc: amounts.platformUsdc,
    payTo: "0xCreatorWallet",
    payoutSource: "creator",
    payer: overrides.payer === undefined ? "0xPayerWallet" : overrides.payer,
    tx: overrides.tx === undefined ? "0xTxHash" : overrides.tx,
  });
  return run.id;
}

describe("GET /api/companies/[id]/books", () => {
  it("(a) sums revenue totals from seeded settlement ledger rows, not price × count", async () => {
    const { companyId, agentId, flowId } = await foundCompany(FIXED_OWNER);
    await seedSettledRun(flowId, agentId, FIXED_OWNER, 0.05, {
      grossUsdc: 0.25,
      creatorUsdc: 0.2,
      platformUsdc: 0.05,
    });
    await seedSettledRun(flowId, agentId, FIXED_OWNER, 0.05, {
      grossUsdc: 0.25,
      creatorUsdc: 0.2,
      platformUsdc: 0.05,
    });
    await sleep(5);

    const { status, json } = await getBooks(companyId);
    expect(status).toBe(200);
    const revenue = json.revenue as { totalGrossUsdc: number; totalCreatorUsdc: number; lines: unknown[] };
    expect(revenue.lines).toHaveLength(2);
    expect(revenue.totalGrossUsdc).toBeCloseTo(0.5, 6);
    expect(revenue.totalCreatorUsdc).toBeCloseTo(0.4, 6);
  });

  it("response shape matches exactly, and tx/payer pass through verbatim including null", async () => {
    const { companyId, agentId, flowId } = await foundCompany(FIXED_OWNER);
    const runId = await seedSettledRun(
      flowId,
      agentId,
      FIXED_OWNER,
      0.05,
      { grossUsdc: 0.25, creatorUsdc: 0.2, platformUsdc: 0.05 },
      { tx: null, payer: null }, // facilitator omitted both — must stay null, not be masked
    );
    await sleep(5);

    const { json } = await getBooks(companyId);
    expect(Object.keys(json).sort()).toEqual(["from", "netUsdc", "revenue", "spend", "to"].sort());
    const revenue = json.revenue as { totalGrossUsdc: number; totalCreatorUsdc: number; lines: Record<string, unknown>[] };
    expect(Object.keys(revenue).sort()).toEqual(["lines", "totalCreatorUsdc", "totalGrossUsdc"].sort());
    const spend = json.spend as { totalUsdc: number };
    expect(Object.keys(spend)).toEqual(["totalUsdc"]);

    const line = revenue.lines[0]!;
    expect(Object.keys(line).sort()).toEqual(
      ["runId", "agentId", "grossUsdc", "creatorUsdc", "platformUsdc", "tx", "payer", "createdAt"].sort(),
    );
    expect(line.runId).toBe(runId);
    expect(line.agentId).toBe(agentId);
    expect(line.tx).toBeNull();
    expect(line.payer).toBeNull();
  });

  it("(b) price-drift: totals are unchanged after repo.updateAgent changes the agent's price", async () => {
    const { companyId, agentId, flowId } = await foundCompany(FIXED_OWNER);
    await seedSettledRun(flowId, agentId, FIXED_OWNER, 0.05, {
      grossUsdc: 0.25,
      creatorUsdc: 0.2,
      platformUsdc: 0.05,
    });
    await sleep(5);

    const before = await getBooks(companyId);
    const beforeRevenue = before.json.revenue as { totalGrossUsdc: number; totalCreatorUsdc: number };
    expect(beforeRevenue.totalGrossUsdc).toBeCloseTo(0.25, 6);
    expect(beforeRevenue.totalCreatorUsdc).toBeCloseTo(0.2, 6);

    // The core honesty claim: editing price after the fact must never
    // rewrite settled history because totals come from the ledger, not
    // priceUsdc × count.
    await repo.updateAgent(agentId, { priceUsdc: 99 });

    const after = await getBooks(companyId);
    const afterRevenue = after.json.revenue as { totalGrossUsdc: number; totalCreatorUsdc: number };
    expect(afterRevenue.totalGrossUsdc).toBe(beforeRevenue.totalGrossUsdc);
    expect(afterRevenue.totalCreatorUsdc).toBe(beforeRevenue.totalCreatorUsdc);
    expect(afterRevenue.totalGrossUsdc).toBeCloseTo(0.25, 6);
    expect(afterRevenue.totalCreatorUsdc).toBeCloseTo(0.2, 6);
  });

  it("(c) window bounds: a from/to range excluding the seeded settlement returns zeros", async () => {
    const { companyId, agentId, flowId } = await foundCompany(FIXED_OWNER);
    await seedSettledRun(flowId, agentId, FIXED_OWNER, 0.05, {
      grossUsdc: 0.25,
      creatorUsdc: 0.2,
      platformUsdc: 0.05,
    });

    // The settlement's createdAt/run started_at are stamped "now" — a window
    // entirely in the past excludes both.
    const { status, json } = await getBooks(companyId, {
      from: "2020-01-01T00:00:00.000Z",
      to: "2020-02-01T00:00:00.000Z",
    });
    expect(status).toBe(200);
    const revenue = json.revenue as { totalGrossUsdc: number; totalCreatorUsdc: number; lines: unknown[] };
    const spend = json.spend as { totalUsdc: number };
    expect(revenue.lines).toEqual([]);
    expect(revenue.totalGrossUsdc).toBe(0);
    expect(revenue.totalCreatorUsdc).toBe(0);
    expect(spend.totalUsdc).toBe(0);
    expect(json.netUsdc).toBe(0);
  });

  it("(d) zero-state shape for a fresh company with no runs at all", async () => {
    const { companyId } = await foundCompany(FIXED_OWNER);

    const { status, json } = await getBooks(companyId);
    expect(status).toBe(200);
    const revenue = json.revenue as { totalGrossUsdc: number; totalCreatorUsdc: number; lines: unknown[] };
    const spend = json.spend as { totalUsdc: number };
    expect(revenue.lines).toEqual([]);
    expect(revenue.totalGrossUsdc).toBe(0);
    expect(revenue.totalCreatorUsdc).toBe(0);
    expect(spend.totalUsdc).toBe(0);
    expect(json.netUsdc).toBe(0);

    // Default window: from = current UTC month start, to = ~now.
    expect(json.from).toBe(new Date(monthWindowStartUtc(new Date())).toISOString());
    expect(typeof json.to).toBe("string");
  });

  it("(e) spend reflects finishRun costs within the window, and netUsdc = creator total - spend total", async () => {
    const { companyId, agentId, flowId } = await foundCompany(FIXED_OWNER);
    await seedSettledRun(flowId, agentId, FIXED_OWNER, 0.03, {
      grossUsdc: 0.25,
      creatorUsdc: 0.2,
      platformUsdc: 0.05,
    });
    // An unsettled run still incurred real cost (spend) but produced no
    // settlement (no revenue line) — both must be reflected independently.
    const unsettled = await repo.createRun({ flowId, agentId, trigger: "agent" });
    await repo.finishRun(unsettled.id, "done", 0.02);
    await sleep(5);

    const { json } = await getBooks(companyId);
    const revenue = json.revenue as { totalCreatorUsdc: number };
    const spend = json.spend as { totalUsdc: number };
    expect(spend.totalUsdc).toBeCloseTo(0.05, 6); // 0.03 + 0.02
    expect(revenue.totalCreatorUsdc).toBeCloseTo(0.2, 6);
    expect(json.netUsdc).toBeCloseTo(0.15, 6); // 0.2 - 0.05
  });

  it("keeps removed employees in the historical books", async () => {
    const { companyId, agentId, flowId } = await foundCompany(FIXED_OWNER);
    await seedSettledRun(flowId, agentId, FIXED_OWNER, 0.03, {
      grossUsdc: 0.25,
      creatorUsdc: 0.2,
      platformUsdc: 0.05,
    });
    expect(await repo.removeEmployee(agentId)).toBe(true);
    await sleep(5);

    const { json } = await getBooks(companyId);
    const revenue = json.revenue as { totalGrossUsdc: number; lines: unknown[] };
    const spend = json.spend as { totalUsdc: number };
    expect(revenue.lines).toHaveLength(1);
    expect(revenue.totalGrossUsdc).toBeCloseTo(0.25, 6);
    expect(spend.totalUsdc).toBeCloseTo(0.03, 6);
  });

  it("(f) 404s for a company id the fixed owner does not own", async () => {
    const other = await foundCompany("owner-someone-else");
    const { status, json } = await getBooks(other.companyId);
    expect(status).toBe(404);
    expect(json.error).toBe("not found");
  });

  it("(f) 404s for a company id that does not exist at all", async () => {
    const { status } = await getBooks("no-such-company-id");
    expect(status).toBe(404);
  });
});
