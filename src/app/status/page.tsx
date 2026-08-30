/**
 * Public status page. Renders only real, computed values paired with the window
 * they were measured over — there is no hardcoded uptime constant anywhere.
 * Availability is shown as a percentage only once a window has accumulated
 * enough hourly checks to be defensible; until then it reads "Measuring since
 * <date>". Live probes and run volume stay honest even before the health_checks
 * migration is applied to production (dark-deploy safe — see src/lib/health.ts).
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { getRepo, type HealthUptimeStats, type RunOutcomeStats } from "@/lib/db/repo";
import {
  availabilityPct,
  runHealthProbes,
  UPTIME_WINDOWS,
  type DependencyProbe,
  type HealthReport,
  type UptimeWindowKey,
} from "@/lib/health";
import { SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./status.css";

// Live probes + recorded windows; regenerate at most once a minute.
export const revalidate = 60;

const PAGE_TITLE = "Status";
const PAGE_DESCRIPTION =
  "Live status for Suede Agent Studio: real checks of the Studio API, the model gateway, and x402 settlement, plus availability measured from recorded data, never a marketing number.";
const PAGE_URL = `${SITE_URL}/status`;

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: `${PAGE_TITLE} | Suede Agent Studio` },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/status" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/status",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
});

const GREEN = "var(--text-success)";
const AMBER = "var(--warning-amber)";
const RED = "var(--rights-red)";

const BANNER: Record<HealthReport["status"], { color: string; text: string }> = {
  ok: { color: GREEN, text: "All systems operational." },
  degraded: { color: AMBER, text: "Partial degradation." },
  down: { color: RED, text: "Major outage." },
};

const PRODUCTION_FACTS = [
  "Served from Vercel's global edge network.",
  "Every flow runs in a separate Test environment before a saved checkpoint is promoted to Live.",
  "Saved versions are immutable; promotion is release-style.",
  "Settlement is dry-run by default.",
  "Every run enforces a per-run USDC cost ceiling and a per-agent daily cap.",
  "A failing node halts its branch instead of charging for downstream work.",
  "Every run writes a per-step USDC cost ledger you can audit.",
] as const;

const emptyUptime: HealthUptimeStats = {
  total: 0,
  ok: 0,
  degraded: 0,
  down: 0,
  firstAt: null,
  lastAt: null,
  avgDbLatencyMs: null,
  avgGatewayLatencyMs: null,
  avgFacilitatorLatencyMs: null,
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function Dot({ color, size = 11 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
        flexShrink: 0,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
      }}
    />
  );
}

interface DependencyRow {
  label: string;
  probe: DependencyProbe;
  core: boolean;
}

export default async function StatusPage(): Promise<React.JSX.Element> {
  const now = Date.now();

  // Probe fetches cache to this page's 60s window (see ProbeOptions), keeping
  // the route ISR instead of forcing per-request dynamic rendering.
  const report = await runHealthProbes({ revalidateSeconds: 60 });

  const repo = await getRepo();
  const windowKeys = Object.keys(UPTIME_WINDOWS) as UptimeWindowKey[];
  const uptimeByWindow = new Map<UptimeWindowKey, HealthUptimeStats>();
  await Promise.all(
    windowKeys.map(async (key) => {
      // getHealthUptime is dark-deploy safe (returns zeros on a missing table).
      const stats = await repo.getHealthUptime(now - UPTIME_WINDOWS[key].ms).catch(() => emptyUptime);
      uptimeByWindow.set(key, stats);
    }),
  );

  let runStats: RunOutcomeStats | null = null;
  try {
    runStats = await repo.getRunOutcomeStats(now - UPTIME_WINDOWS["30d"].ms);
  } catch {
    // A transient run-history read failure must not 500 the public status page.
    runStats = null;
  }

  const banner = BANNER[report.status];
  const dependencyRows: DependencyRow[] = [
    { label: "Studio API", probe: report.db, core: true },
    { label: "LLM gateway", probe: report.gateway, core: false },
    { label: "x402 settlement", probe: report.facilitator, core: false },
  ];

  return (
    <div className="lp">
      <SiteNav active="/status" />

      <div id="main-content" className="lp-shell lp-page">
        <div className="lp-page-head">
          <span className="lp-eyebrow">Status</span>
          <h1>Is Suede Agent Studio up right now?</h1>
          <p>
            This page reads live checks of the Studio API, the model gateway,
            and x402 settlement, and shows availability measured from real
            data, not a marketing number. Every figure below is paired with
            the window it was measured over.
          </p>
        </div>

        {/* Current-status banner */}
        <section aria-label="Current status" className="st-card st-banner">
          <div className="st-banner-row">
            <Dot color={banner.color} size={14} />
            <strong>{banner.text}</strong>
            <span className="st-checked">
              Checked {formatDate(report.checkedAt) ?? "just now"}
            </span>
          </div>

          <div className="st-deps">
            {dependencyRows.map((row) => {
              const color = row.probe.ok ? GREEN : row.core ? RED : AMBER;
              const label = row.probe.ok ? "Operational" : row.core ? "Unavailable" : "Degraded";
              return (
                <div key={row.label} className="st-dep">
                  <Dot color={color} />
                  <span className="label">{row.label}</span>
                  <span className="state" style={{ color }}>{label}</span>
                  <span className="latency">{row.probe.latencyMs} ms</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Availability tiles */}
        <section aria-label="Availability" className="st-section">
          <span className="lp-eyebrow">Availability</span>
          <div className="st-grid">
            {windowKeys.map((key) => {
              const window = UPTIME_WINDOWS[key];
              const stats = uptimeByWindow.get(key) ?? emptyUptime;
              const pct = availabilityPct(stats.total, stats.down, window.minSamples);
              const since = formatDate(stats.firstAt);
              return (
                <div key={key} className="st-card">
                  <div className="st-eyebrow-label">{window.label}</div>
                  {pct !== null ? (
                    <>
                      <div className="st-big">{pct}% availability</div>
                      <div className="st-sub">
                        {stats.total} checks · hourly{since ? ` · since ${since}` : ""}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="st-measuring">
                        {since ? `Measuring since ${since}` : "Measuring: no checks recorded yet"}
                      </div>
                      <div className="st-sub">
                        {stats.total} checks so far; a published uptime figure
                        needs a full {window.label}.
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <p className="st-caption">
            Availability counts every check that was not a major outage. Checks
            run hourly, so a shorter outage can hide inside one recorded hour,
            and no percentage is published until a window is meaningfully
            filled.
          </p>
        </section>

        {/* Production discipline */}
        <section aria-label="Production discipline" className="st-section">
          <span className="lp-eyebrow">Production discipline</span>
          <h2 className="lp-section-title" style={{ maxWidth: "30ch" }}>
            What &ldquo;production-grade&rdquo; actually means here.
          </h2>
          <ul className="st-facts">
            {PRODUCTION_FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          <p className="st-note">
            More on what these checks probe and why we publish no uptime number
            yet: <Link href="/docs/reliability">the reliability explainer</Link>.
          </p>
        </section>

        {/* Live activity */}
        <section aria-label="Live activity" className="st-section">
          <span className="lp-eyebrow">Live activity · last 30 days</span>
          {runStats && runStats.total > 0 ? (
            <div className="st-grid st-grid--narrow">
              <div className="st-card">
                <div className="st-big">{runStats.done}</div>
                <div className="st-eyebrow-label">runs completed</div>
              </div>
              <div className="st-card">
                <div className="st-big">
                  {runStats.medianDurationMs === null ? "n/a" : formatDuration(runStats.medianDurationMs)}
                </div>
                <div className="st-eyebrow-label">median run time</div>
              </div>
              <div className="st-card">
                <div className="st-big">{runStats.agentsLive}</div>
                <div className="st-eyebrow-label">agents live</div>
              </div>
            </div>
          ) : (
            <p className="st-machine">
              {runStats === null
                ? "Run activity is momentarily unavailable."
                : "No launched-agent runs recorded in the last 30 days yet."}
            </p>
          )}
          <p className="st-caption">
            Shown as throughput, not a graded success rate: a run can fail on a
            bad prompt or a broken draft, which is a user outcome, not a
            platform outage.
          </p>
        </section>

        {/* Machine-readable */}
        <section aria-label="Machine-readable" className="st-section">
          <span className="lp-eyebrow">Machine-readable</span>
          <p className="st-machine">
            Monitors and agents can poll{" "}
            <Link href="/api/health"><code>/api/health</code></Link>{" "}
            (200 when up, 503 on a major outage) or{" "}
            <Link href="/status.json"><code>/status.json</code></Link>{" "}
            for the same figures shown above.
          </p>
        </section>
      </div>

      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": `${PAGE_URL}#webpage`,
            url: PAGE_URL,
            name: `${PAGE_TITLE} | Suede Agent Studio`,
            description: PAGE_DESCRIPTION,
            isPartOf: { "@id": `${SITE_URL}/#website` },
          }),
        }}
      />
    </div>
  );
}
