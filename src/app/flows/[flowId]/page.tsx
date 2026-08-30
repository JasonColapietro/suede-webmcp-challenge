"use client";

/**
 * Per-agent hub — ONE place where a single agent is read, discussed, and
 * operated. Before this page an agent's identity was scattered across six
 * surfaces (canvas, guided, code view, the /flows row, /runs, /a/[slug]);
 * the hub aggregates the owner-facing view and links each editing register:
 * Guided (discuss it), Studio (wire it), Code (own every line).
 */
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import { runPillClass, runPillLabel } from "@/lib/runs/status";
import "../../chrome.css";
import "../../site.css";
import "../../workspace.css";
import "../flows.css";

interface MeFlow {
  id: string;
  name: string;
  nodeCount: number;
  updatedAt: number;
}

interface MeSchedule {
  cron: string;
  description: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

interface MeAgent {
  id: string;
  flowId: string;
  slug: string;
  status: "draft" | "live";
  priceUsdc: number;
  settlementLive: boolean;
  calls: number;
  earnedUsdc: number;
  settledUsdc: number;
  schedule: MeSchedule | null;
}

interface MeRun {
  id: string;
  flowId: string;
  status: "running" | "done" | "error";
  trigger: string;
  totalCostUsdc: number;
  startedAt: number;
}

interface MeResponse {
  ownerId: string;
  flows: MeFlow[];
  agents: MeAgent[];
  runs: MeRun[];
}

function isMeResponse(v: unknown): v is MeResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ownerId === "string" &&
    Array.isArray(o.flows) &&
    Array.isArray(o.agents) &&
    Array.isArray(o.runs)
  );
}

