/**
 * Docs / Reliability — the honest, canonical explanation of what
 * "production-grade" means for Suede Agent Studio: the Test/Live model, the
 * cost-ceiling guardrails, exactly what the health checks probe, the
 * hourly-resolution caveat, and an explicit statement that no uptime percentage
 * is published until a full 90-day window at adequate resolution exists.
 * Every claim is grounded in shipped code; no metric is invented.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { SITE_URL } from "@/lib/site";

const PAGE_TITLE = "Reliability | Docs";
const PAGE_DESCRIPTION =
  "What “production-grade” means for Suede Agent Studio: the Test/Live model, cost-ceiling guardrails, what the live status checks actually probe, and why no uptime percentage is published until a full 90-day window at adequate resolution exists.";
const PAGE_URL = `${SITE_URL}/docs/reliability`;
const LAST_UPDATED = "2026-07-22";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/reliability" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/reliability",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

const reliabilityPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "@id": `${PAGE_URL}#webpage`,
  url: PAGE_URL,
  name: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  dateModified: `${LAST_UPDATED}T00:00:00Z`,
  isPartOf: { "@id": `${SITE_URL}/#website` },
};

export default function DocsReliabilityPage(): React.JSX.Element {
  return (
    <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(reliabilityPageJsonLd) }}
        />
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · Reliability</span>
          <h1>What &ldquo;production-grade&rdquo; means here.</h1>
          <p>
            This page explains, honestly, what we mean when we call Suede Agent
            Studio production-grade: the discipline that is actually in the
            product, what the{" "}
            <Link href="/status" style={{ color: "var(--primary)" }}>live status page</Link>{" "}
            checks, and where we deliberately hold back a number until it is real.
          </p>
        </header>

        <section className="lp-doc lp-block" id="test-live" style={{ marginTop: 0 }}>
          <h2>Test and Live, like software</h2>
          <p>
            Every flow keeps a mutable draft and immutable saved versions. You
            run a flow in a separate Test environment and watch each node execute
            before anything reaches customers; only then do you promote a saved
            checkpoint to Live, the way an engineering team ships a release. A
            saved version does not change under you; promotion points Live at a
            specific, frozen version, so what you approved is exactly what runs.
          </p>
        </section>

        <section className="lp-doc lp-block" id="guardrails">
          <h2>Guardrails that stop a run before it overspends</h2>
          <p>
            Settlement defaults to dry-run: a newly launched agent moves no real
            USDC until its creator explicitly switches it live. Beyond that,
            spend is bounded on two axes: every run enforces a per-run cost
            ceiling checked before each cost-bearing node, and each agent has a
            per-agent daily cap backed by durable run history, not just an
            in-memory counter. When a node on the main path fails, the engine
            halts its branch instead of charging for the downstream work that
            would have depended on it. Every run writes a per-step USDC cost
            ledger you can audit after the fact.
          </p>
        </section>

        <section className="lp-doc lp-block" id="health-checks">
          <h2>What the health checks probe</h2>
          <p>
            The status page reads three live checks each time it is refreshed,
            and an hourly job records each result so availability can be measured
            over time:
          </p>
          <ul
            style={{
              color: "var(--text-muted)",
              maxWidth: "62ch",
              lineHeight: 1.65,
              paddingLeft: "1.25rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              marginTop: "1rem",
            }}
          >
            <li>
              <strong style={{ color: "var(--text-primary)" }}>Studio API</strong>:
              a trivial, non-mutating query against the datastore. If this fails,
              the studio cannot serve, and the overall status is a major outage.
            </li>
            <li>
              <strong style={{ color: "var(--text-primary)" }}>Model gateway</strong>:
              a reachability check against the LLM gateway. No API key is sent, so
              nothing is spent and no secret is exposed.
            </li>
            <li>
              <strong style={{ color: "var(--text-primary)" }}>x402 settlement</strong>:
              a reachability check against the configured x402 facilitator. It
              never calls the paid verify or settle paths, so probing costs
              nothing and moves no money.
            </li>
          </ul>
          <p style={{ marginTop: "1rem" }}>
            The gateway and the facilitator are treated as non-core: if one is
            unreachable the status reads degraded, not down, because the studio
            itself is still up. Probes surface only reachability and latency,
            never an upstream error string, wallet address, or credential.
          </p>
        </section>

        <section className="lp-doc lp-block" id="hourly-caveat">
          <h2>The hourly-resolution caveat</h2>
          <p>
            The recorder runs on the existing hourly cron. That resolution is
            honest but coarse: a shorter outage can fall entirely within one
            recorded hour and never register as a separate down check. We show
            the check interval next to every availability figure precisely so the
            number is never read as finer-grained than it is.
          </p>
        </section>

        <section className="lp-doc lp-block" id="uptime-percentage">
          <h2>Why there is no uptime percentage yet</h2>
          <p>
            A defensible &ldquo;99.9%&rdquo;-style claim needs two things at once:
            roughly ninety continuous days of recorded checks, and
            sub-five-minute resolution so short outages cannot hide. Today&apos;s
            hourly cron gives only the first ingredient over time, not the
            second. Until both hold, the status page publishes no headline uptime
            percentage. It shows the real short-window figure paired with its
            window and check interval, or, before a window is meaningfully
            filled, &ldquo;Measuring since&rdquo; a date with the count of checks
            recorded so far. We would rather show you the data as it accumulates
            than invent a number to fill the gap.
          </p>
        </section>

        <section className="lp-doc lp-block" id="run-volume">
          <h2>Run volume, not a graded success rate</h2>
          <p>
            The status page reports launched-agent activity as throughput
            (completed runs, median run time, and how many agents are live),
            never as a success rate. A single raw success rate mixes platform failures
            with user-caused ones: a broken draft or a bad prompt is a user
            outcome, not an outage, and folding the two together would either
            flatter or unfairly punish the platform. Counts and durations stay
            honest without that ambiguity.
          </p>
        </section>

        <section className="lp-doc lp-block" id="see-it-live">
          <h2>See it live</h2>
          <p>
            The{" "}
            <Link href="/status" style={{ color: "var(--primary)" }}>status page</Link>{" "}
            renders the current checks and every measured window. Monitors and
            agents can poll{" "}
            <Link href="/api/health" style={{ color: "var(--primary)" }}>/api/health</Link>{" "}
            (200 when up, 503 on a major outage) or{" "}
            <Link href="/status.json" style={{ color: "var(--primary)" }}>/status.json</Link>{" "}
            for the same figures as JSON.
          </p>
        </section>

        <p
          style={{
            color: "var(--text-muted)",
            fontSize: "var(--text-sm)",
            marginTop: "2rem",
          }}
        >
          Last updated <time dateTime={LAST_UPDATED}>{LAST_UPDATED}</time>.
        </p>
    </>
  );
}
