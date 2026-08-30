/**
 * POST /api/flows/[id]/launch — deploy-on-launch contract.
 *
 * A launch must produce an agent whose PAID call can actually run: the route
 * now promotes the flow's current graph to an active Live deployment before
 * any agent write, and the response reports settlement + payout + pricing
 * state. These tests exercise the real route against the suite's isolated
 * sqlite database (getRepo and getProjectRepo share it), so the assertion
 * "preparePublishedLiveExecution returns an authority" is exactly the gate
 * that previously produced 503 "published run unavailable".
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { getRepo } from "@/lib/db/repo";
import { getProjectRepo } from "@/lib/projects/provider";
import {
  disposePreparedPublishedLiveExecution,
  preparePublishedLiveExecution,
} from "@/lib/run-service";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (key: string) => (key === "x-owner-id" ? currentOwner : null),
  }),
  cookies: async () => ({ get: () => undefined }),
}));

let currentOwner = "owner-launch-live-default";

const { POST } = await import("@/app/api/flows/[id]/launch/route");

afterEach(() => {
  vi.unstubAllEnvs();
});

async function launch(id: string, owner: string, body: unknown = {}): Promise<Response> {
  currentOwner = owner;
  return POST(
    new Request(`https://agents.suedeai.ai/api/flows/${id}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function v1Graph(id: string): FlowGraph {
  return {
    id,
    name: "Launch live flow",
    nodes: [
      { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
      {
        id: "brain",
        type: "llm",
        params: { prompt: "answer", system: "s".repeat(4_000) },
        position: { x: 240, y: 0 },
      },
      { id: "output", type: "output", params: {}, position: { x: 480, y: 0 } },
    ],
    edges: [
      { id: "input-brain", source: "input", target: "brain" },
      { id: "brain-output", source: "brain", target: "output" },
    ],
  };
}

function v2PaidCallGraph(id: string): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id,
    name: "V2 paid call flow",
    nodes: [
      { id: "input", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, bindings: {}, position: { x: 240, y: 0 } },
    ],
    edges: [
      { id: "edge", source: "input", sourceHandle: "result", target: "output", targetHandle: "in" },
    ],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function v2ScheduleGraph(id: string): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id,
    name: "V2 schedule flow",
    nodes: [
      {
        id: "trig",
        type: "schedule",
        params: { cron: "0 9 * * *" },
        bindings: {},
        position: { x: 0, y: 0 },
      },
      { id: "output", type: "output", params: {}, bindings: {}, position: { x: 240, y: 0 } },
    ],
    edges: [
      { id: "edge", source: "trig", sourceHandle: "result", target: "output", targetHandle: "in" },
    ],
    variables: [],
    groups: [],
    annotations: [],
  };
}

describe("POST /api/flows/[id]/launch — deploy on launch", () => {
  it("creates the agent AND an active Live deployment a paid run can resolve", async () => {
    const owner = `owner-launch-live-${Date.now()}-a`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "Launch live", graph: v1Graph("g-launch-live-a") });

    const response = await launch(flow.id, owner, { priceUsdc: 0.05 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agent: { id: string; settlementLive: boolean };
      deployment: { id: string; versionId: string };
      settlementLive: boolean;
      settlementEndpoint: string;
      payoutSource: string;
      floorUsdc: number;
      suggestedUsdc: number;
    };

    const agent = await repo.getAgentByFlowId(flow.id);
    expect(agent).not.toBeNull();
    expect(agent?.status).toBe("live");
    expect(agent?.settlementLive).toBe(false);

    const projectRepo = await getProjectRepo();
    const live = await projectRepo.getActiveDeployment({
      flowId: flow.id,
      environmentKind: "live",
      ownerId: owner,
    });
    expect(live).not.toBeNull();
    expect(live?.status).toBe("live");
    expect(live?.id).toBe(body.deployment.id);
    expect(live?.flowVersionId).toBe(body.deployment.versionId);

    // The exact gate the paid run route checks before 503ing with
    // "published run unavailable": a launch must leave it satisfied.
    const prepared = await preparePublishedLiveExecution({ flowId: flow.id, ownerId: owner });
    expect(prepared).not.toBeNull();
    if (prepared) disposePreparedPublishedLiveExecution(prepared);
  });

  it("returns the additive settlement, payout, and pricing fields", async () => {
    vi.stubEnv("X402_SELLER_WALLET_ADDRESS", "0x1111111111111111111111111111111111111111");
    const owner = `owner-launch-live-${Date.now()}-b`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "Launch fields", graph: v1Graph("g-launch-live-b") });

    const response = await launch(flow.id, owner, { priceUsdc: 0.25 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.settlementLive).toBe(false);
    const agent = await repo.getAgentByFlowId(flow.id);
    expect(body.settlementEndpoint).toBe(`/api/agents/${agent?.id}/settlement`);
    // No owner wallet was saved, so the platform env wallet is the payout
    // fallback and a priced agent must carry the warning.
    expect(body.payoutSource).toBe("platform");
    expect(typeof body.payoutWarning).toBe("string");
    expect(body.payoutWarning).toContain("payout wallet");
    // Cost-derived annotation from the 4,000-char system prompt: a real
    // positive floor, and a suggestion at or above it.
    expect(typeof body.floorUsdc).toBe("number");
    expect(body.floorUsdc as number).toBeGreaterThan(0);
    expect(body.suggestedUsdc as number).toBeGreaterThanOrEqual(body.floorUsdc as number);
  });

  it("omits payoutWarning when the payout routes to a creator wallet", async () => {
    const owner = `owner-launch-live-${Date.now()}-c`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({ ownerId: owner, name: "Creator payout", graph: v1Graph("g-launch-live-c") });

    const response = await launch(flow.id, owner, {
      priceUsdc: 0.1,
      payoutAddress: "0x2222222222222222222222222222222222222222",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.payoutSource).toBe("creator");
    expect("payoutWarning" in body).toBe(false);
  });

  it("launches a v2 paid-call-only graph instead of 409ing (v2 unlock)", async () => {
    const owner = `owner-launch-live-${Date.now()}-d`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({
      ownerId: owner,
      name: "V2 paid call",
      graph: v2PaidCallGraph("g-launch-live-d"),
    });

    const response = await launch(flow.id, owner, { priceUsdc: 0.02 });
    expect(response.status).toBe(200);

    const projectRepo = await getProjectRepo();
    const live = await projectRepo.getActiveDeployment({
      flowId: flow.id,
      environmentKind: "live",
      ownerId: owner,
    });
    expect(live?.status).toBe("live");
  });

  it("still 409s a v2 graph carrying schedule or webhook triggers", async () => {
    const owner = `owner-launch-live-${Date.now()}-e`;
    const repo = await getRepo();
    const flow = await repo.saveFlow({
      ownerId: owner,
      name: "V2 schedule",
      graph: v2ScheduleGraph("g-launch-live-e"),
    });

    const response = await launch(flow.id, owner);
    expect(response.status).toBe(409);
    expect(await repo.getAgentByFlowId(flow.id)).toBeNull();
  });
});
