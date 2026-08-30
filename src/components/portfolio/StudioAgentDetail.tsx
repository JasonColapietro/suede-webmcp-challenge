"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import type { DailyRoll, Earning } from "@/lib/portfolio/types";
import { buildAgentView, fetchPortfolio, loadManual, removeManualAgent, type AgentView, type RealData } from "@/lib/portfolio/client-store";
import { categoryColor } from "@/lib/portfolio/category";
import { compactNum, compactUsd, num, shortAddr, shortDay, signedPct, timeAgo, usd, usdPrecise } from "@/lib/portfolio/format";
import { AreaChart, BarChart } from "@/components/portfolio/charts";
import { CategoryTag, DeltaPill, StatusBadge } from "@/components/portfolio/ui";
import { AgentForm } from "@/components/portfolio/AgentForm";
import { LogEarningsForm } from "@/components/portfolio/LogEarningsForm";
import { DiscoveryConsole } from "@/components/portfolio/DiscoveryConsole";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Per-agent settlement switch, read from /api/me (the portfolio payload does
 * not carry it). null = unknown (fetch failed, or the row is manual/foreign),
 * in which case the toggle simply does not render — never guess about money.
 */
function readSettlementLive(me: unknown, slug: string): boolean | null {
  if (typeof me !== "object" || me === null) return null;
  const agents = (me as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return null;
  for (const entry of agents) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as { slug?: unknown; settlementLive?: unknown };
    if (a.slug === slug && typeof a.settlementLive === "boolean") {
      return a.settlementLive;
    }
  }
  return null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="lp">
      <SiteNav active="/portfolio" />
      <main className="lp-shell lp-page">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function StudioAgentDetail({ id }: { id: string }) {
  const router = useRouter();
  const [real, setReal] = useState<RealData | null>(null);
  const [view, setView] = useState<AgentView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [settlementLive, setSettlementLive] = useState<boolean | null>(null);
  const [settlementBusy, setSettlementBusy] = useState(false);
  const [settlementError, setSettlementError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const r = await fetchPortfolio();
      setReal(r);
      setView(buildAgentView(r, id, loadManual()));
    } catch {
      setError("Couldn't load this agent.");
    } finally {
      setLoaded(true);
    }
  }, [id]);

  // Settlement state lives on /api/me, keyed by slug. Best-effort read: on
  // failure the toggle is hidden rather than shown with a guessed value.
  const agentSlug = view && !view.isManual ? view.agent.slug : null;
  useEffect(() => {
    if (agentSlug === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok) return;
        const body: unknown = await res.json();
        const live = readSettlementLive(body, agentSlug);
        if (!cancelled) setSettlementLive(live);
      } catch {
        // Leave settlementLive null; the toggle stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentSlug]);

  const toggleSettlement = useCallback(async (): Promise<void> => {
    if (agentSlug === null || settlementLive === null || settlementBusy) return;
    setSettlementBusy(true);
    setSettlementError(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentSlug)}/settlement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ live: !settlementLive }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setSettlementError("Couldn't update settlement. Try again.");
        return;
      }
      const next =
        typeof body === "object" && body !== null &&
        typeof (body as { settlementLive?: unknown }).settlementLive === "boolean"
          ? (body as { settlementLive: boolean }).settlementLive
          : !settlementLive;
      setSettlementLive(next);
    } catch {
      setSettlementError("Couldn't update settlement. Try again.");
    } finally {
      setSettlementBusy(false);
    }
  }, [agentSlug, settlementLive, settlementBusy]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onStore = () => setView((v) => (real ? buildAgentView(real, id, loadManual()) : v));
    window.addEventListener("suede:portfolio", onStore);
    return () => window.removeEventListener("suede:portfolio", onStore);
  }, [real, id]);

  if (error) {
    return (
      <Shell>
        <div className="card flex flex-col items-start gap-3 p-6">
          <p style={{ color: "var(--rights-red)" }}>{error}</p>
          <button type="button" onClick={load} className="lp-btn lp-btn--ghost lp-btn--sm">Retry</button>
        </div>
      </Shell>
    );
  }
  if (!loaded) {
    return <Shell><p className="lp-loading">Loading your agent&apos;s numbers…</p></Shell>;
  }
  if (!view) {
    return (
      <Shell>
        <p className="eyebrow">Agent not found</p>
        <h1 className="display" style={{ fontSize: "var(--text-h2)", marginTop: 8 }}>No agent by that id.</h1>
        <p style={{ color: "var(--text-muted)", marginTop: 8 }}>It may not be one of your agents, or the link is stale.</p>
        <Link href="/portfolio" className="mono no-underline" style={{ display: "inline-block", marginTop: 16, color: "var(--primary)", fontSize: "var(--text-sm)" }}>← Back to earnings</Link>
      </Shell>
    );
  }

  const { agent, nowISO, isManual } = view;
  const NOW = new Date(nowISO);
  const color = categoryColor(agent.category);
  const revenueSeries = agent.daily.map((r) => ({ label: r.day, value: r.revenueUsdc }));
  const callSeries = agent.daily.slice(-30).map((r) => ({ label: r.day, value: r.calls }));
  const errorRate = agent.stats.calls > 0 ? agent.stats.errors / agent.stats.calls : 0;
  const loggedDays = agent.daily.filter((r) => r.calls > 0 || r.revenueUsdc > 0 || r.errors > 0).slice(-20).reverse();

  function onDelete() {
    if (window.confirm(`Stop tracking ${agent.name}? This removes it and its manual entries.`)) {
      removeManualAgent(agent.id);
      router.push("/portfolio");
    }
  }

  return (
    <Shell>
      <Link href="/portfolio" className="mono inline-flex items-center gap-1 no-underline" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
        <span aria-hidden="true">←</span> Earnings
      </Link>

      <header className="mb-6 mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="display" style={{ fontSize: "var(--text-h2)" }}>{agent.name}</h1>
            <StatusBadge status={agent.status} size="md" />
            {isManual ? <span className="mono" style={{ fontSize: "var(--text-label)", color: "var(--text-muted)" }}>manual</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            <CategoryTag category={agent.category} />
            <span aria-hidden="true">·</span>
            <span className="tabular" data-numeric>{usdPrecise(agent.priceUsdc)}/call</span>
            <span aria-hidden="true">·</span>
            <span>launched {formatDate(agent.launchedAt)}</span>
            {agent.ownerWallet ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="mono" data-numeric title={agent.ownerWallet}>{shortAddr(agent.ownerWallet)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" onClick={() => setLogging(true)} className="lp-btn lp-btn--primary">+ Log a day</button>
          {isManual ? (
            <>
              <button type="button" onClick={() => setEditing(true)} className="lp-btn lp-btn--ghost">Edit</button>
              <button type="button" onClick={onDelete} className="lp-btn lp-btn--ghost" style={{ color: "var(--rights-red)" }}>Delete</button>
            </>
          ) : agent.x402Url ? (
            <a href={agent.x402Url} className="mono inline-flex items-center gap-1.5 rounded-md px-3.5 no-underline" style={{ height: "var(--control-h)", lineHeight: "var(--control-h)", fontSize: "var(--text-xs)", color: "var(--text-primary)", border: "1px solid var(--hairline)" }}>
              View listing <span aria-hidden="true">↗</span>
            </a>
          ) : null}
        </div>
      </header>

      {!isManual ? (
        <div className="mb-6 rounded-lg border px-4 py-3" style={{ borderColor: "var(--hairline)", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
          Real settlement data from this agent&apos;s paid calls. Use <b style={{ color: "var(--text-primary)" }}>Log a day</b> to override a day&apos;s numbers in your view.
        </div>
      ) : null}

      <section className="card mb-8 grid grid-cols-2 divide-x divide-y lg:grid-cols-4 lg:divide-y-0" style={{ borderColor: "var(--hairline)" }}>
        <Metric label="Total earned">{usd(agent.stats.revenueUsdc)}</Metric>
        <Metric label="Paid calls">{num(agent.stats.calls)}</Metric>
        <Metric label="Last 7 days"><DeltaPill fraction={agent.delta7d} /></Metric>
        <Metric label="Error rate" accent={errorRate > 0.1 ? "var(--rights-red)" : undefined}>{(errorRate * 100).toFixed(1)}%</Metric>
      </section>

      <section className="card mb-6 p-5">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="eyebrow">Earnings · since launch</p>
            <p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>USDC revenue per day</p>
          </div>
          <p className="mono hidden sm:block" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }} data-numeric>
            {compactUsd(agent.stats.revenueUsdc)} settled to your wallet
          </p>
        </div>
        {revenueSeries.some((p) => p.value > 0) ? (
          <AreaChart points={revenueSeries} color={color} height={220} format={compactUsd} ariaLabel={`${agent.name} earnings per day`} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center" style={{ background: "var(--canvas-bg)", border: "1px solid var(--hairline)", borderRadius: "var(--radius)", minHeight: 180 }}>
            <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>No earnings recorded yet.</p>
            <button type="button" onClick={() => setLogging(true)} className="lp-btn lp-btn--primary">+ Log a day</button>
          </div>
        )}
      </section>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <div className="mb-4 flex flex-col gap-1">
            <p className="eyebrow">Call volume · last 30 days</p>
            <p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }} data-numeric>
              {compactNum(callSeries.reduce((s, p) => s + p.value, 0))} calls in window
            </p>
          </div>
          <BarChart points={callSeries} color={color} height={170} ariaLabel={`${agent.name} call volume`} />
        </section>

        <section className="card flex flex-col p-5">
          <p className="eyebrow mb-4">Endpoint health</p>
          <div className="flex flex-col gap-4">
            <HealthRow label="Status"><StatusBadge status={agent.status} size="md" /></HealthRow>
            <HealthRow label="Last call"><span className="tabular" data-numeric>{timeAgo(agent.stats.lastActiveAt, NOW)}</span></HealthRow>
            <HealthRow label="Error rate"><span className="tabular" data-numeric style={{ color: errorRate > 0.1 ? "var(--rights-red)" : undefined }}>{(errorRate * 100).toFixed(1)}%</span></HealthRow>
            <HealthRow label="7-day trend"><span className="tabular" data-numeric>{signedPct(agent.delta7d)}</span></HealthRow>
            {!isManual && settlementLive !== null ? (
              <HealthRow label="Payment">
                <span className="mono" style={{ fontSize: "var(--text-label)", color: settlementLive ? "var(--text-success)" : "var(--text-warning)" }}>
                  {settlementLive ? "collecting" : "free previews"}
                </span>
              </HealthRow>
            ) : null}
          </div>
          {!isManual && settlementLive !== null ? (
            <div className="mt-4 flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => void toggleSettlement()}
                disabled={settlementBusy}
                className="lp-btn lp-btn--ghost lp-btn--sm"
                title={
                  settlementLive
                    ? "Settlement is on: paid calls collect real USDC. Click to switch back to free previews."
                    : "Settlement is off: calls run as free previews. Click to go live and collect real USDC."
                }
              >
                {settlementBusy
                  ? "Updating…"
                  : settlementLive
                    ? "Stop collecting payment"
                    : "Go live: accept payment"}
              </button>
              {!settlementLive ? (
                <p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", margin: 0 }}>
                  Calls are served free until you turn this on.
                </p>
              ) : null}
              {settlementError ? (
                <p role="alert" style={{ color: "var(--rights-red)", fontSize: "var(--text-xs)", margin: 0 }}>
                  {settlementError}
                </p>
              ) : null}
            </div>
          ) : null}
          {agent.x402Url ? (
            <div className="mt-auto flex flex-col gap-1.5 pt-5">
              <a href={agent.x402Url} className="mono no-underline" style={{ fontSize: "var(--text-xs)", color: "var(--primary)" }}>Public listing ↗</a>
            </div>
          ) : null}
        </section>
      </div>

      {!isManual ? (
        <div className="mb-6">
          <DiscoveryConsole agentId={agent.id} slug={agent.slug} />
        </div>
      ) : null}

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
          <p className="eyebrow">{isManual ? "Logged days" : "Recent runs"}</p>
          <button type="button" onClick={() => setLogging(true)} className="mono" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--primary)", fontSize: "var(--text-xs)" }}>+ Log a day</button>
        </div>
        {isManual ? (
          loggedDays.length === 0 ? (
            <EmptyRows onLog={() => setLogging(true)} />
          ) : (
            <EntriesTable rows={loggedDays} />
          )
        ) : agent.recentRuns.length === 0 ? (
          <p className="px-5 py-8 text-center" style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>No paid calls yet.</p>
        ) : (
          <RunsTable runs={agent.recentRuns} now={NOW} />
        )}
      </section>

      {editing && isManual ? <AgentForm initial={agent} onClose={() => setEditing(false)} onSaved={() => real && setView(buildAgentView(real, id, loadManual()))} /> : null}
      {logging ? <LogEarningsForm agentId={agent.id} agentName={agent.name} isReal={!isManual} onClose={() => setLogging(false)} onSaved={() => real && setView(buildAgentView(real, id, loadManual()))} /> : null}
    </Shell>
  );
}

