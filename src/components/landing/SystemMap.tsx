/**
 * Homepage system map. Server component, purely presentational: the four
 * architecture units around the FlowGraph contract (Canvas, Contract, Engine,
 * Runtime) rendered as a wired chain, with a stat row whose numbers are read
 * from the modules the product actually ships. Nothing here is typed in where
 * a derivation exists; when the catalog grows, this section updates itself.
 *
 * Import safety: only client-safe pure-data modules are imported (node-meta,
 * suede-endpoints, company templates, template summaries). Never import
 * src/lib/flow/registry.ts or node executors here.
 */
import { Fragment } from "react";
import { NODE_META } from "@/lib/flow/node-meta";
import { PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS } from "@/lib/rails/suede-endpoints";
import { isPublicEndpointMarketingAllowed } from "@/lib/marketing-holds";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";
import { buildTemplateSummaries } from "@/lib/template-summaries";
import "./system-map.css";

/** Full authored catalog, including gated and prototype nodes. */
const NODE_TYPE_COUNT = NODE_META.length;
const NODE_CATEGORY_COUNT = new Set(NODE_META.map((meta) => meta.group)).size;

/** The public/discoverable Suede x402 allowlist — the same marketing filter
 * /pricing and /docs apply, so one exact-three count shows on every surface. */
const PAID_ENDPOINT_COUNT = PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS.filter(
  (endpoint) => isPublicEndpointMarketingAllowed(endpoint.id),
).length;

/** Implemented public protocol roles. x402 v2 on Base is caller settlement,
 * A2A is the agent interface, ERC-8004 is identity, and Stripe funds builder
 * credit. */
const ECOSYSTEM_REFERENCES = [
  "x402",
  "A2A",
  "ERC-8004",
  "Base",
  "Stripe",
] as const;

const FLOW_TEMPLATE_COUNT = buildTemplateSummaries().length;
const COMPANY_TEMPLATE_COUNT = COMPANY_TEMPLATES.length;

/** Matches MAX_SUBFLOW_DEPTH in src/lib/flow/engine.ts (server-only module). */
const SUBFLOW_DEPTH_LIMIT = 16;

interface SystemUnit {
  no: string;
  name: string;
  path: string;
  /** One plain-English line, for a reader who has never seen a node graph. */
  plain: string;
  /** Bright accent for the card's top bar and wire ticks. */
  bar: string;
  /** Darker twin for small text, holds contrast on white. */
  ink: string;
  points: readonly string[];
}

const UNITS: readonly SystemUnit[] = [
  {
    no: "01",
    name: "Canvas",
    path: "src/components/canvas",
    plain: "Where you build: drag steps onto a board and draw wires between them.",
    bar: "var(--registry-cyan)",
    ink: "var(--text-info)",
    points: [
      "Node graph editor built on @xyflow/react",
      `Palette of ${NODE_TYPE_COUNT} node types in ${NODE_CATEGORY_COUNT} color-coded groups`,
      "Port compatibility checked at wire time",
      "Test runs light each node as it executes",
    ],
  },
  {
    no: "02",
    name: "Contract",
    path: "src/lib/flow/types.ts",
    plain: "What a flow is, written down once, so every part agrees on it.",
    bar: "var(--primary)",
    ink: "var(--primary)",
    points: [
      "One typed FlowGraph shared by canvas, engine, and runtime",
      "zod validation at every external boundary",
      "Client-safe catalog projection keeps executors out of the browser bundle",
      "Versioned graph codec, so saved flows survive schema upgrades",
    ],
  },
  {
    no: "03",
    name: "Engine",
    path: "src/lib/flow/engine.ts",
    plain: "What runs the flow: step by step, in order, on a budget.",
    bar: "var(--amber)",
    ink: "var(--text-warning)",
    points: [
      "Topological run order over the wired graph",
      "Per-node USDC ledger, with a run cost ceiling that halts overspend",
      "A failed node halts its branch; independent branches finish",
      `Subflow nesting capped at ${SUBFLOW_DEPTH_LIMIT} levels`,
    ],
  },
  {
    no: "04",
    name: "Runtime",
    path: "src/lib/run-service.ts + src/app/api",
    plain: "What serves the flow: a URL people and other agents can call.",
    bar: "var(--verified-emerald)",
    ink: "var(--text-success)",
    points: [
      "Payment-enabled calls use x402 v2; published agents otherwise remain previews",
      "Runs stream live over SSE, event by event",
      ".well-known discovery cards for agent-to-agent callers",
      "A cron tick wakes every scheduled flow",
    ],
  },
];

const STATS: readonly { value: number; label: string }[] = [
  { value: NODE_TYPE_COUNT, label: "node types in the catalog" },
  { value: NODE_CATEGORY_COUNT, label: "palette categories" },
  { value: PAID_ENDPOINT_COUNT, label: "public Suede x402 routes" },
  {
    value: ECOSYSTEM_REFERENCES.length,
    label: "commerce, interface & identity references",
  },
  { value: FLOW_TEMPLATE_COUNT, label: "agent templates" },
  { value: COMPANY_TEMPLATE_COUNT, label: "company templates" },
];

export default function SystemMap(): React.JSX.Element {
  return (
    <section id="system-map" className="lp-section" style={{ paddingTop: 0 }}>
      <div className="lp-shell">
        <span className="lp-eyebrow reveal">The system map</span>
        <h2 className="lp-section-title reveal" style={{ animationDelay: "0.06s" }}>
          The machine under the canvas.
        </h2>
        <p className="lp-section-sub reveal" style={{ animationDelay: "0.12s" }}>
          A flow is a graph: every node does one job, and a wire carries one
          node&apos;s output into the next. This is the studio&apos;s actual
          architecture, not a metaphor. Four units meet at one typed FlowGraph
          contract, and every count below is read from the same modules the
          product ships: the node catalog, the public endpoint allowlist, and
          the template registry. When the code grows, this section updates
          itself.
        </p>
        <div className="lp-sysmap-flow reveal" style={{ animationDelay: "0.18s" }}>
          {UNITS.map((unit, i) => (
            <Fragment key={unit.no}>
              <article
                className="lp-sysmap-unit"
                style={{
                  ["--u" as string]: unit.bar,
                  ["--u-ink" as string]: unit.ink,
                }}
              >
                <span className="lp-sysmap-no">{unit.no}</span>
                <h3>{unit.name}</h3>
                <p className="lp-sysmap-plain">{unit.plain}</p>
                <code className="lp-sysmap-path">{unit.path}</code>
                <ul>
                  {unit.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </article>
              {i < UNITS.length - 1 && (
                <span className="lp-sysmap-wire" aria-hidden="true" />
              )}
            </Fragment>
          ))}
        </div>
        <div className="lp-sysmap-stats reveal" style={{ animationDelay: "0.24s" }}>
          {STATS.map((stat) => (
            <div key={stat.label} className="lp-stat">
              <b className="tabular">{stat.value}</b>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
        <p className="lp-sysmap-caption reveal" style={{ animationDelay: "0.3s" }}>
          Per-node cost ledger · SSE run streaming · Cron scheduling ·{" "}
          {SUBFLOW_DEPTH_LIMIT}-deep subflow guard · Preview by default ·
          Payment opt-in
        </p>
      </div>
    </section>
  );
}
