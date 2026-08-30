/**
 * Pure presentation helpers for the company roster and org chart — status
 * dot metadata, relative timestamps, and heartbeat cadence labels.
 *
 * Pure by contract: no repository, no `node:` builtin, no I/O, no imports
 * beyond types.ts. Client list rows, the desktop org chart, and server code
 * all import these same helpers, so a single mapping decides what every
 * surface calls each lifecycle state and which token colors its dot.
 *
 * All color values are tokens.css custom-property references, never literal
 * colors, so the dots follow the bright theme and its dark-mode overrides.
 */
import type { EmployeeLifecycleStatus } from "@/lib/company/types";

export type SeatStatusTone = "active" | "running" | "paused" | "error" | "terminated";

export interface SeatStatusMeta {
  readonly tone: SeatStatusTone;
  readonly label: string;
  readonly cssVar: string;
  readonly pulsing: boolean;
}

/**
 * The status dot for one seat. The schema deliberately has no 'terminated'
 * lifecycle member (removal is a tombstone the repository filters on), so the
 * "terminated" tone exists only for the agent-record-unavailable case, which
 * `agentMissing` signals and which overrides every lifecycle status.
 */
export function seatStatusMeta(
  status: EmployeeLifecycleStatus | undefined,
  options?: { readonly agentMissing?: boolean },
): SeatStatusMeta {
  if (options?.agentMissing === true) {
    return { tone: "terminated", label: "Offline", cssVar: "var(--text-muted)", pulsing: false };
  }
  switch (status) {
    case "running":
      return { tone: "running", label: "Running", cssVar: "var(--registry-cyan)", pulsing: true };
    case "paused":
      return { tone: "paused", label: "Paused", cssVar: "var(--amber)", pulsing: false };
    case "budget_paused":
      return {
        tone: "paused",
        label: "Paused for budget",
        cssVar: "var(--amber)",
        pulsing: false,
      };
    case "error":
      return { tone: "error", label: "Error", cssVar: "var(--rights-red)", pulsing: false };
    case "idle":
    case undefined:
      return { tone: "active", label: "Active", cssVar: "var(--verified-emerald)", pulsing: false };
  }
}

/**
 * The five seat-status legend entries every roster surface shows: Active,
 * Running, Paused, Error, Offline. Built from the same seatStatusMeta the
 * seat dots use so the legend and the dots can never drift apart.
 */
export const SEAT_STATUS_LEGEND: readonly SeatStatusMeta[] = [
  seatStatusMeta("idle", {}),
  seatStatusMeta("running", {}),
  seatStatusMeta("paused", {}),
  seatStatusMeta("error", {}),
  seatStatusMeta(undefined, { agentMissing: true }),
];

/**
 * A compact relative timestamp for the last heartbeat ("just now", "5m ago",
 * "3h ago", "2d ago", or a short date past two weeks). Returns null for a
 * missing or unparseable input so callers can omit the line entirely. Future
 * timestamps (clock skew between the scheduler and the viewer) read as
 * "just now" rather than a negative age.
 */
export function formatRelativeTime(iso: string | null | undefined, now?: Date): string | null {
  if (iso == null) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const reference = now ?? new Date();
  const diffMs = reference.getTime() - parsed;
  const diffSeconds = diffMs / 1000;
  if (diffSeconds < 45) return "just now";
  if (diffSeconds < 90) return "1m ago";
  const diffMinutes = diffSeconds / 60;
  if (diffMinutes < 60) return `${Math.round(diffMinutes)}m ago`;
  const diffHours = diffMinutes / 60;
  if (diffHours < 24) return `${Math.round(diffHours)}h ago`;
  const diffDays = diffHours / 24;
  if (diffDays < 14) return `${Math.round(diffDays)}d ago`;
  return new Date(parsed).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * A human cadence label for a heartbeat interval ("every 30s", "every
 * minute", "every 5 min", "hourly", "every 6h", "daily", "every 3 days").
 * Returns null when no valid cadence exists so callers can omit the line.
 */
export function formatHeartbeatCadence(intervalSeconds: number | null | undefined): string | null {
  if (intervalSeconds == null || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return null;
  }
  if (intervalSeconds < 60) return `every ${intervalSeconds}s`;
  if (intervalSeconds === 60) return "every minute";
  if (intervalSeconds < 3600) return `every ${Math.round(intervalSeconds / 60)} min`;
  if (intervalSeconds === 3600) return "hourly";
  if (intervalSeconds < 86400) return `every ${Math.round(intervalSeconds / 3600)}h`;
  if (intervalSeconds === 86400) return "daily";
  return `every ${Math.round(intervalSeconds / 86400)} days`;
}
