"use client";

import type { RefObject } from "react";
import type {
  ResourceCurrentReleaseSummary,
  ResourceLifecycleAction,
  ResourcePortfolioItem,
} from "./client";
import { resourceReleaseReachability } from "./release-reachability";

const STATE_COPY = {
  live: {
    title: "Live · publicly reachable",
    detail: "The exact release and deployment accept discovery and runs.",
  },
  paused: {
    title: "Paused · not publicly reachable",
    detail: "Release history stays intact. Resume restores only this exact deployment.",
  },
  retired: {
    title: "Retired · terminal",
    detail: "Immutable release history remains available. This release cannot resume.",
  },
} as const;

function liveStateCopy(product: ResourcePortfolioItem): {
  readonly title: string;
  readonly detail: string;
} {
  const release = product.currentRelease;
  if (!release) return STATE_COPY.live;
  const reachability = resourceReleaseReachability(release);
  if (reachability.state === "lifecycle") {
    return {
      title: "Live receipt · deployment unavailable",
      detail: "Discovery and runs remain unavailable because the exact release agent or deployment is no longer Live.",
    };
  }
  if (reachability.state === "freshness") {
    const freshness = release.freshness.slice(0, 1).toUpperCase() +
      release.freshness.slice(1);
    const accessDetail = release.executionAccess === "private"
      ? " Execution access is also private."
      : release.discoveryAccess === "unlisted"
        ? " Discovery access is also unlisted."
        : "";
    return {
      title: `Live receipt · ${freshness} freshness blocked`,
      detail: `Strict freshness blocks discovery and runs until a fresh pack is approved and published.${accessDetail}`,
    };
  }
  if (reachability.state === "private") {
    return {
      title: "Live receipt · private access",
      detail: "The exact release remains recorded for its owner. Public discovery and public runs are blocked.",
    };
  }
  if (reachability.state === "price") {
    return {
      title: "Live receipt · price blocked",
      detail: "Paid runs remain unavailable because the exact release does not have a positive price.",
    };
  }
  if (reachability.state === "payout") {
    return {
      title: "Live receipt · payout blocked",
      detail: "Paid runs remain unavailable until the owner payout wallet is ready.",
    };
  }
  if (reachability.state === "settlement") {
    return {
      title: "Live receipt · settlement off",
      detail: "Paid runs remain unavailable while settlement is off for the exact release deployment.",
    };
  }
  if (!reachability.discoverable) {
    return {
      title: "Live · unlisted",
      detail: "The exact release accepts direct runs but is excluded from public discovery.",
    };
  }
  return STATE_COPY.live;
}

export default function ResourceLifecycleControls({
  product,
  releaseHistory = [],
  disabled,
  busy,
  headingRef,
  onRequest,
}: {
  readonly product: ResourcePortfolioItem;
  readonly releaseHistory?: readonly ResourceCurrentReleaseSummary[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly onRequest: (action: ResourceLifecycleAction, trigger: HTMLButtonElement) => void;
}): React.JSX.Element | null {
  const release = product.currentRelease;
  if (!release || !["live", "paused", "retired"].includes(product.status)) return null;
  const status = product.status as keyof typeof STATE_COPY;
  const copy = status === "live" ? liveStateCopy(product) : STATE_COPY[status];
  const actionDisabled = disabled || busy;
  const action = (value: ResourceLifecycleAction) =>
    (event: React.MouseEvent<HTMLButtonElement>): void => onRequest(value, event.currentTarget);

  const historyLabel = releaseHistory.length < product.releaseCount
    ? `Release history · ${releaseHistory.length} of ${product.releaseCount} receipts`
    : `Release history · ${releaseHistory.length} ${releaseHistory.length === 1 ? "receipt" : "receipts"}`;

  return (
    <section className="resource-lifecycle" data-status={status} aria-labelledby="resource-lifecycle-heading">
      <div className="resource-lifecycle-state">
        <h2 ref={headingRef} id="resource-lifecycle-heading" tabIndex={-1}>Release state</h2>
        <p><strong>{copy.title}</strong><span>{copy.detail}</span></p>
      </div>
      <p className="resource-lifecycle-pin">
        <span>Exact release</span>
        <code>{release.id}</code>
      </p>
      {status !== "retired" && (
        <div className="resource-lifecycle-actions" aria-label="Release lifecycle controls">
          {status === "live" ? (
            <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" disabled={actionDisabled} onClick={action("pause")}>Pause release</button>
          ) : (
            <button type="button" className="lp-btn lp-btn--primary lp-btn--sm" disabled={actionDisabled} onClick={action("resume")}>Resume release</button>
          )}
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm resource-lifecycle-retire" disabled={actionDisabled} onClick={action("retire")}>Retire release</button>
        </div>
      )}
      {releaseHistory.length > 0 && (
        <details className="resource-release-history">
          <summary>{historyLabel}</summary>
          <ol>
            {releaseHistory.map((historicalRelease) => (
              <li key={historicalRelease.id}>
                <p>
                  <strong>{historicalRelease.id === release.id ? "Current release" : "Prior release"}</strong>
                  <time dateTime={historicalRelease.createdAt}>{historicalRelease.createdAt}</time>
                </p>
                <dl>
                  <div><dt>Release</dt><dd><code>{historicalRelease.id}</code></dd></div>
                  <div><dt>Pack</dt><dd><code>{historicalRelease.packVersionId}</code></dd></div>
                  <div><dt>Hash</dt><dd><code className="resource-hash">{historicalRelease.semanticHash}</code></dd></div>
                  <div><dt>Deployment</dt><dd><code>{historicalRelease.deploymentId}</code></dd></div>
                  <div><dt>Lifecycle</dt><dd>
                    Agent {historicalRelease.agentStatus} · Deployment {historicalRelease.deploymentStatus}
                    {historicalRelease.deploymentRetiredAt && (
                      <> · Retired <time dateTime={historicalRelease.deploymentRetiredAt}>{historicalRelease.deploymentRetiredAt}</time></>
                    )}
                  </dd></div>
                  <div><dt>Access</dt><dd>{historicalRelease.executionAccess} · {historicalRelease.discoveryAccess}</dd></div>
                  <div><dt>Price</dt><dd className="tabular">${historicalRelease.priceUsdc.toFixed(6)}</dd></div>
                </dl>
                <div className="resource-release-history-urls">
                  <span>Recorded URLs</span>
                  <ul>
                    {Object.entries(historicalRelease.urls).map(([label, value]) => (
                      <li key={label}><span>{label}</span><code>{value}</code></li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
