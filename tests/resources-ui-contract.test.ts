import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildResourceRecollectRequest,
  buildResourceRejectRequest,
  bootstrapResourceWorkspace,
  parseResourceRefreshResponse,
  parseResourceRefreshRejection,
  parseResourceReleaseHistoryResponse,
  parseResourceListResponse,
  parseResourceTrustResponse,
  requestIsCurrent,
  resourceMutationAllowedForHost,
  type ResourceDryRun,
  type ResourcePackContent,
} from "@/components/resources/client";
import {
  mergeCollectedSource,
  resourceRefreshBaseFromProduct,
  resourcePackPointerFromProduct,
  resourceTabUrl,
} from "@/components/resources/ResourceWorkspace";
import {
  buildResourceRepresentativeProof,
  buildResourceRepresentativeDraft,
  parseResourceRepresentativeDraft,
  resourceRepresentativeForPublication,
  resourceRepresentativeProofIsCurrent,
} from "@/components/resources/representative";
import * as resourceClient from "@/components/resources/client";
import type { ResourcePackBundle } from "@/components/resources/client";
import { resourcePack } from "./resources/fixture";

const read = (path: string): string => existsSync(path) ? readFileSync(path, "utf8") : "";
const resourcePackContent = (): ResourcePackContent =>
  JSON.parse(JSON.stringify(resourcePack())) as ResourcePackContent;

