import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import {
  ResourcePersistenceError,
  ResourceRepositoryConflictError,
  type CreateResourceReleaseInput,
} from "@/lib/resources/repository";
import { SupabaseResourceRepository } from "@/lib/resources/supabase-repository";
import { resourceApiErrorResponse } from "@/lib/resources/service";
import { resourcePack } from "./fixture";

const releaseInput: CreateResourceReleaseInput = Object.freeze({
  ownerId: "owner", resourceProductId: "product-1", packVersionId: "pack-1",
  semanticHash: "a".repeat(64), publicationKey: "publication-1",
  publicationRequestHash: "d".repeat(64), graphSemanticHash: "b".repeat(64),
  graphFullHash: "c".repeat(64), priceUsdc: 0.05,
  executionAccess: "paid", discoveryAccess: "public",
  agentId: "agent-1", flowId: "flow-1", flowVersionId: "version-1",
  deploymentId: "deployment-1", environmentId: "environment-1",
});

function releaseRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "release-1", owner_id: releaseInput.ownerId,
    resource_product_id: releaseInput.resourceProductId,
    pack_version_id: releaseInput.packVersionId, semantic_hash: releaseInput.semanticHash,
    publication_key: releaseInput.publicationKey,
    publication_request_hash: releaseInput.publicationRequestHash,
    graph_semantic_hash: releaseInput.graphSemanticHash,
    graph_full_hash: releaseInput.graphFullHash, price_usdc: releaseInput.priceUsdc,
    execution_access: releaseInput.executionAccess,
    discovery_access: releaseInput.discoveryAccess, agent_id: releaseInput.agentId,
    flow_id: releaseInput.flowId, flow_version_id: releaseInput.flowVersionId,
    deployment_id: releaseInput.deploymentId, environment_id: releaseInput.environmentId,
    created_at: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

const productInput = Object.freeze({
  ownerId: "owner", name: "Resource", slug: "resource",
  executionAccess: "private" as const, discoveryAccess: "unlisted" as const,
});

function productRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "product-1", owner_id: productInput.ownerId,
    name: productInput.name, slug: productInput.slug, status: "draft",
    execution_access: productInput.executionAccess,
    discovery_access: productInput.discoveryAccess,
    ...overrides,
  };
}

function releaseSummaryRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "release-1", resourceProductId: "product-1",
    packVersionId: "pack-1", semanticHash: "a".repeat(64),
    publicationKey: "publication-1", publicationRequestHash: "d".repeat(64),
    priceUsdc: 0.05, executionAccess: "paid", discoveryAccess: "public",
    freshness: "fresh", payoutReady: true, settlementState: "on",
    agentId: "agent-1", agentStatus: "live", flowVersionId: "version-1",
    deploymentId: "deployment-1", deploymentStatus: "live", deploymentRetiredAt: null,
    createdAt: "2026-08-14T12:00:00.000Z",
    urls: { run: "/run", card: "/card", x402: "/x402", a2a: "/a2a", public: "/public" },
    ...overrides,
  };
}

