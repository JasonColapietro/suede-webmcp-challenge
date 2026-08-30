/** Docs / Examples — six concrete workflow patterns with catalog-verified links. */
import type { Metadata } from "next";
import Link from "next/link";
import CopyBlock from "@/components/agent/CopyBlock";
import { buildCatalog } from "@/lib/catalog";
import {
  resolveDocsExamples,
  type ResolvedDocsExample,
} from "@/lib/docs-examples";
import { SITE_URL } from "@/lib/site";

export const revalidate = 300;

export const metadata: Metadata = {
  title: { absolute: "Examples | Suede Agent Studio" },
  description:
    "Six concrete agent workflow patterns: chasing invoices, scanning contracts, triaging support tickets, qualifying leads, and one agent paying another to run it.",
  alternates: { canonical: "/docs/examples" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/examples",
    siteName: "Suede Agent Studio",
    title: "Examples | Suede Agent Studio",
    description:
      "Six concrete agent workflow patterns: chasing invoices, scanning contracts, triaging support tickets, qualifying leads, and one agent paying another to run it.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Examples | Suede Agent Studio",
    description:
      "Six concrete agent workflow patterns: chasing invoices, scanning contracts, triaging support tickets, qualifying leads, and one agent paying another to run it.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

async function loadExamples(): Promise<ResolvedDocsExample[]> {
  try {
    return resolveDocsExamples(await buildCatalog());
  } catch {
    return resolveDocsExamples([]);
  }
}

function agentToAgentCurl(liveSlug: string | null): string {
  const slug = liveSlug ?? "<published-agent-slug>";
  return [
  `# any caller (a script, a bot, another agent) can run this directly`,
  `curl -X POST ${SITE_URL}/api/agents/${slug}/run \\`,
  `  -H 'content-type: application/json' \\`,
  `  -d '{ "input": { "company": "Acme Robotics", "employees": 40, "interest": "warehouse automation" } }'`,
  ``,
  `# input fields mirror this flow's Input node; check any agent's page`,
  `# or its .well-known/x402 for the exact shape before calling.`,
  ``,
  `# first response is a 402 with the price and payment terms;`,
  `# the caller's wallet signs and pays, then gets the real output.`,
  `# no account, no API key issued by Suede; the wallet is the identity.`,
  ].join("\n");
}

export default async function ExamplesPage(): Promise<React.JSX.Element> {
  const examples = await loadExamples();
  const leadQualifier = examples.find(
    (example) => example.templateSlug === "lead-qualifier",
  );
  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · Examples</span>
          <h1>How people actually use this.</h1>
          <p>
            Six workflow patterns from the{" "}
            <Link href="/templates" style={{ color: "var(--primary)" }}>
              catalog
            </Link>
            . A public listing appears only when the current live catalog
            confirms one; otherwise the example links to its buildable
            template instead of guessing a launch URL.
          </p>
        </header>

        <section className="lp-doc lp-block" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">01 · Six agents, six callers</span>
          <h2>A live endpoint when one is published.</h2>
          <p>
            Four of these are run by their own owner in the studio, where
            normal volume stays inside the free monthly token allowance and no
            wallet is involved. A listed price applies only to a stranger
            calling a currently published version directly.
          </p>
          <div>
            {examples.map((example, i) => (
              <div className="lp-doc-step" key={example.templateSlug}>
                <span className="n">{i + 1}</span>
                <div>
                  <h3>{example.who}</h3>
                  <p>{example.what}</p>
                  <p style={{ margin: 0 }}>
                    {example.listing ? (
                      <>
                        <Link
                          href={example.listing.href}
                          className="mono"
                          style={{ color: "var(--primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}
                        >
                          {example.listing.name}
                        </Link>{" "}
                        <span
                          className="lp-pill lp-pill--price tabular"
                          style={{ marginLeft: "0.5rem" }}
                        >
                          ${example.listing.priceUsdc.toFixed(2)} / call
                        </span>
                      </>
                    ) : (
                      <>
                        <Link
                          href={`/build/new?template=${example.templateSlug}`}
                          className="mono"
                          style={{ color: "var(--primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}
                        >
                          Build {example.agentName}
                        </Link>{" "}
                        <span style={{ marginLeft: "0.5rem", color: "var(--text-muted)" }}>
                          No public listing right now
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-doc lp-block" id="agent-to-agent">
          <span className="lp-eyebrow">02 · What calling one looks like</span>
          <h2>The caller can be a machine.</h2>
          <p>
            Every published agent reports whether it offers a preview, accepts
            payment, or is currently unavailable. A script, CI bot, or another
            agent&apos;s pipeline can use the advertised path: preview calls send
            an explicit dry-run, while payment-enabled calls receive an x402
            challenge before the caller&apos;s wallet signs and retries. No Suede
            account is required for an available public call.
          </p>
          <CopyBlock code={agentToAgentCurl(leadQualifier?.listing?.slug ?? null)} />
        </section>

        <section className="lp-doc lp-block" id="next">
          <span className="lp-eyebrow">Next</span>
          <h2>Browse the rest, or build your own.</h2>
          <p>
            The six above are a sample.{" "}
            <Link href="/agents" style={{ color: "var(--primary)" }}>
              The directory
            </Link>{" "}
            lists every live agent, and{" "}
            <Link href="/templates" style={{ color: "var(--primary)" }}>
              the template catalog
            </Link>{" "}
            covers legal, finance, sales, support, dev, ops, HR, e-commerce,
            insurance, and real estate. If the one you need isn&apos;t there
            yet, the same visual canvas builds it: wire it, set a price, and
            it&apos;s a live paid endpoint in minutes. See{" "}
            <Link href="/docs" style={{ color: "var(--primary)" }}>
              the full docs
            </Link>{" "}
            for how calling, publishing, and the SDK work.
          </p>
        </section>
    </>
  );
}