describe("Resource Foundry route shell", () => {
  it("is noindex and loads each private owner surface after hydration", () => {
    const layout = read("src/app/resources/layout.tsx");
    expect(layout).toContain('noIndexFollowMetadata("/resources")');
    expect(layout).toContain("RESOURCE_FOUNDRY_ENABLED");
    expect(layout).not.toMatch(/resolveOwnerId|resolveReadOnlyOwnerId|cookies\(|headers\(/u);

    for (const path of [
      "src/app/resources/page.tsx",
      "src/app/resources/new/page.tsx",
      "src/app/resources/[resourceId]/page.tsx",
    ]) {
      const page = read(path);
      expect(page).toContain('ssr: false');
      expect(page).toContain('role="status"');
    }
  });

  it("does not make the Foundry reachable from the Google Play app host", () => {
    const playGate = read("src/lib/google-play-access-only.ts");
    const appAllowlist = playGate.slice(
      playGate.indexOf("const ALLOWED_APP_PATH_PREFIXES"),
      playGate.indexOf("const ALLOWED_API_PATH_PREFIXES"),
    );
    expect(appAllowlist).not.toContain('"/resources"');
    for (const path of [
      "src/app/api/v2/resources/route.ts",
      "src/app/api/v2/resources/[resourceId]/route.ts",
      "src/app/api/v2/resources/[resourceId]/materialize/route.ts",
      "src/app/api/v2/resources/[resourceId]/packs/route.ts",
      "src/app/api/v2/resources/[resourceId]/publish/route.ts",
      "src/app/api/v2/resources/[resourceId]/lifecycle/route.ts",
      "src/app/api/v2/resources/[resourceId]/records/route.ts",
      "src/app/api/v2/resources/[resourceId]/refresh/route.ts",
      "src/app/api/v2/resources/[resourceId]/sources/route.ts",
      "src/app/api/v2/resources/[resourceId]/sources/collect/route.ts",
      "src/app/api/v2/resources/[resourceId]/test/route.ts",
    ]) expect(read(path)).toContain("googlePlayResourceMutationRefusal(request)");
  });

  it("loads portfolio summaries without per-resource trust or pack fan-out", () => {
    const portfolio = read("src/components/resources/ResourcePortfolio.tsx");
    expect(portfolio).toContain("resource.portfolioFreshness");
    expect(portfolio).toContain("resource.portfolioPayments.executed");
    expect(portfolio).not.toContain("parseResourceTrustResponse");
    expect(portfolio).not.toContain("parseResourcePackResponse");
    expect(portfolio).not.toMatch(/\/trust|\/packs\?/u);
  });

  it("opens confirmation dialogs only through the native modal lifecycle", () => {
    const dialog = read("src/components/resources/ResourceConfirmDialog.tsx");
    expect(dialog).toContain("dialog.showModal()");
    expect(dialog).toContain("dialog.close()");
    expect(dialog).toContain('event.key !== "Tab"');
    expect(dialog).not.toContain("open={open}");
  });

  it("wires owner lifecycle controls through one exact pinned private mutation", () => {
    const workspace = read("src/components/resources/ResourceWorkspace.tsx");
    expect(workspace).toContain("<ResourceLifecycleControls");
    expect(workspace).toContain("buildResourceLifecycleRequest(product, action)");
    expect(workspace).toContain("/lifecycle`");
    expect(workspace).toContain("parseResourceLifecycleResponse");
    expect(workspace).toContain("/releases`");
    expect(workspace).toContain("parseResourceReleaseHistoryResponse");
    expect(workspace).toContain("releaseHistory={releaseHistory}");
    expect(workspace).toMatch(/setProduct\(nextProduct\);\s*setPublished\(null\);/u);
    expect(workspace).toContain('danger={lifecycleRequest?.action === "retire"}');
  });
});

describe("Resource Foundry client boundary", () => {
  const resource = {
    id: "resource-1",
    ownerId: "owner-1",
    name: "Pricing signals",
    slug: "pricing-signals",
    status: "live",
    executionAccess: "paid",
    discoveryAccess: "public",
    candidateRevision: null,
    approvedPackVersionId: "pack-4",
    livePackVersionId: "pack-4",
    currentCandidate: null,
    approvedPack: { packVersionId: "pack-4", revision: 4, semanticHash: "a".repeat(64) },
    livePack: { packVersionId: "pack-4", revision: 4, semanticHash: "a".repeat(64) },
    portfolioFreshness: "fresh",
    portfolioPayments: {
      attempted: null,
      free: 0,
      challenged: null,
      executed: 2,
      credited: { count: 1, amountUsdc: 0.08 },
      settled: { count: 1, amountUsdc: 0.08 },
      refunded: { count: null, amountUsdc: null },
      failed: null,
    },
    currentRelease: {
      id: "release-1",
      resourceProductId: "resource-1",
      packVersionId: "pack-4",
      semanticHash: "a".repeat(64),
      publicationKey: "publication-1",
      publicationRequestHash: "b".repeat(64),
      priceUsdc: 0.08,
      executionAccess: "paid",
      discoveryAccess: "public",
      freshness: "fresh",
      payoutReady: true,
      settlementState: "off",
      agentId: "agent-1",
      agentStatus: "live",
      flowVersionId: "version-1",
      deploymentId: "deployment-1",
      deploymentStatus: "live",
      deploymentRetiredAt: null,
      createdAt: "2026-08-14T12:00:00.000Z",
      urls: { run: "/api/agents/resource-pricing-signals/run", card: "/api/agents/resource-pricing-signals/.well-known/agent-card.json", x402: "/api/agents/resource-pricing-signals/.well-known/x402", a2a: "/api/agents/resource-pricing-signals/a2a", public: "/a/resource-pricing-signals" },
    },
    releaseCount: 1,
    runReceiptCount: 2,
  } as const;

  it("accepts the exact private portfolio shape and rejects partial or extra data", () => {
    expect(parseResourceListResponse({ resources: [resource] })).toEqual([resource]);
    expect(() => parseResourceListResponse({ resources: [{ ...resource, ownerId: 42 }] })).toThrow();
    expect(() => parseResourceListResponse({ resources: [{ ...resource, demand: 12 }] })).toThrow();
    expect(() => parseResourceListResponse({ resources: [{ ...resource, livePack: { ...resource.livePack!, semanticHash: "not-a-hash" } }] })).toThrow();
    expect(() => parseResourceListResponse({ resources: [{ ...resource, currentRelease: { ...resource.currentRelease, payoutReady: "yes" } }] })).toThrow();
    expect(parseResourceListResponse({
      resources: [resource, { ...resource, id: "malformed-resource", ownerId: 42 }],
    })).toEqual([resource]);
  });

  it("strictly binds bounded release history receipts to the requested owner product", () => {
    expect(parseResourceReleaseHistoryResponse(
      { releases: [resource.currentRelease] }, resource.id,
    )).toEqual([resource.currentRelease]);
    expect(() => parseResourceReleaseHistoryResponse({
      releases: [{ ...resource.currentRelease, resourceProductId: "other-resource" }],
    }, resource.id)).toThrow();
    expect(() => parseResourceReleaseHistoryResponse({
      releases: [{ ...resource.currentRelease, content: { private: true } }],
    }, resource.id)).toThrow();
    expect(() => parseResourceReleaseHistoryResponse({
      releases: Array.from({ length: 21 }, (_, index) => ({
        ...resource.currentRelease, id: `release-${index}`,
      })),
    }, resource.id)).toThrow();
  });

  it("keeps every payment fact distinct and preserves unknown facts as null", () => {
    const count = { count: null, basis: "not_recorded" } as const;
    const recorded = { count: 2, basis: "resource_run_receipts" } as const;
    const money = { ...recorded, amountUsdc: 0.16 } as const;
    const trust = {
      activity: { calls: recorded },
      facts: {
        attempted: count, free: recorded, challenged: count, executed: recorded,
        credited: money, settled: money, refunded: { ...count, amountUsdc: null }, failed: count,
      },
      quality: {
        schemaValidExecutions: 2, evidenceBackedExecutions: 2, freshExecutions: 2,
        staleExecutions: 0, mixedExecutions: 0, unknownCount: 1, conflictCount: 0,
      },
      rates: {
        schemaValidRate: 1, evidenceCoverageRate: 1, freshRate: 1,
        staleRate: 0, mixedRate: 0, unknownRate: 0.5, conflictRate: 0,
      },
      economics: {
        price: { executionCount: 2, totalUsdc: 0.16, averageUsdc: 0.08, basis: "resource_run_receipts" },
        cost: { status: "not_recorded", amountUsdc: null },
        margin: { status: "not_recorded", amountUsdc: null },
      },
      demand: { status: "not_measured", value: null },
      revenue: { status: "not_measured", amountUsdc: null },
    } as const;
    expect(parseResourceTrustResponse({ trust })).toEqual(trust);
    expect(() => parseResourceTrustResponse({ trust: { ...trust, demand: { status: "measured", value: 2 } } })).toThrow();
  });

  it("denies mutations on the dedicated Play host and rejects stale or aborted responses", () => {
    expect(resourceMutationAllowedForHost("agents.suedeai.ai")).toBe(true);
    expect(resourceMutationAllowedForHost("android-agents.suedeai.ai")).toBe(false);
    expect(requestIsCurrent(4, 4, false)).toBe(true);
    expect(requestIsCurrent(3, 4, false)).toBe(false);
    expect(requestIsCurrent(4, 4, true)).toBe(false);
  });

  it("seeds one editable representative vector from the approved pack", () => {
    const bundle: ResourcePackBundle = {
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      semanticHash: "a".repeat(64),
      freshness: "fresh",
      content: resourcePackContent(),
    };

    const draft = buildResourceRepresentativeDraft(bundle);
    expect(draft).toEqual({
      inputJson: '{\n  "tier": "paid"\n}',
      expectedProperties: ["name", "tier"],
      limit: "10",
    });
    expect(parseResourceRepresentativeDraft(bundle, draft)).toEqual({
      input: { tier: "paid" },
      filters: { tier: "paid" },
      expectedProperties: ["name", "tier"],
      limit: 10,
    });
    expect(parseResourceRepresentativeDraft(bundle, {
      ...draft,
      inputJson: '{"tier":"paid","unreviewed":"different live input"}',
    })).toBeNull();
    expect(parseResourceRepresentativeDraft({
      ...bundle,
      content: { ...bundle.content, records: [] },
    }, draft)).toBeNull();
  });

  it("publishes only the exact non-empty representative vector that was tested", () => {
    const bundle: ResourcePackBundle = {
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      semanticHash: "a".repeat(64),
      freshness: "fresh",
      content: resourcePackContent(),
    };
    const representative = parseResourceRepresentativeDraft(
      bundle,
      buildResourceRepresentativeDraft(bundle),
    );
    const test: ResourceDryRun = {
      packVersionId: bundle.packVersionId,
      semanticHash: bundle.semanticHash,
      inputSchemaValid: true,
      outputSchemaValid: true,
      measuredCostUsdc: 0,
      externalCalls: 0,
      settlementAttempted: false,
      result: [{ name: "Reviewed answer", tier: "paid" }],
      resourceReceipt: {
        resourceProductId: "resource-1",
        resourceVersion: "pack-1",
        semanticHash: bundle.semanticHash,
        freshness: "fresh",
        evidence: [],
        unknowns: [],
        conflicts: [],
        outputSchemaValid: true,
      },
    };

    const proof = buildResourceRepresentativeProof(representative!, 3);
    expect(resourceRepresentativeForPublication(bundle, test, proof, representative)).toEqual(representative);
    expect(resourceRepresentativeForPublication(bundle, { ...test, result: [] }, proof, representative)).toBeNull();
    expect(resourceRepresentativeForPublication(bundle, { ...test, semanticHash: "b".repeat(64) }, proof, representative)).toBeNull();
    expect(resourceRepresentativeForPublication(bundle, test, proof, {
      ...representative!, input: { tier: "free" }, filters: { tier: "free" },
    })).toBeNull();
    expect(resourceRepresentativeForPublication(bundle, test,
      buildResourceRepresentativeProof({
        ...representative!, expectedProperties: ["missing"],
      }, 3),
      { ...representative!, expectedProperties: ["missing"] },
    )).toBeNull();
  });

  it("rejects a delayed representative proof after the visible draft changes", async () => {
    const bundle: ResourcePackBundle = {
      resourceProductId: "resource-1",
      packVersionId: "pack-1",
      semanticHash: "a".repeat(64),
      freshness: "fresh",
      content: resourcePackContent(),
    };
    const first = parseResourceRepresentativeDraft(
      bundle,
      buildResourceRepresentativeDraft(bundle),
    )!;
    const changed = {
      ...first,
      input: { tier: "free" },
      filters: { tier: "free" },
    };
    let current = first;
    let generation = 7;
    const pendingProof = buildResourceRepresentativeProof(first, generation);
    let resolveResponse!: () => void;
    const response = new Promise<void>((resolve) => { resolveResponse = resolve; });
    const applied = response.then(() =>
      resourceRepresentativeProofIsCurrent(pendingProof, generation, current));

    current = changed;
    generation += 1;
    resolveResponse();

    await expect(applied).resolves.toBe(false);
    expect(resourceRepresentativeProofIsCurrent(
      buildResourceRepresentativeProof(changed, generation),
      generation,
      current,
    )).toBe(true);
  });

  it("completes the explicit adoption mutation before the first resource read", async () => {
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      calls.push(`${String(init?.method ?? "GET").toUpperCase()} ${path}`);
      return new Response(path.endsWith("/adopt") ? '{"adopted":true}' : '{"resources":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await bootstrapResourceWorkspace(async () =>
        resourceClient.resourceJsonRequest("/api/v2/resources"));
      expect(calls).toEqual([
        "POST /api/v2/resources/adopt",
        "GET /api/v2/resources",
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rehydrates only the server-current pack pointer and persists the active tab in the URL", () => {
    const current = { packVersionId: "candidate-3", revision: 3, semanticHash: "b".repeat(64) };
    expect(resourcePackPointerFromProduct({ ...resource, currentCandidate: current })).toEqual({
      id: "candidate-3", revision: 3, status: "candidate", semanticHash: "b".repeat(64),
    });
    const newerApproved = { packVersionId: "approved-5", revision: 5, semanticHash: "c".repeat(64) };
    expect(resourcePackPointerFromProduct({ ...resource, approvedPack: newerApproved })).toEqual({
      id: "approved-5", revision: 5, status: "approved", semanticHash: "c".repeat(64),
    });
    expect(resourceTabUrl("resource / 1", "trust-and-earnings")).toBe("/resources/resource%20%2F%201?tab=trust-and-earnings");
    expect(resourceRefreshBaseFromProduct(resource)).toEqual({ packVersionId: "pack-4", semanticHash: "a".repeat(64) });
  });

  it("builds and parses exact recollect and non-approval rejection contracts", () => {
    const base = { packVersionId: "pack-4", semanticHash: "a".repeat(64) };
    const candidate = { packVersionId: "candidate-5", revision: 5, semanticHash: "b".repeat(64) };
    expect(buildResourceRecollectRequest(base, candidate, ["snapshot-old"], {
      kind: "url", url: "https://acme.example/pricing", freshnessDays: 14,
    })).toEqual({
      action: "recollect", base, candidate, replaceSourceSnapshotIds: ["snapshot-old"],
      source: { kind: "url", url: "https://acme.example/pricing", freshnessDays: 14 },
    });
    expect(buildResourceRejectRequest(base, candidate)).toEqual({ action: "reject", base, candidate });
    expect(parseResourceRefreshRejection({ decision: "rejected", approved: false, republished: false })).toEqual({
      decision: "rejected", approved: false, republished: false,
    });
    expect(() => parseResourceRefreshRejection({ decision: "rejected", approved: true, republished: false })).toThrow();
    const failed = {
      snapshot: {
        id: "snapshot-failed", resourceProductId: "resource-1", locator: "https://acme.example/",
        sourceKind: "url_failed", capturedAt: "2026-08-14T12:00:00.000Z", contentHash: "c".repeat(64),
        freshnessDeadline: "2026-08-28T12:00:00.000Z",
      },
      collection: { status: "failed", records: [], evidence: [], warnings: ["source collection failed"] },
      candidate: null, diff: null,
    } as const;
    expect(parseResourceRefreshResponse(failed)).toEqual(failed);
    expect(() => parseResourceRefreshResponse({ ...failed, demand: 1 })).toThrow();
  });

  it("merges a collected source into the exact current candidate without dropping prior records", () => {
    const content: ResourcePackContent = {
      recordSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      filterFields: [], returnFields: ["text"], taxonomy: [],
      records: [{ id: "old", fields: { text: "Old" }, tags: [], evidenceIds: ["old-evidence"] }],
      evidence: [{ id: "old-evidence", sourceSnapshotId: "old-snapshot", locator: "old", observedAt: "2026-08-13T12:00:00.000Z" }],
      sourceSnapshotIds: ["old-snapshot"],
      jobContract: {
        jobStatement: "Return text.", buyerIntent: "Read text.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        outputSchema: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
        unsupportedRequest: "Unknown.", evidenceRequirement: "Evidence.", safeExample: [{ text: "Example" }],
        reviewBoundary: "Reviewed.", dataHandlingDisclosure: "Private.",
      },
    };
    const merged = mergeCollectedSource(content, {
      snapshot: {
        id: "new-snapshot", resourceProductId: "resource-1", locator: "manual://new", sourceKind: "manual_text",
        capturedAt: "2026-08-14T12:00:00.000Z", contentHash: "c".repeat(64), freshnessDeadline: "2026-09-13T12:00:00.000Z",
      },
      collection: {
        status: "collected",
        records: [{ id: "new", fields: { text: "New" }, tags: [], evidenceIds: ["new-evidence"] }],
        evidence: [{ id: "new-evidence", sourceSnapshotId: "new-snapshot", locator: "manual://new", observedAt: "2026-08-14T12:00:00.000Z" }],
        warnings: [],
      },
    });
    expect(merged.records.map((item) => item.id)).toEqual(["old", "new"]);
    expect(merged.evidence.map((item) => item.id)).toEqual(["old-evidence", "new-evidence"]);
    expect(merged.sourceSnapshotIds).toEqual(["old-snapshot", "new-snapshot"]);
  });

  it("strictly carries a bounded failed-import warning through one Sources navigation", () => {
    const finish = Reflect.get(resourceClient, "finishResourceSiteImport");
    const consume = Reflect.get(resourceClient, "consumeResourceImportNotice");
    expect(finish).toBeTypeOf("function");
    expect(consume).toBeTypeOf("function");

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const navigate = vi.fn();
    const response = {
      resourceId: "resource-import-1", sourceCount: 0, suggestedPriceUsdc: 0.08,
      collectionStatus: "failed", warnings: ["source collection failed"],
      redirectTo: "/resources/resource-import-1?tab=sources",
    };
    const finishImport = finish as (
      value: unknown,
      sessionStorage: typeof storage,
    ) => typeof response;
    const consumeNotice = consume as (
      resourceId: string,
      sessionStorage: typeof storage,
    ) => { collectionStatus: string; warnings: string[] } | null;
    const parsed = finishImport(response, storage);
    navigate(parsed.redirectTo);
    expect(parsed).toEqual(response);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(response.redirectTo);
    expect([...values.values()].join(" ")).not.toContain("private upstream canary");
    expect(consumeNotice(response.resourceId, storage)).toEqual({
      collectionStatus: "failed", warnings: ["source collection failed"],
    });
    expect(consumeNotice(response.resourceId, storage)).toBeNull();

    for (const invalid of [
      { ...response, collectionStatus: "error" },
      { ...response, warnings: [" source collection failed"] },
      { ...response, warnings: ["private\u0000warning"] },
      { ...response, warnings: Array.from({ length: 9 }, (_, index) => `warning-${index}`) },
      { ...response, redirectTo: "/resources/another-resource?tab=sources" },
      { ...response, rawText: "private upstream canary" },
    ]) expect(() => finishImport(invalid, storage)).toThrow();
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
