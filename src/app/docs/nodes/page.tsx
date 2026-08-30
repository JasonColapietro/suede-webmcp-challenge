/**
 * Docs / Node reference — the full authored catalog, derived at render time
 * from src/lib/flow/node-definitions.ts (pure data, client-safe) so this page
 * cannot drift from what the palette ships. Group colors mirror GROUP_COLOR
 * in src/components/canvas/SuedeNode.tsx.
 */
import type { Metadata } from "next";
import Link from "next/link";
import {
  NODE_DEFINITIONS,
  NODE_GROUP_ORDER,
  type NodeDefinitionV2,
  type NodeGroup,
} from "@/lib/flow/node-definitions";
import type { NodeType } from "@/lib/flow/types";
import {
  isOperationalSuedeEndpointId,
  type SuedeEndpointId,
} from "@/lib/rails/suede-endpoints";
import { isPublicEndpointMarketingAllowed } from "@/lib/marketing-holds";

const PAGE_TITLE = "Node reference | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Every node in the Agent Studio catalog, by group: what it does, how it behaves in a dry run, its declared effects, and what it costs per call. Derived from the shipped catalog.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/nodes" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/nodes",
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

/** Mirrors GROUP_COLOR / GROUP_TEXT_COLOR in src/components/canvas/SuedeNode.tsx. */
const GROUP_COLOR: Record<NodeGroup, string> = {
  Triggers: "var(--violet)",
  "I/O": "var(--text-muted)",
  "Music & IP": "var(--registry-cyan)",
  AI: "var(--primary)",
  Rails: "var(--verified-emerald)",
  Logic: "var(--amber)",
  "Docs & Data": "var(--category-docs)",
  "Comms & CRM": "var(--category-comms)",
  "Finance & Ops": "var(--category-finance)",
  "Dev & Infra": "var(--category-devops)",
};

const GROUP_INK: Record<NodeGroup, string> = {
  Triggers: "var(--primary-hover)",
  "I/O": "var(--text-secondary)",
  "Music & IP": "var(--text-info)",
  AI: "var(--primary-hover)",
  Rails: "var(--text-success)",
  Logic: "var(--text-warning)",
  "Docs & Data": "var(--category-docs)",
  "Comms & CRM": "var(--category-comms)",
  "Finance & Ops": "var(--text-success)",
  "Dev & Infra": "var(--text-warning)",
};

const GROUP_BLURB: Record<NodeGroup, string> = {
  Triggers: "How a run starts: on a five-field UTC cron schedule, or when an HMAC-authenticated webhook delivery arrives.",
  "I/O": "The flow's boundary: what comes in when a trigger fires, and what a finished run returns to its caller.",
  AI: "Judgment steps on the Claude-backed gateway. No API key of your own; usage is metered in gateway tokens.",
  Logic: "The plumbing that makes a graph a program: HTTP calls, reshaping, routing, reducing, and running other flows as steps.",
  "Docs & Data": "Documents and structured data processed on the platform: PDF and DOCX text, spreadsheets, row cleanup, knowledge search, and one read-only web fetch.",
  "Comms & CRM": "Outbound messages to the systems a business already runs on, delivered through webhooks you configure.",
  "Finance & Ops": "Operational paperwork as a node: structured line items in, a rendered invoice out.",
  "Dev & Infra": "GitHub as a set of typed steps: read issues and pull requests, file or comment on issues, dispatch workflows.",
  "Music & IP": "The Suede music vertical. Generate Song uses a public x402 route; Analyze and Rights Lookup are internal-only; other authored profiles remain visible for saved-flow compatibility.",
  Rails: "Agent-commerce rails: IP registration and promo campaigns on Base, royalty split tables, and the Connector Lab's simulation-only prototype.",
};

function dryRunLabel(definition: NodeDefinitionV2): string {
  return definition.testMode === "native" ? "Runs for real" : "Stubbed";
}

