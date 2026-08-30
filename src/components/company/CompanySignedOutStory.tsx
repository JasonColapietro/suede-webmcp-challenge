"use client";

/**
 * Signed-out /company story: the full editorial walkthrough of the
 * autonomous-company mechanics, an ungated explorable template preview,
 * the complete template catalog, and a founding-specific FAQ.
 *
 * Every fact on this surface is derived from COMPANY_TEMPLATES and the
 * shipped mechanics in src/lib/company (founding.ts, guardrails.ts,
 * activation.ts, ceo.ts, draft-limits.ts). No invented budgets, prices,
 * cadences, or live states: templates ship with every monthly cap unset,
 * so the caps figure is honestly derived (and reads $0.00 preset), and the
 * org board below is labeled as a template preview, never as a live
 * company. Presentation only; nothing here touches an API.
 */

import OrgChartCanvas from "@/components/company/OrgChartCanvas";
import { TriggerChip } from "@/components/landing/CompanyPreviewCard";
import CompanyPreviewCard from "@/components/landing/CompanyPreviewCard";
import {
  COMPANY_TEMPLATES,
  type CompanyTemplate,
  type CompanyTemplateEmployee,
} from "@/lib/company/templates";
import { templateOrgPreview } from "@/lib/company/template-preview";
import { MAX_COMPANY_DRAFT_EMPLOYEES } from "@/lib/company/draft-limits";
import { NODE_DEFINITION_BY_TYPE } from "@/lib/flow/node-definitions";
import type { NodeType } from "@/lib/flow/types";

/** The general-business template the ungated deep dive opens: it is the one
 * catalog entry that carries all three trigger registers at once (a priced
 * seat, a scheduled seat, and a publish-gated seat), so every mechanic the
 * walkthrough names is visible on one board. */
const DEEP_DIVE_SLUG = "content-studio";

/** The board shown beside the walkthrough. A different template than the
 * deep dive (and than the homepage card) so the page shows breadth. */
const WALKTHROUGH_BOARD_SLUG = "support-triage-shop";

/** Music/IP is one named vertical in the catalog, present but never the
 * lead: these templates gallery last and carry a quiet vertical tag. */
const MUSIC_VERTICAL_SLUGS: ReadonlySet<string> = new Set([
  "rights-precheck-shop",
  "sync-pitch-shop",
]);

interface TemplateCatalogFacts {
  seats: number;
  departments: number;
  pricedSeats: number;
  scheduledSeats: number;
  gatedSeats: number;
  /** Sum of every monthly cap the template ships with (departments and
   * seats). Templates currently ship with all caps unset, so this derives
   * to 0 and the UI says so instead of inventing budget numbers. */
  presetCapsUsdc: number;
}

function catalogFacts(template: CompanyTemplate): TemplateCatalogFacts {
  let seats = 0;
  let pricedSeats = 0;
  let scheduledSeats = 0;
  let gatedSeats = 0;
  let presetCapsUsdc = 0;
  for (const department of template.departments) {
    if (department.monthlyBudgetUsdc !== null) presetCapsUsdc += department.monthlyBudgetUsdc;
    for (const employee of department.employees) {
      seats += 1;
      if (typeof employee.monthlyBudgetUsdc === "number") presetCapsUsdc += employee.monthlyBudgetUsdc;
      if (employee.publishGated === true) gatedSeats += 1;
      if (employee.manifest.triggers.some((t) => t.kind === "paidCall" && t.priceUsdc > 0)) {
        pricedSeats += 1;
      }
      if (employee.manifest.triggers.some((t) => t.kind === "schedule")) {
        scheduledSeats += 1;
      }
    }
  }
  return {
    seats,
    departments: template.departments.length,
    pricedSeats,
    scheduledSeats,
    gatedSeats,
    presetCapsUsdc,
  };
}

function templateBySlug(slug: string): CompanyTemplate {
  return COMPANY_TEMPLATES.find((t) => t.slug === slug) ?? COMPANY_TEMPLATES[0];
}

function isKnownNodeType(type: string): type is NodeType {
  return type in NODE_DEFINITION_BY_TYPE;
}

/** "Input → LLM → Output" line built from the exact steps a seat's manifest
 * ships with, using the same node labels the canvas renders. */
function flowStepLine(employee: CompanyTemplateEmployee): string {
  return employee.manifest.steps
    .map((step) =>
      step.label ?? (isKnownNodeType(step.type) ? NODE_DEFINITION_BY_TYPE[step.type].label : step.type),
    )
    .join(" → ");
}

