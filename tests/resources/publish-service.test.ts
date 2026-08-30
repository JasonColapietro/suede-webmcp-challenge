import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import { hashFlowGraph } from "@/lib/projects/hash";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";
import {
  ResourcePublicationRefusedError,
  ResourcePublishService,
  type MaterializedResourceFlow,
} from "@/lib/resources/publish-service";
import { canonicalResourceAgentSlug } from "@/lib/resources/materialize";
import type { ProjectRepo } from "@/lib/projects/repo";
import {
  ResourceAmbiguousFinalCommitError,
  ResourcePersistenceError,
  ResourceRepositoryConflictError,
  type ResourceRepository,
} from "@/lib/resources/repository";
import { SqliteResourceRepository } from "@/lib/resources/sqlite-repository";
import { RESOURCE_TEST_NOW as NOW, resourcePack } from "./fixture";

const publicationRuntime = vi.hoisted(() => ({ nativeCostUsdc: 0 }));

vi.mock("@/lib/flow/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/flow/engine")>();
  return {
    ...original,
    collectRun: async (...args: Parameters<typeof original.collectRun>) => {
      const summary = await original.collectRun(...args);
      return publicationRuntime.nativeCostUsdc === 0
        ? summary
        : { ...summary, totalCostUsdc: publicationRuntime.nativeCostUsdc };
    },
  };
});