const SUEDE_ENDPOINT_ID_BY_NODE_TYPE: Partial<Record<NodeType, SuedeEndpointId>> = {
  "suede.styleCoach": "styleCoach",
  "suede.lyrics": "lyrics",
  "suede.generateSong": "generateSong",
  "suede.analyze": "analyze",
  "suede.stems": "stems",
  "suede.midi": "midi",
  "suede.mastering": "mastering",
  "suede.rightsLookup": "rightsLookup",
  "suede.chainChat": "chainChat",
};

function suedeProfileStatus(
  definition: NodeDefinitionV2,
): "public" | "internal" | "compatibility" | null {
  const endpointId = SUEDE_ENDPOINT_ID_BY_NODE_TYPE[definition.type];
  if (endpointId === undefined) return null;
  if (isPublicEndpointMarketingAllowed(endpointId)) return "public";
  if (isOperationalSuedeEndpointId(endpointId)) return "internal";
  return "compatibility";
}

function costLabel(definition: NodeDefinitionV2): string {
  const profileStatus = suedeProfileStatus(definition);
  if (profileStatus === "internal") return "Internal only";
  if (profileStatus === "compatibility") return "Route unavailable";
  if (definition.cost.kind === "free") return "Free";
  if (definition.cost.kind === "estimated" && definition.cost.amount !== undefined) {
    return `$${definition.cost.amount.toFixed(3)} est.`;
  }
  return "Variable";
}

