/**
 * settlementReadiness — the /api/health launch-rail signal.
 *
 * Locks in: envLive mirrors X402_SKIP_SETTLEMENT === "false" exactly, the
 * count covers live PRICED agents whose flow lacks an active Live deployment
 * (free agents never count), and a failing store degrades to null (unknown),
 * never a false zero and never a throw.
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settlementReadiness } from "@/lib/health";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { promoteFlowToLive } from "@/lib/launch/promote-live";
import type { FlowGraph } from "@/lib/flow/types";

const OWNER = "health-settlement-owner";

function graph(id: string): FlowGraph {
  return {
    id,
    name: "Health settlement flow",
    nodes: [
      { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: "input-output", source: "input", target: "output" }],
  };
}

async function fixture(): Promise<{
  readonly repo: SqliteRepo;
  readonly projectRepo: SqliteProjectRepo;
  readonly flowId: string;
}> {
  const db = new Database(":memory:");
  const projectRepo = new SqliteProjectRepo(db);
  const repo = new SqliteRepo(db);
  const flow = await repo.saveFlow({ ownerId: OWNER, name: "priced", graph: graph("g-health-a") });
  await repo.createAgent({ flowId: flow.id, slug: "health-priced", status: "live", priceUsdc: 0.1 });
  return { repo, projectRepo, flowId: flow.id };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("settlementReadiness", () => {
  it("reports envLive true only when X402_SKIP_SETTLEMENT is exactly \"false\"", async () => {
    const { repo, projectRepo } = await fixture();
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    expect((await settlementReadiness({ repo, projectRepo })).envLive).toBe(true);
    vi.stubEnv("X402_SKIP_SETTLEMENT", "true");
    expect((await settlementReadiness({ repo, projectRepo })).envLive).toBe(false);
    vi.stubEnv("X402_SKIP_SETTLEMENT", "");
    expect((await settlementReadiness({ repo, projectRepo })).envLive).toBe(false);
  });

  it("counts live priced agents without an active Live deployment, and drops to zero after promotion", async () => {
    const { repo, projectRepo, flowId } = await fixture();

    const before = await settlementReadiness({ repo, projectRepo });
    expect(before.pricedAgentsWithoutLiveDeployment).toBe(1);

    const promotion = await promoteFlowToLive({ flowId, ownerId: OWNER, projectRepo });
    expect(promotion.status).toBe("promoted");

    const after = await settlementReadiness({ repo, projectRepo });
    expect(after.pricedAgentsWithoutLiveDeployment).toBe(0);
  });

  it("ignores free agents: no price means nothing to sell, so no coverage gap", async () => {
    const db = new Database(":memory:");
    const projectRepo = new SqliteProjectRepo(db);
    const repo = new SqliteRepo(db);
    const flow = await repo.saveFlow({ ownerId: OWNER, name: "free", graph: graph("g-health-free") });
    await repo.createAgent({ flowId: flow.id, slug: "health-free", status: "live", priceUsdc: 0 });

    const readiness = await settlementReadiness({ repo, projectRepo });
    expect(readiness.pricedAgentsWithoutLiveDeployment).toBe(0);
  });

  it("degrades to null when the stores fail, instead of throwing or reporting a false zero", async () => {
    const { projectRepo } = await fixture();
    const failingRepo = {
      listLiveAgents: async (): Promise<never> => {
        throw new Error("store down");
      },
      getFlow: async (): Promise<null> => null,
    };
    const readiness = await settlementReadiness({ repo: failingRepo, projectRepo });
    expect(readiness.pricedAgentsWithoutLiveDeployment).toBeNull();
  });
});
