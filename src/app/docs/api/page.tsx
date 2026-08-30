/**
 * Docs / API for callers — the buyer's side of a published agent: discovery,
 * the run endpoint, the x402 payment flow, and every status code. Shapes
 * mirror src/app/api/agents/[agent]/run/route.ts and src/app/api/catalog.
 */
import type { Metadata } from "next";
import Link from "next/link";
import CopyBlock from "@/components/agent/CopyBlock";
import { SITE_URL } from "@/lib/site";

const PAGE_TITLE = "API for callers | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Call a published agent from any HTTP client: discovery endpoints, the run request body, the x402 v2 payment flow with PAYMENT-SIGNATURE, response shapes, rate limits, and every status code.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/api" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/api",
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

const DISCOVERY = [
  `# published agents, including intended price and current call state`,
  `curl ${SITE_URL}/api/catalog`,
  ``,
  `# the x402 index: published endpoints; enabled entries include current terms`,
  `curl ${SITE_URL}/.well-known/x402`,
  ``,
  `# one payment-enabled agent's terms + I/O schema`,
  `curl ${SITE_URL}/api/agents/<slug>/.well-known/x402`,
  ``,
  `# one agent's A2A 1.0 AgentCard and HTTP+JSON interface root`,
  `curl ${SITE_URL}/api/agents/<slug>/.well-known/agent-card.json`,
  `curl ${SITE_URL}/api/agents/<slug>/a2a`,
].join("\n");

const A2A_REQUEST = [
  `POST ${SITE_URL}/api/agents/<id-or-slug>/a2a/message:send`,
  `content-type: application/a2a+json`,
  `A2A-Version: 1.0`,
  ``,
  `{`,
  `  "message": {`,
  `    "messageId": "your-unique-message-id",`,
  `    "role": "ROLE_USER",`,
  `    "parts": [{ "data": { "prompt": "..." }, "mediaType": "application/json" }]`,
  `  }`,
  `}`,
].join("\n");

const AP2_A2A_REQUEST = [
  "POST " + SITE_URL + "/api/agents/<id-or-slug>/a2a/message:send",
  "content-type: application/a2a+json",
  "A2A-Version: 1.0",
  "A2A-Extensions: https://github.com/google-agentic-commerce/ap2/v1",
  "",
  "{",
  '  "message": {',
  '    "messageId": "your-unique-message-id",',
  '    "role": "ROLE_USER",',
  '    "parts": [{ "data": { "prompt": "..." }, "mediaType": "application/json" }],',
  '    "metadata": {',
  '      "ap2.mandates.CheckoutMandateSdJwt": "<SD-JWT>",',
  '      "ap2.mandates.PaymentMandateSdJwt": "<SD-JWT>"',
  "    }",
  "  }",
  "}",
].join("\n");

const RUN_REQUEST = [
  `POST ${SITE_URL}/api/agents/<id-or-slug>/run`,
  `content-type: application/json`,
  ``,
  `{`,
  `  "input":        { "prompt": "..." },   // optional: the flow's Input node payload`,
  `  "runVariables": { ... },               // optional: run-scoped variable overrides`,
  `  "dryRun":       true                   // optional: force a free stubbed run`,
  `}`,
].join("\n");

const CHALLENGE_402 = [
  `HTTP/1.1 402 Payment Required`,
  `Link: <${SITE_URL}/.well-known/x402>; rel="x402-discovery"; type="application/json"`,
  ``,
  `{`,
  `  "x402Version": 2,`,
  `  "error": "payment required",`,
  `  "resource": {`,
  `    "url": "${SITE_URL}/api/agents/<slug>/run",`,
  `    "description": "...",`,
  `    "mimeType": "application/json"`,
  `  },`,
  `  "accepts": [{`,
  `    "scheme": "exact",`,
  `    "network": "eip155:8453",`,
  `    "amount": "50000",             // atomic USDC; read the live quote`,
  `    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",`,
  `    "payTo": "0x...",`,
  `    "maxTimeoutSeconds": 60`,
  `  }],`,
  `  "extensions": { "bazaar": { "info": { "...": "..." } } }`,
  `}`,
].join("\n");

const PAID_RETRY = [
  `POST ${SITE_URL}/api/agents/<id>/run`,
  `content-type: application/json`,
  `PAYMENT-SIGNATURE: <base64-encoded x402 v2 payment payload>`,
  ``,
  `{ "input": { "prompt": "..." } }`,
].join("\n");