function Metric({ label, children, accent }: { label: string; children: React.ReactNode; accent?: string }) {
  return (
    <div className="flex flex-col gap-1.5 px-5 py-4">
      <p className="eyebrow">{label}</p>
      <div className="tabular flex items-center gap-2" data-numeric style={{ fontSize: "1.35rem", fontWeight: 500, letterSpacing: "-0.01em", color: accent }}>
        {children}
      </div>
    </div>
  );
}

function HealthRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{label}</span>
      {children}
    </div>
  );
}

function EmptyRows({ onLog }: { onLog: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>No days logged yet.</p>
      <button type="button" onClick={onLog} className="lp-btn lp-btn--primary">+ Log your first day</button>
    </div>
  );
}

function RunsTable({ runs, now }: { runs: Earning[]; now: Date }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 560 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--hairline)" }}>
            <th className="px-5 py-2.5 text-left"><span className="eyebrow">Call</span></th>
            <th className="px-3 py-2.5 text-right"><span className="eyebrow">Gross</span></th>
            <th className="px-3 py-2.5 text-right"><span className="eyebrow">Net</span></th>
            <th className="px-3 py-2.5 text-right"><span className="eyebrow">When</span></th>
            <th className="px-5 py-2.5 text-right"><span className="eyebrow">Settled</span></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.callId} style={{ borderBottom: "1px solid var(--hairline-visible)" }}>
              <td className="px-5 py-3"><span className="mono" data-numeric style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{run.callId.slice(0, 12)}…</span></td>
              <td className="px-3 py-3 text-right tabular" data-numeric style={{ color: "var(--text-muted)" }}>{usdPrecise(run.grossUsdc)}</td>
              <td className="px-3 py-3 text-right tabular" data-numeric style={{ fontWeight: 500 }}>{run.settled ? usdPrecise(run.amountUsdc) : "—"}</td>
              <td className="px-3 py-3 text-right tabular" data-numeric style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{timeAgo(run.ts, now)}</td>
              <td className="px-5 py-3 text-right">
                {run.settled ? (
                  <span className="mono inline-flex items-center gap-1" style={{ fontSize: "var(--text-label)", color: "var(--text-success)" }}><span aria-hidden="true">✓</span> settled</span>
                ) : (
                  <span className="mono" style={{ fontSize: "var(--text-label)", color: "var(--text-muted)" }}>unsettled</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntriesTable({ rows }: { rows: DailyRoll[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 480 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--hairline)" }}>
            <th className="px-5 py-2.5 text-left"><span className="eyebrow">Day</span></th>
            <th className="px-3 py-2.5 text-right"><span className="eyebrow">Calls</span></th>
            <th className="px-3 py-2.5 text-right"><span className="eyebrow">Revenue</span></th>
            <th className="px-5 py-2.5 text-right"><span className="eyebrow">Errors</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day} style={{ borderBottom: "1px solid var(--hairline-visible)" }}>
              <td className="px-5 py-3"><span className="tabular" data-numeric>{shortDay(r.day)}</span></td>
              <td className="px-3 py-3 text-right tabular" data-numeric>{num(r.calls)}</td>
              <td className="px-3 py-3 text-right tabular" data-numeric style={{ fontWeight: 500 }}>{usd(r.revenueUsdc)}</td>
              <td className="px-5 py-3 text-right tabular" data-numeric style={{ color: r.errors > 0 ? "var(--rights-red)" : "var(--text-muted)" }}>{num(r.errors)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
