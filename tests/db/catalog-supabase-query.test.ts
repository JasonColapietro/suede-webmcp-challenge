import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseRepo } from "@/lib/db/supabase-repo";
import { SupabaseProjectRepo } from "@/lib/projects/supabase-project-repo";

type QueryResult = {
  readonly data: unknown;
  readonly error: null | Readonly<{ message: string }>;
};

function query(result: QueryResult): Record<string, ReturnType<typeof vi.fn> | unknown> {
  const value: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  for (const method of ["select", "eq", "in", "is", "not", "order", "limit"] as const) {
    value[method] = vi.fn(() => value);
  }
  value.then = (
    resolve: (result: QueryResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return value;
}

const createdAt = "2026-07-27T20:00:00.000Z";

describe("Supabase catalog query plan", () => {
  it("reads fresh Live membership, price, and flow graph through one relation", async () => {
    const agentQuery = query({
      data: [{
        id: "agent-1",
        flow_id: "flow-1",
        slug: "agent-one",
        status: "live",
        price_usdc: 4.25,
        settlement_live: false,
        created_at: createdAt,
        flow: {
          id: "flow-1",
          owner_id: "owner-1",
          name: "Agent One",
          graph: {
            id: "flow-1",
            name: "Agent One",
            nodes: [],
            edges: [],
          },
          updated_at: createdAt,
        },
      }],
      error: null,
    });
    const from = vi.fn(() => agentQuery);
    const repo = new SupabaseRepo({ from } as unknown as SupabaseClient);

    await expect(repo.listLiveAgentsWithFlows()).resolves.toMatchObject([{
      agent: { id: "agent-1", status: "live", priceUsdc: 4.25 },
      flow: { id: "flow-1", ownerId: "owner-1", name: "Agent One" },
    }]);
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("agents");
    expect(agentQuery.select).toHaveBeenCalledWith("*, flow:flows!inner(*)");
    expect(agentQuery.eq).toHaveBeenCalledWith("status", "live");
  });

  it("checks active deployment ownership in the same collection read", async () => {
    const deploymentQuery = query({
      data: [{
        id: "deployment-1",
        flow_id: "flow-1",
        flow_version_id: "version-1",
        environment_id: "environment-live",
        status: "live",
        created_at: createdAt,
        retired_at: null,
        flow: { owner_id: "owner-1" },
      }],
      error: null,
    });
    const from = vi.fn(() => deploymentQuery);
    const repo = new SupabaseProjectRepo({ from } as unknown as SupabaseClient);

    await expect(repo.listActiveDeploymentsForFlows({
      flows: [{ flowId: "flow-1", ownerId: "owner-1" }],
      environmentKind: "live",
    })).resolves.toMatchObject([{ id: "deployment-1", flowId: "flow-1", status: "live" }]);
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("deployments");
    expect(deploymentQuery.select).toHaveBeenCalledWith("*, flow:flows!inner(owner_id)");
    expect(deploymentQuery.in).toHaveBeenCalledWith("flow_id", ["flow-1"]);
    expect(deploymentQuery.eq).toHaveBeenCalledWith("status", "live");
    expect(deploymentQuery.is).toHaveBeenCalledWith("retired_at", null);
  });

  it("falls back instead of treating an ownership race as no active deployment", async () => {
    const deploymentQuery = query({
      data: [{
        id: "deployment-1",
        flow_id: "flow-1",
        flow_version_id: "version-1",
        environment_id: "environment-live",
        status: "live",
        created_at: createdAt,
        retired_at: null,
        flow: { owner_id: "owner-2" },
      }],
      error: null,
    });
    const repo = new SupabaseProjectRepo({
      from: vi.fn(() => deploymentQuery),
    } as unknown as SupabaseClient);

    await expect(repo.listActiveDeploymentsForFlows({
      flows: [{ flowId: "flow-1", ownerId: "owner-1" }],
      environmentKind: "live",
    })).rejects.toThrow("ownership changed");
  });

  it("counts settled runs per agent in one bulk read gated on settled_at", async () => {
    const runsQuery = query({
      data: [
        { agent_id: "agent-1" },
        { agent_id: "agent-1" },
        { agent_id: "agent-2" },
      ],
      error: null,
    });
    const from = vi.fn(() => runsQuery);
    const repo = new SupabaseRepo({ from } as unknown as SupabaseClient);

    await expect(
      repo.countSettledRunsByAgent(["agent-1", "agent-2", "agent-3"]),
    ).resolves.toEqual({ "agent-1": 2, "agent-2": 1 });
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("runs");
    expect(runsQuery.in).toHaveBeenCalledWith("agent_id", ["agent-1", "agent-2", "agent-3"]);
    expect(runsQuery.not).toHaveBeenCalledWith("settled_at", "is", null);
  });

  it("reads external-call recency per agent in one bulk read, newest wins", async () => {
    const runsQuery = query({
      data: [
        { agent_id: "agent-1", started_at: "2026-07-27T20:00:00.000Z" },
        { agent_id: "agent-1", started_at: "2026-07-26T20:00:00.000Z" },
        { agent_id: "agent-2", started_at: "2026-07-25T20:00:00.000Z" },
      ],
      error: null,
    });
    const from = vi.fn(() => runsQuery);
    const repo = new SupabaseRepo({ from } as unknown as SupabaseClient);

    await expect(
      repo.lastAgentCallAt(["agent-1", "agent-2"], "agent"),
    ).resolves.toEqual({
      "agent-1": Date.parse("2026-07-27T20:00:00.000Z"),
      "agent-2": Date.parse("2026-07-25T20:00:00.000Z"),
    });
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("runs");
    expect(runsQuery.in).toHaveBeenCalledWith("agent_id", ["agent-1", "agent-2"]);
    expect(runsQuery.eq).toHaveBeenCalledWith("trigger", "agent");
    expect(runsQuery.order).toHaveBeenCalledWith("started_at", { ascending: false });
  });

  it("fails closed to empty aggregates when the runs read throws", async () => {
    const repo = new SupabaseRepo({
      from: vi.fn(() => {
        throw new Error("runs table unavailable");
      }),
    } as unknown as SupabaseClient);

    await expect(repo.countSettledRunsByAgent(["agent-1"])).resolves.toEqual({});
    await expect(repo.lastAgentCallAt(["agent-1"], "agent")).resolves.toEqual({});
  });

  it("reads site verification proofs in one collection query and keeps exact pairs", async () => {
    const verificationQuery = query({
      data: [
        {
          owner_id: "owner-1",
          host: "one.example.com",
          method: "file",
          verified_at: createdAt,
        },
        {
          owner_id: "owner-2",
          host: "two.example.com",
          method: "file",
          verified_at: createdAt,
        },
        {
          // The two IN filters can return this cross-product row, but it was
          // not requested as a pair and must never verify the wrong agent.
          owner_id: "owner-1",
          host: "two.example.com",
          method: "file",
          verified_at: createdAt,
        },
      ],
      error: null,
    });
    const from = vi.fn(() => verificationQuery);
    const repo = new SupabaseRepo({ from } as unknown as SupabaseClient);

    await expect(repo.listSiteVerificationsByOwnersAndHosts([
      { ownerId: "owner-1", host: "one.example.com" },
      { ownerId: "owner-2", host: "two.example.com" },
    ])).resolves.toMatchObject([
      { ownerId: "owner-1", host: "one.example.com" },
      { ownerId: "owner-2", host: "two.example.com" },
    ]);
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("site_verifications");
    expect(verificationQuery.select).toHaveBeenCalledOnce();
    expect(verificationQuery.in).toHaveBeenNthCalledWith(
      1,
      "owner_id",
      ["owner-1", "owner-2"],
    );
    expect(verificationQuery.in).toHaveBeenNthCalledWith(
      2,
      "host",
      ["one.example.com", "two.example.com"],
    );
  });
});