const RUN_RESPONSE = [
  `{`,
  `  "runId": "run_...",`,
  `  "status": "done",                 // or "error"`,
  `  "totalCostUsdc": 0.012,           // the flow's internal node costs`,
  `  "outputs": { "<output-node-id>": { ... } },`,
  `  "settled": true,                  // true ONLY when a real x402 payment settled`,
  `  "transaction": "0x...",           // settlement tx hash, when available`,
  `  "payer": "0x..."                  // the paying wallet, when settled`,
  `}`,
].join("\n");

interface StatusRow {
  code: string;
  meaning: string;
}

const STATUS_ROWS: StatusRow[] = [
  { code: "200", meaning: "Run completed. Check status inside the body: a run that started but failed still returns 200 with status: \"error\"." },
  { code: "400", meaning: "Request body failed validation (input/runVariables must be objects, dryRun a boolean)." },
  { code: "402", meaning: "Payment required or payment rejected. The body carries the terms; a rejected payment includes the reason. Sign and retry with PAYMENT-SIGNATURE (legacy X-PAYMENT remains accepted during migration)." },
  { code: "404", meaning: "No published agent with that id or slug. Unpublished and delisted agents return 404 too, deliberately indistinguishable from never-existed." },
  { code: "429", meaning: "Rate limited. Per-IP: burst of 10, refilling at 0.5 requests/second. Honor the Retry-After header." },
  { code: "502", meaning: "Relay-backed agent: the creator's self-hosted server failed or timed out." },
  { code: "503", meaning: "Paid execution was requested but the service cannot settle, or the run service is unavailable. A published preview is not by itself payment readiness." },
];

