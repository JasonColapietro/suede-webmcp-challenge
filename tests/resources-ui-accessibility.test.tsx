import { createElement, createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ resourceId: "resource-1" }),
  useSearchParams: () => new URLSearchParams("tab=records"),
}));

import ResourceTabs, {
  RESOURCE_TAB_ORDER,
  nextResourceTab,
  parseResourceTab,
} from "@/components/resources/ResourceTabs";
import ResourceCreateForm from "@/components/resources/ResourceCreateForm";
import {
  ResourcePortfolioView,
  type ResourcePortfolioDisplayItem,
} from "@/components/resources/ResourcePortfolio";
import ResourceConfirmDialog, {
  restoreResourceActionFocus,
} from "@/components/resources/ResourceConfirmDialog";
import ResourceSourcesPanel from "@/components/resources/ResourceSourcesPanel";
import ResourceRecordsPanel from "@/components/resources/ResourceRecordsPanel";
import ResourceJobPanel from "@/components/resources/ResourceJobPanel";
import ResourceTestPanel, {
  ResourceRepresentativeProofReceipt,
} from "@/components/resources/ResourceTestPanel";
import ResourcePublishPanel from "@/components/resources/ResourcePublishPanel";
import ResourceTrustEarningsPanel from "@/components/resources/ResourceTrustEarningsPanel";
import {
  buildResourceRepresentativeDraft,
  buildResourceRepresentativeProof,
  parseResourceRepresentativeDraft,
} from "@/components/resources/representative";
import type {
  PublishedResource,
  ResourceDryRun,
  ResourceCurrentReleaseSummary,
  ResourcePackBundle,
  ResourcePackPointer,
  ResourcePortfolioItem,
  ResourceRefreshResult,
  ResourceTrust,
} from "@/components/resources/client";

const semanticHash = "a".repeat(64);
const pack: ResourcePackBundle = {
  resourceProductId: "resource-1", packVersionId: "pack-4", semanticHash, freshness: "fresh",
  content: {
    recordSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    filterFields: [], returnFields: ["text"], taxonomy: [], sourceSnapshotIds: ["snapshot-1"],
    records: [{ id: "record-1", fields: { text: "Reviewed answer" }, tags: [], evidenceIds: ["evidence-1"], unknowns: ["price"], conflicts: ["date"] }],
    evidence: [{ id: "evidence-1", sourceSnapshotId: "snapshot-1", locator: "manual://note", observedAt: "2026-08-14T12:00:00.000Z" }],
    jobContract: {
      jobStatement: "Return one reviewed answer.", buyerIntent: "Check one exact answer.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      outputSchema: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
      unsupportedRequest: "Return an explicit unknown.", evidenceRequirement: "Return evidence.",
      safeExample: [{ text: "Reviewed example" }], reviewBoundary: "Reviewed rows only.",
      dataHandlingDisclosure: "Private bodies are not returned.",
    },
  },
};
const pointer: ResourcePackPointer = { id: "pack-4", revision: 4, status: "approved", semanticHash };
const product: ResourcePortfolioItem = {
  id: "resource-1", ownerId: "owner-1", name: "Pricing signals", slug: "pricing-signals",
  status: "test", executionAccess: "paid", discoveryAccess: "unlisted", candidateRevision: null,
  approvedPackVersionId: "pack-4", livePackVersionId: null, currentCandidate: null,
  approvedPack: { packVersionId: "pack-4", revision: 4, semanticHash }, livePack: null,
  portfolioFreshness: "fresh",
  portfolioPayments: {
    attempted: null, free: 0, challenged: null, executed: 0,
    credited: { count: 0, amountUsdc: 0 }, settled: { count: 0, amountUsdc: 0 },
    refunded: { count: null, amountUsdc: null }, failed: null,
  },
  currentRelease: null,
  releaseCount: 0, runReceiptCount: 0,
};
const dryRun: ResourceDryRun = {
  packVersionId: "pack-4", semanticHash, inputSchemaValid: true, outputSchemaValid: true,
  measuredCostUsdc: 0, externalCalls: 0, settlementAttempted: false,
  result: [{ text: "Reviewed answer" }],
  resourceReceipt: {
    resourceProductId: "resource-1", resourceVersion: "pack-4", semanticHash,
    freshness: "fresh", evidence: pack.content.evidence, unknowns: ["price"], conflicts: ["date"], outputSchemaValid: true,
  },
};