describe("Supabase ResourceRepository contract", () => {
  it.each([
    ["blank", " "],
    ["oversized", "o".repeat(129)],
    ["control", "owner\u007fescape"],
  ])("rejects a %s product owner before either creation RPC", async (_kind, ownerId) => {
    const rpc = vi.fn();
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    const content = { ...resourcePack(), records: [], evidence: [], sourceSnapshotIds: [] };

    await expect(repo.createProduct({ ...productInput, ownerId }))
      .rejects.toThrow("Invalid resource input.");
    await expect(repo.createProductWithCandidate({
      ...productInput, ownerId, content, createdBy: ownerId,
    })).rejects.toThrow("Invalid resource input.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("normalizes the validated owner before the creation RPC", async () => {
    const normalizedOwner = "owner-é";
    const rpc = vi.fn().mockResolvedValue({
      data: productRow({ owner_id: normalizedOwner }), error: null,
    });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.createProduct({ ...productInput, ownerId: "owner-e\u0301" }))
      .resolves.toMatchObject({ ownerId: normalizedOwner });
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_create_product", {
      p_input: { ...productInput, ownerId: normalizedOwner },
    });
  });

  it.each([
    ["transport loss", new Error("connection lost")],
    ["empty success", null],
    ["mismatched success", productRow({ owner_id: "other-owner" })],
  ] as const)("classifies product creation %s as an ambiguous final commit", async (_kind, outcome) => {
    const rpc = outcome instanceof Error
      ? vi.fn().mockRejectedValue(outcome)
      : vi.fn().mockResolvedValue({ data: outcome, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.createProduct(productInput)).rejects.toMatchObject({
      name: "ResourceAmbiguousFinalCommitError",
      code: "RESOURCE_AMBIGUOUS_FINAL_COMMIT",
    });
  });

  it.each(["transport loss", "mismatched success"] as const)(
    "classifies atomic product/candidate creation %s as an ambiguous final commit",
    async (kind) => {
      const content = { ...resourcePack(), records: [], evidence: [], sourceSnapshotIds: [] };
      const semanticHash = resourcePackSemanticHash(content).semanticHash;
      const result = {
        product: productRow(),
        candidate: {
          id: "candidate-1",
          resource_product_id: kind === "mismatched success" ? "different-product" : "product-1",
          revision: 1, status: "candidate", semantic_hash: semanticHash,
          content, created_by: "owner", created_at: "2026-08-14T12:00:00.000Z",
        },
      };
      const rpc = kind === "transport loss"
        ? vi.fn().mockRejectedValue(new Error("connection lost"))
        : vi.fn().mockResolvedValue({ data: result, error: null });
      const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

      await expect(repo.createProductWithCandidate({
        ...productInput, content, createdBy: "owner",
      })).rejects.toMatchObject({
        name: "ResourceAmbiguousFinalCommitError",
        code: "RESOURCE_AMBIGUOUS_FINAL_COMMIT",
      });
    },
  );

  it("hydrates bounded current pack references without pack content", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{
      id: "product-1", owner_id: "owner", name: "Resource", slug: "resource",
      status: "draft", execution_access: "private", discovery_access: "unlisted",
      candidate_revision: 2, approved_pack_version_id: null, live_pack_version_id: null,
      current_candidate: { packVersionId: "candidate-2", revision: 2, semanticHash: "a".repeat(64) },
      approved_pack: null, live_pack: null,
      portfolio_freshness: "fresh",
      portfolio_payments: {
        attempted: null, free: 0, challenged: 0, executed: 0,
        credited: { count: 0, amountUsdc: 0 },
        settled: { count: 0, amountUsdc: 0 },
        refunded: { count: 0, amountUsdc: 0 }, failed: 0,
      },
      current_release: null,
      release_count: 0, run_receipt_count: 0,
    }], error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    const [item] = await repo.listOwnedProducts("owner");
    expect(item?.currentCandidate).toEqual({
      packVersionId: "candidate-2", revision: 2, semanticHash: "a".repeat(64),
    });
    expect(item?.approvedPack).toBeNull();
    expect(item?.livePack).toBeNull();
    expect(JSON.stringify(item)).not.toContain("content");
  });

  it("reads one exact owner portfolio summary without depending on the bounded list RPC", async () => {
    const row = {
      id: "product-101", owner_id: "owner", name: "Older resource", slug: "older-resource",
      status: "draft", execution_access: "private", discovery_access: "unlisted",
      candidate_revision: null, approved_pack_version_id: null, live_pack_version_id: null,
      current_candidate: null, approved_pack: null, live_pack: null,
      portfolio_freshness: null,
      portfolio_payments: {
        attempted: null, free: 0, challenged: 0, executed: 0,
        credited: { count: 0, amountUsdc: 0 },
        settled: { count: 0, amountUsdc: 0 },
        refunded: { count: 0, amountUsdc: 0 }, failed: 0,
      },
      current_release: null,
      release_count: 0, run_receipt_count: 0,
    };
    const rpc = vi.fn().mockResolvedValue({ data: row, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.getOwnedPortfolioItem("owner", "product-101")).resolves.toMatchObject({
      id: "product-101", portfolioFreshness: null, currentRelease: null,
    });
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_get_owned_portfolio_item", {
      p_owner_id: "owner", p_resource_product_id: "product-101",
    });
  });

  it("strictly parses one bounded owner-scoped release-history RPC", async () => {
    const prior = releaseSummaryRow({
      id: "release-prior", agentStatus: "draft", deploymentId: "deployment-prior",
      deploymentStatus: "retired", deploymentRetiredAt: "2026-08-14T13:00:00.000Z",
      createdAt: "2026-08-13T12:00:00.000Z",
    });
    const rpc = vi.fn().mockResolvedValue({ data: [releaseSummaryRow(), prior], error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.listOwnedReleaseHistory("owner", "product-1", 20)).resolves.toEqual([
      releaseSummaryRow(), prior,
    ]);
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_list_owned_releases", {
      p_owner_id: "owner", p_resource_product_id: "product-1", p_limit: 20,
    });
  });

  it.each([
    ["cross-product", [releaseSummaryRow({ resourceProductId: "product-other" })]],
    ["extra field", [releaseSummaryRow({ content: { private: true } })]],
    ["inconsistent lifecycle", [releaseSummaryRow({ deploymentStatus: "retired" })]],
    ["over limit", Array.from({ length: 21 }, (_, index) => releaseSummaryRow({ id: `release-${index}` }))],
  ] as const)("rejects %s release-history output as persistence corruption", async (_kind, data) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.listOwnedReleaseHistory("owner", "product-1", 20))
      .rejects.toBeInstanceOf(ResourcePersistenceError);
  });

  it("uses one prepared RPC for source snapshot and replacement candidate", async () => {
    const content = { ...resourcePack(), records: [], evidence: [], sourceSnapshotIds: [] };
    const semanticHash = resourcePackSemanticHash(content).semanticHash;
    const snapshot = {
      id: "snapshot-atomic", resource_product_id: "product-1", locator: "manual://atomic",
      source_kind: "manual_text", captured_at: "2026-08-14T12:00:00.000Z",
      content_hash: "f".repeat(64), freshness_deadline: "2026-08-21T12:00:00.000Z",
      source_published_at: null, provenance: null, provenance_note: null,
    };
    const rpc = vi.fn().mockResolvedValue({ data: {
      snapshot,
      candidate: {
        id: "candidate-2", resource_product_id: "product-1", revision: 2,
        status: "candidate", semantic_hash: semanticHash, content,
        created_by: "owner", created_at: "2026-08-14T12:00:00.000Z",
      },
    }, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    const input = {
      snapshot: {
        id: "snapshot-atomic", ownerId: "owner", resourceProductId: "product-1",
        locator: "manual://atomic", sourceKind: "manual_text",
        capturedAt: "2026-08-14T12:00:00.000Z", contentHash: "f".repeat(64),
        freshnessDeadline: "2026-08-21T12:00:00.000Z",
      },
      candidate: {
        ownerId: "owner", resourceProductId: "product-1",
        expectedCandidatePackVersionId: "candidate-1", expectedRevision: 1,
        content, createdBy: "owner",
      },
    };
    await expect((repo as typeof repo & {
      createSourceSnapshotAndReplaceCandidate(value: typeof input): Promise<unknown>;
    }).createSourceSnapshotAndReplaceCandidate(input)).resolves.toMatchObject({
      snapshot: { id: "snapshot-atomic" }, candidate: { id: "candidate-2" },
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[0]).toBe("agent_studio_resource_collect_source_candidate");
  });

  it("refuses a mismatched atomic snapshot and candidate before calling Supabase", async () => {
    const content = { ...resourcePack(), records: [], evidence: [], sourceSnapshotIds: [] };
    const rpc = vi.fn();
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.createSourceSnapshotAndReplaceCandidate({
      snapshot: {
        id: "snapshot-cross-owner", ownerId: "snapshot-owner", resourceProductId: "snapshot-product",
        locator: "manual://cross-owner", sourceKind: "manual_text",
        capturedAt: "2026-08-14T12:00:00.000Z", contentHash: "f".repeat(64),
        freshnessDeadline: "2026-08-21T12:00:00.000Z",
      },
      candidate: {
        ownerId: "candidate-owner", resourceProductId: "candidate-product",
        expectedCandidatePackVersionId: "candidate-1", expectedRevision: 1,
        content, createdBy: "candidate-owner",
      },
    })).rejects.toBeInstanceOf(ResourceRepositoryConflictError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("creates the product and initial candidate through one transactional RPC", async () => {
    const content = { ...resourcePack(), records: [], evidence: [], sourceSnapshotIds: [] };
    const semanticHash = resourcePackSemanticHash(content).semanticHash;
    const rpc = vi.fn().mockResolvedValue({ data: {
      product: {
        id: "product-atomic", owner_id: "owner", name: "Atomic", slug: "atomic",
        status: "draft", execution_access: "private", discovery_access: "unlisted",
      },
      candidate: {
        id: "candidate-atomic", resource_product_id: "product-atomic", revision: 1,
        status: "candidate", semantic_hash: semanticHash, content,
        created_by: "owner", created_at: "2026-08-14T12:00:00.000Z",
      },
    }, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.createProductWithCandidate({
      ownerId: "owner", name: "Atomic", slug: "atomic",
      executionAccess: "private", discoveryAccess: "unlisted",
      content, createdBy: "owner",
    })).resolves.toMatchObject({
      product: { id: "product-atomic" }, candidate: { id: "candidate-atomic", revision: 1 },
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[0]).toBe("agent_studio_resource_create_product_with_candidate");
  });

  it("translates the prepared RPC duplicate-slug signal into the fixed private 409", async () => {
    const content = { ...resourcePack(), records: [], evidence: [], sourceSnapshotIds: [] };
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "RESOURCE_CONFLICT" },
    });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    let caught: unknown;
    try {
      await repo.createProductWithCandidate({
        ownerId: "owner", name: "Duplicate", slug: "duplicate",
        executionAccess: "private", discoveryAccess: "unlisted",
        content, createdBy: "owner",
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResourceRepositoryConflictError);
    const response = resourceApiErrorResponse(caught);
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "resource conflict" });
  });

  it("uses transactional server RPCs and surfaces persistence failures", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: {
        id: "product-1", owner_id: "owner", name: "Resource", slug: "resource",
        status: "draft", execution_access: "private", discovery_access: "unlisted",
      }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "private-db-canary" } });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    await expect(repo.createProduct({
      ownerId: "owner", name: "Resource", slug: "resource",
      executionAccess: "private", discoveryAccess: "unlisted",
    })).resolves.toMatchObject({ id: "product-1", ownerId: "owner" });
    await expect(repo.replaceCandidate({
      ownerId: "owner", resourceProductId: "product-1",
      expectedCandidatePackVersionId: null, expectedRevision: 0,
      content: resourcePack(), createdBy: "owner",
    })).rejects.toThrow("Resource persistence failed");
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "agent_studio_resource_create_product",
      "agent_studio_resource_replace_candidate",
    ]);
  });

  it("keeps workspace adoption as one existing atomic owner RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    await repo.adoptOwner("anonymous-owner", "sb:user");
    await repo.adoptOwner("anonymous-owner", "sb:user");
    expect(rpc).toHaveBeenNthCalledWith(1, "agent_studio_adopt_owner_with_connections", {
      p_from_owner_id: "anonymous-owner", p_to_owner_id: "sb:user",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each([1, 100])("bulk-loads %i latest releases with one RPC", async (count) => {
    const agentIds = Array.from({ length: count }, (_, index) => `agent-${index}`);
    const rpc = vi.fn().mockResolvedValue({
      data: agentIds.map((agentId, index) => releaseRow({
        id: `release-${index}`,
        agent_id: agentId,
      })),
      error: null,
    });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.listPublishedReleasesByAgentIds(agentIds)).resolves.toHaveLength(count);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_list_releases_by_agents", {
      p_agent_ids: agentIds,
    });
  });

  it("transitions one pinned release through one final lifecycle RPC", async () => {
    const input = {
      ownerId: "owner", resourceProductId: "product-1", action: "pause" as const,
      expectedStatus: "live" as const, releaseId: "release-1",
      agentId: "agent-1", deploymentId: "deployment-1",
    };
    const rpc = vi.fn().mockResolvedValue({
      data: {
        product: productRow({ status: "paused" }),
        release: releaseRow(),
      },
      error: null,
    });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.transitionReleaseLifecycle(input)).resolves.toMatchObject({
      product: { id: "product-1", status: "paused" },
      release: { id: "release-1", agentId: "agent-1", deploymentId: "deployment-1" },
    });
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_transition_release_lifecycle", {
      p_input: input,
    });
  });

  it.each(["transport", "mismatched-result"] as const)(
    "classifies lifecycle %s as an ambiguous final commit",
    async (kind) => {
      const rpc = kind === "transport"
        ? vi.fn().mockRejectedValue(new Error("connection lost"))
        : vi.fn().mockResolvedValue({
          data: {
            product: productRow({ status: "live" }),
            release: releaseRow(),
          },
          error: null,
        });
      const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
      await expect(repo.transitionReleaseLifecycle({
        ownerId: "owner", resourceProductId: "product-1", action: "pause",
        expectedStatus: "live", releaseId: "release-1",
        agentId: "agent-1", deploymentId: "deployment-1",
      })).rejects.toMatchObject({
        name: "ResourceAmbiguousFinalCommitError",
        code: "RESOURCE_AMBIGUOUS_FINAL_COMMIT",
      });
    },
  );

  it("hydrates a zero-evidence pack using declared-snapshot freshness", async () => {
    const base = resourcePack();
    const content = {
      ...base,
      records: base.records.map((record) => ({ ...record, evidenceIds: [] })),
      evidence: [],
      sourceSnapshotIds: ["snapshot-contract", "snapshot-unreferenced"],
    };
    const { semanticHash } = resourcePackSemanticHash(content);
    const rpc = vi.fn().mockResolvedValue({ data: {
      pack: {
        id: "pack-zero-evidence", resource_product_id: "product-1", revision: 1,
        status: "approved", semantic_hash: semanticHash, content,
        created_by: "owner", created_at: "2026-08-13T12:00:00.000Z",
      },
      freshness: "mixed",
    }, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.getOwnedPack({
      ownerId: "owner", resourceProductId: "product-1",
      packVersionId: "pack-zero-evidence", semanticHash,
    })).resolves.toMatchObject({ freshness: "mixed", content: { evidence: [] } });
  });

  it("reads only the server-current approved pointer without caller pins", async () => {
    const content = resourcePack();
    const { semanticHash } = resourcePackSemanticHash(content);
    const rpc = vi.fn().mockResolvedValue({ data: {
      pack: {
        id: "pack-current", resource_product_id: "product-1", revision: 2,
        status: "approved", semantic_hash: semanticHash, content,
        created_by: "owner", created_at: "2026-08-13T12:00:00.000Z",
      },
      freshness: "fresh",
    }, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.getOwnedApprovedPack("owner", "product-1"))
      .resolves.toMatchObject({ packVersionId: "pack-current", semanticHash });
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_get_owned_approved_pack", {
      p_owner_id: "owner", p_resource_product_id: "product-1",
    });
  });

  it("hydrates only the bounded owner-scoped source aggregate", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { source_count: 2, source_kinds: ["rss", "manual"] }, error: null,
    });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    const reference = {
      ownerId: "owner", resourceProductId: "product-1",
      packVersionId: "pack-1", semanticHash: "a".repeat(64),
    };
    await expect(repo.getOwnedSourceDisclosure(reference)).resolves.toEqual({
      sourceCount: 2, sourceKinds: ["manual", "rss"],
    });
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_get_source_disclosure", { p_reference: reference });
    expect(JSON.stringify(await repo.getOwnedSourceDisclosure(reference))).not.toContain("locator");
  });

  it("strictly hydrates every immutable receipt and payment fact", async () => {
    const row = {
      id: "receipt-1", owner_id: "owner", resource_product_id: "product-1",
      pack_version_id: "pack-1", agent_id: "agent-1", run_id: "run-1",
      flow_version_id: "version-1", deployment_id: "deployment-1",
      payment_id: "credit-1", payment_state: "credited", price_usdc: 0.05,
      semantic_hash: "a".repeat(64), freshness: "fresh",
      evidence_json: resourcePack().evidence, unknowns_json: [], conflicts_json: [],
      output_schema_valid: true, created_at: "2026-08-14T12:00:00.000Z",
    };
    const rpc = vi.fn().mockResolvedValue({ data: row, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    await expect(repo.recordRunReceipt({
      ownerId: "owner", resourceProductId: "product-1", packVersionId: "pack-1",
      agentId: "agent-1", runId: "run-1", flowVersionId: "version-1",
      deploymentId: "deployment-1", paymentId: "credit-1", paymentState: "credited",
      priceUsdc: 0.05, receipt: {
        resourceProductId: "product-1", resourceVersion: "pack-1", semanticHash: "a".repeat(64),
        freshness: "fresh", evidence: resourcePack().evidence, unknowns: [], conflicts: [], outputSchemaValid: true,
      },
    })).resolves.toMatchObject({ agentId: "agent-1", paymentId: "credit-1", paymentState: "credited", priceUsdc: 0.05 });
    rpc.mockResolvedValueOnce({ data: { ...row, payment_state: "paid" }, error: null });
    await expect(repo.listRunReceipts("owner", "product-1")).rejects.toBeInstanceOf(ResourcePersistenceError);
    rpc.mockResolvedValueOnce({
      data: { ...row, evidence_json: [{ ...resourcePack().evidence[0], observedAt: "not-a-timestamp" }] },
      error: null,
    });
    await expect(repo.listRunReceipts("owner", "product-1")).rejects.toBeInstanceOf(ResourcePersistenceError);
    rpc.mockResolvedValueOnce({
      data: { ...row, evidence_json: [{ ...resourcePack().evidence[0], privateSourceText: "must never hydrate" }] },
      error: null,
    });
    await expect(repo.listRunReceipts("owner", "product-1")).rejects.toBeInstanceOf(ResourcePersistenceError);
  });

  it("reconciles an exact immutable release by owner-scoped publication key", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      id: "release-1", owner_id: "owner", resource_product_id: "product-1",
      pack_version_id: "pack-1", semantic_hash: "a".repeat(64),
      publication_key: "publication-1", publication_request_hash: "d".repeat(64),
      graph_semantic_hash: "b".repeat(64), graph_full_hash: "c".repeat(64),
      price_usdc: 0.05, execution_access: "paid", discovery_access: "public",
      agent_id: "agent-1", flow_id: "flow-1", flow_version_id: "version-1",
      deployment_id: "deployment-1", environment_id: "environment-1",
      created_at: "2026-08-14T12:00:00.000Z",
    }, error: null });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.getOwnedPublishedReleaseByPublicationKey(
      "owner", "product-1", "publication-1",
    )).resolves.toMatchObject({
      publicationKey: "publication-1", graphSemanticHash: "b".repeat(64),
      graphFullHash: "c".repeat(64), executionAccess: "paid", discoveryAccess: "public",
    });
    expect(rpc).toHaveBeenCalledWith("agent_studio_resource_get_release_by_publication", {
      p_owner_id: "owner", p_resource_product_id: "product-1", p_publication_key: "publication-1",
    });
  });

  it.each(["transport", "unknown-result"] as const)(
    "classifies a final publication %s as an explicitly ambiguous commit",
    async (failure) => {
      const rpc = failure === "transport"
        ? vi.fn().mockRejectedValue(new Error("connection lost"))
        : vi.fn().mockResolvedValue({ data: null, error: null });
      const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
      let caught: unknown;
      try {
        await repo.createRelease(releaseInput);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({
        name: "ResourceAmbiguousFinalCommitError",
        code: "RESOURCE_AMBIGUOUS_FINAL_COMMIT",
      });
    },
  );

  it("keeps a returned final RPC error deterministic rather than ambiguous", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null, error: { code: "XX000", message: "deterministic integrity refusal" },
    });
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);
    let caught: unknown;
    try {
      await repo.createRelease(releaseInput);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "ResourcePersistenceError",
      code: "RESOURCE_PERSISTENCE_ERROR",
    });
  });

  it.each([
    ["partial", { data: { price_usdc: 0.05, execution_access: "paid", discovery_access: "public" }, error: null }],
    ["mismatched", { data: releaseRow({ graph_full_hash: "e".repeat(64) }), error: null }],
  ] as const)("classifies a %s final RPC success payload as ambiguous", async (_kind, result) => {
    const rpc = vi.fn().mockResolvedValue(result);
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.createRelease(releaseInput)).rejects.toMatchObject({
      name: "ResourceAmbiguousFinalCommitError",
      code: "RESOURCE_AMBIGUOUS_FINAL_COMMIT",
    });
  });

  it.each([
    new ResourceRepositoryConflictError(),
    new ResourcePersistenceError("deterministic adapter refusal"),
  ])("preserves a thrown known deterministic final RPC error", async (failure) => {
    const rpc = vi.fn().mockRejectedValue(failure);
    const repo = new SupabaseResourceRepository({ rpc } as unknown as SupabaseClient);

    await expect(repo.createRelease(releaseInput)).rejects.toBe(failure);
  });

  it("prepares server-only RLS, immutable constraints, and resource-aware adoption without rights gates", () => {
    const migration = readFileSync(
      new URL("../../docs/migrations/agent-resource-foundry.sql", import.meta.url), "utf8",
    ).toLowerCase();
    const deploy = readFileSync(
      new URL("../../src/lib/db/schema.deploy.sql", import.meta.url), "utf8",
    ).toLowerCase();
    const stripeMigration = readFileSync(
      new URL("../../docs/migrations/agent-studio-stripe-revenue-source.sql", import.meta.url), "utf8",
    ).toLowerCase();
    const receiptRpc = migration.match(/create or replace function public\.agent_studio_resource_record_run_receipt\(p_input jsonb\)(.*?)end; \$\$;/su)?.[1];
    const releaseRpc = migration.match(/create or replace function public\.agent_studio_resource_create_release\(p_input jsonb\)(.*?)end; \$\$;/su)?.[1];
    const lifecycleRpc = migration.match(/create or replace function public\.agent_studio_resource_transition_release_lifecycle\(p_input jsonb\)(.*?)end; \$\$;/su)?.[1];
    const packRpc = migration.match(/create or replace function public\.agent_studio_resource_get_owned_pack\(p_reference jsonb\)(.*?)\$\$;/su)?.[1];
    const approvedPackRpc = migration.match(/create or replace function public\.agent_studio_resource_get_owned_approved_pack\(p_owner_id text,p_resource_product_id text\)(.*?)\$\$;/su)?.[1];
    const releaseHistoryRpc = migration.match(/create or replace function public\.agent_studio_resource_list_owned_releases\(\s*p_owner_id text,p_resource_product_id text,p_limit integer\s*\)(.*?)end;\s*\$\$;/su)?.[1];
    const atomicCreateRpc = migration.match(/create or replace function public\.agent_studio_resource_create_product_with_candidate\(p_input jsonb\)(.*?)end; \$\$;/su)?.[1];
    const atomicSourceRpc = migration.match(/create or replace function public\.agent_studio_resource_collect_source_candidate\(p_input jsonb\)(.*?)end; \$\$;/su)?.[1];
    for (const table of [
      "resource_products", "resource_source_assets", "resource_source_snapshots",
      "resource_pack_versions", "resource_records", "resource_evidence_refs",
      "resource_releases", "resource_run_receipts",
    ]) {
      expect(migration).toContain(`create table if not exists public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(deploy).toContain(`create table if not exists ${table}`);
    }
    expect(migration).toContain("create or replace function public.agent_studio_adopt_resource_owner");
    expect(migration).toContain("airbyte_source_private.agent_studio_adopt_stripe_owner(text,text)");
    expect(migration).toContain("resource adoption found an unsafe stripe owner wrapper");
    expect(migration).toContain("update public.resource_products");
    expect(migration).toContain("update public.resource_releases");
    expect(migration).toContain("update public.resource_run_receipts");
    expect(stripeMigration).toContain("create or replace function\n  airbyte_source_private.agent_studio_adopt_stripe_owner");
    expect(stripeMigration).toContain("public.agent_studio_adopt_resource_owner(text,text)");
    expect(stripeMigration).toContain("v_effective_target :=\n    airbyte_source_private.agent_studio_adopt_stripe_owner");
    expect(migration).toContain("resource source snapshots are append-only");
    expect(migration).toContain("resource pack content is immutable");
    expect(migration).toContain("grant delete on table public.resource_pack_versions to service_role;");
    expect(migration).toContain("grant delete on table public.resource_pack_versions to anon;");
    expect(migration).toMatch(/foreign key\s*\(resource_product_id,pack_version_id\)\s*references public\.resource_pack_versions\s*\(resource_product_id,id\)/u);
    expect(releaseRpc).toContain("pg_advisory_xact_lock");
    expect(releaseRpc).toContain("update public.agents set status='live'");
    expect(releaseRpc).toContain("dp.kind='resource'");
    expect(releaseRpc).toContain("publication_request_hash");
    expect(releaseRpc).toContain("graph_semantic_hash");
    expect(releaseRpc).toContain("a.price_usdc");
    expect(releaseRpc).toContain("p.execution_access");
    expect(lifecycleRpc).toContain("pg_advisory_xact_lock");
    expect(lifecycleRpc).toContain("for update");
    expect(lifecycleRpc).toContain("p_input->>'releaseid'");
    expect(lifecycleRpc).toContain("p_input->>'agentid'");
    expect(lifecycleRpc).toContain("p_input->>'deploymentid'");
    expect(lifecycleRpc).toContain("retired_at is null");
    expect(lifecycleRpc).toContain("retired_at is not null");
    expect(lifecycleRpc).toContain("status='paused'");
    expect(lifecycleRpc).toContain("status='retired'");
    expect(migration).toContain("agent_studio_resource_transition_release_lifecycle(jsonb)");
    expect(migration).toMatch(/agent_studio_resource_get_release_by_agent[\s\S]*?p\.status='live'[\s\S]*?a\.status='live'[\s\S]*?d\.status='live'[\s\S]*?d\.retired_at is null/u);
    expect(migration).toContain("agent_studio_resource_get_release_by_publication");
    expect(receiptRpc).toContain("pg_advisory_xact_lock");
    expect(receiptRpc).toContain("resource_product_id=p_input->>'resourceproductid'");
    expect(receiptRpc).toContain("jsonb_array_elements(receipt->'evidence')");
    expect(receiptRpc).toContain("resource_evidence_refs");
    expect(packRpc).toContain("jsonb_array_elements_text(v.content_json->'sourcesnapshotids')");
    expect(packRpc).not.toContain("join public.resource_evidence_refs");
    expect(approvedPackRpc).toContain("v.status='approved'");
    expect(releaseHistoryRpc).toContain("p_limit<1 or p_limit>50");
    expect(releaseHistoryRpc).toContain("r.owner_id=p_owner_id");
    expect(releaseHistoryRpc).toContain("r.resource_product_id=p_resource_product_id");
    expect(releaseHistoryRpc).toContain("order by r.created_at desc,r.id desc");
    expect(releaseHistoryRpc).toContain("limit p_limit");
    expect(releaseHistoryRpc).toContain("'resourceproductid',r.resource_product_id");
    expect(releaseHistoryRpc).toContain("'freshness'");
    expect(migration).toContain("public.agent_studio_resource_list_owned_releases(text,text,integer)");
    expect(atomicCreateRpc).toContain("insert into public.resource_products");
    expect(atomicCreateRpc).toContain("insert into public.resource_pack_versions");
    expect(atomicCreateRpc).toContain("agent_studio_resource_pack_json");
    expect(atomicSourceRpc).toContain("agent_studio_resource_create_source_snapshot");
    expect(atomicSourceRpc).toContain("agent_studio_resource_replace_candidate");
    expect(migration).toContain("public.agent_studio_resource_collect_source_candidate(jsonb)");
    expect(migration).toContain("public.agent_studio_resource_create_product_with_candidate(jsonb)");
    expect(migration).toContain("p_input ? 'name'");
    expect(migration).not.toMatch(/rights_status|rightsstatus|license_document|licensedocument|verified_rights|rights_review/u);
    expect(migration).not.toMatch(/\b(?:psql|supabase db push|migration up)\b/u);
  });
});
