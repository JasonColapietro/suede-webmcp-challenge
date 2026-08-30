/**
 * Docs / Launching — publishing explicit public call state, with separate
 * x402 payment enablement. Request/response shapes mirror the launch route.
 */
import type { Metadata } from "next";
import Link from "next/link";
import CopyBlock from "@/components/agent/CopyBlock";
import { SITE_URL } from "@/lib/site";

const PAGE_TITLE = "Launching an endpoint | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "How a flow publishes preview, payment-enabled, or unavailable state; what launch creates; and how payment is enabled separately.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/launching" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/launching",
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

const LAUNCH_REQUEST = [
  `POST /api/flows/<flowId>/launch`,
  `{`,
  `  "priceUsdc": 0.25,                       // optional; 0 or omitted = no payment challenge`,
  `  "payoutAddress": "0xYourWallet..."       // optional; EVM address your payouts settle to`,
  `}`,
].join("\n");

const LAUNCH_RESPONSE = [
  `{`,
  `  "agent":  { ... },                        // the published agent record`,
  `  "slug":   "lead-qualifier-<suffix>",       // stable across relaunches`,
  `  "urls": {`,
  `    "run":    "/api/agents/<id>/run",       // behavior follows current public call state`,
  `    "card":   "/api/agents/<slug>/.well-known/agent-card.json",`,
  `    "x402":   "/api/agents/<slug>/.well-known/x402",`,
  `    "a2a":    "/api/agents/<slug>/a2a",`,
  `    "public": "/a/<slug>",                  // human-readable page`,
  `    "webhook": "..."                        // only if the flow has a Webhook node`,
  `  },`,
  `  "schedule": { "cron": "...", "nextRunAt": ... },   // only if a Schedule node exists`,
  `  "payout":   { ... },`,
  `  "webhook":  { "url": "...", "secret": "..." }      // secret shown ONCE, save it`,
  `}`,
].join("\n");

const DISCOVERY_CURL = [
  `# publishing adds current preview, payment-enabled, or unavailable state:`,
  `curl ${SITE_URL}/api/catalog                 # catalog with payment readiness`,
  `open ${SITE_URL}/agents                      # human directory`,
  `curl ${SITE_URL}/.well-known/x402            # all states + enabled payment terms`,
].join("\n");

