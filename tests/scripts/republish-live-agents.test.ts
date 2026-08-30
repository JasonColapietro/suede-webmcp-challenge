/**
 * scripts/republish-live-agents.ts — the legacy-agent backfill.
 *
 * Locks in the safety contract Jason relies on when pointing this at prod:
 * dry-run by default (reports candidates, writes nothing), --execute promotes
 * exactly the live agents whose flow lacks an active Live deployment, a
 * re-run is a no-op, and draft agents are never touched.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { republishLiveAgents } from "../../scripts/republish-live-agents";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import { promoteFlowToLive } from "@/lib/launch/promote-live";
import type { FlowGraph } from "@/lib/flow/types";

const OWNER = "republish-script-owner";

function graph(id: string): FlowGraph {
  return {
    id,
    name: `Flow ${id}`,
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
  readonly bareFlowId: string;
  readonly deployedFlowId: string;
}> {
  const db = new Database(":memory:");
  const projectRepo = new SqliteProjectRepo(db);
  const repo = new SqliteRepo(db);

  // A legacy live agent: launched without any Live deployment.
  const bare = await repo.saveFlow({ ownerId: OWNER, name: "Legacy agent", graph: graph("g-bare") });
  await repo.createAgent({ flowId: bare.id, slug: "legacy-live", status: "live", priceUsdc: 0.05 });

  // A healthy live agent: already promoted.
  const deployed = await repo.saveFlow({ ownerId: OWNER, name: "Healthy agent", graph: graph("g-deployed") });
  await repo.createAgent({ flowId: deployed.id, slug: "healthy-live", status: "live", priceUsdc: 0.05 });
  const promotion = await promoteFlowToLive({ flowId: deployed.id, ownerId: OWNER, projectRepo });
  if (promotion.status !== "promoted") throw new Error("fixture promotion failed");

  // A draft agent: never in scope.
  const draft = await repo.saveFlow({ ownerId: OWNER, name: "Draft agent", graph: graph("g-draft") });
  await repo.createAgent({ flowId: draft.id, slug: "still-draft", status: "draft", priceUsdc: 0.05 });

  return { repo, projectRepo, bareFlowId: bare.id, deployedFlowId: deployed.id };
}

describe("republishLiveAgents", () => {
  it("dry-run reports the deployment-less live agent and writes nothing", async () => {
    const setup = await fixture();
    const summary = await republishLiveAgents({
      repo: setup.repo,
      projectRepo: setup.projectRepo,
      execute: false,
    });

    expect(summary.executed).toBe(false);
    expect(summary.scanned).toBe(2); // live agents only; the draft is out of scope
    expect(summary.alreadyLive).toBe(1);
    expect(summary.candidates.map((candidate) => candidate.slug)).toEqual(["legacy-live"]);
    expect(summary.promoted).toEqual([]);
    expect(summary.failed).toEqual([]);

    const live = await setup.projectRepo.getActiveDeployment({
      flowId: setup.bareFlowId,
      environmentKind: "live",
      ownerId: OWNER,
    });
    expect(live).toBeNull();
  });

  it("--execute promotes exactly the candidates, and a re-run is a no-op", async () => {
    const setup = await fixture();
    const first = await republishLiveAgents({
      repo: setup.repo,
      projectRepo: setup.projectRepo,
      execute: true,
    });

    expect(first.executed).toBe(true);
    expect(first.promoted).toEqual(["legacy-live"]);
    expect(first.failed).toEqual([]);

    const live = await setup.projectRepo.getActiveDeployment({
      flowId: setup.bareFlowId,
      environmentKind: "live",
      ownerId: OWNER,
    });
    expect(live).toMatchObject({ status: "live" });

    const second = await republishLiveAgents({
      repo: setup.repo,
      projectRepo: setup.projectRepo,
      execute: true,
    });
    expect(second.alreadyLive).toBe(2);
    expect(second.candidates).toEqual([]);
    expect(second.promoted).toEqual([]);
  });
});
