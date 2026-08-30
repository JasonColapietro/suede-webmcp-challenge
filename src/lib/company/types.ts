/**
 * Company domain types — the Autonomous Company layer over agents/flows.
 * A company groups agent employees into departments under one founder
 * (owner), with budgets, approval gates, and settlement-grounded books.
 * See docs/superpowers/plans/2026-07-17-autonomous-company-prd.md.
 */

export type CompanyStatus = "draft" | "active" | "paused";

export interface CompanyRecord {
  id: string;
  ownerId: string;
  name: string;
  mission: string;
  status: CompanyStatus;
  /**
   * Fires including an employee whose last completed run cost more than
   * this require an approved approval. null disables the threshold gate.
   */
  fireCostThresholdUsdc: number | null;
  createdAt: string;
}

export interface DepartmentRecord {
  id: string;
  companyId: string;
  name: string;
  monthlyBudgetUsdc: number | null;
}

/**
 * Where an employee sits in the org chart. Stored NULL on every row hired
 * before the org-chart columns existed — see resolveEffectiveRole in
 * src/lib/company/roles.ts, which reads a legacy NULL as 'ceo' for the
 * earliest-hired active employee and 'worker' for everyone else. NULL is
 * deliberately not backfilled to 'worker' at the storage layer: that would
 * make every already-founded company read as zero-CEO/all-orphans and blank
 * the chart.
 */
export type EmployeeRole = "ceo" | "manager" | "worker";

/**
 * What the employee is doing right now.
 *
 * There is deliberately no 'terminated' member: removal is already modelled
 * by the `removed_at` tombstone, which listEmployees filters on, and a second
 * answer to "is this employee gone" would drift from it.
 *
 * 'budget_paused' is distinct from 'paused' so the two can expire
 * differently: a budget pause may auto-clear at the UTC month rollover when
 * the department's spend window resets, while a founder's 'paused' stays
 * sticky until the founder lifts it.
 */
export type EmployeeLifecycleStatus =
  | "idle"
  | "running"
  | "error"
  | "paused"
  | "budget_paused";

export interface EmployeeRecord {
  agentId: string;
  companyId: string;
  departmentId: string;
  jobDescription: string;
  /** Firing this employee requires an approved approval (promo publishers). */
  publishGated: boolean;
  monthlyBudgetUsdc: number | null;
  /**
   * This employee's own payout wallet (EVM address). null routes the
   * employee's settled calls to the founder's owner wallet, exactly as
   * before — resolvePayout prefers this address when set. Still 100%
   * creator-side money; platform-take collection is unrelated and remains
   * gated on the custody decision (split-collection design brief).
   */
  payTo: string | null;
  // ── Org chart + heartbeat (additive, nullable in both schemas) ──────────
  // Optional in the type only so the many existing object literals that
  // predate these columns still compile. Every repository read populates all
  // six, so a record that came out of a repo never has them undefined.
  /** null = never written; resolve it through resolveEffectiveRole. */
  role?: EmployeeRole | null;
  /** agentId of this employee's manager. null = reports to nobody (the CEO). */
  reportsTo?: string | null;
  /** Defaults to 'idle' when the column is absent or unwritten. */
  lifecycleStatus?: EmployeeLifecycleStatus;
  /** Whether the scheduler wakes this employee on its own cadence. */
  heartbeatEnabled?: boolean;
  /** Seconds between heartbeats. null = no cadence chosen yet. */
  heartbeatIntervalSeconds?: number | null;
  /** ISO timestamp of the last heartbeat wake, or null if never woken. */
  lastHeartbeatAt?: string | null;
}

/**
 * The employee's durable operating instructions — the markdown documents an
 * employee is booted with. One row per employee (agent_id PK); every document
 * is nullable so a partially-authored employee persists exactly what exists.
 */
export interface EmployeeInstructionsRecord {
  agentId: string;
  agentsMd: string | null;
  soulMd: string | null;
  heartbeatMd: string | null;
  toolsMd: string | null;
  /** Rolling summary carried between sessions so context survives restarts. */
  sessionSummary: string | null;
  updatedAt: string;
}

export type ApprovalKind =
  | "enable_live_selling"
  | "fire_publish_gated"
  | "fire_over_threshold"
  | "hire_employee";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export type ApprovalCostBasis = "quoted" | "estimated" | "unavailable";

/**
 * Cost information captured at the moment an approval is opened. A quote or
 * estimate always carries its USDC amount; unavailable explicitly records
 * that no honest pre-action number existed instead of inferring one from a
 * previous run.
 */
export type ApprovalCostSnapshot =
  | {
      basis: "quoted" | "estimated";
      amountUsdc: number;
      note: string | null;
    }
  | {
      basis: "unavailable";
      amountUsdc: null;
      note: string | null;
    };

export interface CreateApprovalInput {
  companyId: string;
  kind: ApprovalKind;
  subjectId: string;
  /** Durable human-readable description of the exact action under review. */
  actionSummary?: string | null;
  /** Optional for legacy/internal callers; API-created approvals always set it. */
  costSnapshot?: ApprovalCostSnapshot | null;
}

export interface ApprovalRecord {
  id: string;
  companyId: string;
  kind: ApprovalKind;
  /** agentId for employee-scoped kinds; companyId for company-scoped. */
  subjectId: string;
  status: ApprovalStatus;
  reason: string | null;
  actionSummary: string | null;
  costSnapshot: ApprovalCostSnapshot | null;
  createdAt: string;
  decidedAt: string | null;
}
