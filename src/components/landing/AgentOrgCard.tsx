/** The landing page's one org-chart visual language: a seat card (agent brand
 * mark in a department-tinted tile, role prominent, agent name beneath, LIVE
 * dot + optional per-call price on earning seats, cadence chip on scheduled
 * seats) and the elbow-connector tree that arranges seats into a company. The
 * hero (HeroOrgChart), this "bring your own agent" card, CompanyPreviewCard,
 * and JourneyAltitudes all compose these same pieces so the page shows one
 * product, not four sketches. */
import { AgentMark } from "./AgentMarks";

/** Lightweight mirror of the real node catalog for the server-rendered hero.
 * Keeping this local avoids pulling the React Flow canvas into the landing
 * page; a focused contract checks every node against NODE_TYPE_SET. */
export interface SeatStepMeta {
  node: string;
  group: string;
  color: string;
  ink: string;
  spoken: string;
}

export const SEAT_STEP_META = {
  input: {
    node: "input",
    group: "I/O",
    color: "var(--text-muted)",
    ink: "var(--text-secondary)",
    spoken: "input",
  },
  output: {
    node: "output",
    group: "I/O",
    color: "var(--text-muted)",
    ink: "var(--text-secondary)",
    spoken: "output",
  },
  cron: {
    node: "schedule",
    group: "Triggers",
    color: "var(--violet)",
    ink: "var(--primary-hover)",
    spoken: "schedule trigger",
  },
  llm: {
    node: "llm",
    group: "AI",
    color: "var(--primary)",
    ink: "var(--primary-hover)",
    spoken: "LLM",
  },
  classify: {
    node: "ai.classify",
    group: "AI",
    color: "var(--primary)",
    ink: "var(--primary-hover)",
    spoken: "classifier",
  },
  branch: {
    node: "branch",
    group: "Logic",
    color: "var(--amber)",
    ink: "var(--text-warning)",
    spoken: "branch",
  },
  switch: {
    node: "logic.switch",
    group: "Logic",
    color: "var(--amber)",
    ink: "var(--text-warning)",
    spoken: "switch",
  },
  rollup: {
    node: "logic.aggregate",
    group: "Logic",
    color: "var(--amber)",
    ink: "var(--text-warning)",
    spoken: "aggregate",
  },
  subflow: {
    node: "subflow",
    group: "Logic",
    color: "var(--amber)",
    ink: "var(--text-warning)",
    spoken: "subflow",
  },
  transform: {
    node: "transform",
    group: "Logic",
    color: "var(--amber)",
    ink: "var(--text-warning)",
    spoken: "transform",
  },
  fetch: {
    node: "web.fetchUrl",
    group: "Docs & Data",
    color: "var(--category-docs)",
    ink: "var(--category-docs)",
    spoken: "URL fetch",
  },
  sheet: {
    node: "data.parseSpreadsheet",
    group: "Docs & Data",
    color: "var(--category-docs)",
    ink: "var(--category-docs)",
    spoken: "spreadsheet parse",
  },
  filter: {
    node: "data.filterRows",
    group: "Docs & Data",
    color: "var(--category-docs)",
    ink: "var(--category-docs)",
    spoken: "row filter",
  },
  search: {
    node: "docs.knowledgeSearch",
    group: "Docs & Data",
    color: "var(--category-docs)",
    ink: "var(--category-docs)",
    spoken: "knowledge search",
  },
  slack: {
    node: "comms.slackMessage",
    group: "Comms & CRM",
    color: "var(--category-comms)",
    ink: "var(--text-secondary)",
    spoken: "Slack message",
  },
  crm: {
    node: "comms.crmWebhook",
    group: "Comms & CRM",
    color: "var(--category-comms)",
    ink: "var(--text-secondary)",
    spoken: "CRM webhook",
  },
  github: {
    node: "devops.githubRead",
    group: "Dev & Infra",
    color: "var(--category-devops)",
    ink: "var(--text-warning)",
    spoken: "GitHub read",
  },
  issue: {
    node: "devops.githubIssue",
    group: "Dev & Infra",
    color: "var(--category-devops)",
    ink: "var(--text-warning)",
    spoken: "GitHub issue",
  },
  ci: {
    node: "devops.githubWorkflowDispatch",
    group: "Dev & Infra",
    color: "var(--category-devops)",
    ink: "var(--text-warning)",
    spoken: "CI dispatch",
  },
  invoice: {
    node: "finance.generateInvoicePdf",
    group: "Finance & Ops",
    color: "var(--category-finance)",
    ink: "var(--text-success)",
    spoken: "invoice PDF",
  },
} as const satisfies Record<string, SeatStepMeta>;

