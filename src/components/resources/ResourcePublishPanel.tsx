"use client";

import { useEffect, useState, type RefObject } from "react";
import type { PublishedResource, ResourceCurrentReleaseSummary, ResourceDryRun, ResourcePackBundle, ResourcePortfolioItem } from "./client";
import { resourceReleaseReachability } from "./release-reachability";

export interface ResourcePublishFormValue {
  readonly priceUsdc: number;
  readonly payoutAddress?: string;
}

interface ReleasePresentation {
  readonly heading: string;
  readonly urlLabel: string;
  readonly urlNotice: string | null;
}

function releasePresentation(
  product: ResourcePortfolioItem,
  release: ResourceCurrentReleaseSummary | null,
): ReleasePresentation {
  if (product.status === "paused") {
    return {
      heading: "Paused release receipt",
      urlLabel: "Historical service URLs",
      urlNotice: "Historical release URLs — not reachable. These recorded URLs are not publicly reachable.",
    };
  }
  if (product.status === "retired") {
    return {
      heading: "Retired release receipt",
      urlLabel: "Historical service URLs",
      urlNotice: "Historical release URLs — not reachable. These recorded URLs are not publicly reachable.",
    };
  }
  if (!release) {
    return {
      heading: "Current live release",
      urlLabel: "Published service URLs",
      urlNotice: null,
    };
  }
  const reachability = resourceReleaseReachability(release);
  if (reachability.state === "lifecycle") {
    return {
      heading: "Current release · deployment unavailable",
      urlLabel: "Unavailable historical service URLs",
      urlNotice: "Recorded release URLs — not reachable. The exact release agent or deployment is no longer Live.",
    };
  }
  if (reachability.state === "freshness") {
    const freshness = release.freshness.slice(0, 1).toUpperCase() +
      release.freshness.slice(1);
    return {
      heading: `Live release receipt · ${freshness} freshness blocked`,
      urlLabel: "Freshness-blocked service URLs",
      urlNotice: `Recorded release URLs — blocked. Strict freshness blocks discovery and runs while this Live pack is ${release.freshness}.`,
    };
  }
  if (reachability.state === "private") {
    return {
      heading: "Current private release",
      urlLabel: "Private release URLs",
      urlNotice: "Private release URLs — owner record only. Public discovery and public runs are blocked.",
    };
  }
  if (reachability.state === "price" || reachability.state === "payout" || reachability.state === "settlement") {
    const reason = reachability.state === "price" ? "price is not positive"
      : reachability.state === "payout" ? "the payout wallet is not ready"
        : "settlement is off";
    return {
      heading: "Current paid release · runs unavailable",
      urlLabel: "Unavailable paid service URLs",
      urlNotice: `Recorded release URLs — blocked. Paid runs remain unavailable because ${reason}.`,
    };
  }
  if (!reachability.discoverable) {
    return {
      heading: "Current unlisted release",
      urlLabel: "Unlisted service URLs",
      urlNotice: "Unlisted release URLs — direct access only. These recorded URLs can accept direct runs but are excluded from public discovery.",
    };
  }
  return {
    heading: "Current live release",
    urlLabel: "Published service URLs",
    urlNotice: null,
  };
}

