/**
 * promoteFlowToLive — the shared launch promotion sequence.
 *
 * Locks in the contract every launch surface now depends on: a launch is only
 * a launch when the flow's current graph ends up promoted to an active,
 * immutable Live deployment (ensureOwnedFlowContext -> version ->
 * PROMOTE TEST -> PROMOTE LIVE with the Test source). Fixture mirrors
 * tests/api-company-activation.test.ts: one in-memory sqlite database shared
 * by the flow store and the project control plane.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { promoteFlowToLive } from "@/lib/launch/promote-live";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import type { DeployVersionRepositoryInput, ProjectRepo } from "@/lib/projects/repo";
import type { FlowGraph } from "@/lib/flow/types";
import { materializeResourceGraph } from "@/lib/resources/materialize";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { resourcePack } from "../resources/fixture";

const OWNER = "promote-live-owner";

function graph(id: string): FlowGraph {
  return {
    id,
    name: "Promote live flow",
    nodes: [
      { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: "input-output", source: "input", target: "output" }],
  };
}

async function fixture(): Promise<{
  readonly flowRepo: SqliteRepo;
  readonly projectRepo: SqliteProjectRepo;
  readonly flowId: string;
}> {
  const db = new Database(":memory:");
  const projectRepo = new SqliteProjectRepo(db);
  const flowRepo = new SqliteRepo(db);
  const flow = await flowRepo.saveFlow({
    ownerId: OWNER,
    name: "Promote live flow",
    graph: graph("g-promote-live"),
  });
  return { flowRepo, projectRepo, flowId: flow.id };
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

describe("promoteFlowToLive", () => {
  it("promotes a fresh flow through exact Test to an active immutable Live deployment", async () => {
    const setup = await fixture();
    const result = await promoteFlowToLive({
      flowId: setup.flowId,
      ownerId: OWNER,
      projectRepo: setup.projectRepo,
    });

    expect(result.status).toBe("promoted");
    if (result.status !== "promoted") return;
    expect(result.testDeployment.flowVersionId).toBe(result.versionId);
    expect(result.liveDeployment.flowVersionId).toBe(result.versionId);
    expect(result.liveDeployment.status).toBe("live");

    const [versions, testDeployment, liveDeployment] = await Promise.all([
      setup.projectRepo.listFlowVersions({ flowId: setup.flowId, ownerId: OWNER }),
      setup.projectRepo.getActiveDeployment({
        flowId: setup.flowId,
        environmentKind: "test",
        ownerId: OWNER,
      }),
      setup.projectRepo.getActiveDeployment({
        flowId: setup.flowId,
        environmentKind: "live",
        ownerId: OWNER,
      }),
    ]);
    expect(versions).toHaveLength(1);
    expect(testDeployment).toMatchObject({ flowVersionId: result.versionId, status: "test" });
    expect(liveDeployment).toMatchObject({ flowVersionId: result.versionId, status: "live" });
  });

  it("re-promotes on relaunch so the active Live deployment tracks the newest checkpoint", async () => {
    const setup = await fixture();
    const first = await promoteFlowToLive({
      flowId: setup.flowId,
      ownerId: OWNER,
      projectRepo: setup.projectRepo,
    });
    const second = await promoteFlowToLive({
      flowId: setup.flowId,
      ownerId: OWNER,
      projectRepo: setup.projectRepo,
    });
    expect(first.status).toBe("promoted");
    expect(second.status).toBe("promoted");
    if (second.status !== "promoted") return;

    const active = await setup.projectRepo.getActiveDeployment({
      flowId: setup.flowId,
      environmentKind: "live",
      ownerId: OWNER,
    });
    expect(active?.flowVersionId).toBe(second.versionId);
    expect(active?.retiredAt).toBeUndefined();
  });

  it("fails with the live-deployment stage and leaves no active Live deployment behind", async () => {
    const setup = await fixture();
    const result = await promoteFlowToLive({
      flowId: setup.flowId,
      ownerId: OWNER,
      projectRepo: failingLiveDeployment(setup.projectRepo),
    });
    expect(result).toEqual({ status: "failed", stage: "live-deployment" });

    const live = await setup.projectRepo.getActiveDeployment({
      flowId: setup.flowId,
      environmentKind: "live",
      ownerId: OWNER,
    });
    expect(live).toBeNull();
  });

  it("refuses a flow the owner does not hold at the flow-context stage", async () => {
    const setup = await fixture();
    const result = await promoteFlowToLive({
      flowId: setup.flowId,
      ownerId: "some-other-owner",
      projectRepo: setup.projectRepo,
    });
    expect(result).toEqual({ status: "failed", stage: "flow-context" });
  });

  it("checkpoints the exact materialized Resource Pack dependency before Live promotion", async () => {
    const db = new Database(":memory:");
    const flowRepo = new SqliteRepo(db);
    const projectRepo = new SqliteProjectRepo(db);
    const resourceRepo = new SqliteResourceRepository(db);
    const product = await resourceRepo.createProduct({
      ownerId: OWNER, name: "Resource flow", slug: "resource-flow",
      executionAccess: "free", discoveryAccess: "public",
    });
    await resourceRepo.createSourceSnapshot({
      id: "snapshot-contract", ownerId: OWNER, resourceProductId: product.id,
      locator: "manual://pricing", sourceKind: "manual", capturedAt: "2026-08-13T12:00:00.000Z",
      contentHash: "a".repeat(64), freshnessDeadline: "2027-08-20T12:00:00.000Z",
    });
    const candidate = await resourceRepo.replaceCandidate({
      ownerId: OWNER, resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: OWNER,
    });
    await resourceRepo.approveCandidate({
      ownerId: OWNER, resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: 1,
      expectedSemanticHash: candidate.semanticHash, approvedBy: OWNER,
    });
    const pack = await resourceRepo.getOwnedApprovedPack(OWNER, product.id);
    expect(pack).not.toBeNull();
    if (!pack) return;
    const materialized = materializeResourceGraph({ product, pack, sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] } });
    await flowRepo.saveFlow({ id: product.id, ownerId: OWNER, name: product.name, graph: materialized.graph });
    const result = await promoteFlowToLive({ flowId: product.id, ownerId: OWNER, projectRepo });
    expect(result.status).toBe("promoted");
    if (result.status !== "promoted") return;
    const version = await projectRepo.getFlowVersion({
      ownerId: OWNER, flowId: product.id, versionId: result.versionId,
    });
    expect(version?.dependencies).toContainEqual(expect.objectContaining({
      kind: "resource", resourceId: product.id, version: pack.packVersionId,
      contentHash: pack.semanticHash,
    }));
    db.close();
  });
});
