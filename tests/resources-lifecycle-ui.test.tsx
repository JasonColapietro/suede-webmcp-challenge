import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ResourceLifecycleControls from "@/components/resources/ResourceLifecycleControls";
import ResourceConfirmDialog from "@/components/resources/ResourceConfirmDialog";
import {
  buildResourceLifecycleRequest,
  parseResourceLifecycleResponse,
  type ResourcePortfolioItem,
} from "@/components/resources/client";

const hash = "a".repeat(64);
const product: ResourcePortfolioItem = {
  id: "resource-1", ownerId: "owner-1", name: "Pricing signals", slug: "pricing-signals",
  status: "live", executionAccess: "paid", discoveryAccess: "public",
  candidateRevision: null, approvedPackVersionId: null, livePackVersionId: "pack-1",
  currentCandidate: null, approvedPack: null,
  livePack: { packVersionId: "pack-1", revision: 1, semanticHash: hash },
  portfolioFreshness: "fresh",
  portfolioPayments: {
    attempted: null, free: 0, challenged: null, executed: 0,
    credited: { count: 0, amountUsdc: 0 }, settled: { count: 0, amountUsdc: 0 },
    refunded: { count: null, amountUsdc: null }, failed: null,
  },
  currentRelease: {
    id: "release-1", resourceProductId: "resource-1",
    packVersionId: "pack-1", semanticHash: hash,
    publicationKey: "publication-1", publicationRequestHash: "b".repeat(64),
    priceUsdc: 0.08, executionAccess: "paid", discoveryAccess: "public",
    freshness: "fresh", payoutReady: true, settlementState: "on",
    agentId: "agent-1", agentStatus: "live", flowVersionId: "version-1",
    deploymentId: "deployment-1", deploymentStatus: "live", deploymentRetiredAt: null,
    createdAt: "2026-08-16T12:00:00.000Z",
    urls: { run: "/run", card: "/card", x402: "/x402", a2a: "/a2a", public: "/public" },
  },
  releaseCount: 1, runReceiptCount: 0,
};