export default function LaunchingPage(): React.JSX.Element {
  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · Launching</span>
          <h1>Publish a flow with explicit call state</h1>
          <p>
            Launch is one click in the studio (or one API call), it is free,
            and it is repeatable: relaunching updates the agent without
            breaking anyone&apos;s integration. This page covers what launch
            validates, what it creates, and the one secret it will only show
            you once.
          </p>
        </header>

        <section className="lp-doc lp-block" id="what-happens" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">01 · The call</span>
          <h2>One request, an agent out the other side</h2>
          <p>
            From the studio, the Launch button does this for you; from code,
            it is a single authenticated request. The price is optional; a
            flow launched with no price (or a price of 0) becomes a free
            agent whose endpoint never issues a payment challenge. A nonzero
            intended price still does not enable payment by itself.
          </p>
          <CopyBlock code={LAUNCH_REQUEST} />
          <p style={{ marginTop: "0.9rem" }}>The response contains everything an integration needs:</p>
          <CopyBlock code={LAUNCH_RESPONSE} />
        </section>

        <section className="lp-doc lp-block" id="validation">
          <span className="lp-eyebrow">02 · Validation</span>
          <h2>What launch checks before anything goes live</h2>
          <p>
            Launch validates the flow <em>before</em> any writes, so a failed
            launch never leaves a half-published agent behind. The checks,
            in order:
          </p>
          <div className="lp-doc-step">
            <span className="n">1</span>
            <div>
              <h3>Structure</h3>
              <p>
                The graph must be wired together; a disconnected or
                half-built flow is rejected with a specific structural error
                rather than silently going live.
              </p>
            </div>
          </div>
          <div className="lp-doc-step">
            <span className="n">2</span>
            <div>
              <h3>Schedule</h3>
              <p>
                If the flow has a Schedule node, its cron expression must
                parse (five fields, UTC, e.g.{" "}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
                  0 9 * * *
                </span>{" "}
                for daily at 09:00). A bad expression fails the launch, not
                the first scheduled run three days later.
              </p>
            </div>
          </div>
          <div className="lp-doc-step">
            <span className="n">3</span>
            <div>
              <h3>Payout address</h3>
              <p>
                If provided, it must be a valid EVM address. You can launch a
                priced agent without one, but its endpoint will refuse{" "}
                <em>live</em> calls with a 503 until a payout destination
                exists; the platform never settles money into nowhere.
              </p>
            </div>
          </div>
          <div className="lp-doc-step">
            <span className="n">4</span>
            <div>
              <h3>No prototype nodes</h3>
              <p>
                Graphs containing the Connector Lab&apos;s API Operation node
                are rejected with a 409; that node is simulation-only and
                cannot back a live endpoint.
              </p>
            </div>
          </div>
        </section>

        <section className="lp-doc lp-block" id="webhook-secret">
          <span className="lp-eyebrow">03 · The webhook secret</span>
          <h2>Shown once, kept forever</h2>
          <p>
            If the flow has a Webhook node, launch generates the HMAC signing
            secret server-side and returns it <strong>exactly once</strong>,
            in the launch response. It is stored hashed and cannot be
            recovered later. Save it wherever the third-party service that
            will call your webhook keeps its secrets.
          </p>
          <p>
            Relaunching an agent that already has a webhook endpoint
            deliberately does <em>not</em> rotate the secret; whatever
            external service is already signing requests keeps working. The
            signing scheme itself (HMAC-SHA256 over{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
              timestamp.body
            </span>
            , 5-minute staleness window) is documented in the{" "}
            <Link href="/docs#nodes" style={{ color: "var(--primary)" }}>
              node reference
            </Link>
            .
          </p>
        </section>

        <section className="lp-doc lp-block" id="after">
          <span className="lp-eyebrow">04 · After launch</span>
          <h2>Discovery is automatic, settlement is opt-in</h2>
          <p>
            The moment launch returns, the agent has a public page, directory
            listing, AgentCard, A2A interface, and explicit call state. An
            ordinary standalone service may expose a preview; a company or
            otherwise unready service may be unavailable. Payment-enabled
            services expose active x402 terms:
          </p>
          <CopyBlock code={DISCOVERY_CURL} />
          <p style={{ marginTop: "0.9rem" }}>
            Launch does not turn on real settlement. Ordinary standalone
            services can remain preview-ready until settlement is enabled;
            company and payment-only services may instead be unavailable.
            Launch also does not freeze the flow; relaunch after editing to
            update the live agent. The slug, and therefore every URL above,
            stays the same across relaunches; a relaunch with a new{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
              priceUsdc
            </span>{" "}
            changes the payment terms callers see on their next 402
            challenge, if the service is payment-enabled.
          </p>
          <p>
            What callers experience on the other side of this endpoint
            (the 402 flow, request/response shapes, rate limits) is
            documented in{" "}
            <Link href="/docs/api" style={{ color: "var(--primary)" }}>
              API for callers
            </Link>
            . What you earn per call is in{" "}
            <Link href="/docs/payments" style={{ color: "var(--primary)" }}>
              Payments
            </Link>
            .
          </p>
          <p>
            Launch also does not enable AP2 by itself. A payment-enabled,
            actively deployed service may be eligible for the experimental AP2
            v0.2 merchant authorization profile, but it appears in discovery only when{" "}
            <code>AP2_MODE</code> is <code>optional</code> or{" "}
            <code>required</code> and the platform&apos;s signing key, issuer
            trust, and durable replay storage are ready. The advertised
            extension URI is{" "}
            <code>https://github.com/google-agentic-commerce/ap2/v1</code>.
            x402 remains the settlement rail; the AP2 layer is a gated
            authorization and merchant-receipt profile, not a claim that
            Suede operates every AP2 role.
          </p>
        </section>
    </>
  );
}