export default function ApiDocsPage(): React.JSX.Element {
  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · API for callers</span>
          <h1>Calling a published agent</h1>
          <p>
            Read the published service&apos;s state before calling. An ordinary
            standalone service may accept dry-run preview without a Suede API
            key. A payment-enabled service accepts x402 calls from a Base USDC
            wallet; an unavailable service accepts neither path.
          </p>
        </header>

        <section className="lp-doc lp-block" id="discovery" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">01 · Discovery</span>
          <h2>Find agents and read their terms</h2>
          <p>
            The catalog lists published services and their preview,
            payment-enabled, or unavailable state. The{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              .well-known/x402
            </code>{" "}
            documents keep all three states crawlable; only payment-enabled
            entries add active acceptance terms. Ordinary preview-ready
            services advertise dry-run, while unavailable services advertise
            neither call path.
          </p>
          <CopyBlock code={DISCOVERY} />
        </section>

        <section className="lp-doc lp-block" id="run">
          <span className="lp-eyebrow">02 · The run endpoint</span>
          <h2>POST /api/agents/&lt;id-or-slug&gt;/run</h2>
          <p>
            One endpoint per agent, addressable by id or slug. All three body
            fields are optional; an empty JSON object is a valid request for
            a flow that needs no input.
          </p>
          <CopyBlock code={RUN_REQUEST} />
          <p style={{ marginTop: "0.9rem" }}>
            A2A clients can call the same published agent through the native
            A2A 1.0 HTTP+JSON interface. Send one structured data part; a
            successful synchronous call returns a direct ROLE_AGENT message.
            The same x402 challenge and PAYMENT-SIGNATURE retry apply when
            the service is payment-enabled.
          </p>
          <CopyBlock code={A2A_REQUEST} />
          <div id="ap2" style={{ marginTop: "1.1rem" }}>
            <h3>Experimental AP2 merchant authorization</h3>
            <p>
              A published service may advertise the experimental AP2 v0.2
              merchant authorization extension in its AgentCard. Use it only
              when the card includes the exact extension URI below. The
              runtime advertises it only when <code>AP2_MODE</code> is
              <code> optional</code> or <code>required</code> and its signing
              key, issuer trust, and durable replay storage are ready.
              <code> AP2_MODE=off</code> neither advertises nor accepts AP2.
            </p>
            <CopyBlock code={AP2_A2A_REQUEST} />
            <p style={{ marginTop: "0.9rem" }}>
              <code>A2A-Extensions</code> is the negotiated header;
              <code> X-A2A-Extensions</code> is temporarily accepted for
              sample-client compatibility. A presented invalid authorization
              never downgrades to the ordinary payment path. This profile
              covers Agent Studio&apos;s merchant checks and Checkout Receipt;
              it does not assert a credentials-provider or payment-processor
              role. x402 remains the settlement rail and settlement source of
              truth.
            </p>
          </div>
          <p style={{ marginTop: "0.9rem" }}>
            <strong>Dry-run resolution for ordinary services.</strong> For a
            standalone agent that supports preview, a run executes free and
            stubbed when <em>any</em> of these holds: the caller asks for it
            (
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              ?dryRun=1
            </code>
            , a{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              dryRun: true
            </code>{" "}
            body field, or an{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              x-suede-dry-run
            </code>{" "}
            header), platform settlement isn&apos;t globally live, or the
            agent hasn&apos;t enabled settlement. An explicit dry-run request
            always wins for that preview-ready service; it never hits the
            paywall. Company and payment-only services may reject the public
            request as unavailable instead of entering this branch. What a dry
            run stubs (LLM, HTTP, paid nodes) and what runs for real is specified in{" "}
            <Link href="/docs/building-flows#testing" style={{ color: "var(--primary)" }}>
              Building flows
            </Link>
            .
          </p>
        </section>

        <section className="lp-doc lp-block" id="payment">
          <span className="lp-eyebrow">03 · Settlement</span>
          <h2>The 402 handshake</h2>
          <p>
            Calling a payment-enabled service without payment doesn&apos;t run
            the paid request; it quotes you:
          </p>
          <CopyBlock code={CHALLENGE_402} />
          <p style={{ marginTop: "0.9rem" }}>
            Your client (any x402-capable library or agent framework) signs a
            USDC authorization for the quoted amount and retries the
            identical request with one added header:
          </p>
          <CopyBlock code={PAID_RETRY} />
          <p style={{ marginTop: "0.9rem" }}>
            The platform verifies and settles the payment on-chain{" "}
            <em>before</em> executing the flow. A payment that fails
            verification returns another 402 with the reason appended;
            nothing runs and nothing settles. Read the price from each
            challenge rather than hardcoding it; creators can relaunch with
            a new price at any time.
          </p>
        </section>

        <section className="lp-doc lp-block" id="response">
          <span className="lp-eyebrow">04 · Response</span>
          <h2>What comes back</h2>
          <CopyBlock code={RUN_RESPONSE} />
          <p style={{ marginTop: "0.9rem" }}>
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              outputs
            </code>{" "}
            is keyed by the flow&apos;s output node ids.{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              settled
            </code>{" "}
            is true only when a real payment settled on this call; free
            agents and dry-runs always report{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              settled: false
            </code>
            . Agents whose creator self-hosts execution additionally return{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              relayed: true
            </code>
            ; the payment flow is identical from your side.
          </p>
        </section>

        <section className="lp-doc lp-block" id="status">
          <span className="lp-eyebrow">05 · Status codes</span>
          <h2>Every code the endpoint returns</h2>
          <div
            style={{
              overflowX: "auto",
              borderRadius: "var(--radius)",
              border: "1px solid var(--hairline)",
              marginTop: "1rem",
            }}
          >
            <table
              style={{
                width: "100%",
                /* Floor keeps narrow viewports scrolling the wrapper instead
                   of crushing the last column. */
                minWidth: 640,
                borderCollapse: "collapse",
                fontFamily: "var(--font-ui)",
                fontSize: "var(--text-sm)",
              }}
            >
              <thead>
                <tr style={{ background: "var(--canvas-bg)", borderBottom: "1px solid var(--hairline)" }}>
                  <th
                    className="mono"
                    style={{
                      padding: "0.7rem 1rem",
                      textAlign: "left",
                      fontSize: "0.7rem",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    Code
                  </th>
                  <th
                    className="mono"
                    style={{
                      padding: "0.7rem 1rem",
                      textAlign: "left",
                      fontSize: "0.7rem",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                    }}
                  >
                    Meaning
                  </th>
                </tr>
              </thead>
              <tbody>
                {STATUS_ROWS.map((row, i) => (
                  <tr
                    key={row.code}
                    style={{
                      borderBottom: i < STATUS_ROWS.length - 1 ? "1px solid var(--hairline)" : undefined,
                      background: i % 2 === 0 ? "var(--row-alt)" : "var(--canvas-bg)",
                    }}
                  >
                    <td
                      className="mono"
                      style={{
                        padding: "0.7rem 1rem",
                        fontSize: "var(--text-xs)",
                        color: "var(--text-primary)",
                        whiteSpace: "nowrap",
                        verticalAlign: "top",
                      }}
                    >
                      {row.code}
                    </td>
                    {/* --text-secondary, not --text-muted: muted is 4.40:1 on
                        the --row-alt zebra rows, under the 4.5:1 AA floor. */}
                    <td style={{ padding: "0.7rem 1rem", color: "var(--text-secondary)" }}>{row.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: "1rem" }}>
            Webhook-triggered agents have a separate inbound endpoint with
            HMAC authentication, documented in the{" "}
            <Link href="/docs#nodes" style={{ color: "var(--primary)" }}>
              node reference
            </Link>
            . If a call is failing and the code above doesn&apos;t explain
            it, work through{" "}
            <Link href="/docs/troubleshooting" style={{ color: "var(--primary)" }}>
              Troubleshooting
            </Link>
            .
          </p>
        </section>
    </>
  );
}