describe("ResourcePublishService", () => {
  let db: Database.Database;
  let flowRepo: SqliteRepo;
  let projectRepo: SqliteProjectRepo;
  let resourceRepo: SqliteResourceRepository;

  beforeEach(() => {
    publicationRuntime.nativeCostUsdc = 0;
    db = new Database(":memory:");
    runSqliteMigrations(db);
    flowRepo = new SqliteRepo(db);
    projectRepo = new SqliteProjectRepo(db);
    resourceRepo = new SqliteResourceRepository(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  async function approved(
    access: "free" | "paid" | "private" = "paid",
    freshnessDeadline = "2026-08-20T12:00:00.000Z",
    discoveryAccess: "public" | "unlisted" = "public",
  ) {
    const product = await resourceRepo.createProduct({
      ownerId: "owner-a", name: "Pricing signals", slug: `pricing-${access}`,
      executionAccess: access, discoveryAccess,
    });
    const snapshotId = access === "paid" ? "snapshot-contract" : "snapshot-contract-free";
    await resourceRepo.createSourceSnapshot({
      id: snapshotId, ownerId: "owner-a", resourceProductId: product.id,
      locator: "manual://pricing", sourceKind: "manual", capturedAt: NOW.toISOString(),
      contentHash: "a".repeat(64), freshnessDeadline,
    });
    const base = resourcePack();
    const content = snapshotId === "snapshot-contract" ? base : {
      ...base,
      evidence: base.evidence.map((item) => ({ ...item, sourceSnapshotId: snapshotId })),
      sourceSnapshotIds: [snapshotId],
    };
    const candidate = await resourceRepo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content, createdBy: "owner-a",
    });
    const pack = await resourceRepo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: candidate.id, expectedRevision: candidate.revision,
      expectedSemanticHash: candidate.semanticHash, approvedBy: "owner-a",
    });
    return { product, pack };
  }

  it("publishes the exact current pack with immutable release identity and settlement still off", async () => {
    const { product, pack } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const dryRun = vi.fn().mockResolvedValue({ measuredCostUsdc: 0 });
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo, dryRun });
    const published = await service.publish("owner-a", product.id, {
      priceUsdc: 0.05,
      representative: {
        input: { tier: "paid" },
        filters: { tier: "paid" },
        expectedProperties: ["name", "tier"],
      },
    });

    expect(published.release).toMatchObject({
      resourceProductId: product.id, packVersionId: pack.id,
      semanticHash: pack.semanticHash, flowId: product.id, priceUsdc: 0.05,
      executionAccess: "paid", discoveryAccess: "public",
      publicationKey: expect.any(String), publicationRequestHash: expect.any(String),
      graphSemanticHash: expect.any(String), graphFullHash: expect.any(String),
    });
    expect(published.agent).toMatchObject({
      slug: canonicalResourceAgentSlug(product), status: "live", settlementLive: false, priceUsdc: 0.05,
    });
    expect(await resourceRepo.getOwnedProduct("owner-a", product.id)).toMatchObject({ status: "live" });
    expect(await resourceRepo.getOwnedPack({
      ownerId: "owner-a", resourceProductId: product.id,
      packVersionId: pack.id, semanticHash: pack.semanticHash,
    })).toMatchObject({ packVersionId: pack.id });
    const version = await projectRepo.getFlowVersion({
      ownerId: "owner-a", flowId: product.id, versionId: published.release.flowVersionId,
    });
    expect(version?.dependencies).toContainEqual(expect.objectContaining({
      kind: "resource", resourceId: product.id, version: pack.id, contentHash: pack.semanticHash,
    }));
    expect(version).toMatchObject({
      semanticHash: published.release.graphSemanticHash,
      fullHash: published.release.graphFullHash,
    });
    expect(dryRun).toHaveBeenCalledWith(expect.objectContaining({
      graphSemanticHash: published.release.graphSemanticHash,
      graphFullHash: published.release.graphFullHash,
      graph: expect.objectContaining({ id: `resource-product:${product.id}` }),
      representative: {
        input: { tier: "paid" },
        filters: { tier: "paid" },
        expectedProperties: ["name", "tier"],
      },
    }));
    expect(published.urls).toEqual({
      run: `/api/agents/${published.agent.slug}/run`,
      card: `/api/agents/${published.agent.slug}/.well-known/agent-card.json`,
      x402: `/api/agents/${published.agent.slug}/.well-known/x402`,
      a2a: `/api/agents/${published.agent.slug}/a2a`,
      public: `/a/${published.agent.slug}`,
    });
  });

  it("refuses price below measured cost before creating an agent", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const dryRun = vi.fn().mockResolvedValue({ measuredCostUsdc: 0.1 });
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo, dryRun });
    await expect(service.publish("owner-a", product.id, {
      priceUsdc: 0.09,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);
    expect(await flowRepo.getAgentByFlowId(product.id)).toBeNull();
  });

  it("refuses a positive native representative cost before creating an agent or release", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    publicationRuntime.nativeCostUsdc = 0.01;
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });

    await expect(service.publish("owner-a", product.id, {
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);
    expect(await flowRepo.getAgentByFlowId(product.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
  });

  it("refuses publication when proof filters differ from live caller input", async () => {
    const { product } = await approved("paid");
    const dryRun = vi.fn().mockResolvedValue({ measuredCostUsdc: 0 });
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo, dryRun });

    await expect(service.publish("owner-a", product.id, {
      priceUsdc: 0.05,
      representative: {
        input: { tier: "missing" },
        filters: { tier: "paid" },
        expectedProperties: ["name"],
      },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);
    expect(dryRun).not.toHaveBeenCalled();
    expect(await flowRepo.getAgentByFlowId(product.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
  });

  it("refuses publication when the representative result omits an expected property", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });

    await expect(service.publish("owner-a", product.id, {
      priceUsdc: 0.05,
      representative: {
        input: { tier: "paid" },
        filters: { tier: "paid" },
        expectedProperties: ["privateSourceBody"],
      },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);
    expect(await flowRepo.getAgentByFlowId(product.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
  });

  it("requires payout readiness only for paid execution", async () => {
    const paid = await approved("paid");
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });
    await expect(service.publish("owner-a", paid.product.id, {
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);

    const free = await approved("free");
    await expect(service.publish("owner-a", free.product.id, {
      priceUsdc: 0,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).resolves.toMatchObject({ agent: { status: "live", settlementLive: false } });
  });

  it.each([
    ["free", 0.01],
    ["private", 0.01],
  ] as const)("requires %s publication price to be exactly zero", async (access, priceUsdc) => {
    const { product } = await approved(access);
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });
    await expect(service.publish("owner-a", product.id, {
      priceUsdc,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);
    expect(await flowRepo.getAgentByFlowId(product.id)).toBeNull();
  });

  it.each([
    ["free", "public"],
    ["private", "public"],
    ["paid", "unlisted"],
  ] as const)("persists immutable %s/%s publication access", async (access, discoveryAccess) => {
    const { product } = await approved(access, "2026-08-20T12:00:00.000Z", discoveryAccess);
    if (access === "paid") {
      await flowRepo.saveWallet({
        ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
      });
    }
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });
    const published = await service.publish("owner-a", product.id, {
      priceUsdc: access === "paid" ? 0.05 : 0,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    });
    expect(published.release).toMatchObject({ executionAccess: access, discoveryAccess });
  });

  it("fails publication when the mutable draft changes after materialization", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    let raced = false;
    const racingProjectRepo = new Proxy(projectRepo as ProjectRepo, {
      get(target, property, receiver): unknown {
        if (property === "createFlowVersion") {
          return async (...args: Parameters<ProjectRepo["createFlowVersion"]>) => {
            if (!raced) {
              raced = true;
              const flow = await flowRepo.getFlow(product.id);
              if (!flow) throw new Error("expected materialized flow");
              await flowRepo.saveFlow({
                id: flow.id, ownerId: flow.ownerId, name: flow.name,
                graph: { ...flow.graph, name: "Concurrent private draft" },
              });
            }
            return target.createFlowVersion(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new ResourcePublishService({
      resourceRepo, flowRepo, projectRepo: racingProjectRepo,
    });
    await expect(service.publish("owner-a", product.id, {
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
    expect(await flowRepo.getAgentByFlowId(product.id)).toMatchObject({ status: "draft" });
  });

  it.each(["wiring", "expected-hashes"] as const)(
    "runs the production representative evaluator against exact materialized %s identity",
    async (mutation) => {
      const { product } = await approved("paid");
      await flowRepo.saveWallet({
        ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
      });
      const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });
      const materialize = service.materialize.bind(service);
      vi.spyOn(service, "materialize").mockImplementation(async (...args): Promise<MaterializedResourceFlow> => {
        const exact = await materialize(...args);
        if (mutation === "expected-hashes") {
          return Object.freeze({
            ...exact,
            semanticHash: "f".repeat(64),
            fullHash: "e".repeat(64),
          });
        }
        const graph = {
          ...exact.graph,
          edges: exact.graph.edges.map((edge) => edge.id === "resource-input-query"
            ? { ...edge, targetHandle: "missing-filter-port" }
            : edge),
        };
        const dependencies = [{
          kind: "resource" as const,
          resourceId: exact.product.id,
          version: exact.pack.packVersionId,
          contentHash: exact.pack.semanticHash,
        }];
        return Object.freeze({
          ...exact,
          graph,
          semanticHash: hashFlowGraph(graph, { semantic: true }, dependencies),
          fullHash: hashFlowGraph(graph, { semantic: false }, dependencies),
        });
      });

      await expect(service.publish("owner-a", product.id, {
        priceUsdc: 0.05,
        representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
      })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);
      expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 0 });
      expect(await flowRepo.getAgentByFlowId(product.id)).toBeNull();
    },
  );

  it("reconciles a committed release after an ambiguous persistence error and replays it", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    let ambiguous = true;
    const fault = new Proxy(resourceRepo as ResourceRepository, {
      get(target, property, receiver): unknown {
        if (property === "createRelease") {
          return async (...args: Parameters<ResourceRepository["createRelease"]>) => {
            const release = await target.createRelease(...args);
            if (ambiguous) {
              ambiguous = false;
              throw new ResourceAmbiguousFinalCommitError();
            }
            return release;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new ResourcePublishService({ resourceRepo: fault, flowRepo, projectRepo });
    const request = {
      idempotencyKey: "publish-pricing-v1",
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    };
    const first = await service.publish("owner-a", product.id, request);
    const replay = await service.publish("owner-a", product.id, request);
    expect(replay).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 1 });
    expect(await flowRepo.getAgent(first.agent.id)).toMatchObject({
      status: "live", priceUsdc: 0.05, settlementLive: false,
    });
  });

  it("refuses stale approved material before any flow or agent write", async () => {
    const { product } = await approved("paid", "2026-08-01T12:00:00.000Z");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });
    await expect(service.publish("owner-a", product.id, {
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);
    expect(await flowRepo.getFlow(product.id)).toBeNull();
    expect(await flowRepo.getAgentByFlowId(product.id)).toBeNull();
  });

  it("preserves the prior Live release when the final transaction refuses a superseding pack", async () => {
    const { product, pack: firstPack } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const service = new ResourcePublishService({ resourceRepo, flowRepo, projectRepo });
    const first = await service.publish("owner-a", product.id, {
      priceUsdc: 0.05,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    });
    const nextCandidate = await resourceRepo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 1,
      content: resourcePack("Superseding"), createdBy: "owner-a",
    });
    const nextPack = await resourceRepo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: nextCandidate.id, expectedRevision: 2,
      expectedSemanticHash: nextCandidate.semanticHash, approvedBy: "owner-a",
    });
    const fault = new Proxy(resourceRepo as ResourceRepository, {
      get(target, property, receiver): unknown {
        if (property === "createRelease") return async () => { throw new ResourceRepositoryConflictError(); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const retry = new ResourcePublishService({ resourceRepo: fault, flowRepo, projectRepo });
    await expect(retry.publish("owner-a", product.id, {
      priceUsdc: 0.06,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    expect(await resourceRepo.getPublishedReleaseByAgent(first.agent.id)).toEqual(first.release);
    expect(await flowRepo.getAgent(first.agent.id)).toMatchObject({ status: "live", priceUsdc: 0.05, settlementLive: false });
    expect(db.prepare("SELECT status FROM resource_pack_versions WHERE id=?").get(firstPack.id)).toEqual({ status: "live" });
    expect(db.prepare("SELECT status FROM resource_pack_versions WHERE id=?").get(nextPack.id)).toEqual({ status: "approved" });
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 1 });
  });

  it("restores the prior Live agent after a pre-final promotion failure even when release lookup is unavailable", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const first = await new ResourcePublishService({ resourceRepo, flowRepo, projectRepo }).publish(
      "owner-a",
      product.id,
      {
        idempotencyKey: "publish-prior-live",
        priceUsdc: 0.05,
        representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
      },
    );
    const nextCandidate = await resourceRepo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 1,
      content: resourcePack("Pre-final failure"), createdBy: "owner-a",
    });
    await resourceRepo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: nextCandidate.id, expectedRevision: 2,
      expectedSemanticHash: nextCandidate.semanticHash, approvedBy: "owner-a",
    });
    let publicationReads = 0;
    const unavailableReconciliation = new Proxy(resourceRepo as ResourceRepository, {
      get(target, property, receiver): unknown {
        if (property === "getOwnedPublishedReleaseByPublicationKey") {
          return async (...args: Parameters<ResourceRepository["getOwnedPublishedReleaseByPublicationKey"]>) => {
            publicationReads += 1;
            if (publicationReads > 1) throw new ResourcePersistenceError();
            return target.getOwnedPublishedReleaseByPublicationKey(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failedPromotion = new Proxy(projectRepo as ProjectRepo, {
      get(target, property, receiver): unknown {
        if (property === "createFlowVersion") return async () => null;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(new ResourcePublishService({
      resourceRepo: unavailableReconciliation,
      flowRepo,
      projectRepo: failedPromotion,
    }).publish("owner-a", product.id, {
      idempotencyKey: "publish-pre-final-failure",
      priceUsdc: 0.07,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);

    expect(publicationReads).toBe(1);
    expect(await flowRepo.getAgent(first.agent.id)).toMatchObject({
      status: "live", priceUsdc: 0.05, settlementLive: false,
    });
    expect(await projectRepo.getActiveDeployment({
      flowId: product.id, ownerId: "owner-a", environmentKind: "live",
    })).toMatchObject({ id: first.release.deploymentId });
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 1 });
  });

  it("restores the prior Live agent after deterministic final integrity failure without reconciliation", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const first = await new ResourcePublishService({ resourceRepo, flowRepo, projectRepo }).publish(
      "owner-a", product.id,
      {
        idempotencyKey: "publish-integrity-prior",
        priceUsdc: 0.05,
        representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
      },
    );
    const nextCandidate = await resourceRepo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 1,
      content: resourcePack("Integrity failure"), createdBy: "owner-a",
    });
    await resourceRepo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: nextCandidate.id, expectedRevision: 2,
      expectedSemanticHash: nextCandidate.semanticHash, approvedBy: "owner-a",
    });
    let publicationReads = 0;
    const deterministicFailure = new Proxy(resourceRepo as ResourceRepository, {
      get(target, property, receiver): unknown {
        if (property === "getOwnedPublishedReleaseByPublicationKey") {
          return async (...args: Parameters<ResourceRepository["getOwnedPublishedReleaseByPublicationKey"]>) => {
            publicationReads += 1;
            if (publicationReads > 1) throw new ResourcePersistenceError();
            return target.getOwnedPublishedReleaseByPublicationKey(...args);
          };
        }
        if (property === "createRelease") {
          return async () => { throw new ResourcePersistenceError("Resource persistence integrity check failed."); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(new ResourcePublishService({
      resourceRepo: deterministicFailure, flowRepo, projectRepo,
    }).publish("owner-a", product.id, {
      idempotencyKey: "publish-integrity-next",
      priceUsdc: 0.07,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toMatchObject({ code: "RESOURCE_PERSISTENCE_ERROR" });

    expect(publicationReads).toBe(1);
    expect(await flowRepo.getAgent(first.agent.id)).toMatchObject({
      status: "live", priceUsdc: 0.05, settlementLive: false,
    });
    expect(await projectRepo.getActiveDeployment({
      flowId: product.id, ownerId: "owner-a", environmentKind: "live",
    })).toMatchObject({ id: first.release.deploymentId });
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 1 });
  });

  it("restores the prior Live agent when the draft mutation returns an unexpected record", async () => {
    const { product } = await approved("paid");
    await flowRepo.saveWallet({
      ownerId: "owner-a", address: "0x2222222222222222222222222222222222222222",
    });
    const first = await new ResourcePublishService({ resourceRepo, flowRepo, projectRepo }).publish(
      "owner-a", product.id,
      {
        idempotencyKey: "publish-draft-prior",
        priceUsdc: 0.05,
        representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
      },
    );
    const nextCandidate = await resourceRepo.replaceCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      expectedCandidatePackVersionId: null, expectedRevision: 1,
      content: resourcePack("Unexpected draft"), createdBy: "owner-a",
    });
    await resourceRepo.approveCandidate({
      ownerId: "owner-a", resourceProductId: product.id,
      candidatePackVersionId: nextCandidate.id, expectedRevision: 2,
      expectedSemanticHash: nextCandidate.semanticHash, approvedBy: "owner-a",
    });
    const unexpectedDraft = new Proxy(flowRepo, {
      get(target, property, receiver): unknown {
        if (property === "updateAgent") {
          return async (...args: Parameters<SqliteRepo["updateAgent"]>) => {
            const updated = await target.updateAgent(...args);
            const patch = args[1];
            return patch.status === "draft" && updated
              ? Object.freeze({ ...updated, status: "live" as const })
              : updated;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(new ResourcePublishService({
      resourceRepo, flowRepo: unexpectedDraft, projectRepo,
    }).publish("owner-a", product.id, {
      idempotencyKey: "publish-draft-next",
      priceUsdc: 0.08,
      representative: { input: { tier: "paid" }, filters: { tier: "paid" } },
    })).rejects.toBeInstanceOf(ResourcePublicationRefusedError);

    expect(await flowRepo.getAgent(first.agent.id)).toMatchObject({
      status: "live", priceUsdc: 0.05, settlementLive: false,
    });
    expect(db.prepare("SELECT COUNT(*) count FROM resource_releases").get()).toEqual({ count: 1 });
  });
});
