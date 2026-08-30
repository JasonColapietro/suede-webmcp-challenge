/**
 * Docs — three quickstarts (creator, agent, developer), SDK/Code setting
 * reference, and the full endpoint price list. One page, zero setup:
 * preview-ready ordinary services need no wallet and no keys for dry-run.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { BUILD_SETTINGS_LEDE } from "@/lib/build-settings";
import CopyBlock from "@/components/agent/CopyBlock";
import { PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS } from "@/lib/rails/suede-endpoints";
import { isPublicEndpointMarketingAllowed } from "@/lib/marketing-holds";
import { SITE_URL } from "@/lib/site";
import { DEFAULT_EXPR_LIMITS } from "@/lib/flow/expr";
import { BUILTINS } from "@/lib/flow/expr/builtins";
import {
  FREE_MONTHLY_GATEWAY_TOKENS,
  GATEWAY_MARGIN,
  gatewayPricePer1M,
} from "@/lib/billing";
import { DOCS_SECTIONS } from "./docs-nav";

export const metadata: Metadata = {
  title: { absolute: "Docs | Suede Agent Studio" },
  description:
    "Build on the canvas, write TypeScript, or call a published service according to its preview, payment-enabled, or unavailable state.",
  alternates: { canonical: "/docs" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs",
    siteName: "Suede Agent Studio",
    title: "Docs | Suede Agent Studio",
    description:
      "Build on the canvas, write TypeScript, or call a published service according to its preview, payment-enabled, or unavailable state.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Docs | Suede Agent Studio",
    description:
      "Build on the canvas, write TypeScript, or call a published service according to its preview, payment-enabled, or unavailable state.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

const CALL_CURL = [
  `# 1. discover published agents and their payment state`,
  `curl ${SITE_URL}/api/catalog`,
  ``,
  `# 2. read an agent's payment state and active terms, when enabled`,
  `curl ${SITE_URL}/api/agents/<slug>/.well-known/x402`,
  ``,
  `# 3. run it (when state=preview: free dry-run, no wallet needed)`,
  `curl -X POST ${SITE_URL}/api/agents/<id>/run \\`,
  `  -H 'content-type: application/json' \\`,
  `  -d '{ "input": { "prompt": "Q3 renewal for Acme Corp, 12 seats, auto-renews in 45 days" } }'`,
  ``,
  `# "prompt" is the default for flows with no configured Input fields.`,
  `# Each agent's real field names are on its page and in its .well-known/x402.`,
].join("\n");

const PUBLISH_NOTE = [
  `POST /api/flows/<flowId>/launch`,
  `{ "priceUsdc": 0.25 }`,
  ``,
  `→ { "slug": "...", "urls": { "run": "/api/agents/<id>/run", ... } }`,
].join("\n");

// ---------------------------------------------------------------------------
// SDK section — derived from billing constants (no hardcoded numbers)
// ---------------------------------------------------------------------------


const SDK_INSTALL = `npm install @suedeai/agents`;

const SDK_EXAMPLE = [
  `import { defineAgent, schedule, paidCall, suede } from "@suedeai/agents";`,
  ``,
  `export default defineAgent({`,
  `  name: "price-watcher",`,
  `  description: "Watches a product page and emails a brief when the price drops.",`,
  `  triggers: [schedule("0 13 * * *"), paidCall(0.25)],`,
  `  async run({ input, memory }) {`,
  `    const out = await suede.llm({`,
  `      system: "Extract the price as a number.",`,
  `      prompt: String(input ?? ""),`,
  `    });`,
  `    const last = await memory.get<number>("lastPrice");`,
  `    await memory.set("lastPrice", Number(out.text));`,
  `    return { price: out.text, dropped: last !== undefined && Number(out.text) < last };`,
  `  },`,
  `});`,
].join("\n");

const SDK_TYPES = [
  `// Core exports`,
  `defineAgent(def: AgentDefinition): Readonly<AgentDefinition>`,
  `schedule(cron: string): Trigger          // five-field cron (UTC)`,
  `paidCall(priceUsdc: number): Trigger     // price >= 0`,
  `manual(): Trigger`,
  `webhook(): Trigger                       // relay-driven (suede link)`,
  ``,
  `// LLM gateway`,
  `suede.llm({ system: string; prompt: string }): Promise<{ text: string }>`,
  `suede.run(nodeType: string, config?: unknown): Promise<{ output: unknown }>`,
  ``,
  `// Local dev`,
  `createLocalMemory(workdir?: string): AgentMemory  // .suede/memory.json`,
  ``,
  `// Self-host`,
  `serve(agent: AgentDefinition, { port: number }): ServeHandle`,
  `//   POST /run   · { input?, trigger? } → { output }`,
  `//   GET  /manifest · agent metadata (no run fn)`,
].join("\n");

const SDK_CLI = [
  `suede init              # scaffold agent.ts + .suede/config.json`,
  `suede login <key>       # save workspace key (from agents.suedeai.ai/flows)`,
  `suede push              # publish agent.ts → live endpoint`,
  `suede pull <slug>       # write manifest.json + agent.ts from platform`,
  `suede dev               # local serve on :3001 (POST /run, GET /manifest)`,
  `suede whoami            # show active key prefix + API URL`,
].join("\n");

const SDK_LINK = [
  `# Link your local server to the platform so callers hit YOUR machine:`,
  `suede link <slug> --url https://your-server.com/run`,
  `# → prints: SUEDE_RELAY_SECRET=<hex>   (save this)`,
  ``,
  `# Start your server with the secret to authenticate Suede's forwarded calls:`,
  `SUEDE_RELAY_SECRET=<hex> node dist/agent.js`,
  ``,
  `# From now on: POST /api/agents/<slug>/run → your server → 402-gated as normal`,
].join("\n");

const SDK_ENV = [
  `# Required for live gateway calls`,
  `SUEDE_WORKSPACE_KEY=<key-from-flows-dashboard>`,
  ``,
  `# Optional overrides`,
  `SUEDE_GATEWAY_STUB=1          # offline echo mode: no HTTP, no key`,
  `SUEDE_API_URL=https://...     # override platform URL (default: agents.suedeai.ai)`,
  `SUEDE_RELAY_SECRET=<hex>      # authenticate relay-forwarded calls in serve()`,
].join("\n");

// ---------------------------------------------------------------------------
// Node reference: general-purpose Logic and Trigger nodes. Every number
// below is copied from the node's source file, not estimated.
// ---------------------------------------------------------------------------

const NODE_HTTP_DRYRUN_OUTPUT = [
  `{`,
  `  "status": 200,`,
  `  "body": {`,
  `    "dryRun": true,`,
  `    "note": "HTTP request skipped during dry-run; no real request was made.",`,
  `    "method": "POST",`,
  `    "url": "https://example.com/webhook"`,
  `  }`,
  `}`,
].join("\n");

const NODE_WEBHOOK_SIGN_EXAMPLE = [
  `import { createHmac } from "node:crypto";`,
  ``,
  `const secret = process.env.MY_STORED_SUEDE_SECRET; // shown once, at launch`,
  `const timestamp = Date.now().toString();`,
  `const rawBody = JSON.stringify({ event: "payment.succeeded" });`,
  ``,
  `// Base string is "<timestamp>.<raw body bytes, before JSON parsing>"`,
  `const base = \`\${timestamp}.\${rawBody}\`;`,
  `const signature = "sha256=" + createHmac("sha256", secret).update(base).digest("hex");`,
  ``,
  `await fetch("https://agents.suedeai.ai/api/agents/<agent-id-or-slug>/webhook", {`,
  `  method: "POST",`,
  `  headers: {`,
  `    "content-type": "application/json",`,
  `    "x-suede-webhook-timestamp": timestamp,`,
  `    "x-suede-webhook-signature": signature,`,
  `  },`,
  `  body: rawBody,`,
  `});`,
].join("\n");

const NODE_TRANSFORM_EXAMPLE_1 = `{ email: in.user.email, count: len(in.items) }`;
const NODE_TRANSFORM_EXAMPLE_2 = `map(in.items, x => x.id)`;
const NODE_TRANSFORM_EXAMPLE_3 = `in.status == "active" ? "go" : "hold"`;

const NODE_LOOP_OUTPUT = [
  `{`,
  `  "result": [`,
  `    { "<subflow-node-id>": { "result": "..." } },  // item 0: succeeded`,
  `    null,                                            // item 1: failed, see errors`,
  `    { "<subflow-node-id>": { "result": "..." } }    // item 2: succeeded`,
  `  ],`,
  `  "errors": [`,
  `    { "index": 1, "error": "<subflow-node-id>: <message>" }`,
  `  ]`,
  `}`,
].join("\n");

interface NodeFieldRow {
  field: string;
  type: string;
  default: string;
  notes: string;
}

function NodeConfigTable({ rows }: { rows: NodeFieldRow[] }): React.JSX.Element {
  return (
    <div
      style={{
        overflowX: "auto",
        borderRadius: "var(--radius)",
        border: "1px solid var(--hairline)",
        marginTop: "0.9rem",
      }}
    >
      <table
        style={{
          width: "100%",
          /* Three nowrap columns + width:100% would crush Notes to a few
             characters on phones; a floor makes the wrapper scroll instead. */
          minWidth: 640,
          borderCollapse: "collapse",
          fontFamily: "var(--font-ui)",
          fontSize: "var(--text-sm)",
        }}
      >
        <thead>
          <tr style={{ background: "var(--canvas-bg)", borderBottom: "1px solid var(--hairline)" }}>
            {["Field", "Type", "Default", "Notes"].map((h) => (
              <th
                key={h}
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
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.field}
              style={{
                borderBottom: i < rows.length - 1 ? "1px solid var(--hairline)" : undefined,
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
                }}
              >
                {r.field}
              </td>
              <td style={{ padding: "0.7rem 1rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                {r.type}
              </td>
              <td style={{ padding: "0.7rem 1rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                {r.default}
              </td>
              <td style={{ padding: "0.7rem 1rem", color: "var(--text-secondary)" }}>{r.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeCode({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="lp-code" style={{ margin: "0.6rem 0 0" }}>
      {children}
    </pre>
  );
}

const HTTP_FIELDS: NodeFieldRow[] = [
  {
    field: "method",
    type: "select: GET, POST, PUT, PATCH, DELETE",
    default: "GET",
    notes: "Not interpolated.",
  },
  {
    field: "url",
    type: "string",
    default: "required",
    notes: "http or https only. Supports {{path}} interpolation from upstream inputs.",
  },
  {
    field: "headers",
    type: "JSON object, string to string",
    default: "none",
    notes: "Each value is interpolated the same way as url.",
  },
  {
    field: "body",
    type: "string",
    default: "none",
    notes: "Sent with POST, PUT, PATCH, and DELETE. Interpolated. Dropped on GET (the Fetch spec forbids a GET body).",
  },
  {
    field: "timeoutMs",
    type: "number",
    default: "10000",
    notes: "Capped at 30000 regardless of what's entered.",
  },
];

const WEBHOOK_FIELDS: NodeFieldRow[] = [
  {
    field: "note",
    type: "string",
    default: "none",
    notes: "Descriptive only, for your own reference. Has no effect on verification.",
  },
];

const TRANSFORM_FIELDS: NodeFieldRow[] = [
  {
    field: "expression",
    type: "string (the expression language below)",
    default: "required",
    notes: "Evaluated against the node's inputs; the result becomes this node's output.",
  },
];

const LOOP_FIELDS: NodeFieldRow[] = [
  {
    field: "flowId",
    type: "string",
    default: "required",
    notes: "ID of another flow, run once per array item.",
  },
  {
    field: "itemsPath",
    type: "string",
    default: "none",
    notes: "Dot path to the array inside the upstream value. Blank uses the upstream value directly as the array.",
  },
  {
    field: "concurrency",
    type: "number",
    default: "2",
    notes: "Capped at 4, and never higher than the number of items being processed.",
  },
  {
    field: "maxIterations",
    type: "number",
    default: "50",
    notes: "Hard ceiling of 200. Inputs longer than the effective cap are rejected outright, never truncated.",
  },
];

export default function DocsPage(): React.JSX.Element {
  const endpoints = PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS.filter((endpoint) =>
    isPublicEndpointMarketingAllowed(endpoint.id),
  );
  const pricePer1M = gatewayPricePer1M(GATEWAY_MARGIN);
  const freeTokensLabel = (FREE_MONTHLY_GATEWAY_TOKENS / 1000).toFixed(0) + "k";

  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs</span>
          <h1>From canvas to callable endpoint.</h1>
          <p>
            {BUILD_SETTINGS_LEDE} Published
            services report preview, payment-enabled, or unavailable. Ordinary
            standalone services can offer dry-run with zero caller setup;
            company or otherwise unready services may be unavailable. Want to
            see it used first?{" "}
            <Link href="/docs/examples" style={{ color: "var(--primary)" }}>
              Six real examples, from invoice chasing to one agent paying another.
            </Link>
          </p>
          {/* Capabilities strip: what this page is for and what it holds,
              readable before the first scroll. Same kicker + pills pattern
              as /pricing and /templates. */}
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
              The quick reference
            </span>
            {[
              "Three quickstarts",
              "SDK and CLI",
              "curl a live agent",
              "Node field tables",
              "12 deep-dive guides",
            ].map((item) => (
              <span key={item} role="listitem" className="lp-pill">
                {item}
              </span>
            ))}
          </div>
        </header>

        <section className="lp-doc lp-block" id="guides" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">Guides</span>
          <h2>Longer-form documentation</h2>
          <p>
            This page is the quick reference. The guides go deeper, one topic
            per page:
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "1rem",
              marginTop: "1rem",
            }}
          >
            {DOCS_SECTIONS.flatMap((section) => section.pages)
              .filter((page) => page.href !== "/docs")
              .map((guide) => (
                <Link
                  key={guide.href}
                  href={guide.href}
                  className="card"
                  style={{ padding: "1.1rem 1.3rem", textDecoration: "none", color: "inherit", display: "block" }}
                >
                  <span style={{ color: "var(--primary)", fontWeight: 600 }}>{guide.label}</span>
                  <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", lineHeight: 1.55, margin: "0.35rem 0 0" }}>
                    {guide.description}
                  </p>
                </Link>
              ))}
          </div>
          {/* Not a docs page, so not a card in this grid (the grid mirrors
              the sidebar): long-form writing lives outside the docs shell. */}
          <p style={{ marginTop: "1.1rem" }}>
            Long-form writing on agentic workflows, x402, flow design, and
            endpoint economics lives at{" "}
            <Link href="/articles" style={{ color: "var(--primary)" }}>
              /articles
            </Link>
            .
          </p>
        </section>

        <section className="lp-doc lp-block" id="creators">
          <span className="lp-eyebrow">01 · Builders</span>
          <h2>Build on the canvas</h2>
          <div>
            <div className="lp-doc-step">
              <span className="n">1</span>
              <div>
                <h3>Start from a template or a blank canvas</h3>
                <p>
                  <Link href="/build/new?template=lead-qualifier" style={{ color: "var(--primary)" }}>
                    Input → LLM → Output
                  </Link>{" "}
                  scores a lead in one call. Drag nodes from the palette, or
                  start an external workflow with{" "}
                  <Link href="/build/new?template=campaign-launcher" style={{ color: "var(--primary)" }}>
                    Brief → Campaign Draft → Output
                  </Link>
                  . Every Suede rail is a node with its USDC price on the card.
                </p>
              </div>
            </div>
            <div className="lp-doc-step">
              <span className="n">2</span>
              <div>
                <h3>Run it and watch the ledger</h3>
                <p>
                  The run dock streams every node live with a per-node cost
                  ledger. Dry-run is the default: no USDC moves, the flow logic
                  and pricing are real.
                </p>
              </div>
            </div>
            <div className="lp-doc-step">
              <span className="n">3</span>
              <div>
                <h3>Launch</h3>
                <p>
                  One click publishes the flow with a public page, explicit
                  call-state discovery, an AgentCard, and a run endpoint.
                  Ordinary standalone services may offer a preview;
                  payment-enabled services add active x402 terms; unavailable
                  services remain discoverable without a public call.
                  It lists in the{" "}
                  <Link href="/agents" style={{ color: "var(--primary)" }}>
                    directory
                  </Link>{" "}
                  automatically. Your flows stay private to this browser;
                  find them under{" "}
                  <Link href="/flows" style={{ color: "var(--primary)" }}>
                    Workspace
                  </Link>
                  .
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-doc lp-block" id="agents">
          <span className="lp-eyebrow">02 · Agents &amp; developers</span>
          <h2>Call a published agent in three steps</h2>
          <p>
            Read the service&apos;s current state first. An ordinary preview-ready
            service accepts dry-run without caller API keys. A payment-enabled
            service quotes x402 v2 terms and settles paid calls in USDC on Base;
            an unavailable service accepts neither path.
          </p>
          <CopyBlock code={CALL_CURL} />
        </section>

        <section className="lp-doc lp-block" id="publish">
          <span className="lp-eyebrow">03 · Sellers</span>
          <h2>Publish the state. Enable payment when ready.</h2>
          <p>
            Launching from the studio takes an optional per-call price. Relaunching
            the same flow updates the price and keeps the slug; your integration
            URLs never break.
          </p>
          <CopyBlock code={PUBLISH_NOTE} />
          <p style={{ marginTop: "0.9rem" }}>
            Machine discovery is automatic:{" "}
            <a href="/.well-known/x402" style={{ color: "var(--primary)" }}>
              /.well-known/x402
            </a>{" "}
            indexes published endpoints with explicit payment state; enabled
            entries include active terms. The{" "}
            <a href="/api/catalog" style={{ color: "var(--primary)" }}>
              /api/catalog
            </a>{" "}
            is the crawlable feed.
          </p>
        </section>

        <section className="lp-doc lp-block" id="sdk">
          <span className="lp-eyebrow">04 · Code setting · @suedeai/agents SDK</span>
          <h2>Write an agent in TypeScript. Push it from the terminal.</h2>
          <p>
            The Code setting is the third way to build on Suede. Install the SDK,
            define your agent in a{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>agent.ts</code>{" "}
            file, and push it live with one command: no API keys, no Stripe
            onboarding. Suede provides the model.
          </p>

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>Install</h3>
          <CopyBlock code={SDK_INSTALL} />

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>A working, sellable agent in sixteen lines</h3>
          <CopyBlock code={SDK_EXAMPLE} />

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>API surface (v0)</h3>
          <CopyBlock code={SDK_TYPES} />

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>CLI commands</h3>
          <CopyBlock code={SDK_CLI} />

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>Relay: earn through Suede while running your own server</h3>
          <p>
            Link your self-hosted agent server to the platform so callers use the
            Suede endpoint (402-gated, paid) but execution happens on your
            machine. Suede verifies the payment, forwards the call with an HMAC
            signature, and routes the USDC to your payout address.
          </p>
          <CopyBlock code={SDK_LINK} />

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>Environment variables</h3>
          <CopyBlock code={SDK_ENV} />

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>Gateway pricing</h3>
          <p>
            The Suede gateway provides the LLM; no API key needed. Top up once
            and your workspace gets {freeTokensLabel} tokens included every
            month from then on. Past that:{" "}
            <strong>${pricePer1M.toFixed(2)} per 1M tokens</strong>{" "}
            (drawn from the same credit: HTTP 402, USDC on Base).
            Everything a caller pays for your agent routes to your payout
            address.
          </p>
        </section>

        <section className="lp-doc lp-block" id="connector-lab">
          <span className="lp-eyebrow">05 · Connector Lab</span>
          <h2>Typed API operations, simulated locally</h2>
          <p>
            Connector Lab is a default-off prototype for importing one bounded
            OpenAPI 3.1.0 JSON operation as an immutable typed node. Every API
            Operation is labeled <strong>Prototype: simulation only</strong>.
            Simulation validates the typed request, creates a redacted plan,
            and passes trusted schema-shaped output to local downstream steps.
            The Run Dock says <strong>Simulated locally. No request sent.</strong>
          </p>
          <p>
            An optional readiness check can confirm only that a compatible Test
            slot is configured. Its receipt says <strong>Test slot configured.
            Authentication unverified.</strong> It does not decrypt a credential,
            log in, check provider health, or send a request. API Operation cannot
            run in published, Live, or durable workflows, and this prototype is
            not a broad OpenAPI or connector-parity claim.
          </p>
          <p>
            The Connector Lab adds no required paid service. The exact clean local gate
            is <code>npm run verify:phase4b1</code>; it uses process-level guards,
            not an OS-level network sandbox. Operator compute and storage may
            still cost money.
          </p>
        </section>

        <section className="lp-doc lp-block" id="nodes">
          <span className="lp-eyebrow">06 · Node reference</span>
          <h2>General-purpose nodes: HTTP, Webhook, Transform, Loop</h2>
          <p>
            These four nodes are what make a flow general-purpose instead of
            music-specific: call any REST API, receive events from a third
            party, reshape data between steps, and iterate over a list. The
            full field-level reference for each one folds open below; the
            catalog-wide view by group lives in the{" "}
            <Link href="/docs/nodes" style={{ color: "var(--primary)" }}>
              node reference
            </Link>
            .
          </p>

          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.4rem" }}>Dry-run: what actually runs</h3>
          <p>
            A dry run does not treat every node the same way. The engine
            stubs out any node marked cost-bearing or side-effecting before
            it ever calls that node&apos;s real executor. HTTP Request is
            side-effecting (it can reach an arbitrary third-party URL), so in
            a dry run it never makes a real request; it returns a fixed
            placeholder instead, shown below. LLM is cost-bearing and does
            not call the model. Input, Output, Branch, Schedule, Webhook,
            Subflow, Transform, and Loop are not stubbed at all: they execute
            for real in a dry run, because none of them costs money or
            reaches an external system on their own. Loop is the one
            exception worth calling out by name: it always runs for real (it
            has to, so its inner nodes get a chance to see dry-run mode
            themselves), and it passes dry-run through unchanged to every
            iteration&apos;s nested run, so a dry-run loop still fully iterates,
            it just never lets an inner HTTP or LLM node spend anything
            while doing so.
          </p>

          {/* Folded, not deleted: this is the canonical field-level detail
              (five subpages deep-link to /docs#nodes for it), but open-by-
              default it was the bulk of a 13,000px hub. Native details/
              summary keeps every word server-rendered and crawlable. */}
          <div className="lp-faq-list" style={{ maxWidth: "none" }}>
          <details className="lp-faq-item">
          <summary><h3 style={{ margin: 0 }}>HTTP Request</h3></summary>
          <p>
            Calls any REST API over http or https. This is a free node
            (Suede charges nothing for it; you pay whatever the target API
            charges), and it is the app&apos;s primary SSRF surface, so every
            request is validated before it&apos;s made.
          </p>
          <NodeConfigTable rows={HTTP_FIELDS} />
          <p style={{ marginTop: "0.9rem" }}>
            <strong>SSRF guard.</strong> The URL&apos;s scheme must be http or
            https. Requests are blocked to a fixed set of hostname literals
            (localhost, localhost.localdomain, ip6-localhost, ip6-loopback,
            and anything ending in .local, .internal, or .localhost) and to
            reserved IP ranges: loopback (127.0.0.0/8), the three RFC1918
            private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16),
            link-local (169.254.0.0/16, which also covers the
            169.254.169.254 cloud metadata endpoint), 0.0.0.0/8, and the
            100.64.0.0/10 CGNAT range, plus the IPv6 equivalents (loopback,
            unspecified, link-local, unique-local, and IPv4-mapped
            addresses resolved through the same IPv4 list). The hostname is
            resolved and the resolved address is checked, not just the
            hostname string, and the same check runs again before every
            redirect hop (up to 5 redirects). This narrows but does not
            close DNS rebinding: validation and the actual connection are
            two separate DNS lookups a few milliseconds apart, so a resolver
            that changes its answer inside that window could still slip
            through. Closing that gap fully would need pinning the socket to
            the exact validated IP, which this pass does not do.
          </p>
          <p>
            A 303 redirect downgrades the method to GET and drops the body;
            every other redirect status preserves both. The response body is
            capped at 2 MB, read in a stream and aborted (not truncated) if
            it goes over; the request itself times out after the configured
            timeoutMs (10000 by default, 30000 max).
          </p>
          <p>
            <strong>Output:</strong>{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              {"{ status: number, body: <parsed JSON if the response is application/json, otherwise the raw text> }"}
            </code>
          </p>
          <p>
            <strong>Dry-run:</strong> no request is made. The node returns a
            placeholder in the same envelope shape so a downstream node still
            typechecks, but the body content is a fixed marker, not a guess
            at what the real target would have returned:
          </p>
          <NodeCode>{NODE_HTTP_DRYRUN_OUTPUT}</NodeCode>
          </details>

          <details className="lp-faq-item">
          <summary><h3 style={{ margin: 0 }}>Webhook</h3></summary>
          <p>
            A trigger node: an external service (GitHub, Stripe, Slack, your
            own backend) posts JSON to this agent&apos;s webhook URL and the flow
            runs with that body as its input. Authentication is not a node
            field. A signing secret is generated once, server-side, when
            you launch the agent, and shown to you exactly once. It cannot
            be recovered later; relaunching an agent that already has a
            webhook endpoint leaves the existing secret untouched rather
            than rotating it out from under whatever third party is already
            using it.
          </p>
          <NodeConfigTable rows={WEBHOOK_FIELDS} />
          <p style={{ marginTop: "0.9rem" }}>
            <strong>Calling it.</strong> POST to{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              /api/agents/&lt;agent-id-or-slug&gt;/webhook
            </code>{" "}
            with a JSON body (application/json, exactly, charset suffix
            aside; anything else is rejected) and two headers:{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              x-suede-webhook-signature
            </code>{" "}
            (
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>sha256=&lt;hex&gt;</code>
            ) and{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              x-suede-webhook-timestamp
            </code>{" "}
            (Unix milliseconds, as a decimal string). The signature is an
            HMAC-SHA256, keyed by your webhook secret, over the exact string{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
              {"<timestamp>.<raw request body bytes, before any JSON parsing>"}
            </code>
            . Binding the timestamp into the signature means a captured
            request can&apos;t be replayed with a new timestamp without also
            forging a new signature, and requests signed more than 5 minutes
            off the current time (either direction) are rejected as stale.
            The request body is capped at 256 KB. A bad signature, a stale
            timestamp, and a nonexistent agent all return the same generic
            401, on purpose, so a caller can&apos;t use the response to enumerate
            which agent ids or slugs exist. Both the source IP and the agent
            id are separately rate-limited.
          </p>
          <CopyBlock code={NODE_WEBHOOK_SIGN_EXAMPLE} />
          <p style={{ marginTop: "0.9rem" }}>
            <strong>Output:</strong> the inbound JSON body, forwarded as-is
            (wrapped as{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>{"{ body: <value> }"}</code>{" "}
            if the posted JSON wasn&apos;t a plain object).
          </p>
          <p>
            <strong>Dry-run:</strong> not stubbed. A webhook delivery&apos;s
            payment mode is decided by the service&apos;s payment-enablement state,
            never by the caller. A preview stays free no matter what a third
            party sends, while an enabled service keeps its payment gate.
          </p>
          <p>
            <strong>Security note:</strong> the secret is stored as a hash,
            but that stored value is also the literal HMAC key used to
            verify every request, so a database compromise gets an attacker
            forgeable signatures. That is the same property Stripe&apos;s and
            GitHub&apos;s webhook secrets have; there is no way to have a
            recoverable HMAC key that a database read can&apos;t also recover.
          </p>
          </details>

          <details className="lp-faq-item">
          <summary><h3 style={{ margin: 0 }}>Transform</h3></summary>
          <p>
            Reshapes data between steps: plucks a field, builds a new object,
            filters or formats a list, without a round trip through an LLM.
            This is not a code-execution node: the expression language is a
            small, non-Turing-complete grammar. There is no eval or new
            Function, no globals, no network or filesystem access, no
            require or import, no user-defined functions, and no loop
            construct beyond the single fixed-arity map() builtin.
          </p>
          <NodeConfigTable rows={TRANSFORM_FIELDS} />
          <p style={{ marginTop: "0.9rem" }}>
            <strong>Grammar.</strong> Path access with{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>in.field</code> or{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>in.items[0].id</code>;
            arithmetic (+ - * / %); comparisons (== != &lt; &lt;= &gt;
            &gt;=); logical && and ||; unary ! and -; a ternary{" "}
            <code className="mono" style={{ fontSize: "var(--text-sm)" }}>test ? a : b</code>;
            object literals ({"{ key: value, ... }"}); and array literals ([
            a, b, c ]). Builtins:{" "}
            {"map, " + Object.keys(BUILTINS).join(", ")}. map() is the one
            binder in the language: map(array, item {"=>"} expr) evaluates
            its lambda body once per array element with item scoped to that
            call only.
          </p>
          <NodeCode>{NODE_TRANSFORM_EXAMPLE_1}</NodeCode>
          <NodeCode>{NODE_TRANSFORM_EXAMPLE_2}</NodeCode>
          <NodeCode>{NODE_TRANSFORM_EXAMPLE_3}</NodeCode>
          <p style={{ marginTop: "0.9rem" }}>
            <strong>Limits, all enforced before or during evaluation:</strong>{" "}
            {DEFAULT_EXPR_LIMITS.maxSourceLength} characters of source,{" "}
            {DEFAULT_EXPR_LIMITS.maxTokens} tokens, {DEFAULT_EXPR_LIMITS.maxDepth} levels of
            nesting, {DEFAULT_EXPR_LIMITS.maxNodes} AST nodes total,{" "}
            {DEFAULT_EXPR_LIMITS.maxSteps} evaluation steps (this is what bounds map() fanning
            out over a large array), a {DEFAULT_EXPR_LIMITS.maxTimeMs}ms wall-clock budget per
            evaluation, {DEFAULT_EXPR_LIMITS.maxArrayOpItems} items max for map()/join()/split(),
            and {DEFAULT_EXPR_LIMITS.maxJsonInputLength.toLocaleString()} characters max for
            jsonParse()&apos;s input. __proto__, constructor, and prototype are denied everywhere,
            static and dynamic, so no path through the language can reach the prototype chain.
          </p>
          <p>
            <strong>Dry-run:</strong> not stubbed. This is local computation
            only, so it always runs for real, dry run or not.
          </p>
          </details>

          <details className="lp-faq-item">
          <summary><h3 style={{ margin: 0 }}>Loop</h3></summary>
          <p>
            Runs another flow once per element of an upstream array and
            collects the per-element results in order. Without this node, a
            flow author has to pre-batch an entire array into one blob and
            ask a single LLM call to handle all of it at once, forcing an
            all-or-nothing retry on any hiccup. The loop node itself never
            makes a paid or external call; every dollar it can spend comes
            from the nodes inside the subflow it runs.
          </p>
          <NodeConfigTable rows={LOOP_FIELDS} />
          <p style={{ marginTop: "0.9rem" }}>
            <strong>Failure policy: collect errors, not fail fast.</strong>{" "}
            Every element is attempted; one flaky item does not stop the
            others. The loop node itself still reports success as long as
            it could start (a valid array, a loadable subflow, within the
            iteration cap). Per-element failures land in the errors output
            instead of failing the whole node. The cost trade-off is
            explicit: because every element still runs, the worst-case cost
            of a loop is always up to N times the subflow&apos;s cost, whether or
            not some elements fail.
          </p>
          <p>
            <strong>Output:</strong> two separate outputs, result and
            errors. Each entry in result is the full outputs record from
            that element&apos;s nested run (keyed by the subflow&apos;s own internal
            node ids), or null if that element failed. Each entry in errors
            is {"{ index, error }"}, where error names the subflow node that
            failed:
          </p>
          <NodeCode>{NODE_LOOP_OUTPUT}</NodeCode>
          <p style={{ marginTop: "0.9rem" }}>
            <strong>Cost ceiling.</strong> Every run (top-level or nested)
            shares one in-run cost ceiling, checked before every cost-bearing
            node runs. The ceiling is the minimum of an absolute per-run cap
            (the RUN_COST_CEILING_USDC environment variable, $5 if unset or
            invalid) and the agent&apos;s own remaining daily budget at the start
            of the run. If a loop iteration&apos;s nested run gets aborted for
            hitting that ceiling, it is not treated as a per-element failure:
            no further iterations start, and the loop node itself fails with
            a message stating how many of the N iterations completed before
            the abort, so the abort propagates to the whole run instead of
            being swallowed by collect-errors.
          </p>
          <p>
            <strong>Nesting.</strong> A loop&apos;s subflow runs one level deeper
            than the run that called it, and the engine bounds total
            subflow/loop nesting with a depth guard: 16 levels. Loops inside
            subflows (and loops inside loops) are legal up to that ceiling,
            all sharing the one in-run cost ceiling; a nested run that would
            cross the depth guard fails just that iteration, surfaced in
            errors, not the whole run.
          </p>
          <p>
            <strong>Dry-run:</strong> not stubbed. The loop always runs for
            real so its inner nodes get a chance to see dry-run mode
            themselves; ctx.dryRun passes through unchanged to every nested
            run, so a dry-run loop still iterates fully, it just never lets
            an inner cost-bearing or side-effecting node spend anything.
          </p>
          </details>
          </div>
        </section>

        {/* The full per-row ledger used to be inlined here as well as on
            /pricing — the same rows twice. The hub keeps the summary facts
            and points at the one canonical ledger. */}
        <section className="lp-doc lp-block" id="endpoints">
          <span className="lp-eyebrow">The rails</span>
          <h2>The {endpoints.length} public Suede gateway routes</h2>
          <p>
            The public App catalog exposes {endpoints.length} pay-per-call routes on{" "}
            <code className="mono">api.suedeai.xyz</code>{" "}
            that return x402 payment terms. Prices are fixed per call in USDC;
            internal operational profiles and retained compatibility entries
            are excluded from this public inventory.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "1rem",
              marginTop: "1rem",
            }}
          >
            {[
              { href: "/pricing#endpoints", title: "The price ledger", body: "Every public gateway route with its exact per-call price: music, video, and image generation." },
              { href: "/docs/nodes", title: "Node reference", body: "The authored node catalog, with retained compatibility profiles distinguished from currently live gateway routes." },
              { href: "/docs/payments", title: "Payments", body: "How a priced call settles: your costs, the caller's price, and how payouts land in your wallet." },
            ].map((card) => (
              <Link
                key={card.href}
                href={card.href}
                className="card"
                style={{ padding: "1.1rem 1.3rem", textDecoration: "none", color: "inherit", display: "block" }}
              >
                <span style={{ color: "var(--primary)", fontWeight: 600 }}>{card.title}</span>
                <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", lineHeight: 1.55, margin: "0.35rem 0 0" }}>
                  {card.body}
                </p>
              </Link>
            ))}
          </div>
        </section>
    </>
  );
}
