"use client";

/**
 * Company dashboard shell — list the founder's companies, found a new one
 * from a first-party template, and view a company's departments and
 * employees. Governance actions and receipts-grounded books share the same
 * detail surface so a founder can run, approve, pause, and audit the company
 * without leaving its operating view.
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Tasks 12–13 (dashboard shell, governance, and books panels).
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import OrgChartCanvas, { type OrgChartEmployee } from "@/components/company/OrgChartCanvas";
import CompanySignedOutStory from "@/components/company/CompanySignedOutStory";
import { COMPANY_TEMPLATES, type CompanyTemplate } from "@/lib/company/templates";
import { templateOrgPreview } from "@/lib/company/template-preview";
import type {
  ApprovalCostSnapshot,
  ApprovalKind,
  ApprovalRecord,
  CompanyRecord,
  CompanyStatus,
  EmployeeLifecycleStatus,
  EmployeeRole,
} from "@/lib/company/types";
import {
  SEAT_STATUS_LEGEND,
  formatHeartbeatCadence,
  formatRelativeTime,
  seatStatusMeta,
} from "@/lib/company/presentation";
import "../chrome.css";
import "../site.css";
import "../workspace.css";
import "./company.css";
import { signInUrl } from "@/lib/sign-in-url";

const SIGN_IN_URL = signInUrl("https://agents.suedeai.ai/company");

/** Below this width the org chart is unusable; mobile gets the list. */
const MOBILE_QUERY = "(max-width: 767px)";

interface CompanyListItem extends CompanyRecord {
  employeeCount: number;
}

interface CompaniesResponse {
  companies: CompanyListItem[];
}

function isCompaniesResponse(v: unknown): v is CompaniesResponse {
  if (typeof v !== "object" || v === null) return false;
  return Array.isArray((v as { companies?: unknown }).companies);
}

interface CompanyTemplateSummary {
  slug: string;
  name: string;
  mission: string;
  pitch: string;
  departments: { name: string; employeeCount: number }[];
}

interface TemplatesResponse {
  templates: CompanyTemplateSummary[];
}

function isTemplatesResponse(v: unknown): v is TemplatesResponse {
  if (typeof v !== "object" || v === null) return false;
  return Array.isArray((v as { templates?: unknown }).templates);
}

interface DetailAgent {
  id: string;
  flowId: string;
  slug: string;
  status: "draft" | "live";
  priceUsdc: number;
  settlementLive: boolean;
}

interface DetailEmployee {
  agentId: string;
  companyId: string;
  departmentId: string;
  jobDescription: string;
  publishGated: boolean;
  monthlyBudgetUsdc: number | null;
  /** Employee's own payout wallet; null settles to the company wallet. */
  payTo: string | null;
  monthSpendUsdc: number;
  agent: DetailAgent | null;
  role: EmployeeRole | null;
  reportsTo: string | null;
  lifecycleStatus: EmployeeLifecycleStatus;
  heartbeatEnabled: boolean;
  heartbeatIntervalSeconds: number | null;
  /** ISO timestamp of the last heartbeat wake, or null if never woken. */
  lastHeartbeatAt: string | null;
}

interface DetailDepartment {
  id: string;
  companyId: string;
  name: string;
  monthlyBudgetUsdc: number | null;
  monthSpendUsdc: number;
  employees: DetailEmployee[];
}

interface CompanyDetailResponse {
  company: CompanyRecord;
  departments: DetailDepartment[];
  pendingApprovals: ApprovalRecord[];
}

type FireReason =
  | "employee_budget_exhausted"
  | "department_budget_exhausted"
  | "approval_required_publish_gated"
  | "approval_required_over_threshold"
  | "agent_missing"
  | "flow_missing";

interface FireResult {
  agentId: string;
  ran: boolean;
  dryRun?: boolean;
  runId?: string;
  reason?: FireReason;
}

interface FireResponse {
  results: FireResult[];
}

interface BooksLine {
  runId: string;
  agentId: string;
  grossUsdc: number;
  creatorUsdc: number;
  platformUsdc: number;
  tx: string | null;
  payer: string | null;
  createdAt: string;
}

interface BooksResponse {
  from: string;
  to: string;
  revenue: {
    totalGrossUsdc: number;
    totalCreatorUsdc: number;
    lines: BooksLine[];
  };
  spend: { totalUsdc: number };
  netUsdc: number;
}

type ActivityStatus =
  | "running"
  | "done"
  | "error"
  | "pending"
  | "approved"
  | "rejected"
  | "consumed";

interface ActivityEntry {
  id: string;
  kind: "run" | "approval";
  employeeId: string | null;
  departmentId: string | null;
  status: ActivityStatus;
  occurredAt: string;
  trigger: string | null;
  costUsdc: number | null;
  approvalKind: ApprovalKind | null;
  reason: string | null;
  outcome: {
    kind: "output" | "error" | "none";
    nodeId: string | null;
    preview: string | null;
  };
  receipt: {
    tx: string | null;
    payer: string | null;
    grossUsdc: number;
    creatorUsdc: number;
  } | null;
}

interface ActivityResponse {
  from: string;
  to: string;
  activities: ActivityEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface ActivityFilters {
  employeeId: string;
  departmentId: string;
  status: string;
  month: string;
}

function isCompanyDetailResponse(v: unknown): v is CompanyDetailResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.company === "object" && o.company !== null && Array.isArray(o.departments) && Array.isArray(o.pendingApprovals);
}

function isFireResponse(v: unknown): v is FireResponse {
  if (typeof v !== "object" || v === null) return false;
  return Array.isArray((v as { results?: unknown }).results);
}

function isBooksResponse(v: unknown): v is BooksResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.revenue !== "object" || o.revenue === null) return false;
  if (typeof o.spend !== "object" || o.spend === null) return false;
  const revenue = o.revenue as Record<string, unknown>;
  const spend = o.spend as Record<string, unknown>;
  return (
    typeof revenue.totalCreatorUsdc === "number" &&
    Array.isArray(revenue.lines) &&
    typeof spend.totalUsdc === "number" &&
    typeof o.netUsdc === "number"
  );
}

function isActivityResponse(v: unknown): v is ActivityResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.activities) &&
    typeof o.hasMore === "boolean" &&
    (typeof o.nextCursor === "string" || o.nextCursor === null)
  );
}

interface CeoMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposal: unknown | null;
  createdAt: string;
}

interface CeoMessagesResponse {
  messages: CeoMessage[];
}

function isCeoMessagesResponse(v: unknown): v is CeoMessagesResponse {
  if (typeof v !== "object" || v === null) return false;
  return Array.isArray((v as { messages?: unknown }).messages);
}

interface CeoTurnResponse {
  reply: string;
  proposal: unknown | null;
  executed: { kind: string } | null;
}

function isCeoTurnResponse(v: unknown): v is CeoTurnResponse {
  if (typeof v !== "object" || v === null) return false;
  return typeof (v as { reply?: unknown }).reply === "string";
}

function errorMessageFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof message === "string") return message;
  return typeof error === "string" ? error : null;
}

function extractCompanyId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { companyId?: unknown }).companyId;
  return typeof value === "string" ? value : null;
}

function extractRetryAfterSec(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { retryAfterSec?: unknown }).retryAfterSec;
  return typeof value === "number" ? value : null;
}

function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

interface TemplateFacts {
  seats: number;
  departments: number;
  pricedSeats: number;
  scheduledSeats: number;
  monthlyCapsUsdc: number;
}

/** The commercial shape of a template, read straight from the catalog the
 * founder is about to materialize: seat count, how many seats charge per
 * call, how many run on a schedule, and the monthly caps it ships with. */
function templateFacts(template: CompanyTemplate): TemplateFacts {
  let seats = 0;
  let pricedSeats = 0;
  let scheduledSeats = 0;
  let monthlyCapsUsdc = 0;
  for (const department of template.departments) {
    if (department.monthlyBudgetUsdc !== null) monthlyCapsUsdc += department.monthlyBudgetUsdc;
    for (const employee of department.employees) {
      seats += 1;
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
    monthlyCapsUsdc,
  };
}

function statusPillClass(status: CompanyStatus): string {
  if (status === "active") return "lp-pill lp-pill--live";
  if (status === "draft") return "lp-pill lp-pill--draft";
  return "lp-pill";
}

function formatPricePerCall(priceUsdc: number): string {
  return priceUsdc === 0 ? "Free" : `$${priceUsdc.toFixed(3)} per call`;
}

function formatUsdc(value: number): string {
  return `$${value.toFixed(2)}`;
}

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(month: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isInteger(year) || monthIndex < 0 || monthIndex > 11) return null;
  return {
    from: new Date(Date.UTC(year, monthIndex, 1)).toISOString(),
    to: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString(),
  };
}

function fireReasonSentence(reason: FireReason | undefined): string {
  if (reason === "employee_budget_exhausted" || reason === "department_budget_exhausted") {
    return "Budget reached for this month";
  }
  if (reason === "approval_required_publish_gated" || reason === "approval_required_over_threshold") {
    return "Waiting for your approval";
  }
  if (reason === "agent_missing") return "Agent record unavailable";
  if (reason === "flow_missing") return "Agent flow unavailable";
  return "Run skipped";
}

function approvalKindSentence(kind: ApprovalKind): string {
  if (kind === "enable_live_selling") return "Enable live selling";
  if (kind === "fire_publish_gated") return "Run a publish-gated employee";
  return "Run above the company cost threshold";
}

function approvalActionSummary(kind: ApprovalKind, employee: DetailEmployee | undefined): string {
  const employeeName = employee?.agent?.slug ?? employee?.agentId ?? "this employee";
  if (kind === "enable_live_selling") return `Enable live selling for ${employeeName}`;
  if (kind === "fire_publish_gated") {
    return `Run ${employeeName}: ${employee?.jobDescription ?? "publish-gated work"}`;
  }
  return `Run ${employeeName}: ${employee?.jobDescription ?? "work above the company cost threshold"}`;
}

function approvalCostSnapshot(kind: ApprovalKind): ApprovalCostSnapshot {
  if (kind === "enable_live_selling") {
    return {
      basis: "quoted",
      amountUsdc: 0,
      note: "This setting change does not execute a paid run.",
    };
  }
  return {
    basis: "unavailable",
    amountUsdc: null,
    note: "Execution cost is not quoted before this run.",
  };
}

function approvalCostLabel(snapshot: ApprovalCostSnapshot | null): string {
  if (!snapshot || snapshot.basis === "unavailable") return "Cost not available";
  return `${snapshot.basis === "quoted" ? "Quoted" : "Estimated"} cost: ${formatUsdc(snapshot.amountUsdc)}`;
}

function approvalKindForFireReason(reason: FireReason | undefined): ApprovalKind | null {
  if (reason === "approval_required_publish_gated") return "fire_publish_gated";
  if (reason === "approval_required_over_threshold") return "fire_over_threshold";
  return null;
}

