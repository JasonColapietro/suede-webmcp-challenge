/**
 * Docs / Payments — the money model, stated plainly. Every number on this
 * page is imported from src/lib/billing.ts so it cannot drift from what the
 * platform actually charges.
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import {
  COMMIT_GATEWAY_MARGIN,
  FREE_MONTHLY_GATEWAY_TOKENS,
  GATEWAY_MARGIN,
  gatewayPricePer1M,
} from "@/lib/billing";

const PAGE_TITLE = "Pricing & payments | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "The full money model: what building costs, what callers pay, how payouts reach your wallet, gateway token pricing, spend ceilings, and the honest caveats. No revenue promises.";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/payments" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/payments",
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
});

export default function PaymentsDocsPage(): React.JSX.Element {
  const pricePer1M = gatewayPricePer1M(GATEWAY_MARGIN);
  const commitPricePer1M = gatewayPricePer1M(COMMIT_GATEWAY_MARGIN);
  const freeTokensLabel = (FREE_MONTHLY_GATEWAY_TOKENS / 1000).toFixed(0) + "k";

  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · Payments</span>
          <h1>How the money works</h1>
          <p>
            There are exactly three places money exists in this product: what
            it costs you to run a flow, what a caller pays to run your agent,
            and what routes to your payout address in between. This page states all
            three plainly, including the caveats.
          </p>
        </header>

        <section className="lp-doc lp-block" id="free" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">What costs nothing</span>
          <h2>Building, launching, and dry-running are free</h2>
          <p>
            There is no subscription and no listing fee. Creating flows,
            editing them, launching agents, and every dry run (yours in the
            studio, or a caller&apos;s against your published endpoint) cost
            nothing and require no wallet. Dry-run is also the{" "}
            <strong>default</strong>: no USDC moves anywhere in the system
            until settlement is explicitly switched on for an agent.
          </p>
        </section>

        <section className="lp-doc lp-block" id="your-costs">
          <span className="lp-eyebrow">Your costs as a builder</span>
          <h2>Two meters: gateway tokens and priced nodes</h2>
          <p>
            <strong>The LLM gateway.</strong> The LLM node uses a
            Claude-backed gateway; you never bring an API key. Top up once and
            your workspace gets {freeTokensLabel} tokens included every month
            from then on; the allowance is earned by having paid, not by
            signing up. Beyond it, tokens cost{" "}
            <strong>${pricePer1M.toFixed(2)} per million</strong>, drawn from
            the same credit. Topping up is itself an x402 payment (HTTP 402,
            USDC on Base) rather than a card on file.
          </p>
          <p>
            <strong>Committed-use credit.</strong> If you run a lot of tokens,
            you can commit up front and pre-buy gateway fuel in bulk with one
            card charge. Commit tiers price pre-bought tokens lower:{" "}
            <strong>${commitPricePer1M.toFixed(2)} per million</strong> instead
            of ${pricePer1M.toFixed(2)}. It is the same metered gateway
            underneath with nothing recurring; the discount lands as bonus
            credit at purchase and only changes what your own runs cost, never
            what selling a flow earns you.
          </p>
          <p>
            <strong>Priced endpoint nodes.</strong> Specialized Suede nodes
            (document extraction, song generation, IP registration, and the
            rest) each carry a fixed per-call USDC price, shown on the node
            card in the palette and listed in full on{" "}
            <Link href="/pricing" style={{ color: "var(--primary)" }}>
              Pricing
            </Link>
            . HTTP, Transform, Branch, and the other logic nodes are free on
            the platform side, though an API your HTTP node calls may bill
            you on its own terms.
          </p>
          <p>
            <strong>Spend guards.</strong> Every run shares one in-run cost
            ceiling, checked before each cost-bearing node: the minimum of a
            per-run cap ($5 unless the operator configures otherwise) and the
            agent&apos;s remaining daily budget. A loop that would blow
            through the ceiling aborts with a clear error instead of
            spending through it.
          </p>
        </section>

        <section className="lp-doc lp-block" id="caller-pays">
          <span className="lp-eyebrow">What callers pay</span>
          <h2>Your price, settled per call in USDC on Base</h2>
          <p>
            You set a per-call price at launch (or zero, for a free agent).
            A caller hitting a payment-enabled agent without payment gets an
            HTTP 402 response carrying the exact terms (price, asset,
            network, payout address), signs a USDC authorization, and
            retries. The platform verifies and settles the payment on-chain{" "}
            <em>before</em> the flow executes; if verification fails, the
            caller gets another 402 with the reason and nothing runs. The
            full request-level detail is in{" "}
            <Link href="/docs/api" style={{ color: "var(--primary)" }}>
              API for callers
            </Link>
            .
          </p>
          <p>
            Free agents (price zero) and dry-run responses never settle, and
            the response&apos;s{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
              settled
            </span>{" "}
            field never claims otherwise; a response only says{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
              settled: true
            </span>{" "}
            when a real x402 payment verified and settled.
          </p>
          <p>
            Where the other protocols fit today: x402 is the caller-settlement
            rail; every payment-enabled direct or A2A public call verifies and
            settles through it. Stripe
            powers card top-ups for your own gateway credit (a builder cost,
            not caller settlement), and each published agent exposes a native
            A2A 1.0 HTTP+JSON interface so other agents can find and call it.
            Its AgentCard advertises the A2A interface while the typed Suede
            extension describes x402 pricing and the direct run endpoint.
          </p>
        </section>

        <section className="lp-doc lp-block" id="ap2">
          <span className="lp-eyebrow">Experimental authorization</span>
          <h2>AP2 v0.2 merchant checks before x402 settlement</h2>
          <p>
            Every eligible published service can expose experimental AP2 v0.2
            merchant authorization through its A2A AgentCard, but only when
            Live x402 settlement is enabled, its price is exactly representable
            in USD cents, fulfillment runs locally or through the idempotent
            relay-v2 execute/status contract, and every runtime readiness dependency
            is healthy. Legacy relay-v1 services keep their baseline x402
            surface but do not advertise or accept AP2. The exact
            extension URI is{" "}
            <code>https://github.com/google-agentic-commerce/ap2/v1</code>.
            Its profile is deliberately narrow: Agent Studio verifies the
            supported Checkout and Payment Mandates, binds them to the quoted
            service request, rejects replay, and signs the merchant Checkout
            Receipt. It does not issue an AP2 Payment Receipt.
          </p>
          <p>
            <code>AP2_MODE=off</code> is the default and does not advertise or
            accept AP2. <code>optional</code> advertises only after the merchant
            signing key, issuer, trusted issuer registry, and durable replay
            store pass readiness; callers without AP2 can still use the
            baseline x402 flow. <code>required</code> applies the same readiness
            gate and requires AP2 before a priced Live call can settle or run.
            In either enabled mode, invalid presented AP2 authorization fails
            closed and never falls back to the baseline path.
          </p>
          <p>
            When advertised, start at <code>/.well-known/ap2.json</code>, read
            the service terms at{" "}
            <code>/api/agents/&lt;slug&gt;/.well-known/ap2</code>, then POST the
            exact service input to{" "}
            <code>/api/agents/&lt;slug&gt;/ap2/checkout</code>. The returned signed
            checkout quote binds that input, the immutable Live deployment,
            price, payout address, expiry, and x402 rail before a caller
            presents its mandates to the run or A2A endpoint.
          </p>
          <p>
            This is an experimental merchant profile, not a claim that Suede
            implements every AP2 role or every AP2+x402 configuration. x402
            remains the settlement rail and the source of settlement truth;
            AP2 adds authorization, request binding, replay protection, and a
            merchant receipt before that existing settlement step.
            Autonomous authorization is limited to one ES256 P-256 delegation
            hop, requires iat/exp/aud/nonce claims, does not accept stateful open
            payment constraints, and binds the selected payment instrument to
            the x402 payer&apos;s CAIP-10 identifier.
          </p>
        </section>

        <section className="lp-doc lp-block" id="split">
          <span className="lp-eyebrow">The payout</span>
          <h2>Settled calls route straight to your wallet</h2>
          <p>
            On every settled call, the settled price routes to the payout
            address you set. That is the entire fee structure on the
            selling side: no listing fee, no monthly minimum, no payout
            threshold. A priced agent with <em>no</em> payout address
            configured refuses live calls with a 503 rather than settling
            into a void; set the address at launch or before enabling
            settlement.
          </p>
        </section>

        <section className="lp-doc lp-block" id="caveats">
          <span className="lp-eyebrow">The caveats, in plain language</span>
          <h2>What we will not promise</h2>
          <p>
            <strong>No revenue promises.</strong> Publishing a service makes
            it discoverable and reports its current call state; it does not
            make it called.
            Most agents earn nothing until their creator finds them callers.{" "}
            <Link href="/articles/monetizing-agent-endpoints" style={{ color: "var(--primary)" }}>
              Monetizing an agent endpoint
            </Link>{" "}
            covers the economics honestly.
          </p>
          <p>
            <strong>Settlement is final.</strong> x402 has no chargeback
            mechanism. Sellers are protected from payment reversal; buyers
            should use dry-run before paying when the service advertises a
            preview, because the
            protocol will not refund a disappointing output.
          </p>
          <p>
            <strong>Stablecoin plumbing is real plumbing.</strong> Receiving
            money means controlling an EVM wallet address and holding USDC on
            Base. Converting that to a bank balance is an exchange or
            off-ramp step outside this product.
          </p>
          <p>
            <strong>Prices can change between calls.</strong> A relaunch can
            change an agent&apos;s per-call price. Well-behaved callers read
            the current terms from each 402 challenge (or the agent&apos;s{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
              .well-known/x402
            </span>{" "}
            document) rather than hardcoding a price.
          </p>
        </section>
    </>
  );
}
