/**
 * Autonomous-company visual: one real first-party company template rendered as
 * a founder's org board — the company and its mission at the top, its
 * departments below, and the specialist agent seated in each one. Names,
 * missions, and per-call prices are read straight from COMPANY_TEMPLATES so
 * the illustration can never drift from the shipped /company feature.
 */
import { COMPANY_TEMPLATES, type CompanyTemplate } from "@/lib/company/templates";
import type { ManifestTrigger } from "@/lib/manifest/schema";
import { describeCron } from "@/lib/cron";

// Department accent colors, assigned by position from the locked category set.
const DEPT_COLORS = [
  "var(--registry-cyan)",
  "var(--violet)",
  "var(--amber)",
  "var(--verified-emerald)",
] as const;

// The general-business template we feature. Falls back to the first template
// so the card still renders real data if the catalog is ever reshaped.
const FEATURED_SLUG = "content-studio";

function featuredTemplate(): CompanyTemplate {
  return COMPANY_TEMPLATES.find((t) => t.slug === FEATURED_SLUG) ?? COMPANY_TEMPLATES[0];
}

/** Chip form of the honest cron description: "daily at 09:00 UTC" reads
 * "daily 09:00" at chip size, same register as the hero chart's cadence chips. */
function scheduleLabel(cron: string): string {
  return describeCron(cron).replace(" at ", " ").replace(" UTC", "");
}

/**
 * The hero chart's chip vocabulary applied to an employee's real trigger:
 * emerald price chip on priced seats, department-tinted cadence chip on
 * scheduled seats, and the quiet dotted meta line for on-demand work. No
 * invented cadence, no invented price. Shared with JourneyAltitudes so every
 * org surface renders triggers identically.
 */
export function TriggerChip({
  trigger,
}: {
  readonly trigger: ManifestTrigger;
}): React.JSX.Element {
  switch (trigger.kind) {
    case "paidCall":
      return (
        <span className="lp-price-chip">{`$${trigger.priceUsdc.toFixed(2)} · call`}</span>
      );
    case "schedule":
      return <span className="lp-sched-chip">{scheduleLabel(trigger.cron)}</span>;
    case "manual":
      return (
        <span className="meta">
          <i /> on demand
        </span>
      );
    case "webhook":
      return (
        <span className="meta">
          <i /> webhook
        </span>
      );
  }
}

type EmpMarkKind = "building" | "clock" | "braces" | "megaphone" | "pen" | "spark";

const EMP_MARKS: Record<string, EmpMarkKind> = {
  "daily-brief": "clock",
  "doc-to-json": "braces",
  promoter: "megaphone",
  "campaign-writer": "pen",
};

function Mark({ kind }: { kind: EmpMarkKind }): React.JSX.Element {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "building":
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="1.5" />
          <path d="M9 8h.5M14.5 8h.5M9 12h.5M14.5 12h.5M10 21v-3h4v3" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "braces":
      return (
        <svg {...common}>
          <path d="M8 4c-2 0-2.5 1-2.5 3v1.5c0 1-.6 1.8-1.8 1.8 1.2 0 1.8.8 1.8 1.8V17c0 2 .5 3 2.5 3" />
          <path d="M16 4c2 0 2.5 1 2.5 3v1.5c0 1 .6 1.8 1.8 1.8-1.2 0-1.8.8-1.8 1.8V17c0 2-.5 3-2.5 3" />
        </svg>
      );
    case "megaphone":
      return (
        <svg {...common}>
          <path d="M4 10v4h3l7 4V6L7 10H4z" />
          <path d="M17 9.5a3.5 3.5 0 0 1 0 5" />
        </svg>
      );
    case "pen":
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      );
    case "spark":
      return (
        <svg {...common}>
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
        </svg>
      );
  }
}

export default function CompanyPreviewCard({
  template: templateProp,
}: {
  /** Render a specific template's org board; defaults to the featured one. */
  readonly template?: CompanyTemplate;
} = {}): React.JSX.Element {
  const template = templateProp ?? featuredTemplate();
  // Keep the illustration bounded regardless of how a template is shaped.
  const departments = template.departments.slice(0, 2);
  // Real census for the frame bar, read from the full template so the header
  // stays honest even when the board below shows a pruned cut.
  const employees = template.departments.flatMap((d) => d.employees);
  const seatCount = employees.length;
  const pricedCount = employees.filter(
    (e) => e.manifest.triggers[0]?.kind === "paidCall",
  ).length;
  const shownCount = departments.reduce(
    (sum, d) => sum + Math.min(d.employees.length, 2),
    0,
  );
  const hiddenCount = seatCount - shownCount;
  return (
    <div
      className="lp-org-card-frame reveal"
      style={{ animationDelay: "0.25s" }}
      role="img"
      aria-label={`${template.name} company board: ${seatCount} agent seats across ${template.departments.length} departments, including ${departments
        .map((d) => d.name)
        .join(" and ")}. Priced seats charge per call in USDC; scheduled seats run on cron.`}
    >
      <div className="lp-company-preview">
        <div className="lp-org-frame-bar" aria-hidden="true">
          {/* Kicker is the bare slug: the "company · " prefix pushed long
              slugs (rights-precheck-shop) into a mid-name ellipsis at card
              widths, and the aria-label above already says this is a
              company board. */}
          <b>{template.slug}</b>
          <span className="tabular">
            {seatCount} {seatCount === 1 ? "seat" : "seats"}
            {pricedCount > 0 ? ` · ${pricedCount} priced` : ""}
          </span>
        </div>
        <div className="lp-company-head" style={{ ["--c" as string]: "var(--primary)" }}>
          <span className="lp-seat-mark">
            <Mark kind="building" />
          </span>
          <div className="lp-company-head-body">
            <span className="name">{template.name}</span>
            <span className="mission">{template.mission}</span>
          </div>
        </div>
        <div className="lp-org-stem" />
        <div className="lp-company-depts">
          {departments.map((dept, di) => {
            const color = DEPT_COLORS[di % DEPT_COLORS.length];
            return (
              <div className="lp-company-dept" key={dept.name}>
                <span className="lp-company-dept-label" style={{ ["--c" as string]: color }}>
                  {dept.name}
                </span>
                <div className="lp-company-emps">
                  {dept.employees.slice(0, 2).map((emp) => (
                    <div
                      className="lp-seat"
                      key={emp.slug}
                      style={{ ["--c" as string]: color }}
                    >
                      <span className="lp-seat-mark">
                        <Mark kind={EMP_MARKS[emp.slug] ?? "spark"} />
                      </span>
                      <div className="lp-seat-body">
                        <span className="name">{emp.manifest.name}</span>
                        <TriggerChip trigger={emp.manifest.triggers[0]} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {hiddenCount > 0 && (
          <span className="lp-company-more">
            + {hiddenCount} more {hiddenCount === 1 ? "seat" : "seats"} on the full board
          </span>
        )}
      </div>
    </div>
  );
}