export default function NodesReferencePage(): React.JSX.Element {
  const groups = NODE_GROUP_ORDER.map((group) => ({
    group,
    nodes: NODE_DEFINITIONS.filter((definition) => definition.category === group),
  })).filter((entry) => entry.nodes.length > 0);

  const total = NODE_DEFINITIONS.length;
  const pricedCount = NODE_DEFINITIONS.filter(
    (definition) => definition.cost.kind === "estimated",
  ).length;
  const freeCount = NODE_DEFINITIONS.filter(
    (definition) => definition.cost.kind === "free",
  ).length;
  const compatibilityCount = NODE_DEFINITIONS.filter(
    (definition) => suedeProfileStatus(definition) === "compatibility",
  ).length;
  const internalProfileCount = NODE_DEFINITIONS.filter(
    (definition) => suedeProfileStatus(definition) === "internal",
  ).length;

  return (
    <>
      <header className="lp-page-head">
        <span className="lp-eyebrow">Docs · Node reference</span>
        <h1>Every node in the catalog</h1>
        <p>
          The full authored palette: {total} node types in {groups.length}{" "}
          groups, {freeCount} of them free on the platform side and{" "}
          {pricedCount} carrying an authored USDC estimate. Of those, {internalProfileCount}{" "}
          Suede profiles are internal-only and {compatibilityCount} are retained
          for compatibility because their routes are not currently live. This
          page is derived from the same catalog module the studio ships (
          <code className="mono" style={{ fontSize: "var(--text-sm)" }}>
            src/lib/flow/node-definitions.ts
          </code>
          ), so when the palette grows, this reference updates itself.
        </p>
      </header>

      <section className="lp-doc lp-block" id="reading" style={{ marginTop: 0 }}>
        <span className="lp-eyebrow">How to read the tables</span>
        <h2>Four columns, no surprises</h2>
        <p>
          <strong>Dry run</strong> is what the node does in the default free
          mode. &ldquo;Runs for real&rdquo; means the node executes its actual
          logic in a dry run because it costs nothing and reaches nothing
          external on its own. &ldquo;Stubbed&rdquo; means the engine
          intercepts the node before its executor runs and returns a
          placeholder in the real output shape: no money moves, no external
          system is touched.
        </p>
        <p>
          <strong>Effects</strong> are the node&apos;s declared capabilities:
          what it can read, write, send, spend, publish, or settle. A dash
          means the node is pure local computation. Subflow and Loop declare
          every effect because they run another flow: their true effects are
          whatever the inner flow contains, and the engine budgets them
          accordingly.
        </p>
        <p>
          <strong>Cost</strong> is the platform-side price.
          &ldquo;Variable&rdquo; covers three honest cases: AI nodes metered
          in gateway tokens, HTTP-shaped nodes whose real cost is whatever the
          target service bills you, and Subflow/Loop whose cost is the sum of
          what runs inside them. Fixed estimates are per call in USDC when the
          backing route is public. Internal operational profiles say
          &ldquo;Internal only&rdquo;; retired compatibility profiles say
          &ldquo;Route unavailable.&rdquo; Neither is part of the public price ledger.
          The pricing model behind all of this is documented in{" "}
          <Link href="/docs/payments" style={{ color: "var(--primary)" }}>
            Payments
          </Link>
          .
        </p>
        <p>
          Field-level detail for the four general-purpose workhorses (HTTP,
          Webhook, Transform, Loop), including caps, the SSRF guard, and the
          expression grammar, lives on the{" "}
          <Link href="/docs#nodes" style={{ color: "var(--primary)" }}>
            quick reference
          </Link>
          .
        </p>
      </section>

      {groups.map(({ group, nodes }) => (
        <section
          key={group}
          className="lp-doc docs-nodes-group"
          id={group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
          style={{
            ["--group" as string]: GROUP_COLOR[group],
            ["--group-ink" as string]: GROUP_INK[group],
          }}
        >
          <div className="docs-nodes-group-head">
            <span className="docs-nodes-swatch" aria-hidden="true" />
            <h2>{group}</h2>
            <span className="docs-nodes-count">
              {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
            </span>
          </div>
          <p>{GROUP_BLURB[group]}</p>
          <div className="docs-nodes-scroll">
            <table className="docs-nodes-table">
              <thead>
                <tr>
                  <th scope="col">Node</th>
                  <th scope="col">What it does</th>
                  <th scope="col">Dry run</th>
                  <th scope="col">Effects</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((definition) => (
                  <tr key={definition.type}>
                    <td>
                      <span className="docs-nodes-name">{definition.label}</span>
                      <span className="docs-nodes-type">{definition.type}</span>
                      {definition.prototype ? (
                        <span className="docs-nodes-proto">
                          {definition.prototype.badge}
                        </span>
                      ) : null}
                      {suedeProfileStatus(definition) === "internal" ? (
                        <span className="docs-nodes-proto">
                          Internal profile · not a public offering
                        </span>
                      ) : null}
                      {suedeProfileStatus(definition) === "compatibility" ? (
                        <span className="docs-nodes-proto">
                          Compatibility profile · route unavailable
                        </span>
                      ) : null}
                    </td>
                    <td>{definition.description}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{dryRunLabel(definition)}</td>
                    <td className="docs-nodes-effects">
                      {definition.effects.length > 0
                        ? definition.effects.join(" · ")
                        : "-"}
                    </td>
                    <td className="docs-nodes-price">{costLabel(definition)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="lp-doc lp-block" id="availability">
        <span className="lp-eyebrow">One honest footnote</span>
        <h2>Catalog versus palette</h2>
        <p>
          This page lists the complete authored catalog, including the
          Connector Lab&apos;s API Operation prototype, which is
          simulation-only and cannot be launched into a live agent (the launch
          API rejects graphs that contain it). The palette you see in the
          studio can additionally gate nodes by availability, so a node listed
          here may not be offered to every workspace yet. Music &amp; IP rows
          labeled &ldquo;Internal profile&rdquo; are not public offerings, while
          &ldquo;Compatibility profile&rdquo; rows are retained so older saved flows
          remain readable and do not claim a live route. The exact-three public
          gateway inventory lives on <Link href="/pricing#endpoints">Pricing</Link>.
        </p>
      </section>
    </>
  );
}
