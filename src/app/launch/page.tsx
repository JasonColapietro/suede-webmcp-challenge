import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import { Fragment } from "react";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { buildCatalog } from "@/lib/catalog";
import "../chrome.css";
import "../site.css";
import "./launch.css";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: "Agent Launch Pad | Suede Agent Studio" },
  description:
    "Publish an agent with explicit preview, payment-enabled, or unavailable state. Payment is enabled separately after readiness checks.",
  alternates: { canonical: "/launch" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/launch",
    siteName: "Suede Agent Studio",
    title: "Agent Launch Pad | Suede Agent Studio",
    description:
      "Publish an agent with explicit preview, payment-enabled, or unavailable state. Payment remains separate until ready.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Launch Pad | Suede Agent Studio",
    description:
      "Publish an agent with explicit preview, payment-enabled, or unavailable state. Payment remains separate until ready.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
});

export const revalidate = 120;

/** Semantic keys for the "what launches" icon slot — stroke marks, not emoji,
 * matching the icon language used elsewhere (see Mark in
 * CompanyPreviewCard.tsx: viewBox 0 0 24 24, stroke currentColor, round
 * caps/joins). */
type LaunchMarkKind = "bolt" | "document" | "clock" | "chart";

function LaunchMark({ kind }: { kind: LaunchMarkKind }): React.JSX.Element {
  const common = {
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "bolt":
      return (
        <svg {...common}>
          <path d="M13 3 6 14h5l-1 7 7-11h-5l1-7z" />
        </svg>
      );
    case "document":
      return (
        <svg {...common}>
          <path d="M7 3h6l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
          <path d="M13 3v4h4" />
          <path d="M9 13h6M9 17h6" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "chart":
      return (
        <svg {...common}>
          <path d="M5 20V11M12 20V5M19 20V14" />
          <path d="M3 20h18" />
        </svg>
      );
  }
}

// First-screen capabilities strip: the concrete things a visitor can do from
// this page. Same pattern on / and /start; keep phrases 2-4 words.
const PAGE_CAPABILITIES = [
  "Build on the canvas",
  "Set a price per call",
  "Launch in one click",
  "Publish explicit call state",
  "Enable x402 when ready",
];

const STEPS: {
  no: string;
  title: string;
  body: string;
  color: string;
  sub: string;
}[] = [
  {
    no: "01",
    title: "Build on the canvas",
    body: "Drop nodes, wire them together. LLM calls, Suede rails, schedule triggers, logic branches: every agent capability is a node. No code required.",
    color: "var(--primary)",
    sub: "Visual · Node-graph",
  },
  {
    no: "02",
    title: "Set a price per call",
    body: "Name your intended rate in USDC. The studio prefills a suggestion based on node costs. A nonzero price does not enable payment; $0 keeps access free.",
    color: "var(--text-info)",
    sub: "USDC · x402 · Base",
  },
  {
    no: "03",
    title: "Launch: one click, state published",
    body: "Hit Launch. The endpoint reports preview, payment-enabled, or unavailable. Ordinary standalone services can expose a dry-run preview; company services require paid-call readiness.",
    color: "var(--text-success)",
    sub: "Published · State explicit · Instant",
  },
  {
    no: "04",
    title: "Enable payment when ready",
    body: "After deployment, payout, and platform checks pass, enable payment separately. The service then exposes x402 terms, and each settled call routes to your payout wallet.",
    color: "var(--text-warning)",
    sub: "Opt-in · x402 · Settled calls",
  },
];

const WHAT_LAUNCHES: { icon: LaunchMarkKind; title: string; body: string }[] = [
  {
    icon: "bolt",
    title: "A public HTTP route",
    body: "POST /api/agents/[slug]/run exposes the service's current state. Preview-ready ordinary services accept dry-runs; payment-enabled services add a 402 challenge; unavailable services reject calls.",
  },
  {
    icon: "document",
    title: "Payment terms when enabled",
    body: "Once payment is enabled, GET /.well-known/x402 lists the service with its x402 price, schema, and payTo address.",
  },
  {
    icon: "clock",
    title: "A schedule (if you set one)",
    body: "A cron schedule node turns your agent into an autonomous worker. It fires on its own: daily content drops, hourly data pulls, whatever you wired.",
  },
  {
    icon: "chart",
    title: "A public listing",
    body: "Your agent appears in the Agent Directory at /agents with call count, intended price, and current call state. Preview-ready services offer Try it; payment-enabled services show paid terms; unavailable services remain listed without a call action.",
  },
];

export default async function LaunchPadPage(): Promise<React.JSX.Element> {
  const catalog = await buildCatalog().catch(() => []);
  const published = catalog.slice(0, 6);

  return (
    <div className="lp">
      <SiteNav active="/launch" />

      {/* Every other page puts id="main-content" on a real <main>; this page
          had it on the hero <section>, so the skip link jumped past the hero
          and the page exposed no main landmark at all. */}
      <main id="main-content">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="lp-hero">
        <div className="lp-shell">
          <div style={{ position: "relative", zIndex: 1 }}>
            <span className="lp-eyebrow">Agent Launch Pad</span>
            <h1
              className="lp-h1"
              style={{ marginTop: "0.6rem", maxWidth: "18ch" }}
            >
              Canvas to{" "}
              <em>published service</em>{" "}
              in one session.
            </h1>
            <p className="lp-lede">
              Build an agent on the visual canvas, set a price, and hit Launch.
              Its public page and explicit call state go live instantly.
              Ordinary standalone services may expose a dry-run preview;
              company or otherwise unready services may be unavailable.{" "}
              <b>Enable x402 payment separately when it is ready.</b>
            </p>
            {/* Capabilities strip: within the first screen, say what this
                page is for and what a visitor can do here. Mirrored on /
                and /start. */}
            <div className="lp-caps">
              <span className="lp-eyebrow">What you can do here</span>
              <div className="lp-caps-pills">
                {PAGE_CAPABILITIES.map((cap) => (
                  <span key={cap} className="lp-pill">
                    {cap}
                  </span>
                ))}
              </div>
            </div>
            <div className="lp-hero-actions">
              <Link href="/start" className="lp-btn lp-btn--primary">
                Start building →
              </Link>
              <Link href="/agents" className="lp-btn lp-btn--ghost">
                Browse live agents
              </Link>
            </div>

            {/* Live indicator */}
            <div className="lp-hero-meta">
              <div className="launch-live">
                <span className="launch-live-dot" aria-hidden="true" />
                <span className="launch-live-label">
                  {catalog.length === 0
                    ? "Be the first to launch"
                    : `${catalog.length} ${catalog.length === 1 ? "agent" : "agents"} published on the pad`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="lp-shell lp-page" style={{ paddingTop: 0 }}>

        {/* ── Launch Sequence ────────────────────────────────────────────── */}
        <section className="lp-section" style={{ paddingTop: "clamp(2rem,5vw,4rem)" }}>
          <span className="lp-eyebrow">The sequence</span>
          <h2 className="lp-section-title" style={{ maxWidth: "22ch" }}>
            Four steps from idea to a published agent.
          </h2>

          <div className="lp-relay" style={{ marginTop: "2rem" }}>
            {STEPS.map((step, i) => (
              <Fragment key={step.no}>
                <div
                  className="lp-relay-step"
                  style={{ "--c": step.color } as React.CSSProperties}
                >
                  <div className="num">{step.no}</div>
                  <div className="role">{step.title}</div>
                  <p className="launch-step-body">{step.body}</p>
                  <div className="desc">{step.sub}</div>
                </div>
                {i < STEPS.length - 1 && (
                  <div className="lp-relay-arrow">→</div>
                )}
              </Fragment>
            ))}
          </div>
        </section>

        {/* ── What launching creates ─────────────────────────────────────── */}
        <section className="lp-section">
          <span className="lp-eyebrow">What launches</span>
          <h2 className="lp-section-title" style={{ maxWidth: "24ch", marginBottom: "2rem" }}>
            One click creates four things at once.
          </h2>

          <div className="launch-grid">
            {WHAT_LAUNCHES.map((item) => (
              <div key={item.title} className="lp-feature">
                <div className="mark">
                  <LaunchMark kind={item.icon} />
                </div>
                {/* The title is a heading, not an eyebrow: lp-feature-no is the
                    11px mono slot, so titles rendered smaller than their body
                    copy and no h3 existed to navigate by. The body <p> also
                    carried the .lp-feature card class, nesting a bordered card
                    (plus its ::before accent bar) inside each card. */}
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── The endpoint ──────────────────────────────────────────────── */}
        <section className="lp-section">
          <span className="lp-eyebrow">Machine-native</span>
          <h2 className="lp-section-title" style={{ maxWidth: "22ch" }}>
            Your agent, by the call.
          </h2>
          <p className="lp-section-sub" style={{ maxWidth: "52ch", marginBottom: "2rem" }}>
            Every published agent reports preview, payment-enabled, or
            unavailable. Ordinary standalone agents may accept dry-run preview
            calls. Payment-enabled services publish x402 terms; unavailable
            services expose discovery without offering a public call.
          </p>

          <div className="launch-console">
            <div className="c" style={{ marginBottom: "0.5rem" }}>
              # Discover: published endpoints and their current call state
            </div>
            <div>
              <span className="verb">GET</span>{" "}
              <span>https://agents.suedeai.ai/.well-known/x402</span>
            </div>
            <div className="c" style={{ marginTop: "1rem" }}>
              # Call an enabled agent: retry after its 402 quote
            </div>
            <div>
              <span className="verb">POST</span>{" "}
              <span>https://agents.suedeai.ai/api/agents/[slug]/run</span>
            </div>
            <div className="c" style={{ marginTop: "0.35rem" }}>
              {"  "}
              <span className="hdr">PAYMENT-SIGNATURE</span>
              {": <x402-v2-payload> "}
              <span className="c" style={{ fontSize: "0.72rem" }}>
                # USDC on Base, settled by x402
              </span>
            </div>
          </div>
        </section>

        {/* ── Live on the pad ───────────────────────────────────────────── */}
        {published.length > 0 && (
          <section className="lp-section">
            <span className="lp-eyebrow">Published on the pad</span>
            <h2 className="lp-section-title" style={{ marginBottom: "1.75rem" }}>
              Agents and their current call state.
            </h2>

            <div className="lp-dir-grid">
              {published.map((entry) => (
                <a
                  key={entry.id}
                  href={entry.urls.public}
                  className="lp-dir-card"
                >
                  <h3>{entry.name}</h3>
                  <span className="sum">{entry.summary}</span>
                  <div className="lp-dir-meta">
                    <span className="lp-pill lp-pill--price tabular">
                      {entry.acceptsPayment
                        ? `$${entry.priceUsdc.toFixed(3)} / call`
                        : entry.paymentState === "preview" && entry.priceUsdc === 0
                          ? "Free preview"
                          : `$${entry.priceUsdc.toFixed(3)} suggested`}
                    </span>
                    <span className="lp-pill lp-pill--calls tabular">
                      {entry.calls} {entry.calls === 1 ? "call" : "calls"}
                    </span>
                    <span className="lp-pill">
                      {entry.paymentState === "payment-enabled"
                        ? "x402 payment enabled"
                        : entry.paymentState === "preview"
                          ? "Preview callable"
                          : "Currently unavailable"}
                    </span>
                  </div>
                </a>
              ))}
            </div>

            <div style={{ marginTop: "1.5rem" }}>
              <Link href="/agents" className="lp-btn lp-btn--ghost lp-btn--sm">
                All agents →
              </Link>
            </div>
          </section>
        )}

        {/* ── CTA ──────────────────────────────────────────────────────── */}
        <section className="lp-section launch-cta">
          <span className="lp-eyebrow">Ready to launch</span>
          <h2 className="lp-section-title" style={{ margin: "0.4em auto 0.5em", maxWidth: "18ch" }}>
            Build once. Publish. Enable payment when ready.
          </h2>
          <p className="lp-section-sub" style={{ maxWidth: "44ch", margin: "0 auto 2rem" }}>
            The canvas is free. Launch takes one click and publishes the
            endpoint&apos;s current state. Ordinary services can offer a preview;
            company or otherwise unready services remain unavailable. Payment
            stays separate until readiness checks pass and you enable it.
          </p>
          <div className="launch-cta-actions">
            <Link href="/start" className="lp-btn lp-btn--primary">
              Start building →
            </Link>
            <Link href="/agents" className="lp-btn lp-btn--ghost">
              See what launched
            </Link>
          </div>
        </section>
      </div>
      </main>

      <SiteFooter />
    </div>
  );
}
