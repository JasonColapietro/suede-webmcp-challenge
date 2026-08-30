/**
 * "One company, every altitude" — the journey section's three panels plus the
 * five-stop journey rail. One real employee (Document to JSON from the
 * Content Studio template) is shown at all three altitudes: a seat on the org
 * chart, its wired flow on the Studio canvas, and the same flow as a paid
 * endpoint in code. Everything renders from COMPANY_TEMPLATES and the node
 * registry, same discipline as CompanyPreviewCard: the illustration can never
 * drift from the shipped product.
 */
import Link from "next/link";
import { COMPANY_TEMPLATES, type CompanyTemplate } from "@/lib/company/templates";
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import { NODE_META } from "@/lib/flow/node-meta";
import type { NodeType } from "@/lib/flow/types";
import type { ManifestTrigger } from "@/lib/manifest/schema";
import { TriggerChip } from "./CompanyPreviewCard";
import { SITE_URL } from "@/lib/site";

const TEMPLATE_SLUG = "content-studio";
const FEATURED_EMPLOYEE_SLUG = "doc-to-json";

/** The seat-panel projection: name plus the seat's real trigger, so the org
 * altitude renders the same price/cadence chips as every other org surface. */
interface SeatSummary {
  readonly name: string;
  readonly trigger: ManifestTrigger;
}

function seatSummaries(
  dept: CompanyTemplate["departments"][number],
): SeatSummary[] {
  return dept.employees.map((e) => ({
    name: e.manifest.name,
    trigger: e.manifest.triggers[0],
  }));
}

function featured(): {
  template: CompanyTemplate;
  departmentName: string;
  seats: SeatSummary[];
  employee: CompanyTemplate["departments"][number]["employees"][number];
} {
  const template =
    COMPANY_TEMPLATES.find((t) => t.slug === TEMPLATE_SLUG) ?? COMPANY_TEMPLATES[0];
  for (const dept of template.departments) {
    const employee = dept.employees.find((e) => e.slug === FEATURED_EMPLOYEE_SLUG);
    if (employee) {
      return {
        template,
        departmentName: dept.name,
        seats: seatSummaries(dept),
        employee,
      };
    }
  }
  // Catalog reshaped: fall back to the first seat of the first department so
  // the section still renders real data.
  const dept = template.departments[0];
  return {
    template,
    departmentName: dept.name,
    seats: seatSummaries(dept),
    employee: dept.employees[0],
  };
}

/** Same color vocabulary the node-palette chips on this page already use. */
function stepColor(type: NodeType): string {
  if (type === "llm") return "var(--primary)";
  if (type === "transform") return "var(--text-warning)";
  if (type === "input" || type === "output") return "var(--text-muted)";
  if (type.startsWith("docs.")) return "var(--text-info)";
  if (type.startsWith("suede.")) return "var(--text-success)";
  return "var(--primary)";
}

function priceLabel(employee: ReturnType<typeof featured>["employee"]): string | null {
  const trigger = employee.manifest.triggers[0];
  return trigger?.kind === "paidCall" ? `$${trigger.priceUsdc.toFixed(2)} · call` : null;
}

