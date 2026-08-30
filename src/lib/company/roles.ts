/**
 * Org-chart roles — the pure rules that sit between the additive
 * `company_employees` columns (role, reports_to) and everything that draws or
 * mutates the chart.
 *
 * Pure by contract: no repository, no `node:` builtin, no I/O. Both the server
 * repositories and client canvas code import it, so anything unserialisable
 * here would break the browser bundle the same way importing the node registry
 * does.
 *
 * Two facts shape every function below.
 *
 * 1. `role` is NULL on every employee hired before the column existed.
 *    Defaulting those rows to 'worker' would make each already-founded company
 *    read as zero-CEO/all-orphans, which blanks the chart and leaves hiring
 *    with no manager to attach to. So NULL is resolved, not replaced:
 *    resolveEffectiveRole reads the earliest-hired active employee's NULL as
 *    'ceo' and every other NULL as 'worker', and backfillCompanyRoles turns
 *    that reading into a patch set the first real hire persists.
 *
 * 2. `company_employees` carries no hire timestamp, so "earliest-hired" means
 *    "first in the roster the repository returned" — SQLite hands rows back in
 *    insertion (rowid) order. Callers pass the active roster straight from
 *    listEmployees; the derivation runs once and backfillCompanyRoles makes it
 *    durable so later ordering can never move the CEO.
 */

import type { EmployeeLifecycleStatus, EmployeeRole } from "@/lib/company/types";

const EMPLOYEE_ROLES: readonly EmployeeRole[] = ["ceo", "manager", "worker"];

const LIFECYCLE_STATUSES: readonly EmployeeLifecycleStatus[] = [
  "idle",
  "running",
  "error",
  "paused",
  "budget_paused",
];

/** The default an unwritten or absent lifecycle column reads as. */
export const DEFAULT_LIFECYCLE_STATUS: EmployeeLifecycleStatus = "idle";

/**
 * The employee fields these rules read. Structurally satisfied by
 * EmployeeRecord, and narrow enough that tests and future callers do not have
 * to build a whole employee to ask a question about the chart.
 */
export interface RoleRosterEntry {
  agentId: string;
  role?: EmployeeRole | null;
  reportsTo?: string | null;
}

export type RoleViolation =
  | "self_parent"
  | "cycle"
  | "unknown_manager"
  | "unknown_employee";

export type RoleValidation =
  | { ok: true }
  | { ok: false; violation: RoleViolation; message: string };

/** One durable role/manager assignment for a single employee. */
export interface RolePatch {
  agentId: string;
  role: EmployeeRole;
  reportsTo: string | null;
}

/** Narrow an unknown storage value to a role, or null when it is not one. */
export function parseEmployeeRole(value: unknown): EmployeeRole | null {
  return EMPLOYEE_ROLES.find((role) => role === value) ?? null;
}

/**
 * Narrow an unknown storage value to a lifecycle status. Anything unwritten,
 * absent (a schema without the column), or unrecognised reads as 'idle' —
 * an employee whose state cannot be established is not running.
 */
export function parseLifecycleStatus(value: unknown): EmployeeLifecycleStatus {
  return (
    LIFECYCLE_STATUSES.find((status) => status === value) ?? DEFAULT_LIFECYCLE_STATUS
  );
}

/** True when every active employee predates the role column. */
export function isLegacyCompany(activeRoster: readonly RoleRosterEntry[]): boolean {
  // An empty roster is not legacy: there is nothing to repair, and reporting
  // it as legacy would ask callers to backfill a company that has no rows.
  return activeRoster.length > 0 && activeRoster.every((entry) => entry.role == null);
}

/**
 * The role to draw and reason with for one employee, given the active roster
 * it belongs to. A stored role always wins; a NULL resolves to 'ceo' only for
 * the earliest-hired active employee, and only while no other active employee
 * already claims 'ceo' — a company never resolves to two chief executives.
 */