function when(ts: number): string {
  const delta = Date.now() - ts;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function untilShort(ts: number): string {
  const hours = Math.round((ts - Date.now()) / 3_600_000);
  if (hours <= 1) return "within the hour";
  if (hours < 48) return `~${hours}h`;
  return `~${Math.round(hours / 24)}d`;
}

function priceLabel(priceUsdc: number): string {
  return priceUsdc === 0 ? "Free" : `$${priceUsdc.toFixed(3)}`;
}

const HUB_RUN_LIMIT = 12;

export default function AgentHubPage({
  params,
}: {
  params: Promise<{ flowId: string }>;
}): React.JSX.Element {
  const { flowId } = use(params);
  const [data, setData] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body: unknown = await res.json();
      if (!isMeResponse(body)) throw new Error("Malformed response.");
      setData(body);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSettlementToggle = useCallback(
    async (agent: MeAgent): Promise<void> => {
      try {
        const res = await fetch(`/api/agents/${agent.slug}/settlement`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ live: !agent.settlementLive }),
        });
        if (!res.ok) throw new Error(`Toggle failed (${res.status})`);
        await load();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Toggle failed.");
      }
    },
    [load],
  );

  const copyPublicLink = useCallback(async (slug: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/a/${slug}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be denied; the visible public link still works.
    }
  }, []);

  const flow = data?.flows.find((f) => f.id === flowId) ?? null;
  const agent = data?.agents.find((a) => a.flowId === flowId) ?? null;
  const runs = (data?.runs ?? []).filter((r) => r.flowId === flowId);

  return (
    <div className="lp">
      <SiteNav active="/flows" />
      <WorkspaceTabs active="/flows" />
      <main id="main-content" className="lp-shell lp-page" style={{ paddingTop: 0 }}>
        <nav className="ws-crumbs" aria-label="Breadcrumb">
          <Link href="/flows">Workspace</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{flow ? flow.name : "Agent"}</span>
        </nav>

        {error && (
          <div className="state-panel state-panel--error" role="alert" style={{ margin: "1rem 0" }}>
            {error}
          </div>
        )}

        {!data ? (
          <div className="lp-loading" role="status" style={{ marginTop: "1.5rem" }}>Loading agent…</div>
        ) : !flow ? (
          <div className="lp-empty" style={{ textAlign: "left", marginTop: "1.5rem" }}>
            <b>No agent with that id in this workspace.</b>
            It may have been deleted, or it belongs to a different workspace key.
            <div style={{ marginTop: "1.1rem" }}>
              <Link href="/flows" className="lp-btn lp-btn--primary lp-btn--sm">
                Back to Workspace →
              </Link>
            </div>
          </div>
        ) : (
          <>
            <header className="ws-head">
              <h1>{flow.name}</h1>
              <span className={`lp-pill ${agent?.status === "live" ? "lp-pill--live" : "lp-pill--draft"}`}>
                {agent ? agent.status : "draft"}
              </span>
              <div className="ws-head-actions">
                <Link href={`/start?flow=${encodeURIComponent(flow.id)}`} className="lp-btn lp-btn--ghost lp-btn--sm">
                  Discuss in Guided
                </Link>
                <Link href={`/build/${flow.id}`} className="lp-btn lp-btn--primary lp-btn--sm">
                  Open in Studio
                </Link>
                <Link href={`/code/${flow.id}`} className="lp-btn lp-btn--ghost lp-btn--sm">
                  Open as Code
                </Link>
              </div>
              <p className="ws-head-sub">
                {flow.nodeCount} {flow.nodeCount === 1 ? "node" : "nodes"} · updated {when(flow.updatedAt)}
                {agent && (
                  <>
                    {" · public at "}
                    <Link href={`/a/${agent.slug}`} className="fl-endpoint">/a/{agent.slug}</Link>
                    {" "}
                    <button
                      type="button"
                      className="lp-iconbtn"
                      style={{ marginLeft: "0.35rem" }}
                      onClick={() => void copyPublicLink(agent.slug)}
                    >
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <span className="sr-only" role="status">
                      {copied ? "Public link copied" : ""}
                    </span>
                  </>
                )}
              </p>
            </header>

            {agent ? (
              <dl className="ws-facts">
                <div className="ws-fact">
                  <dt>Price per call</dt>
                  <dd className="tabular">{priceLabel(agent.priceUsdc)}</dd>
                </div>
                <div className="ws-fact">
                  <dt>Schedule</dt>
                  <dd>
                    {agent.schedule ? (
                      <>
                        {agent.schedule.description}
                        {agent.schedule.nextRunAt !== null && (
                          <span className="sub tabular">next {untilShort(agent.schedule.nextRunAt)}</span>
                        )}
                      </>
                    ) : (
                      "On demand"
                    )}
                  </dd>
                </div>
                <div className="ws-fact">
                  <dt>Calls</dt>
                  <dd className="tabular">{agent.calls}</dd>
                </div>
                <div className="ws-fact">
                  <dt>Earnings</dt>
                  <dd className="tabular">
                    ${agent.settledUsdc.toFixed(2)} settled
                    {agent.earnedUsdc > agent.settledUsdc && (
                      <span className="sub tabular">
                        ${(agent.earnedUsdc - agent.settledUsdc).toFixed(2)} pending
                      </span>
                    )}
                  </dd>
                </div>
                <div className="ws-fact">
                  <dt>Settlement</dt>
                  <dd>
                    <button
                      type="button"
                      className={`lp-iconbtn${agent.settlementLive ? " lp-iconbtn--active fl-settle-on" : ""}`}
                      aria-pressed={agent.settlementLive}
                      title={
                        agent.settlementLive
                          ? "Settlement live: click to disable"
                          : "Settlement off: click to enable (sends real USDC)"
                      }
                      onClick={() => void handleSettlementToggle(agent)}
                    >
                      {agent.settlementLive ? "Settle: ON" : "Settle: OFF"}
                    </button>
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="state-panel" style={{ marginBottom: "1.4rem" }}>
                Not launched yet — this flow has no public endpoint. Open it in
                Studio and hit Launch to price it and put it in the directory.
              </div>
            )}

            <section className="lp-block" style={{ marginTop: 0 }}>
              <div className="fl-section-head">
                <h2 className="lp-eyebrow">Runs of this agent</h2>
                {runs.length > 0 && (
                  <Link
                    href={`/runs?flow=${encodeURIComponent(flow.id)}`}
                    className="lp-iconbtn"
                    style={{ textDecoration: "none" }}
                  >
                    Full history
                  </Link>
                )}
              </div>
              {runs.length === 0 ? (
                <div className="lp-empty" style={{ textAlign: "left" }}>
                  No runs recorded yet. Run it from the canvas, or wait for its
                  schedule or a paid call — the node-by-node receipt lands here.
                </div>
              ) : (
                <div className="lp-rows">
                  {runs.slice(0, HUB_RUN_LIMIT).map((r) => (
                    <Link key={r.id} href={`/runs/${r.id}`} className="lp-row fl-run-row">
                      <span className={runPillClass(r.status)}>{runPillLabel(r.status)}</span>
                      <div className="grow">
                        <div className="fl-run-name">{r.trigger}</div>
                        <div className="fl-run-meta">{when(r.startedAt)}</div>
                      </div>
                      <span className="lp-pill tabular fl-run-cost">${r.totalCostUsdc.toFixed(3)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
