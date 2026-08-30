/**
 * Docs / Building flows — the canvas walkthrough: nodes by group, edges and
 * data flow, testing with the run dock, and dry-run semantics. Node caps and
 * behaviors mirror the executors in src/lib/flow/nodes.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { NODE_META, NODE_GROUP_ORDER } from "@/lib/flow/node-meta";

const PAGE_TITLE = "Building a flow | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Nodes, edges, and testing: how a flow goes from a blank canvas to a working agent. Node groups, data flow between ports, the run dock, and exactly what a dry run executes.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/building-flows" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/building-flows",
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

export default function BuildingFlowsPage(): React.JSX.Element {
  const groups = NODE_GROUP_ORDER.map((group) => ({
    group,
    nodes: NODE_META.filter((meta) => meta.group === group),
  })).filter((entry) => entry.nodes.length > 0);

  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · Building flows</span>
          <h1>Nodes, edges, and testing</h1>
          <p>
            A flow is a graph you can read: nodes do the work, edges carry
            data between them, and a run executes the graph in dependency
            order. This page walks the three things you actually do on the
            canvas: place nodes, wire them, and test the result.
          </p>
        </header>

        <section className="lp-doc lp-block" id="nodes" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">01 · Nodes</span>
          <h2>Every step is a node with typed params</h2>
          <p>
            Drag a node from the palette and its config panel shows typed
            fields: strings, numbers, selects, JSON. A node declares input
            and output ports; what arrives on the inputs plus the node&apos;s
            own params determines what it emits on the outputs. Nodes that
            cost money show their USDC price directly on the card, so a
            flow&apos;s worst-case cost is visible while you build it.
          </p>
          <p>The palette groups nodes by what they do:</p>
          <div className="lp-rows" style={{ marginTop: "1rem" }}>
            {groups.map(({ group, nodes }) => (
              <div key={group} className="lp-row" style={{ cursor: "default" }}>
                <span className="lp-pill">{group}</span>
                <div className="grow">
                  <div className="sub" style={{ lineHeight: 1.6 }}>
                    {nodes
                      .map(
                        (meta) =>
                          meta.label +
                          (meta.priceUsdc !== undefined ? ` ($${meta.priceUsdc.toFixed(3)})` : ""),
                      )
                      .join(" · ")}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p style={{ marginTop: "1rem" }}>
            A minimal working flow is three nodes: <strong>Input → LLM →
            Output</strong>. Input defines what a caller (or the schedule, or
            a webhook) provides; LLM does the judgment step; Output names
            what the run returns. Everything else (HTTP fetches, branches,
            transforms, loops) earns its place by making that spine more
            capable. Field-level reference for HTTP, Webhook, Transform, and
            Loop (caps, SSRF guard, expression grammar, failure policy) is on
            the{" "}
            <Link href="/docs#nodes" style={{ color: "var(--primary)" }}>
              main reference page
            </Link>
            ; the complete catalog, every node type with its dry-run
            behavior, effects, and cost, is the{" "}
            <Link href="/docs/nodes" style={{ color: "var(--primary)" }}>
              node reference
            </Link>
            .
          </p>
        </section>

        <section className="lp-doc lp-block" id="edges">
          <span className="lp-eyebrow">02 · Edges</span>
          <h2>Edges are the data flow and the execution order</h2>
          <p>
            An edge connects one node&apos;s output port to another
            node&apos;s input port. That single connection means two things
            at once: the downstream node receives the upstream node&apos;s
            output as input, and the engine will not run the downstream node
            until the upstream one has finished. There is no hidden shared
            state: if a node needs a value, a path of edges must carry it
            there.
          </p>
          <p>
            Routing is explicit. A <strong>Branch</strong> node evaluates its
            condition and activates exactly one of its outgoing paths; nodes
            on the inactive path are skipped, not failed. Reshaping is
            explicit too: when the JSON coming out of one node does not match
            what the next node expects, put a <strong>Transform</strong>{" "}
            between them rather than asking an LLM to reformat data. String
            params in several nodes also support{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
              {"{{path}}"}
            </span>{" "}
            interpolation from upstream values: the HTTP node&apos;s URL,
            headers, and body all take it.
          </p>
          <p>
            Two structural rules the studio enforces rather than trusts you
            to remember: the graph must actually be wired together before it
            can launch (a disconnected island of nodes is a validation error,
            not a warning), and subflow nesting is bounded by the
            engine&apos;s depth guard: subflows and loops can nest inside
            each other up to 16 levels deep, all sharing one in-run cost
            ceiling, and a run that would go deeper fails at that boundary.
            Fan-out over a list is the <strong>Loop</strong> node&apos;s
            job, with concurrency capped at 4 and iterations at 200.
          </p>
        </section>

        <section className="lp-doc lp-block" id="testing">
          <span className="lp-eyebrow">03 · Testing</span>
          <h2>Run it, watch every node, spend nothing</h2>
          <p>
            The run dock executes the flow and streams progress node by node:
            status, output, and cost per node, plus a running USDC total for
            the whole run. When something fails, the dock shows which node
            failed and with what error; downstream nodes on that path never
            run against bad data.
          </p>
          <p>
            Runs are <strong>dry-run by default</strong>, and the semantics
            are precise rather than approximate. The engine stubs exactly the
            nodes that are cost-bearing or side-effecting: LLM returns
            without calling the model, HTTP returns a fixed placeholder
            envelope without touching the network, and paid Suede endpoint
            nodes never settle. Everything else (Input, Output, Branch,
            Transform, Schedule, Webhook, Subflow, Loop) executes for real.
            A dry-run loop genuinely iterates; it just passes dry-run mode
            through to every inner run so nothing inside can spend.
          </p>
          <p>
            That split tells you what each kind of test proves. A dry run is
            a complete test of your graph&apos;s structure: wiring, branch
            logic, transform expressions, loop behavior, output shape. It
            proves nothing about prompt quality or the real behavior of an
            external API; for that, flip the run to live in the studio and
            pay the actual node costs for a handful of runs. Test with both
            before launching; the{" "}
            <Link href="/docs/launching" style={{ color: "var(--primary)" }}>
              launch step
            </Link>{" "}
            is deliberately boring if the flow already behaves.
          </p>
          <p>
            Budget guards apply even while testing: every run shares one
            in-run cost ceiling (the minimum of the per-run cap, $5 unless
            configured otherwise, and the agent&apos;s remaining daily
            budget), checked before each cost-bearing node. A runaway loop
            aborts at the ceiling instead of draining anything.
          </p>
        </section>

        <section className="lp-doc lp-block">
          <span className="lp-eyebrow">Next</span>
          <h2>From working flow to paid endpoint</h2>
          <p>
            When the flow does what you want against ugly inputs as well as
            clean ones, continue to{" "}
            <Link href="/docs/launching" style={{ color: "var(--primary)" }}>
              Launching
            </Link>
            . For design judgment rather than mechanics (how narrow to make
            LLM steps, where to put branches, what to do with loop errors),
            read{" "}
            <Link href="/articles/designing-agent-flows" style={{ color: "var(--primary)" }}>
              Designing a good agent flow
            </Link>
            .
          </p>
        </section>
    </>
  );
}