export default function ResourcePublishPanel({
  product,
  pack,
  testResult,
  representativeReady,
  published,
  releaseSummary,
  busy,
  triggerRef,
  onRequestPublish,
}: {
  readonly product: ResourcePortfolioItem;
  readonly pack: ResourcePackBundle | null;
  readonly testResult: ResourceDryRun | null;
  readonly representativeReady: boolean;
  readonly published: PublishedResource | null;
  readonly releaseSummary: ResourceCurrentReleaseSummary | null;
  readonly busy: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onRequestPublish: (value: ResourcePublishFormValue) => void;
}): React.JSX.Element {
  const [price, setPrice] = useState(published?.release.priceUsdc ?? releaseSummary?.priceUsdc ?? (product.executionAccess === "paid" ? 0.08 : 0));
  const [payoutAddress, setPayoutAddress] = useState("");
  useEffect(() => {
    if (published) setPrice(published.release.priceUsdc);
    else if (releaseSummary) setPrice(releaseSummary.priceUsdc);
  }, [published, releaseSummary]);
  const testedPack = pack !== null && testResult !== null &&
    testResult.packVersionId === pack.packVersionId && testResult.semanticHash === pack.semanticHash;
  const releaseMatchesPack = pack !== null && releaseSummary !== null &&
    releaseSummary.packVersionId === pack.packVersionId && releaseSummary.semanticHash === pack.semanticHash;
  const publishedMatchesPack = pack !== null && published !== null &&
    published.release.packVersionId === pack.packVersionId && published.release.semanticHash === pack.semanticHash;
  const currentPackAlreadyReleased = releaseMatchesPack || publishedMatchesPack;
  const lifecycleLocked = product.status === "paused" || product.status === "retired";
  const cost = testedPack ? testResult.measuredCostUsdc : 0;
  const margin = price - cost;
  const payoutReady = product.executionAccess !== "paid" || releaseSummary?.payoutReady === true || published !== null ||
    (price > 0 && /^0x[0-9a-fA-F]{40}$/u.test(payoutAddress));
  const ready = pack !== null && testedPack && representativeReady && price >= cost && payoutReady &&
    !currentPackAlreadyReleased && !lifecycleLocked;
  const publishedSummary: ResourceCurrentReleaseSummary | null = published !== null && pack !== null &&
      published.release.packVersionId === pack.packVersionId && published.release.semanticHash === pack.semanticHash
    ? {
        id: published.release.id,
        resourceProductId: published.release.resourceProductId,
        packVersionId: published.release.packVersionId,
        semanticHash: published.release.semanticHash,
        publicationKey: published.release.publicationKey,
        publicationRequestHash: published.release.publicationRequestHash,
        priceUsdc: published.release.priceUsdc,
        executionAccess: published.release.executionAccess,
        discoveryAccess: published.release.discoveryAccess,
        freshness: pack.freshness,
        payoutReady: true,
        settlementState: published.agent.settlementLive ? "on" : "off",
        agentId: published.release.agentId,
        agentStatus: published.agent.status,
        flowVersionId: published.release.flowVersionId,
        deploymentId: published.release.deploymentId,
        deploymentStatus: "live",
        deploymentRetiredAt: null,
        createdAt: published.release.createdAt,
        urls: published.urls,
      }
    : null;
  // A successful local publication is newer than the cached owner summary.
  // The workspace clears it only after a successful server-current reload, so
  // every displayed field below always comes from one exact receipt.
  const exactRelease = publishedSummary ?? releaseSummary ?? product.currentRelease;
  const urls = exactRelease?.urls ?? null;
  const settlementState = exactRelease?.settlementState ?? "off";
  const currentRelease = exactRelease;
  const publishLabel = product.status === "paused"
    ? "Release paused"
    : product.status === "retired"
      ? "Release retired"
      : currentPackAlreadyReleased
        ? "Published Live"
        : "Review publication";
  const presentation = releasePresentation(product, exactRelease);

  return (
    <section className="resource-stage" aria-labelledby="resource-publish-heading">
      <div className="resource-stage-head">
        <p className="resource-kicker">06 / Publish</p>
        <h2 id="resource-publish-heading">Pin one exact release</h2>
        <p>Publish uses the approved pack, typed Job Contract, immutable flow version, and existing Live deployment rails.</p>
      </div>
      <dl className="resource-fact-strip">
        <div><dt>Price</dt><dd className="tabular">${price.toFixed(6)}</dd></div>
        <div><dt>Measured cost</dt><dd className="tabular">${cost.toFixed(6)}</dd></div>
        <div><dt>Margin</dt><dd className="tabular">${margin.toFixed(6)}</dd></div>
        <div><dt>Payout</dt><dd>{payoutReady ? "Ready" : "Required"}</dd></div>
        <div><dt>Settlement</dt><dd>Settlement {settlementState}</dd></div>
      </dl>
      <div className="resource-publish-controls">
        <label>Price per successful call, USDC<input type="number" min={0} step="0.000001" value={price} onChange={(event) => setPrice(Number(event.target.value))} disabled={busy || currentPackAlreadyReleased || lifecycleLocked} /></label>
        <label>Payout {product.executionAccess === "paid" ? "wallet" : "not required"}<input value={payoutAddress} onChange={(event) => setPayoutAddress(event.target.value)} placeholder="0x…" disabled={busy || product.executionAccess !== "paid" || currentPackAlreadyReleased || lifecycleLocked || releaseSummary?.payoutReady === true} /></label>
      </div>
      <p className="resource-boundary-note">Optional source context is informational. Empty context does not disable this action. Paid execution still requires the real technical payout and price-floor prerequisites.</p>
      <div className="resource-form-action">
        <button
          ref={triggerRef}
          type="button"
          className="lp-btn lp-btn--primary"
          disabled={busy || !ready}
          onClick={() => onRequestPublish({ priceUsdc: price, ...(payoutAddress.trim() === "" ? {} : { payoutAddress: payoutAddress.trim() }) })}
        >
          {publishLabel}
        </button>
      </div>
      {currentRelease && (
        <div className="resource-current-release">
          <h3>{presentation.heading}</h3>
          <p className="resource-receipt-line">
            <span>Release <code>{currentRelease.id}</code></span>
            <span>Pack <code>{currentRelease.packVersionId}</code></span>
            <span>Hash <code className="resource-hash">{currentRelease.semanticHash}</code></span>
          </p>
        </div>
      )}
      {urls && presentation.urlNotice && (
        <p className="resource-boundary-note">
          {presentation.urlNotice}
        </p>
      )}
      {urls && (
        <div className="resource-url-register" aria-label={presentation.urlLabel}>
          {Object.entries(urls).map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}
        </div>
      )}
    </section>
  );
}