export type SeatStepKind = keyof typeof SEAT_STEP_META;

export interface SeatStep {
  kind: SeatStepKind;
  label: string;
  /** Marks the real paid node inside an earning seat. */
  bills?: true;
}

export interface SeatFlow {
  slug: string;
  /** Fixed length keeps every pre-rendered strip the same height. */
  steps: readonly [SeatStep, SeatStep, SeatStep, SeatStep];
}

export const DEFAULT_HERO_SEAT_SLUG = "lead-scorer";

export interface OrgNode {
  role: string;
  agent: string;
  /** Department accent. Growth = cyan, Engineering = violet, Finance =
   * emerald (the money color doubles as the money department, and its head
   * earns live so the two emerald meanings stay coherent), Support Ops =
   * amber, CEO = indigo. */
  color: string;
  live?: boolean;
  /** Per-call USDC price, shown as a chip on live seats in the hero chart. */
  price?: string;
  /** Cron cadence, shown as a chip on scheduled seats in the hero chart. */
  schedule?: string;
  /** The real node chain illustrated when this seat is selected in the hero. */
  flow: SeatFlow;
}

/** A second-level seat that may carry third-level reports of its own. */
export interface OrgReport extends OrgNode {
  reports?: OrgNode[];
}

export interface OrgBranch {
  dept: string;
  node: OrgNode;
  children?: OrgReport[];
}

/** Single source of truth for the "founder's company" org data — shared by
 * this pill-card tree and the hero chart (HeroOrgChart) so the two surfaces
 * can't drift apart. Department color logic: each branch keeps one accent for
 * every seat in it. Casting rule: department heads are five distinct agents,
 * and reports may re-run a brand already on staff (a real company runs many
 * seats on the same brain) but never stack the same mark directly above or
 * beside itself. Every mark must stay legible at tile size, which is why the
 * Hermes wordmark doesn't hold a seat here — it's a wide lockup that turns to
 * noise below ~60px; it stays in the logo grid. */
export const ORG_ROOT: OrgNode = {
  role: "CEO",
  agent: "Claude",
  color: "var(--primary)",
  flow: {
    slug: "route-request",
    steps: [
      { kind: "input", label: "Request" },
      { kind: "llm", label: "Read intent" },
      { kind: "switch", label: "Route dept" },
      { kind: "subflow", label: "Hand off" },
    ],
  },
};