function makeReleaseSummary(
  overrides: Partial<ResourceCurrentReleaseSummary> = {},
): ResourceCurrentReleaseSummary {
  return {
    id: "release-1", resourceProductId: "resource-1", packVersionId: "pack-4", semanticHash,
    publicationKey: "key-1", publicationRequestHash: "b".repeat(64), priceUsdc: 0.08,
    executionAccess: "paid", discoveryAccess: "unlisted", freshness: "fresh",
    payoutReady: true, settlementState: "off", agentId: "agent-1", agentStatus: "live",
    flowVersionId: "version-1", deploymentId: "deployment-1", deploymentStatus: "live",
    deploymentRetiredAt: null, createdAt: "2026-08-14T12:00:00.000Z",
    urls: { run: "/run", card: "/card", x402: "/x402", a2a: "/a2a", public: "/public" },
    ...overrides,
  };
}

describe("Resource Foundry keyboard and state semantics", () => {
  it("renders seven labelled tabs with roving focus and predictable keyboard movement", () => {
    const markup = renderToStaticMarkup(createElement(ResourceTabs, {
      active: "records",
      states: { brief: "complete", sources: "ready", records: "ready" },
      onSelect: vi.fn(),
    }));
    expect(RESOURCE_TAB_ORDER).toEqual([
      "brief", "sources", "records", "job", "test", "publish", "trust-and-earnings",
    ]);
    expect(markup.match(/role="tab"/g)).toHaveLength(7);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Resource release stages"');
    expect(markup).toMatch(/aria-selected="true"[^>]*tabindex="0"/);
    expect(markup).toContain('data-state="complete"');
    expect(markup).toContain("Brief, complete");
    expect(nextResourceTab("records", "ArrowRight")).toBe("job");
    expect(nextResourceTab("brief", "ArrowLeft")).toBe("trust-and-earnings");
    expect(nextResourceTab("job", "Home")).toBe("brief");
    expect(nextResourceTab("job", "End")).toBe("trust-and-earnings");
    expect(parseResourceTab("unknown")).toBe("brief");
  });

  it("renders directional loading, error/retry, empty, and populated portfolio states", () => {
    const loading = renderToStaticMarkup(createElement(ResourcePortfolioView, { state: { status: "loading" }, onRetry: vi.fn() }));
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading resource products");

    const failed = renderToStaticMarkup(createElement(ResourcePortfolioView, { state: { status: "error" }, onRetry: vi.fn() }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(">Retry<");

    const empty = renderToStaticMarkup(createElement(ResourcePortfolioView, { state: { status: "ready", items: [] }, onRetry: vi.fn() }));
    expect(empty).toContain("No resources yet");
    expect(empty).toContain('href="/resources/new"');

    const item: ResourcePortfolioDisplayItem = {
      id: "resource-1", name: "Pricing signals", status: "live", livePackVersionId: "pack-4",
      freshness: "fresh", executedCalls: 2, settledUsdc: 0.16,
    };
    const ready = renderToStaticMarkup(createElement(ResourcePortfolioView, { state: { status: "ready", items: [item] }, onRetry: vi.fn() }));
    for (const text of ["Pricing signals", "Live", "pack-4", "Fresh", "2", "$0.16"]) expect(ready).toContain(text);
  });

  it("makes the three starter briefs one lifecycle and manual source intake the primary next action", () => {
    const create = renderToStaticMarkup(createElement(ResourceCreateForm));
    for (const name of ["Niche Data Refinery", "Agent Readiness", "Expert Archive"]) expect(create).toContain(name);
    expect(create).toContain("All three continue through the same seven release stages.");
    expect(create.toLowerCase()).toContain("add a manual source next");
    expect(create).toContain('aria-live="polite"');

    const sources = renderToStaticMarkup(createElement(ResourceSourcesPanel, {
      disabled: false,
      busy: false,
      onAdd: vi.fn(),
      refreshDisabled: false,
      refreshBusy: false,
      rejectBusy: false,
      canReject: true,
      sourceSnapshotIds: ["snapshot-1"],
      refreshResult: null,
      onRefresh: vi.fn(),
      onReject: vi.fn(),
    }));
    expect(sources).toContain("Optional source context — supplied by you and not verified by Suede.");
    expect(sources).toContain("Manual source");
    expect(sources).toMatch(/name="provenance"(?![^>]*required)[^>]*>/);
    for (const text of ["Recollect reviewed source", "Replace source snapshots", "Reject this candidate"]) expect(sources).toContain(text);
  });

  it("renders every bounded refresh diff dimension and import warning before approval", () => {
    const refreshResult: ResourceRefreshResult = {
      snapshot: {
        id: "snapshot-new", resourceProductId: "resource-1", locator: "manual://refresh",
        sourceKind: "manual_text", capturedAt: "2026-08-14T13:00:00.000Z",
        contentHash: "b".repeat(64), freshnessDeadline: "2026-09-13T13:00:00.000Z",
      },
      collection: {
        status: "collected",
        records: [{ id: "record-added", fields: { text: "New" }, tags: ["new-tag"], evidenceIds: ["evidence-added"] }],
        evidence: [{
          id: "evidence-added", sourceSnapshotId: "snapshot-new", locator: "manual://refresh#row-1",
          observedAt: "2026-08-14T13:00:00.000Z",
        }],
        warnings: ["One canonical duplicate was omitted."],
      },
      candidate: {
        id: "candidate-5", resourceProductId: "resource-1", revision: 5, status: "candidate",
        semanticHash: "c".repeat(64), content: pack.content, createdBy: "owner-1",
        createdAt: "2026-08-14T13:00:00.000Z",
      },
      diff: {
        addedRecordIds: ["record-added"], changedRecordIds: ["record-changed"], removedRecordIds: ["record-removed"],
        addedSourceSnapshotIds: ["snapshot-new"], removedSourceSnapshotIds: ["snapshot-old"],
        schemaChanged: true, taxonomyChanged: true, evidenceChanged: true,
        addedEvidenceIds: ["evidence-added"], changedEvidenceIds: ["evidence-changed"], removedEvidenceIds: ["evidence-removed"],
        jobContractChanged: true,
        freshness: { before: "stale", candidate: "fresh" },
        unknowns: { before: 2, candidate: 1, delta: -1 },
        conflicts: { before: 1, candidate: 2, delta: 1 },
      },
    };
    const markup = renderToStaticMarkup(createElement(ResourceSourcesPanel, {
      disabled: false, busy: false, onAdd: vi.fn(), refreshDisabled: false,
      refreshBusy: false, rejectBusy: false, canReject: true,
      sourceSnapshotIds: ["snapshot-old"], refreshResult,
      importNotice: { collectionStatus: "failed", warnings: ["The website collection failed safely."] },
      onRefresh: vi.fn(), onReject: vi.fn(),
    }));

    for (const text of [
      "The website collection failed safely.", "record-added", "record-changed", "record-removed",
      "snapshot-new", "snapshot-old", "evidence-added", "evidence-changed", "evidence-removed",
      "Taxonomy", "Job Contract", "Changed", "stale", "fresh", "Unknowns", "Conflicts",
    ]) expect(markup).toContain(text);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("The private draft remains available for review");
    expect(markup).toContain("does not disable approval or publication");
  });

  it("uses a labelled confirmation dialog and restores focus to a connected trigger", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const dialog = renderToStaticMarkup(createElement(ResourceConfirmDialog, {
      open: true,
      title: "Approve immutable pack?",
      confirmLabel: "Approve pack",
      busy: false,
      triggerRef,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }, "This creates an immutable receipt."));
    expect(dialog).toContain("<dialog");
    expect(dialog).not.toMatch(/<dialog[^>]*\sopen(?:=|\s|>)/u);
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("Approve immutable pack?");
    const connected = { isConnected: true, focus: vi.fn() };
    restoreResourceActionFocus(connected);
    expect(connected.focus).toHaveBeenCalledOnce();
    const detached = { isConnected: false, focus: vi.fn() };
    restoreResourceActionFocus(detached);
    expect(detached.focus).not.toHaveBeenCalled();
    const fallback = { isConnected: true, focus: vi.fn() };
    restoreResourceActionFocus(detached, fallback);
    expect(fallback.focus).toHaveBeenCalledOnce();
  });

  it("renders immutable records, schemas, evidence, unknowns, conflicts, and the exact zero-cost test receipt", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const records = renderToStaticMarkup(createElement(ResourceRecordsPanel, {
      pack, pointer, busy: false, triggerRef, onRequestApprove: vi.fn(),
    }));
    for (const text of [
      "pack-4", semanticHash, "1 record", "1 evidence pointer", "Reviewed answer",
      "manual://note", "2026-08-14T12:00:00.000Z", "price", "date", "Page 1 of 1",
    ]) expect(records).toContain(text);

    const emptyPack: ResourcePackBundle = {
      ...pack,
      content: { ...pack.content, records: [], evidence: [], sourceSnapshotIds: [] },
    };
    const emptyRecords = renderToStaticMarkup(createElement(ResourceRecordsPanel, {
      pack: emptyPack,
      pointer: { ...pointer, status: "candidate" },
      busy: false,
      triggerRef,
      onRequestApprove: vi.fn(),
    }));
    expect(emptyRecords).toContain("This pack is honestly empty: 0 records and 0 evidence pointers.");
    expect(emptyRecords).toContain("You can approve an empty pack, but publication requires a representative test that returns at least one record.");
    expect(emptyRecords).toMatch(/<button[^>]*>Review and approve pack<\/button>/u);

    const job = renderToStaticMarkup(createElement(ResourceJobPanel, { pack }));
    for (const text of ["Input schema", "Output schema", "Safe example", "Return one reviewed answer."]) expect(job).toContain(text);

    const test = renderToStaticMarkup(createElement(ResourceTestPanel, { pack, result: dryRun, busy: false, onRun: vi.fn() }));
    for (const text of [
      "Representative input", "Declared filters", "Expected output properties",
      "$0.000000", "No settlement attempted", "Fresh", "Semantic hash", semanticHash,
      "Evidence 1", "Unknowns 1", "Conflicts 1",
    ]) expect(test).toContain(text);
  });

  it("freezes every representative control while its proof is in flight", () => {
    const markup = renderToStaticMarkup(createElement(ResourceTestPanel, {
      pack,
      result: null,
      busy: true,
      onRun: vi.fn(),
    }));

    expect(markup).toContain("Testing…");
    expect(markup.match(/disabled=""/gu)).toHaveLength(4);
  });

  it("shows the exact tested representative and digest in the publication receipt", () => {
    const representative = parseResourceRepresentativeDraft(
      pack,
      buildResourceRepresentativeDraft(pack),
    )!;
    const proof = buildResourceRepresentativeProof(representative, 4);
    const markup = renderToStaticMarkup(createElement(
      ResourceRepresentativeProofReceipt,
      { proof },
    ));

    expect(markup).toContain("Representative proof");
    expect(markup).toContain(proof.digest);
    expect(markup).toContain('&quot;expectedProperties&quot;');
    expect(markup).toContain('&quot;text&quot;');
  });

  it("renders price and margin separately from payout/settlement and prints every exact public URL", () => {
    const published = {
      agent: { id: "agent-1", flowId: "resource-1", slug: "resource-pricing-signals", status: "live", priceUsdc: 0.08, createdAt: 1, settlementLive: false },
      release: {
        id: "release-1", ownerId: "owner-1", resourceProductId: "resource-1", packVersionId: "pack-4",
        semanticHash, publicationKey: "key-1", publicationRequestHash: "b".repeat(64), graphSemanticHash: "c".repeat(64),
        graphFullHash: "d".repeat(64), priceUsdc: 0.08, executionAccess: "paid", discoveryAccess: "unlisted",
        agentId: "agent-1", flowId: "resource-1", flowVersionId: "version-1", deploymentId: "deployment-1",
        environmentId: "environment-1", createdAt: "2026-08-14T12:00:00.000Z",
      },
      urls: { run: "/run", card: "/card", x402: "/x402", a2a: "/a2a", public: "/public" },
    } satisfies PublishedResource;
    const publish = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product, pack, testResult: dryRun, representativeReady: true, published, releaseSummary: null, busy: false,
      triggerRef: createRef<HTMLButtonElement>(), onRequestPublish: vi.fn(),
    }));
    for (const text of ["Price", "Margin", "$0.080000", "Payout", "Settlement off", "/run", "/card", "/x402", "/a2a", "/public"]) expect(publish).toContain(text);
    expect(publish).toContain("Current paid release · runs unavailable");
    expect(publish).toContain("Paid runs remain unavailable because settlement is off");
    expect(publish).toContain('aria-label="Unavailable paid service URLs"');
    expect(publish).not.toContain("direct access only");

    const releaseSummary = makeReleaseSummary();
    const reloaded = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product: { ...product, status: "live", livePackVersionId: "pack-4", livePack: product.approvedPack },
      pack,
      testResult: null,
      representativeReady: false,
      published: null,
      releaseSummary,
      busy: false,
      triggerRef: createRef<HTMLButtonElement>(),
      onRequestPublish: vi.fn(),
    }));
    expect(reloaded).toContain("Published Live");
    expect(reloaded).not.toContain("Review publication");
    expect(reloaded).toContain("release-1");
    expect(reloaded).toContain("Current paid release · runs unavailable");
    expect(reloaded).toContain("$0.080000");
    expect(reloaded).toMatch(/<button[^>]*disabled=""[^>]*>Published Live<\/button>/u);

    const paused = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product: { ...product, status: "paused", livePackVersionId: "pack-4", livePack: product.approvedPack },
      pack, testResult: null, representativeReady: false, published: null, releaseSummary, busy: false,
      triggerRef: createRef<HTMLButtonElement>(), onRequestPublish: vi.fn(),
    }));
    expect(paused).toContain("Release paused");
    expect(paused).toContain("Paused release receipt");
    expect(paused).toContain("Historical release URLs — not reachable");
    expect(paused).not.toContain("Current live release");

    const retired = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product: { ...product, status: "retired", livePackVersionId: null, livePack: null },
      pack: null, testResult: null, representativeReady: false, published: null, releaseSummary, busy: false,
      triggerRef: createRef<HTMLButtonElement>(), onRequestPublish: vi.fn(),
    }));
    expect(retired).toContain("Release retired");
    expect(retired).toContain("Retired release receipt");
    expect(retired).toContain("These recorded URLs are not publicly reachable.");
    expect(retired).not.toContain("Current live release");

    const nextHash = "e".repeat(64);
    const nextApproved = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product: {
        ...product,
        status: "test",
        approvedPackVersionId: "pack-5",
        approvedPack: { packVersionId: "pack-5", revision: 5, semanticHash: nextHash },
        livePack: product.approvedPack,
        currentRelease: releaseSummary,
      },
      pack: { ...pack, packVersionId: "pack-5", semanticHash: nextHash },
      testResult: { ...dryRun, packVersionId: "pack-5", semanticHash: nextHash },
      representativeReady: true,
      published: null,
      releaseSummary,
      busy: false,
      triggerRef: createRef<HTMLButtonElement>(),
      onRequestPublish: vi.fn(),
    }));
    expect(nextApproved).toContain("Current paid release · runs unavailable");
    expect(nextApproved).toContain("release-1");
    expect(nextApproved).toContain("/run");
    expect(nextApproved).toContain("Review publication");

    const belowCost = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product, pack, testResult: { ...dryRun, measuredCostUsdc: 0.1 }, representativeReady: true, published: null, releaseSummary: null, busy: false,
      triggerRef: createRef<HTMLButtonElement>(), onRequestPublish: vi.fn(),
    }));
    expect(belowCost).toContain("$-0.020000");
  });

  it("uses one newly published receipt until a server-current reload reconciles it", () => {
    const prior = makeReleaseSummary({
      id: "release-prior", freshness: "stale",
      urls: { run: "/prior/run", card: "/prior/card", x402: "/prior/x402", a2a: "/prior/a2a", public: "/prior/public" },
    });
    const published = {
      agent: { id: "agent-1", flowId: "resource-1", slug: "resource-pricing-signals", status: "live", priceUsdc: 0.08, createdAt: 1, settlementLive: false },
      release: {
        id: "release-new", ownerId: "owner-1", resourceProductId: "resource-1", packVersionId: "pack-4",
        semanticHash, publicationKey: "key-new", publicationRequestHash: "f".repeat(64), graphSemanticHash: "c".repeat(64),
        graphFullHash: "d".repeat(64), priceUsdc: 0.08, executionAccess: "paid", discoveryAccess: "unlisted",
        agentId: "agent-1", flowId: "resource-1", flowVersionId: "version-new", deploymentId: "deployment-new",
        environmentId: "environment-1", createdAt: "2026-08-16T12:00:00.000Z",
      },
      urls: { run: "/new/run", card: "/new/card", x402: "/new/x402", a2a: "/new/a2a", public: "/new/public" },
    } satisfies PublishedResource;
    const markup = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product: { ...product, status: "test", currentRelease: prior },
      pack, testResult: dryRun, representativeReady: true, published, releaseSummary: prior, busy: false,
      triggerRef: createRef<HTMLButtonElement>(), onRequestPublish: vi.fn(),
    }));

    expect(markup).toContain("release-new");
    expect(markup).toContain("/new/run");
    expect(markup).toContain("Current paid release · runs unavailable");
    expect(markup).not.toContain("release-prior");
    expect(markup).not.toContain("/prior/run");
    expect(markup).not.toContain("freshness blocked");
  });

  it("labels private live release URLs as owner records that are not publicly runnable", () => {
    const releaseSummary = makeReleaseSummary({
      id: "release-private", publicationKey: "key-private", priceUsdc: 0,
      executionAccess: "private", discoveryAccess: "public", agentId: "agent-private",
      flowVersionId: "version-private", deploymentId: "deployment-private",
      urls: { run: "/private/run", card: "/private/card", x402: "/private/x402", a2a: "/private/a2a", public: "/private/public" },
    });
    const markup = renderToStaticMarkup(createElement(ResourcePublishPanel, {
      product: {
        ...product,
        status: "live",
        executionAccess: "private",
        discoveryAccess: "public",
        livePackVersionId: "pack-4",
        livePack: product.approvedPack,
      },
      pack,
      testResult: null,
      representativeReady: false,
      published: null,
      releaseSummary,
      busy: false,
      triggerRef: createRef<HTMLButtonElement>(),
      onRequestPublish: vi.fn(),
    }));

    expect(markup).toContain("Current private release");
    expect(markup).toContain("Private release URLs — owner record only");
    expect(markup).toContain("Public discovery and public runs are blocked");
    expect(markup).toContain('aria-label="Private release URLs"');
    expect(markup).not.toContain('aria-label="Published service URLs"');
  });

  it.each(["stale", "mixed"] as const)(
    "labels a %s live release receipt as strict-freshness blocked",
    (portfolioFreshness) => {
      const releaseSummary = makeReleaseSummary({
        id: `release-${portfolioFreshness}`, publicationKey: `key-${portfolioFreshness}`,
        freshness: portfolioFreshness, agentId: `agent-${portfolioFreshness}`,
      });
      const markup = renderToStaticMarkup(createElement(ResourcePublishPanel, {
        product: {
          ...product,
          status: "live",
          discoveryAccess: "public",
          portfolioFreshness,
          livePackVersionId: "pack-4",
          livePack: product.approvedPack,
        },
        pack,
        testResult: null,
        representativeReady: false,
        published: null,
        releaseSummary,
        busy: false,
        triggerRef: createRef<HTMLButtonElement>(),
        onRequestPublish: vi.fn(),
      }));

      const freshnessLabel = portfolioFreshness.slice(0, 1).toUpperCase() + portfolioFreshness.slice(1);
      expect(markup).toContain(`Live release receipt · ${freshnessLabel} freshness blocked`);
      expect(markup).toContain("Strict freshness blocks discovery and runs");
      expect(markup).toContain('aria-label="Freshness-blocked service URLs"');
      expect(markup).not.toContain("Current live release");
    },
  );

  it("keeps attempted, challenged, executed, credited, settled, refunded, and failed facts distinct without inventing demand or revenue", () => {
    const unknown = { count: null, basis: "not_recorded" } as const;
    const zero = { count: 0, basis: "resource_run_receipts" } as const;
    const money = { ...zero, amountUsdc: 0 } as const;
    const trust: ResourceTrust = {
      activity: { calls: zero },
      facts: { attempted: unknown, free: zero, challenged: unknown, executed: zero, credited: money, settled: money, refunded: { ...unknown, amountUsdc: null }, failed: unknown },
      quality: { schemaValidExecutions: 0, evidenceBackedExecutions: 0, freshExecutions: 0, staleExecutions: 0, mixedExecutions: 0, unknownCount: 0, conflictCount: 0 },
      rates: { schemaValidRate: null, evidenceCoverageRate: null, freshRate: null, staleRate: null, mixedRate: null, unknownRate: null, conflictRate: null },
      economics: {
        price: { executionCount: 0, totalUsdc: 0, averageUsdc: null, basis: "resource_run_receipts" },
        cost: { status: "not_recorded", amountUsdc: null },
        margin: { status: "not_recorded", amountUsdc: null },
      },
      demand: { status: "not_measured", value: null }, revenue: { status: "not_measured", amountUsdc: null },
    };
    const markup = renderToStaticMarkup(createElement(ResourceTrustEarningsPanel, { trust }));
    for (const text of ["Attempted", "Challenged", "Executed", "Credited", "Settled", "Refunded", "Failed", "Not measured"]) expect(markup).toContain(text);
    expect(markup).not.toContain("customer demand");
  });
});
