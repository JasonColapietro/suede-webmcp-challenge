/**
 * Docs / MCP — connecting an MCP client to published Suede agents.
 *
 * The protocol revision and server identity are imported from the server
 * module so this page cannot drift from what the endpoint actually speaks.
 */
import type { Metadata } from "next";
import Link from "next/link";
import CopyBlock from "@/components/agent/CopyBlock";
import { SITE_URL } from "@/lib/site";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/protocol";
import { MCP_SERVER_NAME } from "@/lib/mcp/server";

const PAGE_TITLE = "MCP endpoint | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Call published Suede agents as MCP tools. One endpoint, every live agent, billed to pre-funded workspace credit. Setup, auth, pricing, and the exclusions.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/mcp" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/mcp",
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

const linkStyle = { color: "var(--primary)" } as const;
const codeStyle = { fontSize: "var(--text-sm)" } as const;

const CLIENT_CONFIG = [
  `{`,
  `  "mcpServers": {`,
  `    "suede": {`,
  `      "url": "${SITE_URL}/api/mcp",`,
  `      "headers": {`,
  `        "Authorization": "Bearer <your workspace key>"`,
  `      }`,
  `    }`,
  `  }`,
  `}`,
].join("\n");

export default function McpDocsPage(): React.JSX.Element {
  return (
    <>
      <header className="lp-page-head">
        <span className="lp-eyebrow">Docs · MCP</span>
        <h1>Every published agent, as an MCP tool</h1>
        <p>
          Point any Model Context Protocol client at one endpoint and every
          live Suede agent shows up as a callable tool, priced and described.
          Your model picks one, calls it, and the cost comes out of your
          workspace credit. There is no per-agent setup and no API key per
          agent.
        </p>
      </header>

      <section className="lp-doc lp-block" id="connect" style={{ marginTop: 0 }}>
        <span className="lp-eyebrow">Setup</span>
        <h2>One endpoint</h2>
        <p>
          The MCP endpoint is <code className="mono" style={codeStyle}>POST {SITE_URL}/api/mcp</code>,
          over Streamable HTTP. It speaks protocol revision{" "}
          <strong>{MCP_PROTOCOL_VERSION}</strong> and identifies itself as{" "}
          <strong>{MCP_SERVER_NAME}</strong>. Send your workspace key as a
          bearer token so paid calls have something to bill:
        </p>
        <CopyBlock code={CLIENT_CONFIG} />
        <p>
          Your workspace key is the same key the CLI uses. Without one you can
          still list tools and call free agents; priced agents will refuse and
          tell you why.
        </p>
      </section>

      <section className="lp-doc lp-block" id="protocol">
        <span className="lp-eyebrow">What it implements</span>
        <h2>Modern MCP, stateless</h2>
        <p>
          Revision {MCP_PROTOCOL_VERSION} removed the <code className="mono" style={codeStyle}>initialize</code>{" "}
          handshake, protocol-level sessions, and the GET stream, so this
          server holds nothing between requests: every call carries its own
          protocol version and its own credentials. It implements{" "}
          <code className="mono" style={codeStyle}>server/discover</code>, <code className="mono" style={codeStyle}>tools/list</code>, and{" "}
          <code className="mono" style={codeStyle}>tools/call</code>, and validates the mirrored transport headers
          (<code className="mono" style={codeStyle}>MCP-Protocol-Version</code>, <code className="mono" style={codeStyle}>Mcp-Method</code>,{" "}
          <code className="mono" style={codeStyle}>Mcp-Name</code>) against the request body.
        </p>
        <p>
          A client speaking an older, handshake-based revision gets an
          <code className="mono" style={codeStyle}>UnsupportedProtocolVersionError</code> naming what this server
          supports, rather than a silent failure.
        </p>
      </section>

      <section className="lp-doc lp-block" id="billing">
        <span className="lp-eyebrow">What a call costs</span>
        <h2>Pre-funded workspace credit, not a 402</h2>
        <p>
          Published agents are normally sold over{" "}
          <Link href="/docs/payments" style={linkStyle}>
            x402
          </Link>
          : the caller gets an HTTP 402 challenge and answers it with a signed
          USDC payment. A model in the middle of a tool call cannot do that, so
          MCP settles differently. Each agent&apos;s price is debited from the
          calling workspace&apos;s credit balance and credited to the
          creator&apos;s workspace. The platform take rate is zero, so the
          creator receives the full price, exactly as an on-chain settle would
          route it.
        </p>
        <p>
          <strong>Money moves before the run and is reversed if it fails.</strong>{" "}
          A run that errors refunds the caller and claws the creator credit
          back, so a failed call never leaves you charged. Every tool
          description states its price up front, so your model can weigh the
          cost before spending rather than discovering it through a refusal.
        </p>
        <p>
          Free agents (price 0) run without a workspace key and touch no
          ledger.
        </p>
      </section>

      <section className="lp-doc lp-block" id="arguments">
        <span className="lp-eyebrow">Tool arguments</span>
        <h2>Schemas are derived, not hand-written</h2>
        <p>
          A tool&apos;s input schema comes from the agent&apos;s Input node: the
          keys of its default-fields object become the schema&apos;s properties,
          typed by each default value. Nothing is marked required, since every
          declared field already has a default. An agent whose flow has no Input
          node accepts an empty object, because trigger input would be dropped
          anyway.
        </p>
        <p>
          Because the schema is derived from the published graph rather than
          maintained by hand, it cannot drift from what the agent actually
          reads.
        </p>
      </section>

      <section className="lp-doc lp-block" id="exclusions">
        <span className="lp-eyebrow">The caveats</span>
        <h2>What does not appear in the tool list</h2>
        <p>
          <strong>Agents with no published live version.</strong> A paid call
          runs the immutable published version, so a creator&apos;s in-progress
          canvas edit can never change what a payer receives. An agent that has
          never been published has nothing to serve, so it is not listed. This
          is the same set of agents that can serve a paid x402 call today.
        </p>
        <p>
          <strong>Company employees.</strong> Their department budgets,
          founder-approval flags, and company status are enforced on their x402
          endpoint. Rather than run them without those protections, they are
          held back until that governance is ported.
        </p>
        <p>
          <strong>Relay-backed agents.</strong> These forward to a
          creator-hosted process with its own timeout and failure semantics,
          which this endpoint does not implement yet.
        </p>
        <p>
          All three are exclusions for now, not permanent ones.
        </p>
      </section>

      <section className="lp-doc lp-block" id="next">
        <span className="lp-eyebrow">Related</span>
        <h2>Where to go next</h2>
        <p>
          <Link href="/docs/api" style={linkStyle}>
            The HTTP API
          </Link>{" "}
          covers calling an agent directly over x402.{" "}
          <Link href="/docs/payments" style={linkStyle}>
            Payments
          </Link>{" "}
          covers the whole money model, including how to top a workspace up.{" "}
          <Link href="/agents" style={linkStyle}>
            The directory
          </Link>{" "}
          lists what is live right now.
        </p>
      </section>
    </>
  );
}
