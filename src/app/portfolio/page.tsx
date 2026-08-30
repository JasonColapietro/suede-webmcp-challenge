"use client";

/**
 * /portfolio — the owner's earnings dashboard. Real settlement data for agents
 * launched in the studio (via /api/portfolio), with a manual overlay layered on
 * top client-side: track external agents, or override a day's numbers by hand.
 * Identity is the per-browser owner cookie; nothing here is public.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { buildView, clearManual, fetchPortfolio, loadManual, type PortfolioView, type RealData } from "@/lib/portfolio/client-store";
import { StatTiles } from "@/components/portfolio/StatTiles";
import { PortfolioTrend } from "@/components/portfolio/PortfolioTrend";
import { AgentTable } from "@/components/portfolio/AgentTable";
import { AgentForm } from "@/components/portfolio/AgentForm";
import { PortfolioEmpty } from "@/components/portfolio/PortfolioEmpty";
import "../chrome.css";
import "../site.css";
import "./portfolio.css";

function formatAsOf(iso: string): string {
  return (
    new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: false,
    }) + " UTC"
  );
}

export default function PortfolioPage() {
  const [real, setReal] = useState<RealData | null>(null);
  const [view, setView] = useState<PortfolioView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const r = await fetchPortfolio();
      setReal(r);
      setView(buildView(r, loadManual()));
    } catch {
      setError("Couldn't load your portfolio. Check that you're signed in to the studio.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onStore = () => setView((v) => (real ? buildView(real, loadManual()) : v));
    window.addEventListener("suede:portfolio", onStore);
    return () => window.removeEventListener("suede:portfolio", onStore);
  }, [real]);

  const summary = view?.summary;
  const agents = view?.agents ?? [];
  const asOf = view ? formatAsOf(view.nowISO) : "";
  const manualCount = agents.filter((a) => a.manual).length;

  return (
    <div className="lp">
      <SiteNav active="/portfolio" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="pf-head">
          <div className="pf-head-copy">
            {/* "as of" is a claim about data. With no agents there is no data
                to be as-of, so the timestamp only adds noise to the zero state. */}
            <p className="eyebrow">Portfolio{asOf && agents.length > 0 ? ` · as of ${asOf}` : ""}</p>
            <h1>Watch your agents earn.</h1>
            <p>
              Every settled call lands in your wallet. This is the ledger:
              what each agent charges, how often it gets called, and what it has
              paid you back
              {manualCount > 0 ? `, plus ${manualCount} you track by hand` : ""}.
            </p>
            <div
              aria-label="What you can do on this page"
              style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginTop: "14px" }}
            >
              <span className="lp-eyebrow" style={{ marginRight: "4px" }}>
                On this page
              </span>
              <span className="lp-pill">See earnings per agent</span>
              <span className="lp-pill">Follow the revenue trend</span>
              <span className="lp-pill">Track outside agents by hand</span>
              <span className="lp-pill">Private to this browser</span>
            </div>
          </div>
          {agents.length > 0 ? (
            <div className="pf-head-actions">
              <Link href="/start" className="lp-btn lp-btn--primary lp-btn--sm">
                Launch another →
              </Link>
              <button type="button" onClick={() => setShowAdd(true)} className="lp-btn lp-btn--ghost lp-btn--sm">
                + Track agent
              </button>
            </div>
          ) : null}
        </header>

        {error ? (
          <div className="card flex flex-col items-start gap-3 p-6">
            <p style={{ color: "var(--rights-red)" }}>{error}</p>
            <button type="button" onClick={load} className="lp-btn lp-btn--ghost lp-btn--sm">
              Retry
            </button>
          </div>
        ) : !view || !summary ? (
          <div className="card p-6">
            <p className="lp-loading">Loading your earnings…</p>
          </div>
        ) : agents.length === 0 ? (
          <PortfolioEmpty onTrack={() => setShowAdd(true)} />
        ) : (
          <div className="pf-stack">
            <StatTiles summary={summary} />
            <PortfolioTrend summary={summary} />
            <AgentTable agents={agents} nowISO={view.nowISO} />
            {manualCount > 0 ? (
              <div className="pf-footnote">
                <p>
                  {manualCount} of these {manualCount === 1 ? "agents is" : "agents are"} tracked by
                  hand in this browser. Clearing them leaves real settlement data untouched.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm("Remove all manually-tracked agents and overrides? Real settlement data stays.")) clearManual();
                  }}
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                >
                  Clear manual entries
                </button>
              </div>
            ) : null}
          </div>
        )}
      </main>
      <SiteFooter />
      {showAdd ? <AgentForm onClose={() => setShowAdd(false)} onSaved={() => real && setView(buildView(real, loadManual()))} /> : null}
    </div>
  );
}