export const ORG_BRANCHES: OrgBranch[] = [
  {
    dept: "Growth",
    node: {
      role: "CMO",
      agent: "Gemini",
      color: "var(--registry-cyan)",
      live: true,
      price: "$0.008 · call",
      flow: {
        slug: "plan-campaign",
        steps: [
          { kind: "input", label: "Brief" },
          { kind: "search", label: "Brand voice" },
          { kind: "llm", label: "Plan push", bills: true },
          { kind: "output", label: "Campaign" },
        ],
      },
    },
    children: [
      {
        role: "Lead Scorer",
        agent: "Claude",
        color: "var(--registry-cyan)",
        live: true,
        price: "$0.004 · call",
        flow: {
          slug: "score-lead",
          steps: [
            { kind: "input", label: "Input" },
            { kind: "llm", label: "Score Lead", bills: true },
            { kind: "branch", label: "Qualified?" },
            { kind: "output", label: "Output" },
          ],
        },
      },
      {
        role: "Outreach Writer",
        agent: "Pi",
        color: "var(--registry-cyan)",
        schedule: "daily 9:07a",
        flow: {
          slug: "write-outreach",
          steps: [
            { kind: "cron", label: "Morning run" },
            { kind: "filter", label: "New leads" },
            { kind: "llm", label: "Write note" },
            { kind: "crm", label: "Queue send" },
          ],
        },
      },
    ],
  },
  {
    dept: "Engineering",
    node: {
      role: "CTO",
      agent: "Codex",
      color: "var(--violet)",
      live: true,
      price: "$0.010 · call",
      flow: {
        slug: "review-diff",
        steps: [
          { kind: "input", label: "Pull req" },
          { kind: "github", label: "Read diff" },
          { kind: "llm", label: "Risk review", bills: true },
          { kind: "output", label: "Verdict" },
        ],
      },
    },
    children: [
      {
        role: "Frontend Eng",
        agent: "Cursor",
        color: "var(--violet)",
        live: true,
        price: "$0.005 · call",
        flow: {
          slug: "ship-ui-change",
          steps: [
            { kind: "input", label: "Ticket" },
            { kind: "llm", label: "Plan change", bills: true },
            { kind: "issue", label: "Open issue" },
            { kind: "output", label: "Patch plan" },
          ],
        },
      },
      {
        role: "On-call SRE",
        agent: "OpenCode",
        color: "var(--violet)",
        schedule: "hourly",
        flow: {
          slug: "probe-health",
          steps: [
            { kind: "cron", label: "Hourly" },
            { kind: "fetch", label: "Probe API" },
            { kind: "branch", label: "Errors up?" },
            { kind: "slack", label: "Page team" },
          ],
        },
      },
    ],
  },
  {
    dept: "Finance",
    node: {
      role: "CFO",
      agent: "Pi",
      color: "var(--verified-emerald)",
      live: true,
      price: "$0.012 · call",
      flow: {
        slug: "reconcile-ledger",
        steps: [
          { kind: "input", label: "Statement" },
          { kind: "sheet", label: "Parse rows" },
          { kind: "llm", label: "Reconcile", bills: true },
          { kind: "output", label: "Ledger" },
        ],
      },
    },
    children: [
      {
        role: "Invoice Chaser",
        agent: "Gemini",
        color: "var(--verified-emerald)",
        schedule: "daily 8:00a",
        flow: {
          slug: "chase-invoice",
          steps: [
            { kind: "cron", label: "Morning run" },
            { kind: "filter", label: "Overdue" },
            { kind: "invoice", label: "Restate PDF" },
            { kind: "crm", label: "Send chase" },
          ],
        },
      },
      {
        role: "Expense Audit",
        agent: "Claude",
        color: "var(--verified-emerald)",
        schedule: "weekly Mon",
        flow: {
          slug: "audit-expenses",
          steps: [
            { kind: "cron", label: "Weekly Mon" },
            { kind: "sheet", label: "Parse rows" },
            { kind: "branch", label: "Outlier?" },
            { kind: "output", label: "Audit report" },
          ],
        },
      },
    ],
  },
  {
    dept: "Support Ops",
    node: {
      role: "COO",
      agent: "OpenClaw",
      color: "var(--amber)",
      schedule: "hourly",
      flow: {
        slug: "daily-standup",
        steps: [
          { kind: "cron", label: "Hourly" },
          { kind: "llm", label: "Read day" },
          { kind: "rollup", label: "Roll up" },
          { kind: "slack", label: "Standup" },
        ],
      },
    },
    children: [
      {
        role: "Support Triage",
        agent: "Claude",
        color: "var(--amber)",
        live: true,
        price: "$0.002 · call",
        flow: {
          slug: "triage-ticket",
          steps: [
            { kind: "input", label: "Ticket" },
            { kind: "classify", label: "Intent", bills: true },
            { kind: "branch", label: "Escalate?" },
            { kind: "output", label: "Reply" },
          ],
        },
      },
      {
        role: "CRM Sync",
        agent: "Gemini",
        color: "var(--amber)",
        schedule: "every 15m",
        flow: {
          slug: "sync-crm",
          steps: [
            { kind: "cron", label: "Every 15m" },
            { kind: "fetch", label: "Pull rows" },
            { kind: "transform", label: "Map fields" },
            { kind: "crm", label: "Push CRM" },
          ],
        },
      },
    ],
  },
];