export default function JourneyAltitudes(): React.JSX.Element {
  const { template, departmentName, seats, employee } = featured();
  const steps = employee.manifest.steps.map((step) => ({
    id: step.id,
    label: getNodeDefinition(step.type as NodeType)?.label ?? step.type,
    type: step.type as NodeType,
  }));
  const price = priceLabel(employee);
  const otherDepartments = template.departments.filter((d) =>
    d.employees.every((e) => e.slug !== employee.slug),
  );

  return (
    <>
      <div className="lp-alt-grid">
        {/* Altitude 1: the seat on the org chart */}
        <article className="lp-alt-panel reveal" style={{ animationDelay: "0.06s" }}>
          <header className="lp-alt-head">
            {/* --text-info, not --registry-cyan: this pill is 9.9px text on
                white, and the bright signal cyan is 2.43:1 there. Matches the
                Developers panel's darker text-role pattern. */}
            <span className="lp-alt-persona" style={{ ["--c" as string]: "var(--text-info)" }}>
              Founders
            </span>
            <h3>A seat in your company</h3>
          </header>
          <div className="lp-alt-body">
            <div className="lp-company-head" style={{ ["--c" as string]: "var(--primary)" }}>
              <div className="lp-company-head-body">
                <span className="name">{template.name}</span>
                <span className="mission">{template.mission}</span>
              </div>
            </div>
            <div className="lp-org-stem" />
            <span
              className="lp-company-dept-label"
              style={{ ["--c" as string]: "var(--registry-cyan)" }}
            >
              {departmentName}
            </span>
            <div className="lp-alt-seats">
              {seats.map((seat) => (
                <div
                  key={seat.name}
                  className={
                    seat.name === employee.manifest.name
                      ? "lp-seat lp-alt-seat is-featured"
                      : "lp-seat lp-alt-seat"
                  }
                  style={{ ["--c" as string]: "var(--registry-cyan)" }}
                >
                  <div className="lp-seat-body">
                    <span className="name">{seat.name}</span>
                    <TriggerChip trigger={seat.trigger} />
                  </div>
                </div>
              ))}
            </div>
            {otherDepartments.length > 0 && (
              <span className="lp-alt-more">
                + {otherDepartments.map((d) => d.name).join(", ")}
              </span>
            )}
          </div>
          <p className="lp-alt-caption">
            Found it staffed. Every seat has a job description, a budget, and an
            approval gate you control.
          </p>
          <Link href="/company" className="lp-alt-link">
            Found a company
          </Link>
        </article>

        {/* Altitude 2: the same seat, opened on the Studio canvas */}
        <article className="lp-alt-panel reveal" style={{ animationDelay: "0.12s" }}>
          <header className="lp-alt-head">
            <span className="lp-alt-persona" style={{ ["--c" as string]: "var(--primary)" }}>
              Operators
            </span>
            <h3>The same seat, on the canvas</h3>
          </header>
          <div className="lp-alt-body lp-alt-canvas">
            <div className="lp-canvas-flowname">
              <b>{employee.manifest.name}</b>
              {price && <span>{price}</span>}
            </div>
            <div className="lp-canvas-chain">
              {steps.map((step, index) => (
                <div className="lp-canvas-hop" key={step.id}>
                  {index > 0 && <span className="lp-canvas-wire" aria-hidden="true" />}
                  <div
                    className="lp-canvas-node"
                    style={{ ["--c" as string]: stepColor(step.type) }}
                  >
                    <span className="type">{step.label}</span>
                    <span className="id">{step.id}</span>
                  </div>
                  {step.type === "llm" && (
                    <div className="lp-canvas-attach" aria-hidden="true">
                      <span className="lp-canvas-attach-wire" />
                      <span className="lp-canvas-attach-pill">Claude · model</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <p className="lp-alt-caption">
            Open any seat and rewire it: {NODE_META.length} node types,
            subflows, typed ports, versioned saves, and a command palette when
            you outgrow the mouse.
          </p>
          <Link href="/build/new" className="lp-alt-link">
            Open the studio
          </Link>
        </article>

        {/* Altitude 3: the same flow as a machine-discoverable service */}
        <article className="lp-alt-panel reveal" style={{ animationDelay: "0.18s" }}>
          <header className="lp-alt-head">
            <span className="lp-alt-persona" style={{ ["--c" as string]: "var(--text-success)" }}>
              Developers
            </span>
            <h3>The same flow, as an endpoint</h3>
          </header>
          <div className="lp-alt-body">
            <pre className="lp-alt-code">
              <code>{[
                `BASE=${SITE_URL}`,
                "",
                "# every published seat advertises its current call state",
                "curl $BASE/api/agents/<id>/.well-known/x402",
                "",
                "# call it only when the advertised state allows it",
                "curl -X POST $BASE/api/agents/<id>/run \\",
                "  -H 'content-type: application/json' \\",
                `  -d '{ "input": { "document": "..." }, "dryRun": true }'`,
                "",
                "# payment-enabled calls settle through x402 v2",
              ].join("\n")}</code>
            </pre>
          </div>
          <p className="lp-alt-caption">
            Agents and scripts can discover every published seat and inspect
            whether it is preview-ready, payment-enabled, or unavailable.
            Payment-enabled services publish x402 terms and ledger receipts.
          </p>
          <Link href="/docs" className="lp-alt-link">
            Read the docs
          </Link>
        </article>
      </div>

      {/* The journey rail: every point covered, in order. */}
      <ol className="lp-journey">
        {[
          {
            step: "Found",
            body: "Pick a staffed template or describe your company in chat.",
            href: "/company",
          },
          {
            step: "Staff",
            body: "Hire, budget, and gate every seat. The CEO takes it from chat.",
            href: "/company",
          },
          {
            step: "Wire",
            body: "Go node-deep on any seat's flow whenever you want the controls.",
            href: "/build/new",
          },
          {
            step: "Launch",
            body: "Publish the flow with its current public call state.",
            href: "/launch",
          },
          {
            step: "Earn",
            body: "Payment-enabled calls that settle land on the books, receipt by receipt.",
            href: "/flows",
          },
        ].map((stop, index) => (
          <li className="lp-journey-stop" key={stop.step}>
            <span className="lp-journey-no">{index + 1}</span>
            <div className="lp-journey-body">
              <Link href={stop.href}>{stop.step}</Link>
              <p>{stop.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
