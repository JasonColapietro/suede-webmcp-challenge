/**
 * handleCliAgentsPush — deploy-on-push contract.
 *
 * A CLI push must leave the same deployment state a studio launch leaves: the
 * saved flow promoted to an active Live deployment, BEFORE any agent write.
 * Promotion failure throws CliLaunchPromotionError with no agent row behind
 * it. The default (no injected projectRepo) path promotes through
 * getProjectRepo() when the caller passes the process-canonical repo, which
 * is what the real route always does.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  CliLaunchPromotionError,
  handleCliAgentsPush,
} from "@/lib/cli/agents-handler";
import { getRepo } from "@/lib/db/repo";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import type { AgentManifest } from "@/lib/manifest/schema";
import { getProjectRepo } from "@/lib/projects/provider";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type { DeployVersionRepositoryInput, ProjectRepo } from "@/lib/projects/repo";

function manifest(name: string): AgentManifest {
  return AgentManifestSchema.parse({
    manifestVersion: 1,
    name,
    description: "A CLI-pushed agent that must be payable",
    triggers: [{ kind: "paidCall", priceUsdc: 0.1 }],
    steps: [
      { id: "n1", type: "input", config: {}, after: [] },
      { id: "n2", type: "llm", config: { prompt: "do stuff" }, after: ["n1"] },
      { id: "n3", type: "output", config: {}, after: ["n2"] },
    ],
    meta: { createdBy: "code" },
  });
}

function sharedStores(): { repo: SqliteRepo; projectRepo: SqliteProjectRepo } {
  const db = new Database(":memory:");
  return { repo: new SqliteRepo(db), projectRepo: new SqliteProjectRepo(db) };
}

function failingLiveDeployment(repo: ProjectRepo): ProjectRepo {
  return new Proxy(repo, {
    get(target, property, receiver): unknown {
      if (property === "deployVersion") {
        return async (input: DeployVersionRepositoryInput) => input.environmentKind === "live"
          ? { status: "conflict" as const }
          : target.deployVersion(input);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("handleCliAgentsPush — deploy on push", () => {
  it("promotes the pushed flow to an active Live deployment", async () => {
    const { repo, projectRepo } = sharedStores();
    const owner = `cli-push-promotion-${Date.now()}-a`;

    const result = await handleCliAgentsPush(manifest("Payable Push"), owner, repo, {
      projectRepo,
    });
    expect(result.ok).toBe(true);

    const [flow] = await repo.listFlows(owner);
    expect(flow).toBeDefined();
    if (!flow) return;
    const live = await projectRepo.getActiveDeployment({
      flowId: flow.id,
      environmentKind: "live",
      ownerId: owner,
    });
    expect(live).toMatchObject({ status: "live" });
    expect(await repo.getAgentByFlowId(flow.id)).not.toBeNull();
  });

  it("throws CliLaunchPromotionError and writes no agent when promotion fails", async () => {
    const { repo, projectRepo } = sharedStores();
    const owner = `cli-push-promotion-${Date.now()}-b`;

    await expect(
      handleCliAgentsPush(manifest("Unpayable Push"), owner, repo, {
        projectRepo: failingLiveDeployment(projectRepo),
      }),
    ).rejects.toBeInstanceOf(CliLaunchPromotionError);

    // The flow saved (safe residue), but no half-launched agent exists.
    const [flow] = await repo.listFlows(owner);
    expect(flow).toBeDefined();
    if (!flow) return;
    expect(await repo.getAgentByFlowId(flow.id)).toBeNull();
  });

  it("promotes by default when pushed through the process-canonical repo", async () => {
    const repo = await getRepo();
    const owner = `cli-push-promotion-${Date.now()}-c`;

    const result = await handleCliAgentsPush(manifest("Canonical Push"), owner, repo);
    expect(result.ok).toBe(true);

    const [flow] = await repo.listFlows(owner);
    expect(flow).toBeDefined();
    if (!flow) return;
    const projectRepo = await getProjectRepo();
    const live = await projectRepo.getActiveDeployment({
      flowId: flow.id,
      environmentKind: "live",
      ownerId: owner,
    });
    expect(live).toMatchObject({ status: "live" });
  });
});
