"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bootstrapResourceWorkspace,
  parseResourceListResponse,
  requestIsCurrent,
  resourceJsonRequest,
} from "./client";

export interface ResourcePortfolioDisplayItem {
  readonly id: string;
  readonly name: string;
  readonly status: "draft" | "test" | "live" | "paused" | "retired";
  readonly livePackVersionId: string | null;
  readonly freshness: "fresh" | "stale" | "mixed" | null;
  readonly executedCalls: number | null;
  readonly settledUsdc: number | null;
}

export type ResourcePortfolioViewState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly items: readonly ResourcePortfolioDisplayItem[] };

function statusLabel(value: ResourcePortfolioDisplayItem["status"]): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function freshnessLabel(value: ResourcePortfolioDisplayItem["freshness"]): string {
  if (value === null) return "Not recorded";
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function ResourcePortfolioView({
  state,
  onRetry,
}: {
  readonly state: ResourcePortfolioViewState;
  readonly onRetry: () => void;
}): React.JSX.Element {
  if (state.status === "loading") {
    return <div className="resource-state" role="status">Loading resource products…</div>;
  }
  if (state.status === "error") {
    return (
      <div className="resource-state resource-state--error" role="alert">
        <b>Resource products could not be loaded.</b>
        <span>The private workspace response was unavailable or did not match its contract.</span>
        <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (state.items.length === 0) {
    return (
      <section className="resource-empty">
        <p className="resource-kicker">No resources yet</p>
        <h2>Frame the job, then add one source.</h2>
        <p>Start with a manual note or reviewed row. Automation can wait until the job proves useful.</p>
        <Link href="/resources/new" className="lp-btn lp-btn--primary">Create a resource →</Link>
      </section>
    );
  }
  return (
    <section className="resource-register" aria-labelledby="resource-register-title">
      <h2 id="resource-register-title" className="sr-only">Resource products</h2>
      <div className="resource-register-head" aria-hidden="true">
        <span>Resource</span><span>State</span><span>Live pack</span><span>Freshness</span><span>Executed</span><span>Settled</span>
      </div>
      {state.items.map((item) => (
        <Link key={item.id} href={`/resources/${encodeURIComponent(item.id)}`} className="resource-register-row">
          <strong>{item.name}</strong>
          <span data-label="State"><span className={`resource-status resource-status--${item.status}`}>{statusLabel(item.status)}</span></span>
          <code data-label="Live pack">{item.livePackVersionId ?? "No Live pack"}</code>
          <span data-label="Freshness">{freshnessLabel(item.freshness)}</span>
          <span data-label="Executed" className="tabular">{item.executedCalls ?? "Not recorded"}</span>
          <span data-label="Settled" className="tabular">{item.settledUsdc === null ? "Not recorded" : `$${item.settledUsdc.toFixed(2)}`}</span>
        </Link>
      ))}
    </section>
  );
}

export default function ResourcePortfolio(): React.JSX.Element {
  const [state, setState] = useState<ResourcePortfolioViewState>({ status: "loading" });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    controller.current?.abort();
    const activeController = new AbortController();
    controller.current = activeController;
    const current = generation.current + 1;
    generation.current = current;
    setState({ status: "loading" });
    try {
      const resources = parseResourceListResponse(await resourceJsonRequest("/api/v2/resources", {
        signal: activeController.signal,
      }));
      const items = resources.map((resource): ResourcePortfolioDisplayItem => ({
          id: resource.id,
          name: resource.name,
          status: resource.status,
          livePackVersionId: resource.livePackVersionId,
          freshness: resource.portfolioFreshness,
          executedCalls: resource.portfolioPayments.executed,
          settledUsdc: resource.portfolioPayments.settled.amountUsdc,
        }));
      if (requestIsCurrent(current, generation.current, activeController.signal.aborted)) {
        setState({ status: "ready", items });
      }
    } catch {
      if (requestIsCurrent(current, generation.current, activeController.signal.aborted)) {
        setState({ status: "error" });
      }
    }
  }, []);

  const bootstrap = useCallback(async (): Promise<void> => {
    setState({ status: "loading" });
    try {
      await bootstrapResourceWorkspace(load);
    } catch {
      setState({ status: "error" });
    }
  }, [load]);

  useEffect(() => {
    void bootstrap();
    return () => controller.current?.abort();
  }, [bootstrap]);

  return (
    <>
      <header className="ws-head resource-page-head">
        <h1>Resource Foundry</h1>
        <div className="ws-head-actions">
          <Link href="/resources/new" className="lp-btn lp-btn--primary lp-btn--sm">New resource →</Link>
        </div>
        <p className="ws-head-sub">Turn reviewed sources into one narrow, immutable service with evidence, a typed contract, and honest settlement facts.</p>
      </header>
      <ResourcePortfolioView state={state} onRetry={() => void bootstrap()} />
    </>
  );
}
