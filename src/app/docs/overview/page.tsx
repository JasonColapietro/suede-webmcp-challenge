/**
 * Docs / Overview — what Suede Agent Studio is, the four-part architecture
 * around the flow contract, what launching produces, and honest scope notes.
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import { buildTemplateSummaries } from "@/lib/template-summaries";
import { PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS } from "@/lib/rails/suede-endpoints";
import { isPublicEndpointMarketingAllowed } from "@/lib/marketing-holds";

const PAGE_TITLE = "What is Suede Agent Studio? | Docs";
const PAGE_DESCRIPTION =
  "A visual node-graph builder where published flows report preview, payment-enabled, or unavailable state. What launching produces and how calls work.";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/overview" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/overview",
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

const PARTS: { name: string; body: string; color: string }[] = [
  {
    name: "The canvas",
    color: "var(--primary)",
    body: "A visual editor where you drag nodes from a palette and wire them with edges. Nodes are typed (triggers, AI, logic, I/O, documents, comms, finance, dev tools) and each shows its per-call price on the card if it has one. The canvas edits a plain data structure, not code.",
  },
  {
    name: "The flow contract",
    color: "var(--text-info)",
    body: "Every flow is a FlowGraph: a list of nodes with typed params and a list of edges connecting outputs to inputs. Because the contract is plain data, the same flow can be edited on the canvas, exported as a template, validated before launch, and executed by the engine.",
  },
  {
    name: "The engine",
    color: "var(--primary)",
    body: "Runs a graph in topological order: each node executes when its inputs are ready. The engine keeps a per-node USDC cost ledger, halts downstream work when a node on the main path errors, guards subflow depth, and enforces a per-run spend ceiling before every cost-bearing node.",
  },
  {
    name: "The runtime",
    color: "var(--text-success)",
    body: "The hosted API around the engine: flow CRUD, streamed runs, cron triggers, signed webhooks, and public call-state discovery. Ordinary standalone services may preview; payment-enabled services expose x402 terms; others may be unavailable.",
  },
];

export default function DocsOverviewPage(): React.JSX.Element {
  const endpointCount = PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS.filter((endpoint) =>
    isPublicEndpointMarketingAllowed(endpoint.id),
  ).length;
  const publicTemplateCount = buildTemplateSummaries().length;

  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · Overview</span>
          <h1>What Suede Agent Studio is</h1>
          <p>
            A visual builder and launcher for agent workflows. You wire nodes
            on a canvas; the studio publishes the service, its HTTP route, and
            its current preview, payment-enabled, or unavailable state.
            Payment is enabled separately after readiness checks.
          </p>
        </header>

        <section className="lp-doc lp-block" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">The idea in ninety seconds</span>
          <h2>Flows in, endpoints out</h2>
          <p>
            A <strong>flow</strong> is a graph: a trigger node starts it, LLM
            and tool nodes do the work, logic nodes route and reshape data,
            and an output node defines the result. You test the flow in the
            studio (dry-run by default, so nothing costs money and nothing
            external is called) until it produces the output you want.
          </p>
          <p>
            <strong>Launching</strong> publishes that flow as an agent: a
            public page, a directory listing, and a run endpoint at{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
              POST /api/agents/&lt;id&gt;/run
            </span>
            . For an ordinary standalone service, publication may expose a
            dry-run preview. Company or otherwise unready services may be
            unavailable. A price is an intended rate, not payment enablement;
            after deployment, payout, platform, and company checks pass and
            payment is enabled, the endpoint issues x402 challenges. Every
            settled call routes to your payout address. Details live in{" "}
            <Link href="/docs/payments" style={{ color: "var(--primary)" }}>
              Payments
            </Link>
            .
          </p>
        </section>

        <section className="lp-doc lp-block">
          <span className="lp-eyebrow">Architecture</span>
          <h2>Four parts around one contract</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "1.25rem",
              marginTop: "1rem",
            }}
          >
            {PARTS.map((part) => (
              <div key={part.name} className="card" style={{ padding: "1.5rem" }}>
                <span className="eyebrow" style={{ color: part.color }}>
                  {part.name}
                </span>
                <p
                  style={{
                    color: "var(--text-muted)",
                    lineHeight: 1.65,
                    fontSize: "var(--text-sm)",
                    marginTop: "0.6rem",
                    marginBottom: 0,
                  }}
                >
                  {part.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-doc lp-block">
          <span className="lp-eyebrow">Ways to build</span>
          <h2>Canvas, code, or templates</h2>
          <p>
            The canvas is the primary setting, and {publicTemplateCount}{" "}
            templates cover common business workflows (lead scoring, invoice
            chasing, contract review, support triage, PR digests) so most
            flows start from a working example rather than a blank page. The{" "}
            <Link href="/docs#sdk" style={{ color: "var(--primary)" }}>
              @suedeai/agents SDK
            </Link>{" "}
            is the code setting: define an agent in TypeScript and push it
            live from the terminal, or run it on your own server and let the
            platform relay preview calls and, when enabled, settled paid calls.
          </p>
          <p>
            The current public Suede gateway inventory has {endpointCount}{" "}
            pay-per-call routes: music, video, and image generation. Each
            public route carries a fixed USDC price listed on{" "}
            <Link href="/pricing" style={{ color: "var(--primary)" }}>
              Pricing
            </Link>
            .
          </p>
        </section>

        <section className="lp-doc lp-block">
          <span className="lp-eyebrow">Scope, honestly</span>
          <h2>What it is not</h2>
          <p>
            <strong>It is not autonomous by default.</strong> Flows run when
            triggered: by you, a schedule, a webhook, or a paying caller.
            Nothing self-modifies, and every cost-bearing step is bounded by
            a per-run ceiling and daily budgets.
          </p>
          <p>
            <strong>It does not move real money until you say so.</strong>{" "}
            Settlement starts off by default. For an ordinary service that can
            yield a preview; a company or payment-only service may instead be
            unavailable. No USDC moves until the service passes deployment,
            payout, and platform checks and payment is explicitly enabled.
            Missing payment readiness never creates a paid service.
          </p>
          <p>
            <strong>Publishing is not demand.</strong> Launching makes an
            agent discoverable in the directory, JSON catalog, AgentCard, and
            A2A interface. The x402 index keeps every published service
            crawlable and marks preview, payment-enabled, or unavailable;
            only payment-enabled entries include active acceptance terms.
            Discoverability is not a promise of callers or revenue.
          </p>
          <p>
            <strong>Some surfaces are prototypes and say so.</strong> The
            Connector Lab&apos;s API Operation node is simulation-only and
            cannot be launched into a live agent; the launch API rejects
            graphs that contain it.
          </p>
        </section>

        <section className="lp-doc lp-block">
          <span className="lp-eyebrow">Next</span>
          <h2>Where to go from here</h2>
          <p>
            <Link href="/docs/building-flows" style={{ color: "var(--primary)" }}>
              Building flows
            </Link>{" "}
            covers nodes, edges, and testing, and the{" "}
            <Link href="/docs/nodes" style={{ color: "var(--primary)" }}>
              node reference
            </Link>{" "}
            lists the full catalog.{" "}
            <Link href="/docs/launching" style={{ color: "var(--primary)" }}>
              Launching
            </Link>{" "}
            covers going live,{" "}
            <Link href="/docs/architecture" style={{ color: "var(--primary)" }}>
              Architecture
            </Link>{" "}
            what runs underneath.{" "}
            <Link href="/docs/api" style={{ color: "var(--primary)" }}>
              API for callers
            </Link>{" "}
            documents the endpoint from the buyer&apos;s side. Prefer prose?
            Start with{" "}
            <Link href="/articles/intro-to-agentic-workflows" style={{ color: "var(--primary)" }}>
              the introduction to agentic workflows
            </Link>
            .
          </p>
        </section>
    </>
  );
}