/**
 * Presentation-level session probe. A signed-out visit to /company used to
 * fire GET /api/companies just to receive a 401, which browsers log to the
 * console as a network error. /api/identity answers signed-in-or-not with a
 * 200 either way (fail-closed, no database), so ask it first and skip the
 * authenticated fetches when there is no session. Auth semantics are
 * unchanged: every API route still verifies the session itself, and any
 * problem probing identity falls open to the original fetch-and-handle-401
 * path. A confirmed session is remembered so signed-in reloads pay the
 * probe exactly once.
 */
let confirmedSessionHint = false;
async function hasSuedeSessionHint(): Promise<boolean> {
  if (confirmedSessionHint) return true;
  try {
    const res = await fetch("/api/identity", { cache: "no-store" });
    if (!res.ok) return true;
    const body: unknown = await res.json().catch(() => null);
    const signedIn =
      typeof body === "object" &&
      body !== null &&
      (body as { signedIn?: unknown }).signedIn === true;
    if (signedIn) confirmedSessionHint = true;
    return signedIn;
  } catch {
    return true;
  }
}

/**
 * Signed-out /company: the full editorial story (mechanics walkthrough,
 * ungated template deep dive, complete catalog, founding FAQ) lives in
 * CompanySignedOutStory so this operating shell stays focused on the
 * signed-in dashboard. Presentation only; auth semantics unchanged.
 */
function SignedOutState(): React.JSX.Element {
  return <CompanySignedOutStory signInUrl={SIGN_IN_URL} />;
}

function TemplatePicker({
  templates,
  templatesError,
  busySlug,
  foundError,
  onFound,
}: {
  readonly templates: readonly CompanyTemplateSummary[] | null;
  readonly templatesError: string | null;
  readonly busySlug: string | null;
  readonly foundError: string | null;
  readonly onFound: (slug: string) => void;
}): React.JSX.Element {
  if (templatesError) {
    return (
      <div className="lp-empty" style={{ borderColor: "var(--rights-red)", color: "var(--rights-red)" }}>
        {templatesError}
      </div>
    );
  }
  if (!templates) {
    return <div className="lp-loading">Loading templates…</div>;
  }
  return (
    <TemplateOrgPicker
      templates={templates}
      busySlug={busySlug}
      foundError={foundError}
      onFound={onFound}
    />
  );
}