function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/** Business templates in catalog order, then the music/rights vertical. */
function galleryOrder(): CompanyTemplate[] {
  const business = COMPANY_TEMPLATES.filter((t) => !MUSIC_VERTICAL_SLUGS.has(t.slug));
  const music = COMPANY_TEMPLATES.filter((t) => MUSIC_VERTICAL_SLUGS.has(t.slug));
  return [...business, ...music];
}

/** FAQ content is founding-specific and mirrors the mechanics in
 * src/lib/company plus the settlement claims on /pricing; it introduces no
 * new pricing or payout promises. */
const FOUNDING_FAQ: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: "What does approving actually mean?",
    answer:
      "Every company opens in draft, and approval is per action, never blanket. Turning on live selling for a seat, running a publish-gated seat, and running work above your cost threshold each create a decision that waits for you, with the cost shown before you decide. Approving one action approves only that action, and a rejection keeps your reason on the record.",
  },
  {
    question: "What does founding cost?",
    answer:
      "Founding is free and the draft needs no wallet. Priced seats settle in USDC on Base only when a call actually runs, at the per-call price the seat ships with, and you can change that price before anything goes live.",
  },
  {
    question: "What runs without me?",
    answer:
      "A draft company runs nothing: no seat executes, sells, or spends. Once you activate it, seats run when you run them from the board or when a paying caller hits a seat you have turned live, always inside the monthly caps you set. Scheduled seats ship with their cadence written down but turned off, and publish-gated seats and above-threshold runs wait for your approval either way.",
  },
  {
    question: "Can I fire a seat?",
    answer:
      "Yes, at any time. Removing an employee stops its public execution immediately while its agent, flow, and run history stay preserved. You can hire a replacement yourself or ask the CEO, whose hire proposal still waits for your confirmation before anything is created.",
  },
  {
    question: "Where does the money go?",
    answer:
      "Every settled call carries a transaction receipt on Base you can open and verify. Earnings route to the seat's own wallet when you assign one, and to your founder wallet otherwise, and the company books show revenue, spend, and net for any month.",
  },
];