/** Every seat in reading order (CEO, then each department head followed by
 * its reports and their reports) — the one flattening both the hero frame's
 * live-seat count and the aria descriptions derive from. */
export function flattenOrg(): OrgNode[] {
  return [
    ORG_ROOT,
    ...ORG_BRANCHES.flatMap((b) => [
      b.node,
      ...(b.children ?? []).flatMap((c) => [c, ...(c.reports ?? [])]),
    ]),
  ];
}

/** Stable per-seat suffix for SVG gradient ids: the same brand mark can now
 * hold several seats on one surface, so each seat needs its own id space. */
export function seatSlug(node: OrgNode): string {
  return node.role.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function seatId(idPrefix: string, node: OrgNode): string {
  return `${idPrefix}-${seatSlug(node)}`;
}

/** The selected radio carries the same information as its visual strip, so
 * no part of the interaction is hover-only or hidden from assistive tech. */
export function describeSeat(node: OrgNode, dept?: string): string {
  const money = node.live && node.price
    ? `Live, earns ${node.price.split(" ")[0]} USDC per call.`
    : node.live
      ? "Live."
      : "";
  const cadence = node.schedule ? `Runs on cron ${node.schedule}.` : "";
  const chain = node.flow.steps
    .map((step) => `${SEAT_STEP_META[step.kind].spoken} ${step.label}`)
    .join(", then ");
  return [
    `${node.role}, ${node.agent}${dept ? `, ${dept}` : ""}.`,
    money,
    cadence,
    `Flow ${node.flow.slug}: ${chain}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** One seat on the org chart. The same anatomy at every scale: brand mark in
 * a department-tinted tile, role first, agent second, LIVE + price only where
 * the seat actually earns, cadence chip only where a cron drives it. */
export function OrgSeat({
  node,
  showPrice = false,
  idPrefix = "org",
  interactive = false,
  dept,
}: {
  node: OrgNode;
  showPrice?: boolean;
  idPrefix?: string;
  /** The hero uses native radios to select a flow with touch or keyboard. */
  interactive?: boolean;
  dept?: string;
}): React.JSX.Element {
  const body = (
    <>
      <span className="lp-seat-mark">
        <AgentMark name={node.agent} idPrefix={seatId(idPrefix, node)} />
      </span>
      <span className="lp-seat-body">
        <span className="name">{node.role}</span>
        <span className="meta">
          <i /> {node.agent}
        </span>
        {showPrice && node.price && (
          /* data-earn feeds the hero's per-call earn tick (CSS ::after) — the
             floating "+$0.010" is the seat's real per-call price, never a
             fabricated running total. */
          <span className="lp-price-chip" data-earn={`+${node.price.split(" ")[0]}`}>
            {node.price}
          </span>
        )}
        {showPrice && !node.price && node.schedule && (
          <span className="lp-sched-chip">{node.schedule}</span>
        )}
      </span>
      {node.live && (
        <span className="lp-live">
          <i /> Live
        </span>
      )}
    </>
  );
  const className = `lp-seat${node.live ? " lp-seat--live" : ""}`;
  if (!interactive) {
    return (
      <div className={className} style={{ ["--c" as string]: node.color }}>
        {body}
      </div>
    );
  }

  const slug = seatSlug(node);
  return (
    <label
      className={`${className} lp-seat--choice`}
      data-seat={slug}
      style={{ ["--c" as string]: node.color }}
    >
      <input
        className="lp-seat-flow-radio"
        type="radio"
        name={`${idPrefix}-seat-flow`}
        value={slug}
        defaultChecked={slug === DEFAULT_HERO_SEAT_SLUG}
        aria-label={`Choose this seat. ${describeSeat(node, dept)}`}
      />
      {body}
    </label>
  );
}

/** A department column in the hero chart: head on top, reports hanging off an
 * elbow spine beneath, third-level seats indented one more step. */
function OrgDept({
  branch,
  idPrefix,
  interactive,
}: {
  branch: OrgBranch;
  idPrefix: string;
  interactive?: boolean;
}): React.JSX.Element {
  const seatProps = { showPrice: true, idPrefix, interactive, dept: branch.dept } as const;
  return (
    <div className={`lp-org-dept${branch.node.live ? " lp-org-dept--live" : ""}`}>
      <OrgSeat node={branch.node} {...seatProps} />
      {branch.children && (
        <ul className="lp-org-reports">
          {branch.children.map((child) => (
            <li key={child.role} className={child.live ? "is-live" : undefined}>
              <OrgSeat node={child} {...seatProps} />
              {child.reports && (
                <ul className="lp-org-reports">
                  {child.reports.map((sub) => (
                    <li key={sub.role} className={sub.live ? "is-live" : undefined}>
                      <OrgSeat node={sub} {...seatProps} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The org-chart markup alone, with no outer frame — for embedding inside
 * another component's own card (e.g. the hero, which shares one frame across
 * this tree and the mini flow strip). AgentOrgCard below wraps it in its own
 * standalone frame for the "bring your own agent" section.
 *
 * The hero variant renders the full company: CEO, a trunk down through two
 * department rows (Growth + Engineering, then Finance + Support Ops), each
 * department a head with its reports on elbow connectors. The card variant is
 * a deliberate pruning of the same data — CEO, the four heads, and the
 * engineering reports — sized for a supporting card, not the hero.
 */
export function AgentOrgTree({
  variant = "card",
  idPrefix = "org",
  interactive = false,
}: {
  variant?: "card" | "hero";
  idPrefix?: string;
  interactive?: boolean;
} = {}): React.JSX.Element {
  if (variant !== "hero") {
    const engineering = ORG_BRANCHES.find((b) => b.dept === "Engineering");
    return (
      <div className="lp-org-tree">
        <div className="lp-org-row lp-org-row--single">
          <OrgSeat node={ORG_ROOT} idPrefix={idPrefix} />
        </div>
        <div className="lp-org-stem" />
        <div className="lp-org-row lp-org-row--four">
          {ORG_BRANCHES.map(({ node }) => (
            <OrgSeat node={node} idPrefix={idPrefix} key={node.role} />
          ))}
        </div>
        <div className="lp-org-stem" />
        <div className="lp-org-row lp-org-row--two">
          {(engineering?.children ?? []).map((c) => (
            <OrgSeat node={c} idPrefix={idPrefix} key={c.role} />
          ))}
        </div>
      </div>
    );
  }
  const rows: OrgBranch[][] = [ORG_BRANCHES.slice(0, 2), ORG_BRANCHES.slice(2)];
  return (
    <div className="lp-org-tree lp-org-tree--hero">
      <div className="lp-org-row lp-org-row--single">
        <OrgSeat node={ORG_ROOT} showPrice idPrefix={idPrefix} interactive={interactive} />
      </div>
      <div className="lp-org-stem" />
      {rows.map((row, i) => (
        <div
          key={row.map((b) => b.dept).join("-")}
          className={`lp-org-deptrow${i < rows.length - 1 ? " lp-org-deptrow--linked" : ""}`}
        >
          {row.map((branch) => (
            <OrgDept
              branch={branch}
              idPrefix={idPrefix}
              interactive={interactive}
              key={branch.dept}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function AgentOrgCard(): React.JSX.Element {
  const engineering = ORG_BRANCHES.find((b) => b.dept === "Engineering");
  return (
    <div
      className="lp-org-card-frame reveal"
      style={{ animationDelay: "0.25s" }}
      role="img"
      aria-label={
        "Org chart of flow roles, each staffed by an example agent: " +
        `CEO ${ORG_ROOT.agent} at the top; ` +
        ORG_BRANCHES.map((b) => `${b.node.role} ${b.node.agent}`).join(", ") +
        " lead the departments; " +
        (engineering?.children ?? [])
          .map((c) => `${c.role} ${c.agent}`)
          .join(" and ") +
        " report to the CTO. Live seats earn per call."
      }
    >
      <AgentOrgTree />
    </div>
  );
}