export function resolveEffectiveRole(
  employee: RoleRosterEntry,
  activeRoster: readonly RoleRosterEntry[],
): EmployeeRole {
  const stored = parseEmployeeRole(employee.role);
  if (stored !== null) return stored;
  if (activeRoster.some((entry) => parseEmployeeRole(entry.role) === "ceo")) {
    return "worker";
  }
  const earliest = activeRoster[0];
  return earliest !== undefined && earliest.agentId === employee.agentId ? "ceo" : "worker";
}

/**
 * The idempotent repair for a company whose employees predate the role
 * column: promote the earliest-hired active employee to 'ceo' reporting to
 * nobody, and point every other role-less active employee at it. Returns only
 * the rows that actually change, so a second call over the patched roster
 * returns an empty set. Employees that already carry a role are left alone —
 * this repairs legacy NULLs, it does not reorganise a chart someone built.
 */
export function backfillCompanyRoles(
  activeRoster: readonly RoleRosterEntry[],
): RolePatch[] {
  if (activeRoster.length === 0) return [];
  const explicitCeo = activeRoster.find(
    (entry) => parseEmployeeRole(entry.role) === "ceo",
  );
  const ceo = explicitCeo ?? (isLegacyCompany(activeRoster) ? activeRoster[0] : undefined);
  // Nothing safe to anchor the chart on: a partially-roled roster with no CEO
  // is left for a human decision rather than repaired by guesswork.
  if (ceo === undefined) return [];

  const patches: RolePatch[] = [];
  if (parseEmployeeRole(ceo.role) !== "ceo" || (ceo.reportsTo ?? null) !== null) {
    patches.push({ agentId: ceo.agentId, role: "ceo", reportsTo: null });
  }
  for (const entry of activeRoster) {
    if (entry.agentId === ceo.agentId) continue;
    if (parseEmployeeRole(entry.role) !== null) continue;
    patches.push({ agentId: entry.agentId, role: "worker", reportsTo: ceo.agentId });
  }
  return patches;
}

/**
 * Write-time invariants for a new employee. Judges only the row being
 * written: the roster is treated as already valid, apart from the cycle walk,
 * which fails closed if it ever finds one.
 */
export function validateHire(
  candidate: { agentId: string; reportsTo?: string | null },
  activeRoster: readonly RoleRosterEntry[],
): RoleValidation {
  return validateParentLink(candidate.agentId, candidate.reportsTo ?? null, activeRoster);
}

/** The same invariants, for moving an existing active employee's manager. */
export function validateReparent(
  agentId: string,
  nextReportsTo: string | null,
  activeRoster: readonly RoleRosterEntry[],
): RoleValidation {
  if (!activeRoster.some((entry) => entry.agentId === agentId)) {
    return {
      ok: false,
      violation: "unknown_employee",
      message: `Employee ${agentId} is not an active member of this company.`,
    };
  }
  return validateParentLink(agentId, nextReportsTo, activeRoster);
}

function validateParentLink(
  agentId: string,
  reportsTo: string | null,
  activeRoster: readonly RoleRosterEntry[],
): RoleValidation {
  if (reportsTo === null) return { ok: true };
  if (reportsTo === agentId) {
    return {
      ok: false,
      violation: "self_parent",
      message: `Employee ${agentId} cannot report to itself.`,
    };
  }
  const byAgentId = new Map(activeRoster.map((entry) => [entry.agentId, entry]));
  if (!byAgentId.has(reportsTo)) {
    return {
      ok: false,
      violation: "unknown_manager",
      message: `Manager ${reportsTo} is not an active member of this company.`,
    };
  }

  // Walk up from the proposed manager. Reaching the employee closes a loop;
  // revisiting anyone means the stored chart already contains one, and either
  // way the write is refused rather than persisted into an unwalkable graph.
  const visited = new Set<string>([agentId]);
  let cursor: string | null = reportsTo;
  while (cursor !== null) {
    if (visited.has(cursor)) {
      return {
        ok: false,
        violation: "cycle",
        message: `Reporting ${agentId} to ${reportsTo} would create a management cycle.`,
      };
    }
    visited.add(cursor);
    const parent: string | null = byAgentId.get(cursor)?.reportsTo ?? null;
    cursor = parent;
  }
  return { ok: true };
}
