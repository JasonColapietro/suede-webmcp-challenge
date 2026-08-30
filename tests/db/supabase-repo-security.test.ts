import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { SupabaseRepo } from "@/lib/db/supabase-repo";
import { readFileSync } from "node:fs";

function client(value: unknown): SupabaseClient {
  return value as SupabaseClient;
}

function readQuery(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "in", "gte", "lt", "lte", "or", "order", "limit"] as const) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => result);
  query.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return query;
}

describe("SupabaseRepo security and billing invariants", () => {
  it("passes a caller-supplied durable run identity to Supabase", async () => {
    const id = "00000000-0000-5000-8000-000000000001";
    let inserted: Record<string, unknown> | null = null;
    const query: Record<string, unknown> = {};
    query.insert = vi.fn((value: Record<string, unknown>) => {
      inserted = value;
      return query;
    });
    query.select = vi.fn(() => query);
    query.single = vi.fn(async () => ({
      data: {
        ...inserted,
        status: "running",
        total_cost_usdc: 0,
        started_at: "2026-08-15T00:00:00.000Z",
        finished_at: null,
        settled_at: null,
      },
      error: null,
    }));
    const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

    const created = await repo.createRun({ id, flowId: "flow", trigger: "agent" });

    expect(inserted).toMatchObject({ id, flow_id: "flow", trigger: "agent" });
    expect(created.id).toBe(id);
  });

  it("keeps consecutive atomic Guided CAS tokens exact at JavaScript millisecond precision", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: "2026-07-18T12:00:00.123000+00:00", error: null })
      .mockResolvedValueOnce({ data: "2026-07-18T12:00:00.124000+00:00", error: null });
    const repo = new SupabaseRepo(client({ rpc }));
    const graph = { id: "graph", name: "Guided", nodes: [], edges: [] };
    const first = await repo.mutateGuidedFlow({
      id: "00000000-0000-0000-0000-000000000001",
      mustExist: true,
      expectedUpdatedAt: Date.parse("2026-07-18T12:00:00.122Z"),
      ownerId: "owner",
      name: "Guided",
      graph,
      priceUsdc: 1,
      scheduleCron: null,
    });
    if (first.status !== "saved") throw new Error(`unexpected ${first.status}`);
    const second = await repo.mutateGuidedFlow({
      id: first.flow.id,
      mustExist: true,
      expectedUpdatedAt: first.flow.updatedAt,
      ownerId: "owner",
      name: "Guided again",
      graph,
      priceUsdc: 2,
      scheduleCron: null,
    });
    expect(second.status).toBe("saved");
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({
      p_expected_updated_at: "2026-07-18T12:00:00.123Z",
    });

    const schema = readFileSync("src/lib/db/schema.deploy.sql", "utf8");
    const normalizedSchema = schema.replace(/\s+/gu, " ").toLowerCase();
    expect(schema).toContain("date_trunc('milliseconds', updated_at)");
    expect(schema).toContain("date_trunc('milliseconds', clock_timestamp())");
    expect(schema).toContain("date_trunc('milliseconds', p_expected_updated_at) + interval '1 millisecond'");
    expect(normalizedSchema).toContain(
      "revoke execute on function public.agent_studio_mutate_guided_flow( text, uuid, timestamptz, text, jsonb, numeric, text ) from public, anon, authenticated;",
    );
    expect(normalizedSchema).toContain(
      "grant execute on function public.agent_studio_mutate_guided_flow( text, uuid, timestamptz, text, jsonb, numeric, text ) to service_role;",
    );
    expect(normalizedSchema).toContain(
      "revoke all privileges on table public.settlements, public.companies, public.company_departments, public.company_employees, public.company_approvals from public, anon, authenticated;",
    );
    expect(normalizedSchema).toContain(
      "grant select, insert, update on table public.settlements, public.companies, public.company_departments, public.company_employees, public.company_approvals to service_role;",
    );
    expect(normalizedSchema).toContain(
      "revoke delete on table public.settlements, public.companies, public.company_departments, public.company_employees, public.company_approvals from service_role;",
    );
    expect(normalizedSchema).toContain(
      "create index if not exists idx_employees_department on company_employees (department_id);",
    );

    const settlementInput = readFileSync("docs/migrations/settlements-ledger.sql", "utf8")
      .replace(/\s+/gu, " ")
      .toLowerCase();
    expect(settlementInput).toContain(
      "revoke all privileges on table public.settlements from public, anon, authenticated;",
    );
    expect(settlementInput).toContain(
      "grant select, insert, update on table public.settlements to service_role;",
    );
    expect(settlementInput).toContain(
      "revoke delete on table public.settlements from service_role;",
    );
  });

  it("bounds mixed company activity at limit plus one per source without employee fanout", async () => {
    const calls: Record<string, Array<{ method: string; args: unknown[] }>> = {};
    const resultByTable: Record<string, { data: unknown[]; error: null }> = {
      company_employees: {
        data: [{ agent_id: "agent-1", department_id: "department-1" }],
        error: null,
      },
      runs: {
        data: [
          {
            id: "run-3",
            agent_id: "agent-1",
            status: "done",
            started_at: "2026-07-03T00:00:03.000Z",
            trigger: "company-fire",
            total_cost_usdc: 0.03,
          },
          {
            id: "run-2",
            agent_id: "agent-1",
            status: "done",
            started_at: "2026-07-03T00:00:02.000Z",
            trigger: "company-fire",
            total_cost_usdc: 0.02,
          },
        ],
        error: null,
      },
      company_approvals: {
        data: [{
          id: "approval-1",
          company_id: "company",
          subject_id: "agent-1",
          status: "approved",
          kind: "fire_over_threshold",
          reason: null,
          created_at: "2026-07-03T00:00:01.000Z",
        }],
        error: null,
      },
      settlements: { data: [], error: null },
    };
    const from = vi.fn((table: string) => {
      calls[table] = [];
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "gte", "lt", "lte", "or", "order", "limit"] as const) {
        query[method] = vi.fn((...args: unknown[]) => {
          calls[table]!.push({ method, args });
          return query;
        });
      }
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(resultByTable[table]).then(resolve, reject);
      return query;
    });
    const repo = new SupabaseRepo(client({ from }));

    const page = await repo.listCompanyActivity({
      companyId: "company",
      fromMs: Date.parse("2026-07-01T00:00:00.000Z"),
      toMs: Date.parse("2026-08-01T00:00:00.000Z"),
      limit: 2,
    });

    expect(page.records.map((record) => record.id)).toEqual(["run:run-3", "run:run-2"]);
    expect(page.hasMore).toBe(true);
    expect(from.mock.calls.filter(([table]) => table === "runs")).toHaveLength(1);
    expect(calls.runs).toContainEqual({ method: "in", args: ["agent_id", ["agent-1"]] });
    expect(calls.runs).toContainEqual({ method: "limit", args: [3] });
    expect(calls.company_approvals).toContainEqual({ method: "limit", args: [3] });
    expect(calls.company_employees?.some((call) => call.method === "is")).toBe(false);
  });

  it("pushes the stable mixed-source cursor into both Supabase queries", async () => {
    const calls: Record<string, Array<{ method: string; args: unknown[] }>> = {};
    const from = vi.fn((table: string) => {
      const query: Record<string, unknown> = {};
      calls[table] = [];
      for (const method of ["select", "eq", "in", "gte", "lt", "lte", "or", "order", "limit"] as const) {
        query[method] = vi.fn((...args: unknown[]) => {
          calls[table]!.push({ method, args });
          return query;
        });
      }
      const result = table === "company_employees"
        ? { data: [{ agent_id: "agent-1", department_id: "department-1" }], error: null }
        : { data: [], error: null };
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return query;
    });
    const repo = new SupabaseRepo(client({ from }));
    const at = Date.parse("2026-07-03T00:00:02.000Z");

    await repo.listCompanyActivity({
      companyId: "company",
      fromMs: Date.parse("2026-07-01T00:00:00.000Z"),
      toMs: Date.parse("2026-08-01T00:00:00.000Z"),
      cursor: { occurredAt: new Date(at).toISOString(), id: "run:run-2" },
      limit: 2,
    });

    expect(calls.runs?.some((call) => call.method === "or")).toBe(true);
    expect(calls.company_approvals).toContainEqual({
      method: "lte",
      args: ["created_at", "2026-07-03T00:00:02.000Z"],
    });
  });

  it("persists and maps an approval action/cost snapshot without inventing cost", async () => {
    let inserted: Record<string, unknown> | null = null;
    const query: Record<string, unknown> = {};
    query.insert = vi.fn((value: Record<string, unknown>) => {
      inserted = value;
      return query;
    });
    query.select = vi.fn(() => query);
    query.single = vi.fn(async () => ({ data: inserted, error: null }));
    const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

    const approval = await repo.createApproval({
      companyId: "company",
      kind: "fire_over_threshold",
      subjectId: "agent",
      actionSummary: "Run the finance agent above the threshold",
      costSnapshot: {
        basis: "unavailable",
        amountUsdc: null,
        note: "Execution cost is not quoted before this run.",
      },
    });

    expect(inserted).toMatchObject({
      company_id: "company",
      kind: "fire_over_threshold",
      subject_id: "agent",
      action_summary: "Run the finance agent above the threshold",
      cost_basis: "unavailable",
      cost_usdc: null,
      cost_note: "Execution cost is not quoted before this run.",
    });
    expect(approval).toMatchObject({
      actionSummary: "Run the finance agent above the threshold",
      costSnapshot: {
        basis: "unavailable",
        amountUsdc: null,
        note: "Execution cost is not quoted before this run.",
      },
    });
  });

  it("routes legacy saves through the owner-scoped mutation path", async () => {
    const repo = new SupabaseRepo(client({}));
    const graph = { id: "graph", name: "Owned", nodes: [], edges: [] };
    const flow = { id: "flow", ownerId: "owner", name: "Owned", graph, updatedAt: 1 };
    const mutate = vi.spyOn(repo, "mutateFlow").mockResolvedValue({ status: "saved", flow });

    await expect(repo.saveFlow({ id: "flow", ownerId: "owner", name: "Owned", graph }))
      .resolves.toEqual(flow);
    expect(mutate).toHaveBeenCalledWith({ id: "flow", ownerId: "owner", name: "Owned", graph });

    mutate.mockResolvedValueOnce({ status: "conflict" });
    await expect(repo.saveFlow({ id: "flow", ownerId: "other", name: "Hijack", graph }))
      .rejects.toThrow(/ownership conflict/u);
  });

  it("keeps recovery creates from overwriting an existing owned Supabase row", async () => {
    const graph = { id: "graph", name: "Owned", nodes: [], edges: [] };
    const query = readQuery({
      data: {
        id: "flow",
        owner_id: "owner",
        name: "Current",
        graph,
        updated_at: "2026-07-21T00:00:00.000Z",
      },
      error: null,
    });
    query.update = vi.fn(() => {
      throw new Error("recovery must not update");
    });
    query.insert = vi.fn(() => {
      throw new Error("recovery must not insert over an existing row");
    });
    const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

    await expect(repo.mutateFlow({
      id: "flow",
      createOnly: true,
      ownerId: "owner",
      name: "Backup copy",
      graph,
    })).resolves.toEqual({ status: "conflict" });
    expect(query.update).not.toHaveBeenCalled();
    expect(query.insert).not.toHaveBeenCalled();
  });

  it("fails closed for both reusable-flow node types until Supabase reference parity exists", async () => {
    const repo = new SupabaseRepo(client({}));
    for (const type of ["subflow", "loop"] as const) {
      await expect(repo.mutateFlow({
        ownerId: "owner",
        name: "Referenced flow",
        graph: {
          id: `graph-${type}`,
          name: "Referenced flow",
          nodes: [{ id: "reference", type, params: { flowId: "child" }, position: { x: 0, y: 0 } }],
          edges: [],
        },
      })).resolves.toEqual({ status: "invalid-reference" });
    }
  });

  it("fails closed when credit balance or transaction reads return Supabase errors", async () => {
    const balanceQuery: Record<string, unknown> = {};
    balanceQuery.select = vi.fn(() => balanceQuery);
    balanceQuery.eq = vi.fn(() => balanceQuery);
    balanceQuery.limit = vi.fn(() => balanceQuery);
    balanceQuery.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: null, error: { message: "balance denied" } }).then(resolve, reject);
    const balanceRepo = new SupabaseRepo(client({ from: vi.fn(() => balanceQuery) }));
    await expect(balanceRepo.getCreditBalance("owner")).rejects.toThrow("balance denied");

    const transactionQuery: Record<string, unknown> = {};
    for (const method of ["select", "eq", "limit"] as const) {
      transactionQuery[method] = vi.fn(() => transactionQuery);
    }
    transactionQuery.maybeSingle = vi.fn(async () => ({
      data: null,
      error: { message: "transaction denied" },
    }));
    const transactionRepo = new SupabaseRepo(client({ from: vi.fn(() => transactionQuery) }));
    await expect(transactionRepo.getCreditByTx("owner", "tx"))
      .rejects.toThrow("transaction denied");
  });

  it("fails closed on unexpected company-membership and company lookup errors", async () => {
    const query: Record<string, unknown> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.is = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({
      data: null,
      error: { code: "XX000", message: "transient company lookup failure" },
    }));
    const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

    await expect(repo.getEmployeeByAgent("agent")).rejects.toThrow(
      "transient company lookup failure",
    );
    await expect(repo.getCompany("company")).rejects.toThrow(
      "transient company lookup failure",
    );
  });

  it("keeps deliberate pre-migration company-table reads dark-deploy safe", async () => {
    const query: Record<string, unknown> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.is = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    }));
    const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

    await expect(repo.getEmployeeByAgent("agent")).resolves.toBeNull();
    await expect(repo.getCompany("company")).resolves.toBeNull();
  });

  it("propagates arbitrary errors from every company list and books read", async () => {
    const query = readQuery({
      data: null,
      error: { code: "XX000", message: "company read denied" },
    });
    const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

    await expect(repo.listCompaniesByOwner("owner")).rejects.toThrow("company read denied");
    await expect(repo.listDepartments("company")).rejects.toThrow("company read denied");
    await expect(repo.listEmployees("company")).rejects.toThrow("company read denied");
    await expect(repo.getApproval("approval")).rejects.toThrow("company read denied");
    await expect(repo.listApprovals("company", "approved")).rejects.toThrow("company read denied");
    await expect(repo.listCompanyActivity({
      companyId: "company",
      fromMs: 0,
      toMs: Date.now(),
      limit: 10,
    })).rejects.toThrow("company read denied");
    await expect(repo.sumCostByAgents(["agent"], 0)).rejects.toThrow("company read denied");
    await expect(repo.listSettlementsByAgents(
      ["agent"],
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    )).rejects.toThrow("company read denied");
  });

  it("fails closed on every core execution-table read error, including missing-table errors", async () => {
    for (const error of [
      { code: "XX000", message: "runs read denied" },
      { code: "42P01", message: "runs table missing" },
    ]) {
      const query = readQuery({ data: null, error });
      const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

      await expect(repo.listRuns("flow")).rejects.toThrow(error.message);
      await expect(repo.listRunSteps("run")).rejects.toThrow(error.message);
      await expect(repo.sumCostByAgents(["agent"], 0)).rejects.toThrow(error.message);
    }
  });

  it("uses null, empty, or zero dark-deploy fallbacks only for recognized missing-table errors", async () => {
    const query = readQuery({
      data: null,
      error: { code: "PGRST205", message: "table is absent from schema cache" },
    });
    const repo = new SupabaseRepo(client({ from: vi.fn(() => query) }));

    await expect(repo.listCompaniesByOwner("owner")).resolves.toEqual([]);
    await expect(repo.listDepartments("company")).resolves.toEqual([]);
    await expect(repo.listEmployees("company")).resolves.toEqual([]);
    await expect(repo.getApproval("approval")).resolves.toBeNull();
    await expect(repo.listApprovals("company", "approved")).resolves.toEqual([]);
    await expect(repo.listCompanyActivity({
      companyId: "company",
      fromMs: 0,
      toMs: Date.now(),
      limit: 10,
    })).resolves.toEqual({ records: [], hasMore: false });
    await expect(repo.sumCostByAgents(["agent"], 0)).rejects.toThrow(
      "table is absent from schema cache",
    );
    await expect(repo.listSettlementsByAgents(
      ["agent"],
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    )).resolves.toEqual([]);
  });

  it("returns an identical existing credit after an owner-scoped transaction race", async () => {
    const insertQuery: Record<string, unknown> = {};
    insertQuery.insert = vi.fn(() => insertQuery);
    insertQuery.select = vi.fn(() => insertQuery);
    insertQuery.single = vi.fn(async () => ({
      data: null,
      error: { code: "23505", message: "duplicate key" },
    }));
    const repo = new SupabaseRepo(client({ from: vi.fn(() => insertQuery) }));
    const existing = {
      id: "credit",
      ownerId: "owner",
      deltaUsdc: 5,
      reason: "stripe-topup",
      tx: "checkout-session",
      createdAt: "2026-07-16T00:00:00.000Z",
    };
    vi.spyOn(repo, "getCreditByTx").mockResolvedValue(existing);

    await expect(repo.createCredit({
      ownerId: "owner",
      deltaUsdc: 5,
      reason: "stripe-topup",
      tx: "checkout-session",
    })).resolves.toEqual(existing);
    await expect(repo.createCredit({
      ownerId: "owner",
      deltaUsdc: 6,
      reason: "stripe-topup",
      tx: "checkout-session",
    })).rejects.toThrow(/transaction conflict/u);
  });

  it("delegates Stripe payment receipt and credit to one atomic RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        recorded: true,
        credit_delta_usdc: "5.50000000",
        refund_state: "none",
      }],
      error: null,
    }));
    const repo = new SupabaseRepo(client({ rpc }));

    await expect(repo.recordStripeRevenueEvent({
      kind: "payment",
      providerEventId: "evt_private001",
      ownerId: "owner-private",
      providerCheckoutSessionId: "cs_private001",
      providerPaymentIntentId: "pi_private001",
      amountTotalCents: 500,
      currency: "USD",
      terminalStatus: "paid",
      providerProductId: "prod_private001",
      providerPriceId: "price_private001",
      creditGrantUsdc: 5.5,
      occurredAt: "2026-07-31T12:00:00.000Z",
    })).resolves.toEqual({
      recorded: true,
      creditDeltaUsdc: 5.5,
      refundState: "none",
    });
    expect(rpc).toHaveBeenCalledWith(
      "agent_studio_record_stripe_revenue_event",
      {
        p_kind: "payment",
        p_provider_event_id: "evt_private001",
        p_owner_id: "owner-private",
        p_checkout_session_id: "cs_private001",
        p_payment_intent_id: "pi_private001",
        p_refund_id: null,
        p_amount_total_cents: 500,
        p_currency: "USD",
        p_terminal_status: "paid",
        p_product_id: "prod_private001",
        p_price_id: "price_private001",
        p_occurred_at: "2026-07-31T12:00:00.000Z",
        p_credit_grant_usdc: 5.5,
      },
    );
  });

  it("sends no owner or product identifiers from a refund event", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        recorded: true,
        credit_delta_usdc: -2,
        refund_state: "partial",
      }],
      error: null,
    }));
    const repo = new SupabaseRepo(client({ rpc }));

    await repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_refund001",
      providerPaymentIntentId: "pi_private001",
      providerRefundId: "re_private001",
      amountTotalCents: 200,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: "2026-07-31T12:01:00.000Z",
    });

    const refundCall = rpc.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(refundCall[1]).toMatchObject({
      p_owner_id: null,
      p_checkout_session_id: null,
      p_refund_id: "re_private001",
      p_product_id: null,
      p_price_id: null,
      p_credit_grant_usdc: null,
    });
  });

  it("accepts only the no-write zero-delta shape for an unmatched refund", async () => {
    const input = {
      kind: "refund" as const,
      providerEventId: "evt_unmatched001",
      providerPaymentIntentId: "pi_unmatched001",
      providerRefundId: "re_unmatched001",
      amountTotalCents: 200,
      currency: "USD",
      terminalStatus: "succeeded" as const,
      occurredAt: "2026-07-31T12:01:00.000Z",
    };
    const unmatched = new SupabaseRepo(client({
      rpc: vi.fn(async () => ({
        data: [{
          recorded: false,
          credit_delta_usdc: "0",
          refund_state: "none",
        }],
        error: null,
      })),
    }));
    const malformed = new SupabaseRepo(client({
      rpc: vi.fn(async () => ({
        data: [{
          recorded: true,
          credit_delta_usdc: "-2",
          refund_state: "none",
        }],
        error: null,
      })),
    }));

    await expect(unmatched.recordStripeRevenueEvent(input)).resolves.toEqual({
      recorded: false,
      creditDeltaUsdc: 0,
      refundState: "none",
    });
    await expect(malformed.recordStripeRevenueEvent(input))
      .rejects.toThrow("invalid result");
  });

  it("fails closed when the Stripe revenue RPC is absent or malformed", async () => {
    const denied = new SupabaseRepo(client({
      rpc: vi.fn(async () => ({
        data: null,
        error: { message: "function is not provisioned" },
      })),
    }));
    const invalid = new SupabaseRepo(client({
      rpc: vi.fn(async () => ({
        data: [{ recorded: true, credit_delta_usdc: "secret", refund_state: "none" }],
        error: null,
      })),
    }));
    const input = {
      kind: "payment" as const,
      providerEventId: "evt_private002",
      ownerId: "owner-private",
      providerCheckoutSessionId: "cs_private002",
      providerPaymentIntentId: "pi_private002",
      amountTotalCents: 500,
      currency: "USD",
      terminalStatus: "paid" as const,
      providerProductId: null,
      providerPriceId: null,
      creditGrantUsdc: 5,
      occurredAt: "2026-07-31T12:00:00.000Z",
    };

    await expect(denied.recordStripeRevenueEvent(input))
      .rejects.toThrow("not provisioned");
    await expect(invalid.recordStripeRevenueEvent(input))
      .rejects.toThrow("invalid result");
  });

  it("uses one guarded boolean aggregate for paid entitlement", async () => {
    const eligibleRpc = vi.fn(async () => ({ data: true, error: null }));
    const eligible = new SupabaseRepo(client({ rpc: eligibleRpc }));
    await expect(eligible.hasEverPaid("owner-private")).resolves.toBe(true);
    expect(eligibleRpc).toHaveBeenCalledWith(
      "agent_studio_has_paid_entitlement",
      { p_owner_id: "owner-private" },
    );

    const refunded = new SupabaseRepo(client({
      rpc: vi.fn(async () => ({ data: false, error: null })),
    }));
    await expect(refunded.hasEverPaid("owner-refunded")).resolves.toBe(false);

    const malformed = new SupabaseRepo(client({
      rpc: vi.fn(async () => ({ data: [{ paid: true }], error: null })),
    }));
    await expect(malformed.hasEverPaid("owner-private"))
      .rejects.toThrow("invalid result");

    const denied = new SupabaseRepo(client({
      rpc: vi.fn(async () => ({
        data: null,
        error: { message: "paid entitlement is unauthorized" },
      })),
    }));
    await expect(denied.hasEverPaid("owner-private"))
      .rejects.toThrow("unauthorized");
  });

  it("delegates workspace adoption to one atomic database RPC", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const repo = new SupabaseRepo(client({ rpc }));

    await repo.adoptOwner("anonymous-owner", "sb:user");

    expect(rpc).toHaveBeenCalledWith("agent_studio_adopt_owner_with_connections", {
      p_from_owner_id: "anonymous-owner",
      p_to_owner_id: "sb:user",
    });
  });
});
