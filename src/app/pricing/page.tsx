/**
 * Pricing — pulled from the same billing constants and endpoint table the
 * docs page uses, so the two never disagree. This is the dedicated URL the
 * nav's "Pricing" link points to from every page (the homepage also keeps a
 * teaser section with the same data via #endpoints).
 *
 * Copy rules for this surface: lead with the payout promise (what lands in
 * the creator's wallet), state the real numbers exactly as billing.ts
 * computes them, and never soften the earned free tier — the monthly token
 * grant unlocks only after a workspace has paid once.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import {
  PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS,
  type SuedeEndpoint,
} from "@/lib/rails/suede-endpoints";
import { isPublicEndpointMarketingAllowed } from "@/lib/marketing-holds";
import {
  COMMIT_GATEWAY_MARGIN,
  COMMIT_TIERS,
  commitGrantUsdc,
  FREE_MONTHLY_GATEWAY_TOKENS,
  GATEWAY_MARGIN,
  gatewayPricePer1M,
  PLATFORM_TAKE_RATE,
} from "@/lib/billing";
import { TOPUP_TIERS } from "@/lib/gateway/topup-handler";
import "../chrome.css";
import "../site.css";
import "./pricing.css";

const PAGE_TITLE = "Pricing | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Launch and dry-run are free. Eligible published agents can be payment-enabled for x402 v2 caller settlement in USDC on Base.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/pricing",
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


/** One priced endpoint row — identical facts in every group. */
function EndpointRows({ endpoints }: { endpoints: SuedeEndpoint[] }): React.JSX.Element {
  return (
    <div className="lp-rows" style={{ marginTop: "0.9rem" }}>
      {endpoints.map((e) => (
        <div key={e.id} className="lp-row" style={{ cursor: "default" }}>
          <span className="lp-pill">{e.method}</span>
          <div className="grow">
            <div
              className="name mono"
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}
            >
              {e.path}
            </div>
            <div className="sub">{e.description}</div>
          </div>
          <span className="lp-pill lp-pill--price tabular">
            ${e.priceUsdc.toFixed(Math.round(e.priceUsdc * 1000) % 10 === 0 ? 2 : 3)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function PricingPage(): React.JSX.Element {
  const endpoints = PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS.filter((endpoint) =>
    isPublicEndpointMarketingAllowed(endpoint.id),
  );
  const pricePer1M = gatewayPricePer1M(GATEWAY_MARGIN);
  const commitPricePer1M = gatewayPricePer1M(COMMIT_GATEWAY_MARGIN);
  const payMarginPct = Math.round(GATEWAY_MARGIN * 100);
  const commitMarginPct = Math.round(COMMIT_GATEWAY_MARGIN * 100);
  const freeTokensLabel = (FREE_MONTHLY_GATEWAY_TOKENS / 1000).toFixed(0) + "k";
  const platformTakePct = Math.round(PLATFORM_TAKE_RATE * 100);

  return (
    <div className="lp">
      <SiteNav active="/pricing" />
      <main id="main-content" className="lp-shell lp-page">
        <div className="lp-page-rail lp-page-rail--reading">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Pricing</span>
          <h1>Pay per call when you enable it. No keys, no lock-in.</h1>
          <p>
            Launch is free and dry-run needs no wallet. Publishing or promoting
            an agent to Live does not enable payment. Once an eligible agent is
            separately payment-enabled, paid calls use x402 v2 caller settlement
            in USDC on Base at the quoted price. Nothing is metered until it
            actually runs, and nothing needs a signup.
          </p>
          {/* Capabilities strip: what this page is for and what it holds,
              readable before the first scroll. Same kicker + pills pattern
              as /templates and /docs. */}
          <div
            role="list"
            aria-label="What this page covers"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "var(--space-4)",
            }}
          >
            <span
              className="mono"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-label)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-secondary)",
              }}
            >
              The full price sheet
            </span>
            {[
              "Every per-call price",
              "Gateway token rates",
              "Your payout split",
              "Committed-use tiers",
            ].map((item) => (
              <span key={item} role="listitem" className="lp-pill">
                {item}
              </span>
            ))}
          </div>
          {/* This page had zero links or buttons in <main>: a reader who
              arrived ready to buy had no next step but the global nav. */}
          <div className="lp-page-head-actions">
            <Link href="/start" className="lp-btn lp-btn--primary">
              Start building →
            </Link>
            <Link href="/docs/payments" className="lp-btn lp-btn--ghost">
              How payments work
            </Link>
          </div>
        </header>

        {/* Where money moves, in one glance: build, run, sell. */}
        <section className="lp-block" style={{ marginTop: 0 }} aria-label="Pricing at a glance">
          <div className="pricing-glance">
            <div
              className="pricing-glance-card"
              style={{ "--c": "var(--primary)" } as React.CSSProperties}
            >
              <span className="k">Build and launch</span>
              <span className="v">$0</span>
              <p>
                The canvas, dry-run, and Launch are free. You pay nothing to
                put an agent live.
              </p>
            </div>
            <div
              className="pricing-glance-card"
              style={{ "--c": "var(--text-info)" } as React.CSSProperties}
            >
              <span className="k">Run the model</span>
              <span className="v">From ${TOPUP_TIERS[0]}</span>
              <p>
                One top-up unlocks the metered Claude gateway. No API key of
                your own, ever.
              </p>
            </div>
            <div
              className="pricing-glance-card"
              style={{ "--c": "var(--text-success)" } as React.CSSProperties}
            >
              <span className="k">When it sells</span>
              <span className="v">Your wallet</span>
              <p>
                For a payment-enabled service, callers pay the quoted price and
                each settled call routes to the payout address on the flow.
              </p>
            </div>
          </div>
        </section>

        {/* The payout promise is the center of this page. */}
        <section className="lp-block" id="split">
          <div className="pricing-payout">
            <span className="lp-eyebrow">Selling a flow</span>
            <h2>You set the price. The sale is yours.</h2>
            <p>
              When another agent or caller pays for one of your payment-enabled
              published flows,{" "}
              {platformTakePct > 0 ? (
                <>
                  <strong>{100 - platformTakePct}%</strong> of the settled
                  price routes to your wallet after Suede&apos;s{" "}
                  <strong>{platformTakePct}%</strong> take
                </>
              ) : (
                <>
                  the <strong>whole settled price</strong> routes to your
                  wallet. Suede takes nothing from the sale
                </>
              )}
              . There is no separate listing fee, and there is no payout
              schedule to wait on: settlement is the payout.
            </p>
            <div className="pricing-payout-rails">
              <span className="lp-pill">USDC on Base</span>
              <span className="lp-pill">x402 v2 caller settlement</span>
              <span className="lp-pill">Stripe builder funding</span>
            </div>
          </div>
        </section>

        <section className="lp-doc lp-block" id="gateway">
          <span className="lp-eyebrow">LLM gateway</span>
          <h2>The model comes with the studio</h2>
          <p>
            Every agent gets a Claude-backed LLM node with no API key to
            manage. Top up once, from ${TOPUP_TIERS[0]}, and your workspace
            gets {freeTokensLabel} tokens included every month from then on.
            Past that: <strong>${pricePer1M.toFixed(2)} per 1M tokens</strong>,
            drawn from builder credit. Machine top-ups use HTTP 402 in USDC on
            Base; card purchases through Stripe are builder funding, not caller
            settlement.
          </p>
          <p>
            The included tokens are earned, not given: nothing on Suede is
            free until your workspace has paid at least once. After that
            first top-up, the monthly grant renews on its own.
          </p>
        </section>

        <section className="lp-doc lp-block" id="endpoints">
          <span className="lp-eyebrow">The rails</span>
          <h2>The {endpoints.length} public Suede gateway routes</h2>
          <p>
            These are the routes on{" "}
            <span className="mono" style={{ fontFamily: "var(--font-mono)" }}>
              api.suedeai.xyz
            </span>{" "}
            in the public App catalog, each returning x402 payment terms.
            Internal operational profiles and saved-flow compatibility entries
            are not public offerings, so they stay off this price sheet.
          </p>
          <p>
            The general workflow nodes are priced elsewhere on this page: LLM
            calls meter through the gateway above, and HTTP, schedule, and
            branch nodes cost nothing on the platform side. The public
            fixed-price media routes are listed below.
          </p>
          <details className="pricing-rails-group" open>
            <summary>
              <span className="k">Public media generation</span>
              <span className="n tabular">
                {endpoints.length}{" "}
                {endpoints.length === 1 ? "route" : "routes"}
              </span>
            </summary>
            <EndpointRows endpoints={endpoints} />
          </details>
        </section>

        <section className="lp-doc lp-block" id="committed">
          <span className="lp-eyebrow">Committed-use</span>
          <h2>Buy fuel in bulk. Keep the per-call model.</h2>
          <p>
            Running a lot of gateway tokens? Commit up front and every dollar
            buys more. It&apos;s the same metered gateway, the same
            pay-as-you-go rate underneath. You&apos;re pre-buying at a committed
            margin, not signing up for anything. Launch stays free, selling
            still routes every settled call to your wallet, and this only
            changes what your own runs cost.
          </p>
          <p>
            At the committed margin, gateway tokens run{" "}
            <strong>${commitPricePer1M.toFixed(2)} per 1M</strong> instead of{" "}
            <strong>${pricePer1M.toFixed(2)}</strong>: a {commitMarginPct}%
            gateway margin in place of {payMarginPct}%. The difference lands as
            bonus credit the moment you buy.
          </p>
          <div className="pricing-tiers">
            {COMMIT_TIERS.map((tier) => (
              <div key={tier} className="pricing-tier">
                <span className="charge">${tier}</span>
                <span className="label">One card charge</span>
                <span className="credit">
                  ${commitGrantUsdc(tier).toFixed(2)} credit
                </span>
              </div>
            ))}
          </div>
          <p style={{ marginTop: "1rem" }}>
            Top up or commit from{" "}
            your <Link href="/flows">workspace</Link>.
          </p>
        </section>

        {/* Close the loop: a reader who scrolled the whole ledger is ready. */}
        <section className="lp-block">
          <div className="lp-money-block">
            <h2>Connect a wallet when you enable payments.</h2>
            <p>
              No API keys: Suede meters the model. No servers: Suede hosts the
              endpoint. Launch is free and starts without payments. For an
              eligible payment-enabled service, you set the price and settled
              caller payments route to your payout wallet.
            </p>
            <div className="lp-page-head-actions">
              <Link href="/start" className="lp-btn lp-btn--primary">
                Start building →
              </Link>
              {/* The secondary CTA has to land somewhere else: two buttons
                  pointing at /start is one choice wearing two hats. */}
              <Link href="/templates" className="lp-btn lp-btn--ghost">
                Start from a template →
              </Link>
            </div>
          </div>
        </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