function DeepDiveRoster({ template }: { readonly template: CompanyTemplate }): React.JSX.Element {
  return (
    <div className="co-roster">
      {template.departments.map((dept) => (
        <div className="co-roster-dept" key={dept.name}>
          <h3 className="co-roster-dept-name">{dept.name}</h3>
          <div className="co-roster-seats">
            {dept.employees.map((emp) => (
              <article className="co-roster-seat" key={emp.slug}>
                <div className="co-roster-seat-head">
                  <b>{emp.manifest.name}</b>
                  <TriggerChip trigger={emp.manifest.triggers[0]} />
                  {emp.publishGated === true && (
                    <span className="co-gated-pill">runs on your approval</span>
                  )}
                </div>
                <p className="co-roster-seat-role">{emp.jobDescription}</p>
                <p className="co-roster-seat-flow" aria-label="Flow steps this seat ships with">
                  {flowStepLine(emp)}
                </p>
              </article>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CompanySignedOutStory({
  signInUrl,
}: {
  readonly signInUrl: string;
}): React.JSX.Element {
  const deepDive = templateBySlug(DEEP_DIVE_SLUG);
  const deepDiveFacts = catalogFacts(deepDive);
  const deepDivePreview = templateOrgPreview(deepDive);
  const walkthroughBoard = templateBySlug(WALKTHROUGH_BOARD_SLUG);

  return (
    <>
      {/* ---- Hero -------------------------------------------------------- */}
      <header className="lp-page-head" style={{ maxWidth: "none" }}>
        <span className="lp-eyebrow">Company</span>
        <h1>Build a company of agents. Stay the founder.</h1>
        <p style={{ color: "var(--text-muted)", maxWidth: 640, lineHeight: 1.6 }}>
          Pick a template and it opens pre-staffed: departments, specialist
          employees, budgets, and a CEO you direct in plain English. Every
          hire, fire, and budget change waits for your confirmation, and
          nothing sells live until you approve it.
        </p>
        <p className="co-hero-def">
          Every seat on the chart is an agent flow &mdash; a node graph you can
          open, read, and run &mdash; and a priced seat sells per call in USDC
          on Base.
        </p>
        <div className="lp-row-actions" style={{ marginTop: "1.1rem" }}>
          <a className="lp-btn lp-btn--primary" href={signInUrl}>
            Sign in with Suede to found yours
          </a>
          <a className="lp-btn lp-btn--ghost" href="#how-a-company-runs">
            See how one runs
          </a>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", marginTop: "0.6rem" }}>
          Same login as Suede Social and Suede Muse. Founding is free.
        </p>
        <nav className="co-jump" aria-label="On this page">
          <a href="#how-a-company-runs">How it runs</a>
          <a href="#inside-a-template">Inside {deepDive.name}</a>
          <a href="#templates">All {COMPANY_TEMPLATES.length} templates</a>
          <a href="#founding-faq">Founding FAQ</a>
        </nav>
      </header>

      {/* ---- The operating loop ------------------------------------------ */}
      <section id="how-a-company-runs" className="lp-block">
        <div className="lp-boya-grid">
          <div>
            <span className="lp-eyebrow">The operating loop</span>
            <h2 className="lp-section-title">
              Six mechanics, all under your signature.
            </h2>
            <div className="lp-company-steps" style={{ marginTop: "1.3rem" }}>
              <div className="lp-company-step">
                <h3>Found it as a draft.</h3>
                <p>
                  Choose one of the {COMPANY_TEMPLATES.length} first-party
                  templates, or describe the company in plain English and let
                  the founding brain draft it. Either way it opens pre-staffed,
                  with a mission, departments, and a specialist agent in every
                  seat (up to {MAX_COMPANY_DRAFT_EMPLOYEES}), and in draft:
                  nothing runs, sells, or spends yet.
                </p>
              </div>
              <div className="lp-company-step">
                <h3>Meet the team on one board.</h3>
                <p>
                  The org chart is the operating view, not an illustration.
                  Every seat opens into the exact flow it ships with, and you
                  run a seat, a department, or the whole roster from the same
                  canvas after founding.
                </p>
              </div>
              <div className="lp-company-step">
                <h3>Approve before anything sells.</h3>
                <p>
                  Live selling is off for every seat until you turn it on, one
                  seat at a time. Publish-gated seats and runs above your cost
                  threshold each queue a decision with the cost shown before
                  you decide, and your reason stays on the record.
                </p>
              </div>
              <div className="lp-company-step">
                <h3>Cap what any seat can spend.</h3>
                <p>
                  Set monthly budgets per seat and per department, checked
                  against the calendar month in UTC. Leave a cap blank and
                  there is no cap; hit one and the run is blocked, not billed.
                </p>
              </div>
              <div className="lp-company-step">
                <h3>Direct the CEO. Reshape the roster.</h3>
                <p>
                  The CEO chat proposes exactly one action at a time: hire a
                  seat, let one go, set a budget, open a department. Nothing
                  executes until you confirm it in the thread, and a removed
                  seat keeps its agent, flow, and history preserved.
                </p>
              </div>
              <div className="lp-company-step">
                <h3>Every settled call lands in the books.</h3>
                <p>
                  Priced seats settle per call in USDC on Base with a receipt
                  you can open on Basescan. Monthly books show revenue, spend,
                  and net, and each seat pays out to its own wallet when you
                  assign one, otherwise to yours.
                </p>
              </div>
            </div>
          </div>
          <CompanyPreviewCard template={walkthroughBoard} />
        </div>
      </section>

      {/* ---- Ungated template deep dive ---------------------------------- */}
      <section id="inside-a-template" className="lp-block">
        <span className="lp-eyebrow">Template preview · no account needed</span>
        <h2 className="lp-section-title">Inside {deepDive.name}, seat by seat.</h2>
        <p className="lp-section-sub">
          {deepDive.mission} Everything below is read from the shipped
          template: roles, flows, prices, and cadences exactly as they found.
        </p>
        <div className="co-facts" aria-label={`${deepDive.name} at a glance`}>
          <span className="co-fact">
            <b className="tabular">{deepDiveFacts.seats}</b>{" "}
            {plural(deepDiveFacts.seats, "seat")}
          </span>
          <span className="co-fact">
            <b className="tabular">{deepDiveFacts.departments}</b>{" "}
            {plural(deepDiveFacts.departments, "department")}
          </span>
          {deepDiveFacts.pricedSeats > 0 && (
            <span className="co-fact co-fact--paid">
              <b className="tabular">{deepDiveFacts.pricedSeats}</b> priced per call
            </span>
          )}
          {deepDiveFacts.scheduledSeats > 0 && (
            <span className="co-fact">
              <b className="tabular">{deepDiveFacts.scheduledSeats}</b> on a schedule
            </span>
          )}
          {deepDiveFacts.gatedSeats > 0 && (
            <span className="co-fact">
              <b className="tabular">{deepDiveFacts.gatedSeats}</b> approval-gated
            </span>
          )}
          <span className="co-fact">
            <b className="tabular">${deepDiveFacts.presetCapsUsdc.toFixed(2)}</b> caps preset
          </span>
        </div>
        <p className="co-caps-note">
          Templates ship with every monthly cap unset. You set per-seat and
          per-department budgets after founding, and a blank cap means no cap.
        </p>

        <DeepDiveRoster template={deepDive} />

        <p className="lp-hero-note" style={{ marginTop: "1.1rem", marginBottom: 0 }}>
          This is a template preview, not a live company. It is the same
          canvas you operate after founding: click any seat to open the flow
          it ships with.
        </p>
        <div className="co-chart-frame co-chart-frame--picker">
          <OrgChartCanvas
            company={deepDivePreview.company}
            departments={deepDivePreview.departments}
            employees={deepDivePreview.employees}
            staticNestedFlows={deepDivePreview.nestedFlows}
          />
        </div>
      </section>

      {/* ---- The full catalog -------------------------------------------- */}
      <section id="templates" className="lp-block">
        <span className="lp-eyebrow">The catalog</span>
        <h2 className="lp-section-title">
          {COMPANY_TEMPLATES.length} companies, ready to found.
        </h2>
        <p className="lp-section-sub">
          Each one is a full company: real seats, real flows, and real per-call
          prices, founded as a draft under your control. Music and rights work
          is one vertical in the set, not the frame.
        </p>
        <div className="co-gallery">
          {galleryOrder().map((template) => {
            const facts = catalogFacts(template);
            const employees = template.departments.flatMap((d) => d.employees);
            return (
              <article className="co-gallery-card" key={template.slug}>
                <div className="co-gallery-kicker">
                  <b>{template.slug}</b>
                  {MUSIC_VERTICAL_SLUGS.has(template.slug) && (
                    <span className="co-gallery-vertical">music vertical</span>
                  )}
                </div>
                <h3>{template.name}</h3>
                <p className="co-gallery-mission">{template.mission}</p>
                <div className="co-facts co-facts--card">
                  <span className="co-fact">
                    <b className="tabular">{facts.seats}</b> {plural(facts.seats, "seat")}
                  </span>
                  <span className="co-fact">
                    <b className="tabular">{facts.departments}</b>{" "}
                    {plural(facts.departments, "dept")}
                  </span>
                  {facts.pricedSeats > 0 && (
                    <span className="co-fact co-fact--paid">
                      <b className="tabular">{facts.pricedSeats}</b> priced
                    </span>
                  )}
                  {facts.scheduledSeats > 0 && (
                    <span className="co-fact">
                      <b className="tabular">{facts.scheduledSeats}</b> scheduled
                    </span>
                  )}
                </div>
                <ul className="co-gallery-seats">
                  {employees.map((emp) => (
                    <li key={emp.slug}>
                      <span className="co-gallery-seat-name">{emp.manifest.name}</span>
                      <TriggerChip trigger={emp.manifest.triggers[0]} />
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      {/* ---- Founding FAQ ------------------------------------------------ */}
      <section id="founding-faq" className="lp-block">
        <span className="lp-eyebrow">Founding questions</span>
        <h2 className="lp-faq-title">Before you sign the paperwork</h2>
        <div className="lp-faq-list">
          {FOUNDING_FAQ.map((item, index) => (
            <details key={item.question} className="lp-faq-item" open={index === 0}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ---- Sign-off ---------------------------------------------------- */}
      <section className="lp-block co-signoff">
        <span className="lp-eyebrow">Found yours</span>
        <h2 className="lp-section-title">The paperwork takes one click.</h2>
        <p className="lp-section-sub">
          It opens as a draft, pre-staffed and waiting on your first approval.
          Nothing runs, sells, or spends until you say so.
        </p>
        <div className="lp-row-actions" style={{ marginTop: "1rem" }}>
          <a className="lp-btn lp-btn--primary" href={signInUrl}>
            Sign in with Suede to found yours
          </a>
        </div>
      </section>
    </>
  );
}