function CompanyOperatingLoop(): React.JSX.Element {
  const steps = [
    ["01", "Set direction", "Give the CEO the outcome, constraints, and budget."],
    ["02", "Shape the org", "The CEO proposes departments and hires; you confirm changes."],
    ["03", "Delegate work", "Run the company, a department, or one specialist."],
    ["04", "Stay in control", "Approvals, spend, activity, and receipts remain visible."],
  ] as const;

  return (
    <ol className="co-operating-loop" aria-label="How Company works">
      {steps.map(([number, title, description]) => (
        <li key={number}>
          <span className="co-loop-number tabular">{number}</span>
          <span>
            <b>{title}</b>
            <small>{description}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Org-chart-first template picker: the live org chart of the selected
 * template IS the picker. A new founder's first authenticated screen shows a
 * fully staffed company on the same canvas they'll operate after founding —
 * template chips switch companies, clicking an employee opens the flow it
 * ships with, and one button founds it.
 */
function TemplateOrgPicker({
  templates,
  busySlug,
  foundError,
  onFound,
}: {
  readonly templates: readonly CompanyTemplateSummary[];
  readonly busySlug: string | null;
  readonly foundError: string | null;
  readonly onFound: (slug: string) => void;
}): React.JSX.Element {
  // Only templates that exist in the local catalog can render a live org
  // preview; API-only strays (never expected) fall back to the first match.
  const previewable = useMemo(
    () => templates.filter((t) => COMPANY_TEMPLATES.some((full) => full.slug === t.slug)),
    [templates],
  );
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    previewable.length > 0 ? previewable[0].slug : null,
  );
  const selected =
    (selectedSlug && previewable.find((t) => t.slug === selectedSlug)) ||
    (previewable.length > 0 ? previewable[0] : null);
  const fullTemplate = selected
    ? COMPANY_TEMPLATES.find((t) => t.slug === selected.slug) ?? null
    : null;
  const preview = useMemo(
    () => (fullTemplate ? templateOrgPreview(fullTemplate) : null),
    [fullTemplate],
  );

  if (!selected || !fullTemplate || !preview) {
    return <div className="lp-empty">No templates available right now.</div>;
  }

  const facts = templateFacts(fullTemplate);
  const busy = busySlug === selected.slug;

  return (
    <div>
      {/* Ordinary pressed buttons, not a partial tabs pattern: there is no
          tabpanel relationship or roving focus here, so aria-pressed states
          what these are — toggles over which template the preview shows. */}
      <div role="group" aria-label="Company templates" className="co-picker-chips">
        {previewable.map((template) => {
          const active = template.slug === selected.slug;
          const chipSeats = template.departments.reduce((sum, d) => sum + d.employeeCount, 0);
          return (
            <button
              key={template.slug}
              type="button"
              aria-pressed={active}
              className="co-chip-card"
              onClick={() => setSelectedSlug(template.slug)}
            >
              <b>{template.name}</b>
              <span className="tabular">{pluralize(chipSeats, "seat")}</span>
            </button>
          );
        })}
      </div>

      <p className="co-picker-pitch">{selected.pitch}</p>
      <div className="co-facts" aria-label={`${selected.name} at a glance`}>
        <span className="co-fact">
          <b className="tabular">{facts.seats}</b> {facts.seats === 1 ? "seat" : "seats"}
        </span>
        <span className="co-fact">
          <b className="tabular">{facts.departments}</b>{" "}
          {facts.departments === 1 ? "department" : "departments"}
        </span>
        {facts.pricedSeats > 0 && (
          <span className="co-fact co-fact--paid">
            <b className="tabular">{facts.pricedSeats}</b> priced per call
          </span>
        )}
        {facts.scheduledSeats > 0 && (
          <span className="co-fact">
            <b className="tabular">{facts.scheduledSeats}</b> on a schedule
          </span>
        )}
        {facts.monthlyCapsUsdc > 0 && (
          <span className="co-fact">
            <b className="tabular">{formatUsdc(facts.monthlyCapsUsdc)}</b> monthly caps
          </span>
        )}
      </div>
      <p className="lp-hero-note" style={{ marginTop: "0.65rem", marginBottom: 0 }}>
        This is the live org chart, the same canvas you operate after founding. Click any seat
        to see the flow it ships with.
      </p>

      <div className="co-chart-frame co-chart-frame--picker">
        <OrgChartCanvas
          key={selected.slug}
          company={preview.company}
          departments={preview.departments}
          employees={preview.employees}
          staticNestedFlows={preview.nestedFlows}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.9rem",
          flexWrap: "wrap",
          marginTop: "0.9rem",
        }}
      >
        <button
          type="button"
          className="lp-btn lp-btn--primary"
          disabled={busySlug !== null}
          onClick={() => onFound(selected.slug)}
        >
          {busy ? "Founding…" : `Found ${selected.name}`}
        </button>
        <p className="co-found-note">
          Founds as a draft under your control. Nothing runs, sells, or spends until you
          approve it.
        </p>
      </div>

      {foundError && (
        <div
          className="lp-empty"
          style={{ marginTop: "0.9rem", borderColor: "var(--rights-red)", color: "var(--rights-red)" }}
        >
          {foundError}
        </div>
      )}
    </div>
  );
}

function CompanyDashboardPage(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = searchParams.get("id");

  const [signedOut, setSignedOut] = useState<boolean>(false);

  const [companies, setCompanies] = useState<CompanyListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [templates, setTemplates] = useState<CompanyTemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);

  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [foundError, setFoundError] = useState<string | null>(null);

  const [detail, setDetail] = useState<CompanyDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNotFound, setDetailNotFound] = useState<boolean>(false);
  // Chart-first on desktop: the org chart IS the product's mental model, so
  // it is the default operating view there. Mobile defaults to (and is held
  // on) the list; the chart is a desktop-only surface.
  const [detailViewMode, setDetailViewMode] = useState<"list" | "chart">(() =>
    typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches ? "list" : "chart",
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      if (event.matches) setDetailViewMode("list");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [showActivateConfirm, setShowActivateConfirm] = useState<boolean>(false);
  const activateCancelRef = useRef<HTMLButtonElement | null>(null);
  const activateTriggerRef = useRef<HTMLElement | null>(null);
  // Inert everything behind the modal so SR virtual cursors can't escape it.
  useEffect(() => {
    if (!showActivateConfirm) return;
    const touched: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.dialogPortal === "company-activate" || child.inert) continue;
      child.inert = true;
      touched.push(child);
    }
    return () => {
      for (const el of touched) el.inert = false;
    };
  }, [showActivateConfirm]);
  useEffect(() => {
    if (showActivateConfirm) {
      activateCancelRef.current?.focus();
    } else {
      // Return focus to the Review-and-activate button on close.
      activateTriggerRef.current?.focus();
      activateTriggerRef.current = null;
    }
  }, [showActivateConfirm]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [fireResults, setFireResults] = useState<FireResult[]>([]);
  const [approvalReasons, setApprovalReasons] = useState<Record<string, string>>({});
  const [companyNameInput, setCompanyNameInput] = useState<string>("");
  const [departmentName, setDepartmentName] = useState<string>("");
  const [thresholdInput, setThresholdInput] = useState<string>("");
  const [departmentBudgetInputs, setDepartmentBudgetInputs] = useState<Record<string, string>>({});
  const [employeeBudgetInputs, setEmployeeBudgetInputs] = useState<Record<string, string>>({});
  const [employeeWalletInputs, setEmployeeWalletInputs] = useState<Record<string, string>>({});

  const [booksMonth, setBooksMonth] = useState<string>(currentMonthValue);
  const [books, setBooks] = useState<BooksResponse | null>(null);
  const [booksLoading, setBooksLoading] = useState<boolean>(false);
  const [booksError, setBooksError] = useState<string | null>(null);

  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState<boolean>(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityEmployeeId, setActivityEmployeeId] = useState<string>("");
  const [activityDepartmentId, setActivityDepartmentId] = useState<string>("");
  const [activityStatus, setActivityStatus] = useState<string>("");
  const [activityMonth, setActivityMonth] = useState<string>(currentMonthValue);

  const [ceoMessages, setCeoMessages] = useState<CeoMessage[]>([]);
  const [ceoLoaded, setCeoLoaded] = useState<boolean>(false);
  const [ceoInput, setCeoInput] = useState<string>("");
  const [ceoBusy, setCeoBusy] = useState<boolean>(false);
  const [ceoError, setCeoError] = useState<string | null>(null);

  const loadCompanies = useCallback(async (): Promise<void> => {
    setListError(null);
    if (!(await hasSuedeSessionHint())) {
      setSignedOut(true);
      setCompanies(null);
      return;
    }
    try {
      const res = await fetch("/api/companies");
      if (res.status === 401) {
        setSignedOut(true);
        setCompanies(null);
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isCompaniesResponse(body)) {
        throw new Error(errorMessageFrom(body) ?? `Could not load your companies (${res.status}).`);
      }
      setSignedOut(false);
      setCompanies(body.companies);
    } catch (err: unknown) {
      setListError(err instanceof Error ? err.message : "Could not load your companies.");
    }
  }, []);

  const loadTemplates = useCallback(async (): Promise<void> => {
    setTemplatesError(null);
    try {
      const res = await fetch("/api/companies/templates");
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isTemplatesResponse(body)) {
        throw new Error(errorMessageFrom(body) ?? `Could not load templates (${res.status}).`);
      }
      setTemplates(body.templates);
    } catch (err: unknown) {
      setTemplatesError(err instanceof Error ? err.message : "Could not load templates.");
    }
  }, []);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    setDetailError(null);
    setDetailNotFound(false);
    if (!(await hasSuedeSessionHint())) {
      setSignedOut(true);
      setDetail(null);
      return;
    }
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}`);
      if (res.status === 401) {
        setSignedOut(true);
        setDetail(null);
        return;
      }
      if (res.status === 404) {
        setDetailNotFound(true);
        setDetail(null);
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isCompanyDetailResponse(body)) {
        throw new Error(errorMessageFrom(body) ?? `Could not load this company (${res.status}).`);
      }
      setSignedOut(false);
      setDetail(body);
      setCompanyNameInput(body.company.name);
      setThresholdInput(
        body.company.fireCostThresholdUsdc === null
          ? ""
          : String(body.company.fireCostThresholdUsdc),
      );
      setDepartmentBudgetInputs(
        Object.fromEntries(
          body.departments.map((department) => [
            department.id,
            department.monthlyBudgetUsdc === null ? "" : String(department.monthlyBudgetUsdc),
          ]),
        ),
      );
      setEmployeeBudgetInputs(
        Object.fromEntries(
          body.departments.flatMap((department) =>
            department.employees.map((employee) => [
              employee.agentId,
              employee.monthlyBudgetUsdc === null ? "" : String(employee.monthlyBudgetUsdc),
            ]),
          ),
        ),
      );
      setEmployeeWalletInputs(
        Object.fromEntries(
          body.departments.flatMap((department) =>
            department.employees.map((employee) => [employee.agentId, employee.payTo ?? ""]),
          ),
        ),
      );
    } catch (err: unknown) {
      setDetailError(err instanceof Error ? err.message : "Could not load this company.");
    }
  }, []);

  const loadBooks = useCallback(async (id: string, month: string): Promise<void> => {
    const bounds = monthBounds(month);
    if (!bounds) {
      setBooksError("Choose a valid month.");
      return;
    }
    setBooksLoading(true);
    setBooksError(null);
    try {
      const query = new URLSearchParams(bounds);
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}/books?${query.toString()}`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isBooksResponse(body)) {
        throw new Error(errorMessageFrom(body) ?? `Could not load company books (${res.status}).`);
      }
      setBooks(body);
    } catch (err: unknown) {
      setBooks(null);
      setBooksError(err instanceof Error ? err.message : "Could not load company books.");
    } finally {
      setBooksLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async (
    id: string,
    filters: ActivityFilters,
    options?: { cursor?: string; append?: boolean },
  ): Promise<void> => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const query = new URLSearchParams({ month: filters.month, limit: "50" });
      if (filters.employeeId) query.set("employeeId", filters.employeeId);
      if (filters.departmentId) query.set("departmentId", filters.departmentId);
      if (filters.status) query.set("status", filters.status);
      if (options?.cursor) query.set("cursor", options.cursor);
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}/activity?${query.toString()}`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isActivityResponse(body)) {
        throw new Error(errorMessageFrom(body) ?? `Could not load company activity (${res.status}).`);
      }
      setActivity((current) => {
        if (!options?.append || current === null) return body;
        const seen = new Set(current.activities.map((entry) => entry.id));
        return {
          ...body,
          activities: [
            ...current.activities,
            ...body.activities.filter((entry) => !seen.has(entry.id)),
          ],
        };
      });
    } catch (err: unknown) {
      if (!options?.append) setActivity(null);
      setActivityError(err instanceof Error ? err.message : "Could not load company activity.");
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const loadCeoMessages = useCallback(async (id: string): Promise<void> => {
    try {
      if (!(await hasSuedeSessionHint())) return;
      const res = await fetch(`/api/companies/${encodeURIComponent(id)}/ceo`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isCeoMessagesResponse(body)) return;
      setCeoMessages(body.messages);
    } catch {
      // Best-effort: chat history is supplementary, not load-bearing for the rest of the page.
    } finally {
      setCeoLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (companyId) {
      setDetail(null);
      setFireResults([]);
      setActionError(null);
      setActionNotice(null);
      setCeoMessages([]);
      void loadDetail(companyId);
      void loadCeoMessages(companyId);
    } else {
      setCompanies(null);
      void loadCompanies();
      void loadTemplates();
    }
  }, [companyId, loadDetail, loadCeoMessages, loadCompanies, loadTemplates]);

  useEffect(() => {
    if (!companyId) return;
    setBooks(null);
    void loadBooks(companyId, booksMonth);
  }, [booksMonth, companyId, loadBooks]);

  useEffect(() => {
    if (!companyId) return;
    setActivity(null);
    void loadActivity(companyId, {
      employeeId: activityEmployeeId,
      departmentId: activityDepartmentId,
      status: activityStatus,
      month: activityMonth,
    });
  }, [
    activityDepartmentId,
    activityEmployeeId,
    activityMonth,
    activityStatus,
    companyId,
    loadActivity,
  ]);

  const handleFound = useCallback(
    async (slug: string): Promise<void> => {
      setBusySlug(slug);
      setFoundError(null);
      try {
        const res = await fetch("/api/companies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ templateSlug: slug }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (res.status === 401) {
          setSignedOut(true);
          return;
        }
        const newCompanyId = extractCompanyId(body);
        if (!res.ok || newCompanyId === null) {
          const retryAfterSec = extractRetryAfterSec(body);
          const message =
            retryAfterSec !== null
              ? `You're founding companies quickly. Try again in ${retryAfterSec}s.`
              : (errorMessageFrom(body) ?? `Could not start that company (${res.status}).`);
          throw new Error(message);
        }
        router.push(`/company?id=${encodeURIComponent(newCompanyId)}`);
      } catch (err: unknown) {
        setFoundError(err instanceof Error ? err.message : "Could not start that company.");
      } finally {
        setBusySlug(null);
      }
    },
    [router],
  );

  const patchCompany = useCallback(
    async (
      id: string,
      patch: { name?: string; status?: CompanyStatus; fireCostThresholdUsdc?: number | null },
      busyKey: string,
      successMessage: string,
    ): Promise<void> => {
      setActionBusy(busyKey);
      setActionError(null);
      setActionNotice(null);
      try {
        const res = await fetch(`/api/companies/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(errorMessageFrom(body) ?? `Could not update the company (${res.status}).`);
        }
        await loadDetail(id);
        setActionNotice(successMessage);
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not update the company.");
      } finally {
        setActionBusy(null);
      }
    },
    [loadDetail],
  );

  const handleCompanyRename = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!companyId) return;
      const name = companyNameInput.trim();
      if (name === "") {
        setActionError("Company name cannot be empty.");
        return;
      }
      await patchCompany(companyId, { name }, "rename", "Company name updated.");
      await loadCompanies();
    },
    [companyId, companyNameInput, loadCompanies, patchCompany],
  );

  const handleThresholdSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!companyId) return;
      const trimmed = thresholdInput.trim();
      const threshold = trimmed === "" ? null : Number(trimmed);
      if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0)) {
        setActionError("Enter a non-negative run-cost threshold, or leave it blank.");
        return;
      }
      await patchCompany(
        companyId,
        { fireCostThresholdUsdc: threshold },
        "threshold",
        threshold === null
          ? "The company can now run without a per-run cost approval threshold."
          : "The company will ask before repeating work above that cost.",
      );
    },
    [companyId, patchCompany, thresholdInput],
  );

  const handleAddDepartment = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!companyId || departmentName.trim() === "") return;
      setActionBusy("add-department");
      setActionError(null);
      setActionNotice(null);
      try {
        const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/departments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: departmentName.trim() }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(errorMessageFrom(body) ?? `Could not add the department (${res.status}).`);
        }
        setDepartmentName("");
        await loadDetail(companyId);
        setActionNotice("Department added. Staff it when the role is ready.");
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not add the department.");
      } finally {
        setActionBusy(null);
      }
    },
    [companyId, departmentName, loadDetail],
  );

  const sendCeoMessage = useCallback(
    async (message: string): Promise<void> => {
      if (!companyId || message.trim() === "" || ceoBusy) return;
      setCeoBusy(true);
      setCeoError(null);
      try {
        const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/ceo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: message.trim() }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok || !isCeoTurnResponse(body)) {
          throw new Error(errorMessageFrom(body) ?? `The CEO could not respond (${res.status}).`);
        }
        setCeoInput("");
        await loadCeoMessages(companyId);
        if (body.executed) {
          await loadDetail(companyId);
        }
      } catch (err: unknown) {
        setCeoError(err instanceof Error ? err.message : "The CEO could not respond.");
      } finally {
        setCeoBusy(false);
      }
    },
    [ceoBusy, companyId, loadCeoMessages, loadDetail],
  );

  const handleCeoSend = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      await sendCeoMessage(ceoInput);
    },
    [ceoInput, sendCeoMessage],
  );

  const handleBudgetSave = useCallback(
    async (kind: "department" | "employee", targetId: string): Promise<void> => {
      if (!companyId) return;
      const raw = (kind === "department"
        ? departmentBudgetInputs[targetId]
        : employeeBudgetInputs[targetId]) ?? "";
      const trimmed = raw.trim();
      const monthlyBudgetUsdc = trimmed === "" ? null : Number(trimmed);
      if (monthlyBudgetUsdc !== null && (!Number.isFinite(monthlyBudgetUsdc) || monthlyBudgetUsdc < 0)) {
        setActionError("Enter a non-negative monthly cap, or leave it blank.");
        return;
      }

      const busyKey = `budget:${kind}:${targetId}`;
      const path = kind === "department"
        ? `/api/companies/${encodeURIComponent(companyId)}/departments/${encodeURIComponent(targetId)}`
        : `/api/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(targetId)}`;
      setActionBusy(busyKey);
      setActionError(null);
      setActionNotice(null);
      try {
        const res = await fetch(path, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monthlyBudgetUsdc }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(errorMessageFrom(body) ?? `Could not save the monthly cap (${res.status}).`);
        }
        await loadDetail(companyId);
        setActionNotice(
          monthlyBudgetUsdc === null
            ? `${kind === "department" ? "Department" : "Employee"} monthly cap removed.`
            : `${kind === "department" ? "Department" : "Employee"} monthly cap saved.`,
        );
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not save the monthly cap.");
      } finally {
        setActionBusy(null);
      }
    },
    [companyId, departmentBudgetInputs, employeeBudgetInputs, loadDetail],
  );

  const handleWalletSave = useCallback(
    async (agentId: string): Promise<void> => {
      if (!companyId) return;
      const raw = (employeeWalletInputs[agentId] ?? "").trim();
      const payTo = raw === "" ? null : raw;
      if (payTo !== null && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
        setActionError("Enter a valid EVM wallet address (0x…40 hex chars), or leave it blank to use the company wallet.");
        return;
      }
      const busyKey = `wallet:${agentId}`;
      setActionBusy(busyKey);
      setActionError(null);
      setActionNotice(null);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(agentId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payTo }),
          },
        );
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(errorMessageFrom(body) ?? `Could not save the wallet (${res.status}).`);
        }
        await loadDetail(companyId);
        setActionNotice(
          payTo === null
            ? "Employee wallet cleared. Settled calls route to the company wallet again."
            : "Employee wallet saved. Future settled calls route to it directly.",
        );
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not save the wallet.");
      } finally {
        setActionBusy(null);
      }
    },
    [companyId, employeeWalletInputs, loadDetail],
  );

  const handleRemoveEmployee = useCallback(
    async (employee: DetailEmployee): Promise<void> => {
      if (!companyId) return;
      const confirmed = window.confirm(
        "Remove this employee from the company? Public execution will stop; their agent, flow, and history will be preserved.",
      );
      if (!confirmed) return;

      const busyKey = `remove:${employee.agentId}`;
      setActionBusy(busyKey);
      setActionError(null);
      setActionNotice(null);
      try {
        const res = await fetch(
          `/api/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(employee.agentId)}`,
          { method: "DELETE" },
        );
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(errorMessageFrom(body) ?? `Could not remove the employee (${res.status}).`);
        }
        const nextEmployeeId = activityEmployeeId === employee.agentId ? "" : activityEmployeeId;
        if (nextEmployeeId !== activityEmployeeId) setActivityEmployeeId(nextEmployeeId);
        await Promise.all([
          loadDetail(companyId),
          loadActivity(companyId, {
            employeeId: nextEmployeeId,
            departmentId: activityDepartmentId,
            status: activityStatus,
            month: activityMonth,
          }),
        ]);
        setActionNotice("Employee removed and unpublished. Their agent, flow, and company history are preserved.");
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not remove the employee.");
      } finally {
        setActionBusy(null);
      }
    },
    [
      activityDepartmentId,
      activityEmployeeId,
      activityMonth,
      activityStatus,
      companyId,
      loadActivity,
      loadDetail,
    ],
  );

  const handleFire = useCallback(
    async (scope: "company" | "department" | "employee", targetId?: string): Promise<void> => {
      if (!companyId) return;
      const busyKey = `fire:${scope}:${targetId ?? companyId}`;
      setActionBusy(busyKey);
      setActionError(null);
      setActionNotice(null);
      setFireResults([]);
      try {
        const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/fire`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(targetId ? { scope, targetId } : { scope }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok || !isFireResponse(body)) {
          throw new Error(errorMessageFrom(body) ?? `Could not run that scope (${res.status}).`);
        }
        setFireResults(body.results);
        const ranCount = body.results.filter((result) => result.ran).length;
        setActionNotice(
          ranCount === 0
            ? "Nothing ran. Review the decisions below."
            : `${pluralize(ranCount, "seat")} completed this run.`,
        );
        await Promise.all([
          loadDetail(companyId),
          loadBooks(companyId, booksMonth),
          loadActivity(companyId, {
            employeeId: activityEmployeeId,
            departmentId: activityDepartmentId,
            status: activityStatus,
            month: activityMonth,
          }),
        ]);
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not run that scope.");
      } finally {
        setActionBusy(null);
      }
    },
    [
      activityDepartmentId,
      activityEmployeeId,
      activityMonth,
      activityStatus,
      booksMonth,
      companyId,
      loadActivity,
      loadBooks,
      loadDetail,
    ],
  );

  const createApproval = useCallback(
    async (kind: ApprovalKind, subjectId: string): Promise<void> => {
      if (!companyId || !detail) return;
      const alreadyPending = detail.pendingApprovals.some(
        (approval) => approval.kind === kind && approval.subjectId === subjectId,
      );
      if (alreadyPending) {
        setActionNotice("That decision is already waiting for you below.");
        return;
      }
      const employee = detail.departments
        .flatMap((department) => department.employees)
        .find((candidate) => candidate.agentId === subjectId);
      const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          create: {
            kind,
            subjectId,
            actionSummary: approvalActionSummary(kind, employee),
            costSnapshot: approvalCostSnapshot(kind),
          },
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(errorMessageFrom(body) ?? `Could not open the approval (${res.status}).`);
      }
      await Promise.all([
        loadDetail(companyId),
        loadActivity(companyId, {
          employeeId: activityEmployeeId,
          departmentId: activityDepartmentId,
          status: activityStatus,
          month: activityMonth,
        }),
      ]);
      setActionNotice("Decision added to your approval queue.");
    },
    [
      activityDepartmentId,
      activityEmployeeId,
      activityMonth,
      activityStatus,
      companyId,
      detail,
      loadActivity,
      loadDetail,
    ],
  );

  const handleRequestApproval = useCallback(
    async (kind: ApprovalKind, subjectId: string): Promise<void> => {
      setActionBusy(`approval:create:${kind}:${subjectId}`);
      setActionError(null);
      setActionNotice(null);
      try {
        await createApproval(kind, subjectId);
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not open the approval.");
      } finally {
        setActionBusy(null);
      }
    },
    [createApproval],
  );

  const handleSettlementToggle = useCallback(
    async (employee: DetailEmployee): Promise<void> => {
      if (!companyId || !employee.agent) return;
      const live = !employee.agent.settlementLive;
      const busyKey = `settlement:${employee.agentId}`;
      setActionBusy(busyKey);
      setActionError(null);
      setActionNotice(null);
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(employee.agent.slug)}/settlement`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ live }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (res.status === 409 && errorMessageFrom(body) === "approval_required") {
          await createApproval("enable_live_selling", employee.agentId);
          return;
        }
        if (!res.ok) {
          throw new Error(errorMessageFrom(body) ?? `Could not change live selling (${res.status}).`);
        }
        await Promise.all([
          loadDetail(companyId),
          loadActivity(companyId, {
            employeeId: activityEmployeeId,
            departmentId: activityDepartmentId,
            status: activityStatus,
            month: activityMonth,
          }),
        ]);
        setActionNotice(live ? "Live selling enabled." : "Live selling paused for this employee.");
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Could not change live selling.");
      } finally {
        setActionBusy(null);
      }
    },
    [
      activityDepartmentId,
      activityEmployeeId,
      activityMonth,
      activityStatus,
      companyId,
      createApproval,
      loadActivity,
      loadDetail,
    ],
  );

  const handleDecideApproval = useCallback(
    async (approval: ApprovalRecord, decision: "approved" | "rejected"): Promise<void> => {
      if (!companyId || !detail) return;
      const busyKey = `approval:decide:${approval.id}`;
      setActionBusy(busyKey);
      setActionError(null);
      setActionNotice(null);
      try {
        const reason = approvalReasons[approval.id]?.trim();
        const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/approvals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decide: {
              approvalId: approval.id,
              decision,
              ...(reason ? { reason } : {}),
            },
          }),
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(errorMessageFrom(body) ?? `Could not save the decision (${res.status}).`);
        }

        if (decision === "approved" && approval.kind === "enable_live_selling") {
          const employee = detail.departments
            .flatMap((department) => department.employees)
            .find((candidate) => candidate.agentId === approval.subjectId);
          if (!employee?.agent) {
            throw new Error("Approval saved, but the employee agent is unavailable.");
          }
          const enable = await fetch(`/api/agents/${encodeURIComponent(employee.agent.slug)}/settlement`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ live: true }),
          });
          const enableBody: unknown = await enable.json().catch(() => null);
          if (!enable.ok) {
            throw new Error(
              errorMessageFrom(enableBody) ?? `Approval saved, but live selling could not start (${enable.status}).`,
            );
          }
        }

        setApprovalReasons((current) => {
          const next = { ...current };
          delete next[approval.id];
          return next;
        });
        await Promise.all([
          loadDetail(companyId),
          loadActivity(companyId, {
            employeeId: activityEmployeeId,
            departmentId: activityDepartmentId,
            status: activityStatus,
            month: activityMonth,
          }),
        ]);
        setActionNotice(
          decision === "approved"
            ? approval.kind === "enable_live_selling"
              ? "Approved. Live selling is enabled for that employee."
              : "Approved. Run the employee again when you're ready."
            : "Rejected. The reason stays with this decision.",
        );
      } catch (err: unknown) {
        await loadDetail(companyId);
        setActionError(err instanceof Error ? err.message : "Could not save the decision.");
      } finally {
        setActionBusy(null);
      }
    },
    [
      activityDepartmentId,
      activityEmployeeId,
      activityMonth,
      activityStatus,
      approvalReasons,
      companyId,
      detail,
      loadActivity,
      loadDetail,
    ],
  );

  const hasCompanies = companies !== null && companies.length > 0;

  function renderList(): React.JSX.Element {
    return (
      <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Company</span>
          <h1>Build the company. Direct the CEO. Approve the work.</h1>
          <p>
            Turn an outcome into a staffed operating company. Your CEO proposes team changes;
            you approve the roster, budgets, and guarded work.
          </p>
          <CompanyOperatingLoop />
          <div className="lp-row-actions" style={{ marginTop: "1rem" }}>
            <Link className="lp-btn lp-btn--ghost lp-btn--sm" href="/company/operations">
              View company evidence
            </Link>
          </div>
        </header>

        {listError && (
          <div
            className="lp-empty"
            style={{
              borderColor: "var(--rights-red)",
              color: "var(--rights-red)",
              marginBottom: "1.2rem",
              textAlign: "left",
            }}
          >
            {listError}
          </div>
        )}

        {!listError && (
          <section className="lp-block" style={{ marginTop: 0 }}>
            {companies === null ? (
              <div className="lp-loading">Loading your companies…</div>
            ) : !hasCompanies ? (
              <div>
                <span className="lp-eyebrow">Found your first company</span>
                <h2 className="co-founding-title">
                  Pick a company. <em>Meet the team.</em> Found it.
                </h2>
                <p className="co-founding-sub">
                  Every template is a fully staffed org chart: departments, an agent in every
                  seat, and the flow each seat runs. Switch templates to compare companies,
                  then found the one you want. You review everything before it runs.
                </p>
                <div style={{ marginTop: "1.2rem" }}>
                  <TemplatePicker
                    templates={templates}
                    templatesError={templatesError}
                    busySlug={busySlug}
                    foundError={foundError}
                    onFound={(slug) => void handleFound(slug)}
                  />
                </div>
              </div>
            ) : (
              <>
                <span className="lp-eyebrow">Your companies</span>
                <h2 className="co-company-list-title">Choose a company to operate.</h2>
                <div className="lp-rows">
                  {companies.map((company) => (
                    <Link key={company.id} href={`/company?id=${encodeURIComponent(company.id)}`} className="lp-row">
                      <div className="grow">
                        <div className="name">{company.name}</div>
                        <div className="sub">{company.mission}</div>
                      </div>
                      <span className="lp-pill tabular">{pluralize(company.employeeCount, "seat")}</span>
                      <span className={statusPillClass(company.status)}>{company.status}</span>
                      <span className="co-open-company" aria-hidden="true">Open →</span>
                    </Link>
                  ))}
                </div>
                <div style={{ marginTop: "1.1rem" }}>
                  <button
                    type="button"
                    className="lp-btn lp-btn--ghost lp-btn--sm"
                    onClick={() => setPickerOpen((open) => !open)}
                  >
                    {pickerOpen ? "Hide templates" : "Found another company"}
                  </button>
                </div>
                {pickerOpen && (
                  <div style={{ marginTop: "1.1rem" }}>
                    <TemplatePicker
                      templates={templates}
                      templatesError={templatesError}
                      busySlug={busySlug}
                      foundError={foundError}
                      onFound={(slug) => void handleFound(slug)}
                    />
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </>
    );
  }

  function renderDetail(): React.JSX.Element {
    if (detailNotFound) {
      return (
        <div className="lp-empty" style={{ textAlign: "left" }}>
          <b>Company not found.</b>
          It may have been removed, or it belongs to a different workspace.
          <div className="lp-row-actions" style={{ marginTop: "1.1rem" }}>
            <Link href="/company" className="lp-iconbtn" style={{ textDecoration: "none" }}>
              ← All companies
            </Link>
          </div>
        </div>
      );
    }
    if (detailError) {
      return (
        <div className="lp-empty" style={{ borderColor: "var(--rights-red)", color: "var(--rights-red)" }}>
          {detailError}
        </div>
      );
    }
    if (!detail) {
      return <div className="lp-loading">Loading this company…</div>;
    }

    const { company, departments, pendingApprovals } = detail;
    const employees = departments.flatMap((department) => department.employees);
    const employeeByAgentId = new Map(employees.map((employee) => [employee.agentId, employee]));
    const liveAgentCount = employees.filter((employee) => employee.agent?.settlementLive).length;
    // Real per-agent revenue, not a placeholder: aggregated from the same
    // settled-run ledger the Books panel below reads (books.revenue.lines),
    // already fetched for the selected month — no new endpoint, no fake numbers.
    const earningsByAgentId = new Map<string, number>();
    for (const line of books?.revenue.lines ?? []) {
      earningsByAgentId.set(line.agentId, (earningsByAgentId.get(line.agentId) ?? 0) + line.creatorUsdc);
    }

    return (
      <>
        <div className="lp-row-actions">
          <Link href="/company" className="lp-iconbtn" style={{ textDecoration: "none" }}>
            ← All companies
          </Link>
          <Link href="/company/operations" className="lp-iconbtn" style={{ textDecoration: "none" }}>
            Company evidence
          </Link>
        </div>

        <header className="lp-page-head" style={{ marginTop: "1.1rem" }}>
          <span className="lp-eyebrow">Company</span>
          <h1>{company.name}</h1>
          <p>{company.mission}</p>
          <span
            className={statusPillClass(company.status)}
            style={{ marginTop: "0.7rem", display: "inline-block" }}
          >
            {company.status}
          </span>

          <div className="co-stats">
            <div className="lp-stat">
              <b className="tabular">{employees.length}</b>
              <span>{employees.length === 1 ? "Seat" : "Seats"}</span>
            </div>
            <div className="lp-stat">
              <b className="tabular">{departments.length}</b>
              <span>{departments.length === 1 ? "Department" : "Departments"}</span>
            </div>
            <div className="lp-stat">
              <b className="tabular">{liveAgentCount}</b>
              <span>Live</span>
            </div>
            <div className="lp-stat">
              <b className="tabular">{formatUsdc(books?.revenue.totalCreatorUsdc ?? 0)}</b>
              <span>Earned</span>
            </div>
            <div className="lp-stat">
              <b className="tabular">{formatUsdc(books?.netUsdc ?? 0)}</b>
              <span>Net</span>
            </div>
          </div>
        </header>

        <section className="co-command-deck" aria-labelledby="company-command-title">
          <div>
            <span className="lp-eyebrow">Founder command</span>
            <h2 id="company-command-title">Direct the CEO. Operate the whole org.</h2>
            <p>
              Give the CEO an outcome, review the proposed team, then run work at company,
              department, or specialist level. Roster changes, budgets, and guarded actions
              still wait for your confirmation.
            </p>
          </div>
          <div className="co-command-actions" role="group" aria-label="Founder commands">
            <a className="lp-btn lp-btn--primary lp-btn--sm" href="#company-ceo">
              Direct the CEO
            </a>
            <button
              type="button"
              className="lp-btn lp-btn--ghost lp-btn--sm"
              disabled={actionBusy !== null || company.status === "paused" || employees.length === 0}
              onClick={() => void handleFire("company")}
            >
              {actionBusy === `fire:company:${company.id}` ? "Running…" : "Run company"}
            </button>
            <a className="lp-btn lp-btn--ghost lp-btn--sm" href="#company-approvals">
              Review approvals{pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ""}
            </a>
          </div>
        </section>

        {company.status === "draft" && (
          <section className="co-draft" aria-label="Draft company">
            <span className="co-draft-kicker">Founded, in draft</span>
            <h2 className="co-draft-title">The team is hired. Nothing moves without you.</h2>
            <p className="co-draft-sub">
              Every seat below is staffed with a real agent: a role, a flow, a budget, and a
              price where one applies. Activation is the moment the company starts working on
              its own triggers.
            </p>
            <ul className="co-draft-list">
              <li>
                <b>Seats are staged</b>
                Each hire ships with its flow and monthly caps already set. Open any seat on
                the chart to inspect its work.
              </li>
              <li>
                <b>Live selling stays off</b>
                Priced seats cannot settle a paid call until you enable live selling for each
                one, and that decision waits in your approval queue.
              </li>
              <li>
                <b>You hold the plan</b>
                Publish-gated seats and runs above your cost threshold keep waiting for your
                sign-off even after the company is active.
              </li>
            </ul>
            <div className="co-draft-actions">
              <button
                type="button"
                className="lp-btn lp-btn--primary"
                disabled={actionBusy !== null}
                onClick={(event) => {
                  activateTriggerRef.current = event.currentTarget;
                  setShowActivateConfirm(true);
                }}
              >
                Review and activate
              </button>
              <p className="co-found-note">
                You can still run any seat manually while the company is in draft.
              </p>
            </div>
          </section>
        )}

        {actionError && (
          <div
            role="alert"
            className="lp-empty"
            style={{ borderColor: "var(--rights-red)", color: "var(--rights-red)", textAlign: "left" }}
          >
            {actionError}
          </div>
        )}
        {actionNotice && (
          <div className="lp-empty" role="status" style={{ textAlign: "left" }}>
            {actionNotice}
          </div>
        )}

        <div
          className="co-toggle"
          role="group"
          aria-label="Department view"
          style={{ marginTop: "1.1rem", marginBottom: "0.8rem" }}
        >
          <button
            type="button"
            className="co-toggle-chart"
            aria-pressed={detailViewMode === "chart"}
            onClick={() => setDetailViewMode("chart")}
          >
            Org chart
          </button>
          <button
            type="button"
            aria-pressed={detailViewMode === "list"}
            onClick={() => setDetailViewMode("list")}
          >
            List
          </button>
        </div>

        {detailViewMode === "chart" ? (
          departments.length === 0 ? (
            <div className="lp-empty">No departments yet. Add the first one in Governance below.</div>
          ) : (
            <div id="company-org-chart" style={{ marginBottom: "1.6rem" }}>
              <span className="lp-eyebrow">Operating org chart</span>
              <p className="lp-hero-note" style={{ marginTop: "0.4rem", marginBottom: "0.9rem" }}>
                Follow the current reporting lines across departments and specialists. Ask the
                CEO to reshape the roster; use List for budgets, wallets, and controls.
              </p>
              <div className="co-chart-frame co-chart-frame--dash">
                <OrgChartCanvas
                  company={company}
                  departments={departments}
                  employees={employees.map(
                    (employee): OrgChartEmployee => ({
                      ...employee,
                      flowId: employee.agent?.flowId,
                      earnedUsdc: earningsByAgentId.get(employee.agentId) ?? 0,
                      live: employee.agent?.settlementLive ?? false,
                      priceUsdc: employee.agent?.priceUsdc,
                    }),
                  )}
                />
              </div>
            </div>
          )
        ) : departments.length === 0 ? (
          <div className="lp-empty">No departments yet. Add the first one in Governance below.</div>
        ) : (
          <>
          <div className="co-status-legend" role="note" aria-label="Status legend">
            {SEAT_STATUS_LEGEND.map((meta) => (
              <span key={meta.tone} className="co-status-legend-item">
                <i
                  className={meta.pulsing ? "co-status-dot is-pulsing" : "co-status-dot"}
                  style={{ background: meta.cssVar }}
                  aria-hidden="true"
                />
                {meta.label}
              </span>
            ))}
          </div>
          {departments.map((department) => {
            const departmentBudgetExhausted =
              department.monthlyBudgetUsdc !== null &&
              department.monthSpendUsdc >= department.monthlyBudgetUsdc;
            return (
            <section key={department.id} className="lp-block">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "0.7rem 0.9rem",
                  marginBottom: "0.8rem",
                }}
              >
                <div>
                  <span className="lp-eyebrow">{department.name}</span>
                  {departmentBudgetExhausted && (
                    <span className="lp-pill lp-pill--draft" style={{ marginLeft: "0.55rem" }}>
                      Paused for budget
                    </span>
                  )}
                  <div
                    className="tabular"
                    style={{
                      marginTop: "0.25rem",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-label)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {formatUsdc(department.monthSpendUsdc)} spent · {department.monthlyBudgetUsdc === null
                      ? "no department cap"
                      : `${formatUsdc(department.monthlyBudgetUsdc)} monthly cap`}
                  </div>
                </div>
                <div className="lp-row-actions" style={{ justifyContent: "flex-end" }}>
                  <label className="guided-field-label" htmlFor={`department-budget-${department.id}`}>
                    Monthly cap
                    <input
                      id={`department-budget-${department.id}`}
                      className="lp-input tabular"
                      style={{ display: "block", marginTop: "0.3rem", width: "9rem" }}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="No cap"
                      value={departmentBudgetInputs[department.id] ?? ""}
                      onChange={(event) =>
                        setDepartmentBudgetInputs((current) => ({
                          ...current,
                          [department.id]: event.target.value,
                        }))
                      }
                      disabled={actionBusy !== null}
                    />
                  </label>
                  <button
                    type="button"
                    className="lp-btn lp-btn--ghost lp-btn--sm"
                    disabled={actionBusy !== null}
                    onClick={() => void handleBudgetSave("department", department.id)}
                  >
                    {actionBusy === `budget:department:${department.id}` ? "Saving…" : "Save cap"}
                  </button>
                  <button
                    type="button"
                    className="lp-btn lp-btn--ghost lp-btn--sm"
                    disabled={
                      actionBusy !== null ||
                      company.status === "paused" ||
                      departmentBudgetExhausted
                    }
                    onClick={() => void handleFire("department", department.id)}
                  >
                    {actionBusy === `fire:department:${department.id}` ? "Running…" : "Run department"}
                  </button>
                </div>
              </div>
              {department.employees.length === 0 ? (
                <div className="lp-empty">
                  No seats in this department yet. Ask the CEO below to hire into it.
                </div>
              ) : (
                <div className="lp-rows">
                  {department.employees.map((employee) => {
                    const employeeBudgetExhausted =
                      employee.monthlyBudgetUsdc !== null &&
                      employee.monthSpendUsdc >= employee.monthlyBudgetUsdc;
                    const pausedForBudget = departmentBudgetExhausted || employeeBudgetExhausted;
                    const seatMeta = seatStatusMeta(employee.lifecycleStatus, {
                      agentMissing: employee.agent === null,
                    });
                    const heartbeatRelative = formatRelativeTime(employee.lastHeartbeatAt);
                    const heartbeatCadence = employee.heartbeatEnabled
                      ? formatHeartbeatCadence(employee.heartbeatIntervalSeconds)
                      : null;
                    const seatMetaLine = [
                      employee.agent
                        ? `/a/${employee.agent.slug} · ${formatPricePerCall(employee.agent.priceUsdc)}`
                        : "Agent record unavailable.",
                      ...(heartbeatRelative !== null ? [`Heartbeat ${heartbeatRelative}`] : []),
                      ...(heartbeatCadence !== null ? [heartbeatCadence] : []),
                    ].join(" · ");
                    return (
                    <div
                      key={employee.agentId}
                      className="lp-row"
                      style={{ cursor: "default", alignItems: "flex-start", flexWrap: "wrap" }}
                    >
                      <div className="grow">
                        <div className="co-seat-head">
                          <i
                            className={seatMeta.pulsing ? "co-status-dot is-pulsing" : "co-status-dot"}
                            style={{ background: seatMeta.cssVar }}
                            aria-hidden="true"
                          />
                          <span className="name">
                            {employee.agent
                              ? `${employee.agent.slug} · ${employee.jobDescription}`
                              : employee.jobDescription}
                          </span>
                          <span className="co-status-label">{seatMeta.label}</span>
                        </div>
                        <div className="sub co-seat-meta">{seatMetaLine}</div>
                        <div className="sub tabular">
                          {formatUsdc(employee.monthSpendUsdc)} spent · {employee.monthlyBudgetUsdc === null
                            ? "no employee cap"
                            : `${formatUsdc(employee.monthlyBudgetUsdc)} monthly cap`}
                        </div>
                        <div className="sub tabular">
                          {employee.payTo
                            ? `Settles to own wallet ${employee.payTo.slice(0, 6)}…${employee.payTo.slice(-4)}`
                            : "Settles to the company wallet"}
                        </div>
                        {employee.agent && (
                          <div className="lp-row-actions" style={{ marginTop: "0.55rem" }}>
                            <Link
                              className="lp-iconbtn"
                              href={`/start?flow=${encodeURIComponent(employee.agent.flowId)}`}
                            >
                              Guided
                            </Link>
                            <Link
                              className="lp-iconbtn"
                              href={`/build/${encodeURIComponent(employee.agent.flowId)}`}
                            >
                              Studio
                            </Link>
                            <Link
                              className="lp-iconbtn"
                              href={`/code/${encodeURIComponent(employee.agent.flowId)}`}
                            >
                              Code
                            </Link>
                            <Link
                              className="lp-iconbtn"
                              href={`/flows/${encodeURIComponent(employee.agent.flowId)}`}
                            >
                              Record
                            </Link>
                          </div>
                        )}
                      </div>
                      <div className="lp-row-actions" style={{ justifyContent: "flex-end" }}>
                        {employee.publishGated && (
                          <span className="lp-pill lp-pill--draft">Approval before publishing</span>
                        )}
                        {pausedForBudget && (
                          <span className="lp-pill lp-pill--draft">Paused for budget</span>
                        )}
                        {employee.agent && (
                          <span className={employee.agent.settlementLive ? "lp-pill lp-pill--live" : "lp-pill"}>
                            {employee.agent.settlementLive ? "Live selling on" : "Live selling off"}
                          </span>
                        )}
                        <label className="guided-field-label" htmlFor={`employee-budget-${employee.agentId}`}>
                          Monthly cap
                          <input
                            id={`employee-budget-${employee.agentId}`}
                            className="lp-input tabular"
                            style={{ display: "block", marginTop: "0.3rem", width: "8rem" }}
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="No cap"
                            value={employeeBudgetInputs[employee.agentId] ?? ""}
                            onChange={(event) =>
                              setEmployeeBudgetInputs((current) => ({
                                ...current,
                                [employee.agentId]: event.target.value,
                              }))
                            }
                            disabled={actionBusy !== null}
                          />
                        </label>
                        <button
                          type="button"
                          className="lp-btn lp-btn--ghost lp-btn--sm"
                          disabled={actionBusy !== null}
                          onClick={() => void handleBudgetSave("employee", employee.agentId)}
                        >
                          {actionBusy === `budget:employee:${employee.agentId}` ? "Saving…" : "Save cap"}
                        </button>
                        <label className="guided-field-label" htmlFor={`employee-wallet-${employee.agentId}`}>
                          Own wallet
                          <input
                            id={`employee-wallet-${employee.agentId}`}
                            className="lp-input tabular"
                            style={{ display: "block", marginTop: "0.3rem", width: "13rem" }}
                            type="text"
                            spellCheck={false}
                            placeholder="0x… (blank = company wallet)"
                            value={employeeWalletInputs[employee.agentId] ?? ""}
                            onChange={(event) =>
                              setEmployeeWalletInputs((current) => ({
                                ...current,
                                [employee.agentId]: event.target.value,
                              }))
                            }
                            disabled={actionBusy !== null}
                          />
                        </label>
                        <button
                          type="button"
                          className="lp-btn lp-btn--ghost lp-btn--sm"
                          disabled={actionBusy !== null}
                          onClick={() => void handleWalletSave(employee.agentId)}
                        >
                          {actionBusy === `wallet:${employee.agentId}` ? "Saving…" : "Save wallet"}
                        </button>
                        <button
                          type="button"
                          className="lp-btn lp-btn--ghost lp-btn--sm"
                          disabled={
                            actionBusy !== null ||
                            company.status === "paused" ||
                            pausedForBudget ||
                            employee.agent === null
                          }
                          onClick={() => void handleFire("employee", employee.agentId)}
                        >
                          {actionBusy === `fire:employee:${employee.agentId}` ? "Running…" : "Run employee"}
                        </button>
                        {employee.agent && (
                          <button
                            type="button"
                            className="lp-btn lp-btn--ghost lp-btn--sm"
                            disabled={actionBusy !== null}
                            onClick={() => void handleSettlementToggle(employee)}
                          >
                            {actionBusy === `settlement:${employee.agentId}`
                              ? "Saving…"
                              : employee.agent.settlementLive
                                ? "Pause live selling"
                                : "Enable live selling"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="lp-btn lp-btn--ghost lp-btn--sm"
                          style={{ color: "var(--rights-red)" }}
                          disabled={actionBusy !== null}
                          onClick={() => void handleRemoveEmployee(employee)}
                        >
                          {actionBusy === `remove:${employee.agentId}` ? "Removing…" : "Remove employee"}
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </section>
            );
          })}
          </>
        )}

        <section id="company-ceo" className="lp-block" style={{ scrollMarginTop: "6rem" }}>
          <span className="lp-eyebrow">The CEO</span>
          <h2 style={{ marginTop: "0.45rem" }}>Give the CEO the next outcome.</h2>
          <p style={{ color: "var(--text-secondary)", maxWidth: "64ch" }}>
            Ask it to hire a specialist, let someone go, change a budget, or create a
            department. The CEO proposes one concrete change; nothing executes until you confirm it.
          </p>

          <div
            className="lp-rows"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            style={{ marginTop: "1rem", maxHeight: "22rem", overflowY: "auto" }}
          >
            {ceoMessages.length === 0 && !ceoLoaded ? (
              <div className="lp-loading">Loading the conversation…</div>
            ) : ceoMessages.length === 0 ? (
              <div className="lp-empty" style={{ textAlign: "left" }}>
                No messages yet. Try &ldquo;hire a note-taker for {departments[0]?.name ?? "Operations"}&rdquo;.
              </div>
            ) : (
              ceoMessages.map((entry, index) => {
                const isProposal = entry.role === "assistant" && entry.proposal !== null;
                const isPendingProposal = isProposal && index === ceoMessages.length - 1;
                return (
                  <div
                    key={entry.id}
                    className="lp-row"
                    style={{
                      cursor: "default",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      ...(isProposal
                        ? {
                            borderColor: "color-mix(in srgb, var(--primary) 38%, var(--hairline))",
                            boxShadow:
                              "inset 0 0 0 1px color-mix(in srgb, var(--primary) 10%, transparent)",
                            background: "color-mix(in srgb, var(--primary) 6%, var(--ink-panel))",
                          }
                        : {}),
                    }}
                  >
                    <span
                      className="guided-field-label"
                      style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
                    >
                      {entry.role === "user" ? "You" : "The CEO"}
                      {isPendingProposal && (
                        <span
                          className="lp-pill"
                          style={{ color: "var(--primary)", borderColor: "var(--primary)" }}
                        >
                          pending, nothing runs until you confirm
                        </span>
                      )}
                    </span>
                    <div className="sub" style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>
                      {entry.content}
                    </div>
                    {isPendingProposal && (
                      <div className="lp-row-actions" style={{ marginTop: "0.6rem" }}>
                        <button
                          type="button"
                          className="lp-btn lp-btn--primary lp-btn--sm"
                          disabled={ceoBusy}
                          onClick={() => void sendCeoMessage("yes")}
                        >
                          Confirm and run it
                        </button>
                        <button
                          type="button"
                          className="lp-btn lp-btn--ghost lp-btn--sm"
                          disabled={ceoBusy}
                          onClick={() => void sendCeoMessage("no")}
                        >
                          Not now
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {ceoError && <p style={{ color: "var(--rights-red)", marginTop: "0.65rem" }}>{ceoError}</p>}

          <form onSubmit={(event) => void handleCeoSend(event)} className="guided-form" style={{ marginTop: "1rem" }}>
            <label className="guided-field-label" htmlFor="ceo-message">
              Message
            </label>
            <input
              id="ceo-message"
              className="lp-input"
              type="text"
              placeholder="Hire another lead qualifier in Marketing"
              value={ceoInput}
              onChange={(event) => setCeoInput(event.target.value)}
              disabled={ceoBusy}
            />
            <button
              type="submit"
              className="lp-btn lp-btn--primary lp-btn--sm"
              disabled={ceoBusy || ceoInput.trim() === ""}
            >
              {ceoBusy ? "Sending…" : "Send"}
            </button>
          </form>
        </section>

        <section className="lp-block">
          <span className="lp-eyebrow">Governance</span>
          <h2 style={{ marginTop: "0.45rem" }}>Set the company guardrails.</h2>
          <p style={{ color: "var(--text-secondary)", maxWidth: "64ch" }}>
            Run the whole company, pause every public run, and keep guarded work waiting for
            your sign-off.
          </p>

          <div className="lp-row-actions" style={{ marginTop: "1rem" }}>
            <button
              type="button"
              className="lp-btn lp-btn--primary lp-btn--sm"
              disabled={actionBusy !== null || company.status === "paused" || employees.length === 0}
              onClick={() => void handleFire("company")}
            >
              {actionBusy === `fire:company:${company.id}` ? "Running company…" : "Run the company"}
            </button>
            {company.status === "draft" ? (
              <button
                type="button"
                className="lp-btn lp-btn--ghost lp-btn--sm"
                disabled={actionBusy !== null}
                onClick={(event) => {
                  activateTriggerRef.current = event.currentTarget;
                  setShowActivateConfirm(true);
                }}
              >
                {actionBusy === "status" ? "Activating…" : "Review and activate"}
              </button>
            ) : company.status === "active" ? (
              <button
                type="button"
                className="lp-btn lp-btn--ghost lp-btn--sm"
                style={{ color: "var(--rights-red)" }}
                disabled={actionBusy !== null}
                onClick={() =>
                  void patchCompany(
                    company.id,
                    { status: "paused" },
                    "status",
                    "Company paused. Public employee runs are blocked until you resume.",
                  )
                }
              >
                {actionBusy === "status" ? "Pausing…" : "Pause company"}
              </button>
            ) : (
              <button
                type="button"
                className="lp-btn lp-btn--primary lp-btn--sm"
                disabled={actionBusy !== null}
                onClick={() =>
                  void patchCompany(
                    company.id,
                    { status: "active" },
                    "status",
                    "Company resumed. Governed runs and public employee runs are available again.",
                  )
                }
              >
                {actionBusy === "status" ? "Resuming…" : "Resume company"}
              </button>
            )}
          </div>

          {showActivateConfirm && createPortal(
            <div
              className="flow-impact-dialog__backdrop"
              data-dialog-portal="company-activate"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setShowActivateConfirm(false);
              }}
            >
              <div
                className="flow-impact-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="activate-company-title"
                aria-describedby="activate-company-desc"
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setShowActivateConfirm(false);
                    return;
                  }
                  if (event.key !== "Tab") return;
                  const focusable = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"),
                  ];
                  if (focusable.length === 0) return;
                  const first = focusable[0]!;
                  const last = focusable.at(-1)!;
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                  }
                }}
              >
                <header className="flow-impact-dialog__heading">
                  <span className="eyebrow">Review before going live</span>
                  <h2 id="activate-company-title">Activate {company.name}?</h2>
                  <p id="activate-company-desc">
                    {employees.length} {employees.length === 1 ? "seat" : "seats"} across{" "}
                    {departments.length} {departments.length === 1 ? "department" : "departments"}{" "}
                    {employees.length === 1 ? "starts" : "start"} running on their triggers.
                    {employees.some((e) => e.publishGated)
                      ? ` ${employees.filter((e) => e.publishGated).length} stay${employees.filter((e) => e.publishGated).length === 1 ? "s" : ""} publish-gated and won't sell live until you clear ${employees.filter((e) => e.publishGated).length === 1 ? "it" : "them"} individually.`
                      : " Every employee's live-selling gate still applies per employee."}
                  </p>
                </header>
                <section className="flow-impact-dialog__summary" aria-label="Department budgets">
                  {departments.some((d) => d.monthlyBudgetUsdc !== null) ? (
                    <ul>
                      {departments
                        .filter((d) => d.monthlyBudgetUsdc !== null)
                        .map((d) => (
                          <li key={d.id}>
                            <span>{d.name}</span>
                            <small>${d.monthlyBudgetUsdc!.toFixed(2)}/mo cap</small>
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p>No department budget caps are set. You can add them any time.</p>
                  )}
                </section>
                <div className="flow-impact-dialog__actions">
                  <button
                    ref={activateCancelRef}
                    type="button"
                    onClick={() => setShowActivateConfirm(false)}
                  >
                    Not yet
                  </button>
                  <button
                    type="button"
                    className="flow-impact-dialog__confirm"
                    disabled={actionBusy !== null}
                    onClick={() => {
                      setShowActivateConfirm(false);
                      void patchCompany(
                        company.id,
                        { status: "active" },
                        "status",
                        "Review approved. The company is active; each employee's live-selling gate still applies.",
                      );
                    }}
                  >
                    Activate the company
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}

          {fireResults.length > 0 && (
            <div style={{ marginTop: "1.2rem" }}>
              <span className="lp-eyebrow">Latest run</span>
              <div className="lp-rows" style={{ marginTop: "0.65rem" }}>
                {fireResults.map((result) => {
                  const employee = employeeByAgentId.get(result.agentId);
                  const approvalKind = approvalKindForFireReason(result.reason);
                  return (
                    <div key={result.agentId} className="lp-row" style={{ cursor: "default", flexWrap: "wrap" }}>
                      <div className="grow">
                        <div className="name">{employee?.jobDescription ?? result.agentId}</div>
                        <div className="sub">
                          {result.ran
                            ? result.dryRun
                              ? "Dry run completed"
                              : "Run completed"
                            : fireReasonSentence(result.reason)}
                        </div>
                      </div>
                      <span className={result.ran ? "lp-pill lp-pill--live" : "lp-pill lp-pill--draft"}>
                        {result.ran ? "completed" : "skipped"}
                      </span>
                      {approvalKind && (
                        <button
                          type="button"
                          className="lp-btn lp-btn--ghost lp-btn--sm"
                          disabled={actionBusy !== null}
                          onClick={() => void handleRequestApproval(approvalKind, result.agentId)}
                        >
                          Add to approvals
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "1rem",
              marginTop: "1.25rem",
            }}
          >
            <form onSubmit={(event) => void handleCompanyRename(event)} className="guided-form">
              <label className="guided-field-label" htmlFor="company-name">
                Company name
              </label>
              <input
                id="company-name"
                className="lp-input"
                maxLength={200}
                value={companyNameInput}
                onChange={(event) => setCompanyNameInput(event.target.value)}
                disabled={actionBusy !== null}
              />
              <p className="guided-hint">Renames the company everywhere it appears.</p>
              <button
                type="submit"
                className="lp-btn lp-btn--ghost lp-btn--sm"
                disabled={
                  actionBusy !== null ||
                  companyNameInput.trim() === "" ||
                  companyNameInput.trim() === company.name
                }
              >
                {actionBusy === "rename" ? "Saving…" : "Rename company"}
              </button>
            </form>

            <form onSubmit={(event) => void handleThresholdSubmit(event)} className="guided-form">
              <label className="guided-field-label" htmlFor="company-fire-threshold">
                Approval threshold per run
              </label>
              <input
                id="company-fire-threshold"
                className="lp-input tabular"
                type="number"
                min="0"
                step="0.001"
                placeholder="No threshold"
                value={thresholdInput}
                onChange={(event) => setThresholdInput(event.target.value)}
                disabled={actionBusy !== null}
              />
              <p className="guided-hint">Work above this prior-run cost waits for your approval.</p>
              <button type="submit" className="lp-btn lp-btn--ghost lp-btn--sm" disabled={actionBusy !== null}>
                {actionBusy === "threshold" ? "Saving…" : "Save threshold"}
              </button>
            </form>

            <form onSubmit={(event) => void handleAddDepartment(event)} className="guided-form">
              <label className="guided-field-label" htmlFor="company-department-name">
                Add a department
              </label>
              <input
                id="company-department-name"
                className="lp-input"
                type="text"
                minLength={1}
                placeholder="Licensing operations"
                value={departmentName}
                onChange={(event) => setDepartmentName(event.target.value)}
                disabled={actionBusy !== null}
              />
              <p className="guided-hint">Grow the org chart without running any employee.</p>
              <button
                type="submit"
                className="lp-btn lp-btn--ghost lp-btn--sm"
                disabled={actionBusy !== null || departmentName.trim() === ""}
              >
                {actionBusy === "add-department" ? "Adding…" : "Add department"}
              </button>
            </form>
          </div>

          <div id="company-approvals" style={{ marginTop: "1.5rem", scrollMarginTop: "6rem" }}>
            <span className="lp-eyebrow">Approvals</span>
            {pendingApprovals.length === 0 ? (
              <div className="lp-empty" style={{ marginTop: "0.65rem", textAlign: "left" }}>
                No decisions waiting. Guarded runs and live-selling changes appear here before they run.
              </div>
            ) : (
              <div className="lp-rows" style={{ marginTop: "0.65rem" }}>
                {pendingApprovals.map((approval) => {
                  const employee = employeeByAgentId.get(approval.subjectId);
                  return (
                    <div
                      key={approval.id}
                      className="lp-row"
                      style={{ cursor: "default", alignItems: "flex-start", flexWrap: "wrap" }}
                    >
                      <div className="grow">
                        <div className="name">{approvalKindSentence(approval.kind)}</div>
                        <div className="sub">{employee?.jobDescription ?? approval.subjectId}</div>
                        <div
                          style={{
                            marginTop: "0.65rem",
                            padding: "0.7rem 0.8rem",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-sm)",
                            background: "var(--surface-raised)",
                          }}
                        >
                          <div className="guided-field-label">Action</div>
                          <div style={{ marginTop: "0.2rem", color: "var(--text-primary)" }}>
                            {approval.actionSummary ?? approvalKindSentence(approval.kind)}
                          </div>
                          <div className="name" style={{ marginTop: "0.55rem" }}>
                            {approvalCostLabel(approval.costSnapshot)}
                          </div>
                          {approval.costSnapshot?.note && (
                            <div className="sub" style={{ marginTop: "0.2rem" }}>
                              {approval.costSnapshot.note}
                            </div>
                          )}
                        </div>
                        <input
                          className="lp-input"
                          style={{ marginTop: "0.65rem", maxWidth: "34rem" }}
                          type="text"
                          placeholder="Optional decision reason"
                          value={approvalReasons[approval.id] ?? ""}
                          onChange={(event) =>
                            setApprovalReasons((current) => ({
                              ...current,
                              [approval.id]: event.target.value,
                            }))
                          }
                          disabled={actionBusy !== null}
                          aria-label={`Optional reason for ${approvalKindSentence(approval.kind)}`}
                        />
                      </div>
                      <div className="lp-row-actions">
                        <button
                          type="button"
                          className="lp-btn lp-btn--primary lp-btn--sm"
                          disabled={actionBusy !== null}
                          onClick={() => void handleDecideApproval(approval, "approved")}
                        >
                          {actionBusy === `approval:decide:${approval.id}` ? "Saving…" : "Approve"}
                        </button>
                        <button
                          type="button"
                          className="lp-btn lp-btn--ghost lp-btn--sm"
                          style={{ color: "var(--rights-red)" }}
                          disabled={actionBusy !== null}
                          onClick={() => void handleDecideApproval(approval, "rejected")}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="lp-block">
          <span className="lp-eyebrow">Company evidence</span>
          <h2 style={{ marginTop: "0.45rem" }}>A durable record of what happened.</h2>
          <p style={{ color: "var(--text-secondary)", maxWidth: "68ch" }}>
            Runs come from persisted execution records; decisions come from the approval
            ledger, with receipt links retained where settlement returns them.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              gap: "0.75rem",
              marginTop: "1rem",
            }}
          >
            <label className="guided-field-label" htmlFor="activity-department">
              Department
              <select
                id="activity-department"
                className="lp-input"
                style={{ display: "block", marginTop: "0.3rem" }}
                value={activityDepartmentId}
                onChange={(event) => setActivityDepartmentId(event.target.value)}
              >
                <option value="">All departments</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
            <label className="guided-field-label" htmlFor="activity-employee">
              Employee
              <select
                id="activity-employee"
                className="lp-input"
                style={{ display: "block", marginTop: "0.3rem" }}
                value={activityEmployeeId}
                onChange={(event) => setActivityEmployeeId(event.target.value)}
              >
                <option value="">All employees</option>
                {employees.map((employee) => (
                  <option key={employee.agentId} value={employee.agentId}>{employee.jobDescription}</option>
                ))}
              </select>
            </label>
            <label className="guided-field-label" htmlFor="activity-status">
              Status
              <select
                id="activity-status"
                className="lp-input"
                style={{ display: "block", marginTop: "0.3rem" }}
                value={activityStatus}
                onChange={(event) => setActivityStatus(event.target.value)}
              >
                <option value="">All statuses</option>
                {[
                  ["running", "Running"],
                  ["done", "Done"],
                  ["error", "Error"],
                  ["pending", "Pending approval"],
                  ["approved", "Approved"],
                  ["rejected", "Rejected"],
                  ["consumed", "Consumed"],
                ].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="guided-field-label" htmlFor="activity-month">
              Month
              <input
                id="activity-month"
                className="lp-input tabular"
                style={{ display: "block", marginTop: "0.3rem" }}
                type="month"
                value={activityMonth}
                onChange={(event) => setActivityMonth(event.target.value)}
              />
            </label>
          </div>

          {activityError && (
            <div
              role="alert"
              className="lp-empty"
              style={{ marginTop: "1rem", borderColor: "var(--rights-red)", color: "var(--rights-red)" }}
            >
              {activityError}
            </div>
          )}
          {activity === null ? (
            !activityError && <div className="lp-loading" style={{ marginTop: "1rem" }}>Loading activity…</div>
          ) : activity.activities.length === 0 ? (
            <div className="lp-empty" style={{ marginTop: "1rem", textAlign: "left" }}>
              No persisted runs or approval decisions match these filters.
            </div>
          ) : (
            <>
              <div className="lp-rows" style={{ marginTop: "1rem" }}>
                {activity.activities.map((entry) => {
                  const employee = entry.employeeId ? employeeByAgentId.get(entry.employeeId) : null;
                  return (
                    <div
                      key={entry.id}
                      className="lp-row"
                      style={{ cursor: "default", alignItems: "flex-start", flexWrap: "wrap" }}
                    >
                      <div className="grow">
                        <div className="name">
                          {entry.kind === "run"
                            ? employee?.jobDescription ?? entry.employeeId ?? "Company run"
                            : entry.approvalKind
                              ? approvalKindSentence(entry.approvalKind)
                              : "Approval decision"}
                        </div>
                        <div className="sub">
                          {new Date(entry.occurredAt).toLocaleString()}
                          {entry.trigger ? ` · ${entry.trigger}` : ""}
                          {entry.costUsdc !== null ? ` · ${formatUsdc(entry.costUsdc)} cost` : ""}
                        </div>
                        {entry.outcome.preview && (
                          <div className="sub" style={{ marginTop: "0.35rem" }}>
                            {entry.outcome.kind === "error" ? "Failed: " : "Produced: "}
                            {entry.outcome.preview}
                          </div>
                        )}
                        {entry.reason && (
                          <div className="sub" style={{ marginTop: "0.35rem" }}>Reason: {entry.reason}</div>
                        )}
                      </div>
                      <div className="lp-row-actions" style={{ justifyContent: "flex-end" }}>
                        <span className={entry.status === "done" || entry.status === "approved"
                          ? "lp-pill lp-pill--live"
                          : entry.status === "error" || entry.status === "rejected"
                            ? "lp-pill lp-pill--draft"
                            : "lp-pill"}
                        >
                          {entry.status}
                        </span>
                        {entry.receipt && (
                          entry.receipt.tx ? (
                            <a
                              className="lp-iconbtn"
                              href={`https://basescan.org/tx/${encodeURIComponent(entry.receipt.tx)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Receipt ↗
                            </a>
                          ) : (
                            <span className="sub">no receipt returned</span>
                          )
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {activity.hasMore && activity.nextCursor && (
                <button
                  type="button"
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                  style={{ marginTop: "0.75rem" }}
                  disabled={activityLoading}
                  onClick={() => {
                    if (!companyId) return;
                    void loadActivity(companyId, {
                      employeeId: activityEmployeeId,
                      departmentId: activityDepartmentId,
                      status: activityStatus,
                      month: activityMonth,
                    }, { cursor: activity.nextCursor ?? undefined, append: true });
                  }}
                >
                  {activityLoading ? "Loading…" : "Load older activity"}
                </button>
              )}
            </>
          )}
        </section>

        <section className="lp-block">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <div>
              <span className="lp-eyebrow">Books</span>
              <h2 style={{ marginTop: "0.45rem", marginBottom: 0 }}>Company books, grounded in the ledgers.</h2>
            </div>
            <label className="guided-field-label" htmlFor="company-books-month">
              Month
              <input
                id="company-books-month"
                className="lp-input tabular"
                style={{ display: "block", marginTop: "0.35rem", width: "auto" }}
                type="month"
                value={booksMonth}
                onChange={(event) => setBooksMonth(event.target.value)}
              />
            </label>
          </div>

          {booksError && (
            <div
              role="alert"
              className="lp-empty"
              style={{ marginTop: "1rem", borderColor: "var(--rights-red)", color: "var(--rights-red)" }}
            >
              {booksError}
            </div>
          )}
          {booksLoading || books === null ? (
            !booksError && <div className="lp-loading" style={{ marginTop: "1rem" }}>Loading company books…</div>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: "0.8rem",
                  marginTop: "1rem",
                }}
              >
                {[
                  ["Revenue", books.revenue.totalCreatorUsdc],
                  ["Spend", books.spend.totalUsdc],
                  ["Net", books.netUsdc],
                ].map(([label, amount]) => (
                  <div key={String(label)} className="lp-row" style={{ cursor: "default", display: "block" }}>
                    <div className="sub">{label}</div>
                    <div
                      className="name tabular"
                      style={{ marginTop: "0.25rem", fontFamily: "var(--font-display)", fontSize: "var(--text-h2)" }}
                    >
                      {formatUsdc(Number(amount))}
                    </div>
                  </div>
                ))}
              </div>

              {books.revenue.lines.length === 0 ? (
                <div className="lp-empty" style={{ marginTop: "1rem", textAlign: "left" }}>
                  No settled calls in this month yet. Runs can still appear as spend before a settlement returns.
                </div>
              ) : (
                <div style={{ overflowX: "auto", marginTop: "1rem" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "640px" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--hairline-visible)" }}>
                        {['Date', 'Employee', 'Revenue', 'Receipt'].map((heading) => (
                          <th
                            key={heading}
                            style={{
                              padding: "0.65rem",
                              textAlign: heading === "Revenue" ? "right" : "left",
                              color: "var(--text-muted)",
                              fontFamily: "var(--font-mono)",
                              fontSize: "var(--text-label)",
                            }}
                          >
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {books.revenue.lines.map((line) => {
                        const employee = employeeByAgentId.get(line.agentId);
                        return (
                          <tr key={line.runId} style={{ borderBottom: "1px solid var(--hairline)" }}>
                            <td className="tabular" style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
                              {new Date(line.createdAt).toLocaleDateString()}
                            </td>
                            <td style={{ padding: "0.75rem" }}>
                              {employee?.jobDescription ?? line.agentId}
                            </td>
                            <td className="tabular" style={{ padding: "0.75rem", textAlign: "right" }}>
                              {formatUsdc(line.creatorUsdc)}
                            </td>
                            <td style={{ padding: "0.75rem" }}>
                              {line.tx ? (
                                <a
                                  href={`https://basescan.org/tx/${encodeURIComponent(line.tx)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  View on Basescan ↗
                                </a>
                              ) : (
                                <span style={{ color: "var(--text-muted)" }}>no receipt returned</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </>
    );
  }

  return (
    <div className="lp">
      <SiteNav active="/company" />
      {/* Signed-out marketing pitch keeps its current chrome; the tab strip is
          for the operating dashboard only, gated on the same session probe
          the page already tracks. */}
      {!signedOut && <WorkspaceTabs active="/company" />}
      <main id="main-content" className="lp-shell lp-page">{signedOut ? <SignedOutState /> : companyId ? renderDetail() : renderList()}</main>
      <SiteFooter />
    </div>
  );
}

/** Static shell shown for the instant before useSearchParams() resolves client-side. */
function CompanyPageFallback(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/company" />
      <main id="main-content" className="lp-shell lp-page">
        <div className="lp-loading">Loading…</div>
      </main>
      <SiteFooter />
    </div>
  );
}

// useSearchParams() opts a static (non-dynamic-segment) route out of static
// generation unless wrapped in Suspense — /company has no [param] segment to
// exempt it the way /build/[flowId] is exempt, so the boundary is required
// here (Next.js hard-fails the build otherwise).
export default function CompanyPage(): React.JSX.Element {
  return (
    <Suspense fallback={<CompanyPageFallback />}>
      <CompanyDashboardPage />
    </Suspense>
  );
}
