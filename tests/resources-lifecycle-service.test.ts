import { describe, expect, it, vi } from "vitest";
import {
  ResourceAmbiguousFinalCommitError,
  ResourcePersistenceError,
  ResourceRepositoryConflictError,
  type ResourceRepository,
} from "@/lib/resources/repository";
import { ResourceFoundryService } from "@/lib/resources/service";

const release = Object.freeze({
  id: "release-1", ownerId: "owner-1", resourceProductId: "resource-1",
  packVersionId: "pack-1", semanticHash: "a".repeat(64), publicationKey: "publication-1",
  publicationRequestHash: "b".repeat(64), graphSemanticHash: "c".repeat(64),
  graphFullHash: "d".repeat(64), priceUsdc: 0.08, executionAccess: "paid" as const,
  discoveryAccess: "public" as const, agentId: "agent-1", flowId: "flow-1",
  flowVersionId: "flow-version-1", deploymentId: "deployment-1",
  environmentId: "environment-1", createdAt: "2026-08-16T12:00:00.000Z",
});

const current = Object.freeze({
  id: "resource-1", ownerId: "owner-1", status: "live",
  currentRelease: {
    id: release.id, agentId: release.agentId, deploymentId: release.deploymentId,
  },
});

describe("Resource lifecycle service final boundary", () => {
  it.each(["failed", "missing"] as const)(
    "classifies a %s post-commit portfolio read as ambiguous",
    async (kind) => {
      let reads = 0;
      let committed = false;
      const repository = {
        getOwnedPortfolioItem: vi.fn(async () => {
          reads += 1;
          if (reads === 1) return current;
          if (kind === "missing") return null;
          throw new ResourcePersistenceError("post-commit read failed");
        }),
        transitionReleaseLifecycle: vi.fn(async () => {
          committed = true;
          return {
            product: {
              id: "resource-1", ownerId: "owner-1", name: "Resource", slug: "resource",
              status: "paused", executionAccess: "paid", discoveryAccess: "public",
            },
            release,
          };
        }),
      } as unknown as ResourceRepository;
      const service = new ResourceFoundryService(repository);

      await expect(service.transitionReleaseLifecycle("owner-1", "resource-1", {
        action: "pause", expectedStatus: "live", releaseId: release.id,
        agentId: release.agentId, deploymentId: release.deploymentId,
      })).rejects.toBeInstanceOf(ResourceAmbiguousFinalCommitError);
      expect(committed).toBe(true);
    },
  );

  it("preserves an optimistic conflict raised before the lifecycle commit", async () => {
    const conflict = new ResourceRepositoryConflictError();
    const repository = {
      getOwnedPortfolioItem: vi.fn().mockResolvedValue(current),
      transitionReleaseLifecycle: vi.fn().mockRejectedValue(conflict),
    } as unknown as ResourceRepository;
    const service = new ResourceFoundryService(repository);

    await expect(service.transitionReleaseLifecycle("owner-1", "resource-1", {
      action: "pause", expectedStatus: "live", releaseId: release.id,
      agentId: release.agentId, deploymentId: release.deploymentId,
    })).rejects.toBe(conflict);
  });
});
