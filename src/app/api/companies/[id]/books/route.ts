/**
 * Books endpoint — the receipts-grounded P&L for a company. Revenue totals
 * derive only from settlement-ledger rows (`repo.listSettlementsByAgents`),
 * never `price × count`, so an owner editing an agent's price after
 * settlement can never rewrite historical totals — see the `updateAgent`
 * price-drift test in tests/api-company-books.test.ts. Spend sums run costs
 * in the same window via `repo.sumCostByAgents`. See
 * docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md, Task 11.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { monthWindowStartUtc } from "@/lib/company/guardrails";

export const runtime = "nodejs";

// offset:true accepts a trailing "Z" as well as "+HH:MM" — Date#toISOString()
// always emits "Z", so plain toISOString() output is always accepted.
const BooksQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/** Rounds to 6 decimal places of USDC precision, clear of float summation noise. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const owner = await resolveOwnerId();
    const repo = await getRepo();

    const company = await repo.getCompany(id);
    if (company === null || company.ownerId !== owner) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const parsedQuery = BooksQuerySchema.safeParse({
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }

    const now = new Date();
    const from = parsedQuery.data.from ?? new Date(monthWindowStartUtc(now)).toISOString();
    const to = parsedQuery.data.to ?? now.toISOString();

    const employeeAgentIds = (await repo.listCompanyEmployeeHistory(company.id))
      .map((employee) => employee.agentId);

    // Revenue and spend are independent ledgers (settlements vs. runs), so
    // they are safe to fetch concurrently.
    const [settlements, spendTotalUsdc] = await Promise.all([
      repo.listSettlementsByAgents(employeeAgentIds, from, to),
      repo.sumCostByAgents(employeeAgentIds, Date.parse(from), Date.parse(to)),
    ]);

    // tx/payer are passed through verbatim, including null — the client
    // labels a null tx as "no receipt returned" rather than the API masking it.
    const lines = settlements.map((settlement) => ({
      runId: settlement.runId,
      agentId: settlement.agentId,
      grossUsdc: settlement.grossUsdc,
      creatorUsdc: settlement.creatorUsdc,
      platformUsdc: settlement.platformUsdc,
      tx: settlement.tx,
      payer: settlement.payer,
      createdAt: settlement.createdAt,
    }));

    // Summed from the ledger rows fetched above — never priceUsdc × a count,
    // which would silently rewrite history whenever a creator edits price.
    const totalGrossUsdc = lines.reduce((sum, line) => sum + line.grossUsdc, 0);
    const totalCreatorUsdc = lines.reduce((sum, line) => sum + line.creatorUsdc, 0);
    const netUsdc = round6(totalCreatorUsdc - spendTotalUsdc);

    return NextResponse.json({
      from,
      to,
      revenue: { totalGrossUsdc, totalCreatorUsdc, lines },
      spend: { totalUsdc: spendTotalUsdc },
      netUsdc,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("companies books route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
