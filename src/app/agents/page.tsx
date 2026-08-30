/**
 * Public agent directory — the shop window for every launched agent. Each card
 * reports its current preview/payment/unavailable state. The header stats,
 * the shelf, and the blueprint backfill are all
 * derived from the same catalog, so this page can never claim inventory it
 * does not have.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import StorefrontTools from "@/components/webmcp/StorefrontTools";
import SiteFooter from "@/components/site/SiteFooter";
import DirectoryExplorer, { type DirectoryAgent } from "./DirectoryExplorer";
import {
  deriveDirectoryStats,
  formatUsdc,
  pickLaunchableTemplates,
  SPARSE_DIRECTORY_THRESHOLD,
} from "./directory-data";
import { buildCatalog } from "@/lib/catalog";
import "../chrome.css";
import "../site.css";
import "./directory.css";

export const metadata: Metadata = {
  title: { absolute: "Agent Directory | Suede Agent Studio" },
  description:
    "Agents published from the studio with current call readiness. Preview-ready listings support dry-runs; payment-enabled listings expose x402 terms.",
  alternates: { canonical: "/agents" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/agents",
    siteName: "Suede Agent Studio",
    title: "Agent Directory | Suede Agent Studio",
    description:
      "Agents published from the studio with current call readiness. Preview-ready listings support dry-runs; payment-enabled listings expose x402 terms.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Directory | Suede Agent Studio",
    description:
      "Agents published from the studio with current call readiness. Preview-ready listings support dry-runs; payment-enabled listings expose x402 terms.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

// Same staleness window the homepage already accepts for the same catalog.
export const revalidate = 120;

export default async function AgentsDirectoryPage(): Promise<React.JSX.Element> {
  const entries = await buildCatalog();
  const stats = deriveDirectoryStats(entries);
  // A sparse shelf still looks intentional: back it with launch-ready
  // blueprints, clearly labeled as templates rather than live inventory.
  const blueprints = entries.length < SPARSE_DIRECTORY_THRESHOLD
    ? pickLaunchableTemplates(entries, 6)
    : [];
  // Slim projection for the client shelf: the card fields plus the public
  // page, run endpoint, x402 terms URL, and the (already public) payout
  // wallet. Nothing else crosses to the browser.
  const shelfEntries: DirectoryAgent[] = entries.map(
    ({
      id,
      slug,
      name,
      summary,
      description,
      priceUsdc,
      calls,
      settledCalls,
      lastCallAt,
      createdAt,
      schedule,
      payTo,
      publishedLive,
      acceptsPayment,
      paymentState,
      previewAvailable,
      urls,
    }) => ({
      id,
      slug,
      name,
      summary,
      description,
      priceUsdc,
      calls,
      settledCalls,
      lastCallAt,
      createdAt,
      schedule,
      payTo,
      publishedLive,
      acceptsPayment,
      paymentState,
      previewAvailable,
      urls: { public: urls.public, run: urls.run, x402: urls.x402 },
    }),
  );

  const priceRange = stats.minPriceUsdc === null
    ? null
    : stats.minPriceUsdc === stats.maxPriceUsdc
      ? `${formatUsdc(stats.minPriceUsdc)} / call`
      : `${formatUsdc(stats.minPriceUsdc)} to ${formatUsdc(stats.maxPriceUsdc ?? stats.minPriceUsdc)} / call`;

  // Zero live listings: "Agents for hire, by the call." over an empty shelf
  // reads as a broken promise. The page stays truthful either way — with no
  // inventory it leads with the launch-ready blueprints and says so plainly.
  // Presentation only; nothing here fakes a listing.
  const shelfIsEmpty = entries.length === 0;

  const blueprintShelf = blueprints.length > 0 && (
    <section className="lp-block" aria-labelledby="agdir-shelf-heading">
      <h2 id="agdir-shelf-heading" className="lp-eyebrow">
        Launch-ready blueprints
      </h2>
      <p className="agdir-shelf-note">
        These are templates, not live agents. Open one in the studio,
        launch it, and it lists {shelfIsEmpty ? "here" : "above"} as a callable
        preview. Payment is enabled separately after readiness checks.
      </p>
      <div className="agdir-shelf-grid">
        {blueprints.map((template) => (
          <Link
            key={template.slug}
            href={`/build/new?template=${template.slug}`}
            className="agdir-tpl"
          >
            <span className="agdir-tpl-tag">Template</span>
            <h3>{template.name}</h3>
            <p>{template.blurb}</p>
            <div className="agdir-meta">
              <span className="agdir-price tabular">
                ${template.price.toFixed(2)} / {template.unit ?? "call"} suggested
              </span>
              {template.cadence && (
                <span className="agdir-chip agdir-chip--sched tabular">
                  runs {template.cadence}
                </span>
              )}
              {typeof template.nodeCount === "number" && (
                <span className="agdir-chip tabular">
                  {template.nodeCount} {template.nodeCount === 1 ? "step" : "steps"}
                </span>
              )}
            </div>
            <span className="agdir-go">Open this template →</span>
          </Link>
        ))}
      </div>
    </section>
  );

  return (
    <div className="lp">
      <StorefrontTools />
      <SiteNav active="/agents" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Directory</span>
          {shelfIsEmpty ? (
            <>
              <h1>Launch the first agent for hire.</h1>
              <p>
                This directory lists published agents with current call
                readiness. Preview-ready entries support dry-runs;
                payment-enabled entries expose x402 terms for settled calls in
                USDC on Base. Nothing is published right now, so the shelf below
                shows launch-ready blueprints.
              </p>
            </>
          ) : (
            <>
              <h1>Agents for hire, by the call.</h1>
              <p>
                Published agents with current call readiness. Built by people,
                hired by agents. Preview-ready listings support dry-runs;
                payment-enabled listings expose x402 terms for paid calls settled
                in USDC on Base.
              </p>
            </>
          )}
          <p className="agdir-explainer">
            Every listing is a flow someone wired on the canvas — nodes chained
            into a graph, each node doing one job — then published at a stable
            URL. Open a listing to read what it does and try it; other agents
            call the same endpoint directly.
          </p>
          <div className="agdir-caps" aria-label="What you can do on this page">
            <span className="lp-eyebrow agdir-caps-kicker">
              On this page
            </span>
            <span className="lp-pill">Browse live agents</span>
            <span className="lp-pill">Try preview-ready agents free</span>
            <span className="lp-pill">See payment readiness</span>
            <span className="lp-pill">Launch from a blueprint</span>
            <span className="lp-pill">Pull the catalog as JSON</span>
          </div>
          {stats.liveCount > 0 && (
            <dl className="agdir-stats" aria-label="Directory inventory, derived from the published catalog">
              <div className="agdir-stat agdir-stat--live">
                <dt>Published</dt>
                <dd>{stats.liveCount} {stats.liveCount === 1 ? "agent" : "agents"}</dd>
              </div>
              {stats.totalCalls > 0 && (
                <div className="agdir-stat">
                  <dt>Calls</dt>
                  <dd>
                    {stats.totalCalls.toLocaleString("en-US")} ·{" "}
                    {stats.totalSettled.toLocaleString("en-US")} settled
                  </dd>
                </div>
              )}
              {priceRange !== null && (
                <div className="agdir-stat">
                  <dt>Listed price</dt>
                  <dd>{priceRange}</dd>
                </div>
              )}
              {stats.freeCount > 0 && stats.minPriceUsdc !== null && (
                <div className="agdir-stat">
                  <dt>Free</dt>
                  <dd>{stats.freeCount} {stats.freeCount === 1 ? "agent" : "agents"}</dd>
                </div>
              )}
              {stats.scheduledCount > 0 && (
                <div className="agdir-stat">
                  <dt>On schedules</dt>
                  <dd>{stats.scheduledCount}</dd>
                </div>
              )}
              <div className="agdir-stat">
                <dt>Rails</dt>
                <dd>HTTP · A2A · agent card</dd>
              </div>
            </dl>
          )}
        </header>

        {/* Empty shelf: blueprints lead, the live-inventory explorer (and its
            honest "no agents are live yet" state) follows. With inventory,
            the live shelf leads as before. */}
        {shelfIsEmpty ? (
          <>
            {blueprintShelf}
            <DirectoryExplorer entries={shelfEntries} />
          </>
        ) : (
          <>
            <DirectoryExplorer entries={shelfEntries} />
            {blueprintShelf}
          </>
        )}

        <section className="lp-block">
          <h2 className="lp-eyebrow">For machines</h2>
          <div className="lp-rows">
            <a className="lp-row" href="/.well-known/x402">
              <div className="grow">
                <div className="name">x402 index</div>
                <div className="sub">GET /.well-known/x402 lists published endpoints; enabled entries include current payment terms</div>
              </div>
              <span className="lp-pill">JSON</span>
            </a>
            <a className="lp-row" href="/api/catalog">
              <div className="grow">
                <div className="name">Catalog feed</div>
                <div className="sub">GET /api/catalog returns names, intended prices, payment readiness, call counts, and URLs</div>
              </div>
              <span className="lp-pill">JSON</span>
            </a>
            <a className="lp-row" href="/openapi.json">
              <div className="grow">
                <div className="name">OpenAPI</div>
                <div className="sub">GET /openapi.json documents the run, x402, agent-card, and A2A routes</div>
              </div>
              <span className="lp-pill">JSON</span>
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
