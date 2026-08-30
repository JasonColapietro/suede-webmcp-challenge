/**
 * Docs / Architecture — the landing page's system map at documentation depth.
 * Every claim mirrors shipped code: engine semantics from
 * src/lib/flow/engine.ts and executor.ts, run events from
 * src/lib/flow/types.ts, ceilings from run-context.ts, promotion from
 * src/lib/projects/deployment-service.ts. State facts, cite sparingly.
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";

const PAGE_TITLE = "Architecture | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "How Agent Studio actually runs a flow: the FlowGraph contract, topological execution, the per-node cost ledger, error-branch halting, the subflow depth guard, SSE streaming, versioned promotion to Live, and dry-run settlement.";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/architecture" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/architecture",
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

const RUN_EVENTS = [
  `run:start    { runId, at }`,
  `node:start   { runId, nodeId, nodeType }`,
  `node:log     { runId, nodeId, level: "info" | "error", msg }`,
  `node:done    { runId, nodeId, nodeType, outputs, costUsdc }`,
  `node:error   { runId, nodeId, nodeType, error, costCeilingExceeded? }`,
  `run:done     { runId, totalCostUsdc, status, abortedReason? }`,
].join("\n");

interface ArchUnit {
  no: string;
  name: string;
  path: string;
  color: string;
  body: string;
}

const UNITS: ArchUnit[] = [
  {
    no: "01",
    name: "Canvas",
    path: "src/components/canvas",
    color: "var(--text-info)",
    body: "The visual editor, built on @xyflow/react. It edits a plain data structure, never code: dragging a node adds an entry to a list, wiring an edge adds a connection between typed ports, and port compatibility is checked at wire time. The canvas imports only the client-safe catalog projection, so no executor code ever reaches the browser bundle.",
  },
  {
    no: "02",
    name: "Contract",
    path: "src/lib/flow/types.ts",
    color: "var(--primary)",
    body: "One typed FlowGraph shared by everything: a list of nodes with typed params and a list of edges connecting output ports to input ports. zod validates it at every external boundary, and the graph codec is versioned, so flows saved under an older schema still parse. Because the contract is plain data, the same graph can be edited, exported as a template, validated at launch, and executed, without translation between representations.",
  },
  {
    no: "03",
    name: "Engine",
    path: "src/lib/flow/engine.ts",
    color: "var(--text-warning)",
    body: "An async generator that walks the graph in topological order and yields run events as it goes. It owns every execution guarantee on this page: dependency ordering, branch skipping, error halting, the cost ledger, the spend ceiling, the depth guard, and the dry-run gate.",
  },
  {
    no: "04",
    name: "Runtime",
    path: "src/lib/run-service.ts + src/app/api",
    color: "var(--text-success)",
    body: "The hosted API around the engine: flow CRUD, streamed runs over SSE, cron-driven schedules, HMAC-signed webhooks, and, after launch, an x402-gated public run endpoint per agent plus machine-readable discovery documents. The runtime decides who may run what and whether money moves; the engine only ever executes what it is handed.",
  },
];

export default function ArchitecturePage(): React.JSX.Element {
  return (
    <>
      <header className="lp-page-head">
        <span className="lp-eyebrow">Docs · Architecture</span>
        <h1>The machine under the canvas</h1>
        <p>
          The{" "}
          <Link href="/docs/overview" style={{ color: "var(--primary)" }}>
            overview
          </Link>{" "}
          names the four parts; this page specifies how they behave. Every
          claim here mirrors shipped code, and where a number appears (a
          ceiling, a depth, a default) it is the number the engine enforces,
          not a rounded aspiration.
        </p>
      </header>

      <section className="lp-doc lp-block" id="units" style={{ marginTop: 0 }}>
        <span className="lp-eyebrow">The shape</span>
        <h2>Four units, one contract</h2>
        <p>
          Everything meets at the FlowGraph. The canvas writes it, the
          contract types and validates it, the engine executes it, and the
          runtime wraps the engine in HTTP, payments, and scheduling. No unit
          reaches around the contract to talk to another.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1rem" }}>
          {UNITS.map((unit) => (
            <div key={unit.no} className="card" style={{ padding: "1.4rem 1.6rem" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.7rem", flexWrap: "wrap" }}>
                <span className="mono" style={{ color: unit.color, fontSize: "var(--text-xs)", fontWeight: 600 }}>
                  {unit.no}
                </span>
                <h3 style={{ margin: 0 }}>{unit.name}</h3>
                <code className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  {unit.path}
                </code>
              </div>
              <p style={{ margin: "0.6rem 0 0", fontSize: "var(--text-sm)", lineHeight: 1.65 }}>
                {unit.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-doc lp-block" id="execution">
        <span className="lp-eyebrow">Execution semantics</span>
        <h2>What the engine guarantees on every run</h2>
        <p>
          <strong>Topological order.</strong> A node executes when every node
          feeding its inputs has finished. Edges are simultaneously the data
          flow and the execution order; there is no hidden shared state a
          node could read around them.
        </p>
        <p>
          <strong>Branches skip, they don&apos;t fail.</strong> When a Branch
          or Switch activates one outgoing path, nodes on the inactive paths
          are marked skipped, a first-class node status distinct from error.
          A skipped node charges nothing and emits nothing downstream.
        </p>
        <p>
          <strong>Errors halt the branch, not the run.</strong> When a node
          fails, everything downstream of it is halted so no later step runs
          against missing data, and nothing downstream is charged. Independent
          branches that don&apos;t depend on the failed node finish normally.
          The run then reports status error with every per-node outcome
          preserved.
        </p>
        <p>
          <strong>The cost ledger.</strong> Every node execution is recorded
          to the run&apos;s ledger: node id, node type, terminal status, the
          USDC it cost, and whether that cost settled for real. The final run
          event carries the total. This is the same ledger the run dock
          renders live and the one you can audit after the fact.
        </p>
        <p>
          <strong>The spend ceiling.</strong> Before every cost-bearing node,
          the engine checks one in-run ceiling: the minimum of the per-run cap
          (the RUN_COST_CEILING_USDC environment variable, $5 when unset) and
          the agent&apos;s remaining daily budget at run start. Crossing it
          aborts the run with an explicit cost-ceiling marker on both the
          failing node event and the final run event. Subflows and loops
          share the parent run&apos;s ceiling by reference, so a nested run
          cannot escape the budget by being nested, and a ceiling abort
          inside an iteration aborts the whole run instead of hiding in a
          per-item error list.
        </p>
        <p>
          <strong>The depth guard.</strong> Subflow and Loop nodes run their
          inner flow one level deeper than the run that called them, and the
          engine refuses any run deeper than 16 levels. The guard exists to
          stop runaway recursion (a flow that loops itself), not to be
          designed against.
        </p>
        <p>
          <strong>Dry-run is deny-by-default.</strong> The engine stubs any
          node declared cost-bearing or side-effecting before its executor
          runs. The gate fails safe: a node that requires a stub but
          doesn&apos;t declare one is refused outright rather than allowed to
          run for real, and an enumeration test pins the full catalog so a
          new node cannot ship without declaring its dry-run behavior. Which
          nodes are stubbed is listed per node in the{" "}
          <Link href="/docs/nodes" style={{ color: "var(--primary)" }}>
            node reference
          </Link>
          .
        </p>
        <p>
          <strong>Tenant isolation at the graph boundary.</strong> A Subflow
          or Loop node can only load flows belonging to the same owner, and a
          flow that is missing returns the same error as a flow owned by
          someone else, so a graph cannot be used to probe for the existence
          of another tenant&apos;s private flows.
        </p>
      </section>

      <section className="lp-doc lp-block" id="streaming">
        <span className="lp-eyebrow">Streaming</span>
        <h2>Runs are event streams, not polling loops</h2>
        <p>
          The engine yields typed events as it executes, and the runtime
          forwards them verbatim as Server-Sent Events. The run dock in the
          studio and an API caller watching a run consume the identical
          stream:
        </p>
        <pre className="lp-code" style={{ marginTop: "0.9rem" }}>{RUN_EVENTS}</pre>
        <p style={{ marginTop: "0.9rem" }}>
          Two details worth noticing. Cost arrives per node, on each
          node:done, so a watcher sees spend accumulate in real time rather
          than discovering it in a summary. And a cost-ceiling abort is
          distinguishable from an ordinary failure on both the node event and
          the final run:done, so a client can tell &ldquo;this step
          broke&rdquo; from &ldquo;this run ran out of budget&rdquo; without
          parsing error strings.
        </p>
      </section>

      <section className="lp-doc lp-block" id="versioning">
        <span className="lp-eyebrow">Versioning &amp; promotion</span>
        <h2>Drafts change, versions don&apos;t, Live points at a version</h2>
        <p>
          Every flow keeps one mutable draft and any number of immutable
          saved versions. Deployment is environment-based, like software:
          you promote a saved version to the Test environment, watch it run,
          and only then promote to Live. Promotion is deliberate on purpose:
          the API requires a typed confirmation (PROMOTE TEST or PROMOTE
          LIVE) and pins the exact version being deployed by hash, so a
          concurrent edit cannot swap the graph between your approval and
          the deploy.
        </p>
        <p>
          What Live runs is therefore exactly what you promoted: editing the
          draft after promotion changes nothing in production until you
          promote again. Version pinning extends through subflows, and the
          Live path refuses graphs containing the Connector Lab&apos;s
          simulation-only API Operation node, the same rule{" "}
          <Link href="/docs/launching" style={{ color: "var(--primary)" }}>
            launch validation
          </Link>{" "}
          enforces.
        </p>
      </section>

      <section className="lp-doc lp-block" id="settlement">
        <span className="lp-eyebrow">Settlement posture</span>
        <h2>Money is opt-in at every layer</h2>
        <p>
          Settlement defaults to dry-run globally, per agent, and per
          request: no USDC moves until an agent&apos;s creator explicitly
          enables it, and an explicit dry-run request always stays free. On
          the selling side, a priced live call is verified and settled on
          Base before the flow executes, and the response&apos;s settled
          field is true only when a real payment settled. The caller&apos;s
          view of that handshake is in{" "}
          <Link href="/docs/api" style={{ color: "var(--primary)" }}>
            API for callers
          </Link>
          ; the money model end to end is in{" "}
          <Link href="/docs/payments" style={{ color: "var(--primary)" }}>
            Payments
          </Link>
          .
        </p>
      </section>
    </>
  );
}