describe("Resource owner lifecycle controls", () => {
  it("pins the exact release, agent, deployment, and expected product status", () => {
    expect(buildResourceLifecycleRequest(product, "pause")).toEqual({
      action: "pause", expectedStatus: "live", releaseId: "release-1",
      agentId: "agent-1", deploymentId: "deployment-1",
    });
    expect(buildResourceLifecycleRequest({ ...product, status: "paused" }, "resume"))
      .toEqual({
        action: "resume", expectedStatus: "paused", releaseId: "release-1",
        agentId: "agent-1", deploymentId: "deployment-1",
      });
    expect(() => buildResourceLifecycleRequest({ ...product, status: "retired" }, "resume"))
      .toThrow();
    expect(() => buildResourceLifecycleRequest({ ...product, currentRelease: null }, "pause"))
      .toThrow();
  });

  it("strictly parses the server-current portfolio returned after a transition", () => {
    const paused = { ...product, status: "paused" as const };
    expect(parseResourceLifecycleResponse({ resource: paused })).toEqual(paused);
    expect(() => parseResourceLifecycleResponse({ resource: paused, stalePin: "deployment-0" }))
      .toThrow();
  });

  it.each([
    ["live", ["Live · publicly reachable", "Pause release", "Retire release"], ["Resume release"]],
    ["paused", ["Paused · not publicly reachable", "Resume release", "Retire release"], ["Pause release"]],
    ["retired", ["Retired · terminal", "Immutable release history remains available"], ["Pause release", "Resume release", "Retire release"]],
  ] as const)("renders honest %s controls", (status, present, absent) => {
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product: { ...product, status }, disabled: false, busy: false, onRequest: vi.fn(),
    }));
    expect(markup).toContain('aria-labelledby="resource-lifecycle-heading"');
    expect(markup).toContain("release-1");
    for (const text of present) expect(markup).toContain(text);
    for (const text of absent) expect(markup).not.toContain(text);
  });

  it("describes a live private release as an owner record rather than a public service", () => {
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product: {
        ...product,
        executionAccess: "private",
        discoveryAccess: "unlisted",
        currentRelease: {
          ...product.currentRelease!, executionAccess: "private", discoveryAccess: "unlisted",
        },
      },
      disabled: false,
      busy: false,
      onRequest: vi.fn(),
    }));

    expect(markup).toContain("Live receipt · private access");
    expect(markup).toContain("Public discovery and public runs are blocked");
    expect(markup).not.toContain("Live · publicly reachable");
    expect(markup).not.toContain("accept discovery and runs");
  });

  it("describes a live unlisted release as directly runnable but undiscoverable", () => {
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product: {
        ...product,
        discoveryAccess: "unlisted",
        currentRelease: { ...product.currentRelease!, discoveryAccess: "unlisted" },
      },
      disabled: false,
      busy: false,
      onRequest: vi.fn(),
    }));

    expect(markup).toContain("Live · unlisted");
    expect(markup).toContain("accepts direct runs but is excluded from public discovery");
    expect(markup).not.toContain("Live · publicly reachable");
  });

  it("never claims that a paid unlisted release accepts runs while settlement is off", () => {
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product: {
        ...product,
        discoveryAccess: "unlisted",
        currentRelease: {
          ...product.currentRelease!, discoveryAccess: "unlisted", settlementState: "off",
        },
      },
      disabled: false,
      busy: false,
      onRequest: vi.fn(),
    }));

    expect(markup).toContain("Live receipt · settlement off");
    expect(markup).toContain("Paid runs remain unavailable");
    expect(markup).not.toContain("accepts direct runs");
    expect(markup).not.toContain("publicly reachable");
  });

  it.each(["stale", "mixed"] as const)(
    "shows that strict freshness blocks a %s live release",
    (releaseFreshness) => {
      const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
        product: {
          ...product,
          portfolioFreshness: "fresh",
          currentRelease: { ...product.currentRelease!, freshness: releaseFreshness },
        },
        disabled: false,
        busy: false,
        onRequest: vi.fn(),
      }));

      const freshnessLabel = releaseFreshness.slice(0, 1).toUpperCase() + releaseFreshness.slice(1);
      expect(markup).toContain(`Live receipt · ${freshnessLabel} freshness blocked`);
      expect(markup).toContain("Strict freshness blocks discovery and runs until a fresh pack is approved and published");
      expect(markup).not.toContain("Live · publicly reachable");
      expect(markup).not.toContain("accept discovery and runs");
    },
  );

  it("keeps Live reachability pinned to release freshness when a candidate is stale", () => {
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product: { ...product, portfolioFreshness: "stale" },
      disabled: false,
      busy: false,
      onRequest: vi.fn(),
    }));

    expect(markup).toContain("Live · publicly reachable");
    expect(markup).not.toContain("freshness blocked");
  });

  it("blocks reachability when the exact release deployment has drifted out of Live", () => {
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product: {
        ...product,
        currentRelease: {
          ...product.currentRelease!, agentStatus: "draft", deploymentStatus: "retired",
          deploymentRetiredAt: "2026-08-16T13:00:00.000Z",
        },
      },
      disabled: false,
      busy: false,
      onRequest: vi.fn(),
    }));

    expect(markup).toContain("Live receipt · deployment unavailable");
    expect(markup).toContain("agent or deployment is no longer Live");
    expect(markup).not.toContain("publicly reachable");
    expect(markup).not.toContain("accepts direct runs");
  });

  it("disables every available lifecycle action while another mutation is active", () => {
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product, disabled: false, busy: true, onRequest: vi.fn(),
    }));
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
  });

  it("keeps a restrained immutable receipt history reachable after republish", () => {
    const prior = {
      ...product.currentRelease!,
      id: "release-prior",
      packVersionId: "pack-prior",
      semanticHash: "c".repeat(64),
      agentStatus: "draft" as const,
      deploymentId: "deployment-prior",
      deploymentStatus: "retired" as const,
      deploymentRetiredAt: "2026-08-15T13:00:00.000Z",
      createdAt: "2026-08-15T12:00:00.000Z",
    };
    const markup = renderToStaticMarkup(createElement(ResourceLifecycleControls, {
      product: { ...product, releaseCount: 2 },
      releaseHistory: [product.currentRelease!, prior],
      disabled: false,
      busy: false,
      onRequest: vi.fn(),
    }));

    expect(markup).toContain("Release history · 2 receipts");
    expect(markup).toContain("Current release");
    expect(markup).toContain("Prior release");
    expect(markup).toContain("release-prior");
    expect(markup).toContain("pack-prior");
    expect(markup).toContain("c".repeat(64));
    expect(markup).toContain("deployment-prior");
    expect(markup).toContain("Deployment retired");
    expect(markup).toContain("2026-08-15T13:00:00.000Z");
    expect(markup).toContain("/run");
    expect(markup).not.toMatch(/content|sourceSnapshotIds|source body/iu);
  });

  it("gives terminal retirement a restrained destructive confirmation action", () => {
    const markup = renderToStaticMarkup(createElement(ResourceConfirmDialog, {
      open: true, title: "Retire this exact release?", confirmLabel: "Retire release",
      busy: false, danger: true, triggerRef: createRef<HTMLButtonElement>(),
      onCancel: vi.fn(), onConfirm: vi.fn(),
    }, "Retirement is terminal."));
    expect(markup).toContain("Retirement is terminal.");
    expect(markup).toMatch(/<button[^>]*resource-confirm-danger[^>]*>Retire release<\/button>/u);
  });
});
