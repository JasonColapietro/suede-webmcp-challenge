"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeType } from "@/lib/flow/types";
import type { EmployeeLifecycleStatus } from "@/lib/company/types";
import { seatStatusMeta, formatRelativeTime, formatHeartbeatCadence } from "@/lib/company/presentation";

const NESTED_FLOW_NODE_CAP = 12;

export interface OrgChartNestedFlowNode {
  readonly id: string;
  readonly label: string;
  readonly nodeType: NodeType;
}

export interface OrgChartNodeData extends Record<string, unknown> {
  kind: "company" | "department" | "employee";
  label: string;
  subtitle?: string;
  /** Department accent color (a `var(--…)` reference). Set on department
   * nodes and inherited by their employee seats so a department's whole
   * branch reads as one colored group. Undefined on the company root. */
  accentVar?: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
  studioHref?: string;
  nestedFlow?: {
    status: "idle" | "loading" | "error" | "ready";
    nodes?: readonly OrgChartNestedFlowNode[];
    positions?: Record<string, { x: number; y: number }>;
  };
  /** True when this seat's agent settles paid calls live. Drives the pulsing
   * live dot and the emerald live chip. */
  live?: boolean;
  /** Per-call USDC price from the agent's paid-call trigger, when it has one. */
  priceUsdc?: number;
  /** Human-readable run cadence (e.g. "daily at 09:00 UTC"), when scheduled. */
  scheduleLabel?: string;
  /** Real settled earnings for this employee (see OrgChartEmployee.earnedUsdc).
   * Undefined only while the books ledger for the period hasn't loaded yet. */
  earnedUsdc?: number;
  /** Where this employee's settled calls route — "Company wallet" or a
   * shortened own-wallet address. Defaults to "Company wallet". */
  walletLabel?: string;
  /** Lifecycle state driving the seat's status dot. Undefined reads as
   * active — the schema's own default for an unwritten column. */
  lifecycleStatus?: EmployeeLifecycleStatus;
  /** True when the seat's agent/flow no longer resolves — shows the grey
   * Offline dot regardless of lifecycleStatus. */
  agentMissing?: boolean;
  /** Reporting-chain rank, set only in reporting mode: "ceo" and "manager"
   * render a kicker chip above the seat name; "worker" renders nothing. */
  roleKind?: "ceo" | "manager" | "worker";
  /** ISO timestamp of the last heartbeat wake, or null if never woken. */
  lastHeartbeatAt?: string | null;
  /** Whether the scheduler wakes this seat on its own cadence. */
  heartbeatEnabled?: boolean;
  /** Seconds between heartbeats. null = no cadence chosen yet. */
  heartbeatIntervalSeconds?: number | null;
}

function formatUsdc(value: number): string {
  return `$${value.toFixed(2)}`;
}

function CompanyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
      <path d="M3 21h18" />
      <path d="M9 7h2m2 0h2M9 11h2m2 0h2M9 15h2m2 0h2" />
    </svg>
  );
}

function ClockIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function EmployeeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/** Earnings chip. Silent until this seat has actually settled revenue —
 * a chart full of "$0.00" lines is noise; a seat that earns should pop. */
function EmployeeWallet({ earnedUsdc, walletLabel }: { earnedUsdc?: number; walletLabel?: string }): React.JSX.Element | null {
  const hasEarned = typeof earnedUsdc === "number" && earnedUsdc > 0;
  if (!hasEarned) return null;
  return (
    <span className="oc-wallet">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
        <path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-4" />
        <path d="M17 12h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3a2 2 0 0 1 0-4Z" />
      </svg>
      <span className="oc-wallet-text" title={`${formatUsdc(earnedUsdc)} · ${walletLabel ?? "Company wallet"}`}>
        {formatUsdc(earnedUsdc)} · {walletLabel ?? "Company wallet"}
      </span>
    </span>
  );
}

function CompanyCard({ data }: { data: OrgChartNodeData }): React.JSX.Element {
  return (
    <div className="oc-card oc-card--company">
      <span className="oc-icon oc-icon--company" aria-hidden="true">
        <CompanyIcon />
      </span>
      <div className="oc-body">
        <span className="oc-kicker">Company</span>
        <span className="oc-name" title={data.label}>{data.label}</span>
        {data.subtitle && (
          <span className="oc-mission" title={data.subtitle}>{data.subtitle}</span>
        )}
      </div>
    </div>
  );
}

function DepartmentCard({ data }: { data: OrgChartNodeData }): React.JSX.Element {
  return (
    <div className="oc-card oc-card--dept">
      <span className="oc-dept-swatch" aria-hidden="true" />
      <div className="oc-body">
        <span className="oc-dept-name" title={data.label}>{data.label}</span>
        {data.subtitle && <span className="oc-sub">{data.subtitle}</span>}
      </div>
    </div>
  );
}

/** Status chips under the seat name: live selling, per-call price, schedule.
 * Each renders only when the seat's data actually carries it. */
function EmployeeChips({ data }: { data: OrgChartNodeData }): React.JSX.Element | null {
  const live = Boolean(data.live);
  const price = typeof data.priceUsdc === "number" && data.priceUsdc > 0 ? data.priceUsdc : null;
  const schedule = data.scheduleLabel;
  if (!live && price === null && !schedule) return null;
  return (
    <span className="oc-chips">
      {live && (
        <span className="oc-chip oc-chip--live">
          <i className="oc-live-dot" aria-hidden="true" />
          Live
        </span>
      )}
      {price !== null && (
        <span className="oc-chip oc-chip--price tabular">{formatUsdc(price)}/call</span>
      )}
      {schedule && (
        <span className="oc-chip oc-chip--schedule" title={schedule}>
          <ClockIcon />
          <span className="oc-chip-text">{schedule}</span>
        </span>
      )}
    </span>
  );
}

/** Full spoken description of a seat: status, live state, price, cadence,
 * earnings, heartbeat, and expand state — everything the visual chips encode. */
function employeeAriaLabel(data: OrgChartNodeData): string {
  const meta = seatStatusMeta(data.lifecycleStatus, { agentMissing: data.agentMissing });
  const parts = [`${data.label}, ${meta.label} agent seat`];
  if (data.live) parts.push("selling live");
  if (typeof data.priceUsdc === "number" && data.priceUsdc > 0) {
    parts.push(`${formatUsdc(data.priceUsdc)} per call`);
  }
  if (data.scheduleLabel) parts.push(`runs ${data.scheduleLabel}`);
  if (typeof data.earnedUsdc === "number" && data.earnedUsdc > 0) {
    parts.push(`earned ${formatUsdc(data.earnedUsdc)}`);
  }
  const rel = formatRelativeTime(data.lastHeartbeatAt ?? null);
  if (rel) parts.push(`heartbeat ${rel}`);
  const cadence = data.heartbeatEnabled
    ? formatHeartbeatCadence(data.heartbeatIntervalSeconds ?? null)
    : null;
  if (rel && cadence) parts.push(`cadence ${cadence}`);
  parts.push(data.expanded ? "expanded" : "collapsed");
  return parts.join(", ");
}

function EmployeeCard({ data }: { data: OrgChartNodeData }): React.JSX.Element {
  const clickable = Boolean(data.onToggleExpand);
  const hasEarned = typeof data.earnedUsdc === "number" && data.earnedUsdc > 0;
  const statusMeta = seatStatusMeta(data.lifecycleStatus, { agentMissing: data.agentMissing });
  const heartbeatRel = formatRelativeTime(data.lastHeartbeatAt ?? null);
  const heartbeatCadence = data.heartbeatEnabled
    ? formatHeartbeatCadence(data.heartbeatIntervalSeconds ?? null)
    : null;
  const cardClass = [
    "oc-card oc-card--emp",
    hasEarned ? "is-earning" : "",
    data.live ? "is-live" : "",
    data.expanded ? "is-expanded" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={cardClass}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? data.onToggleExpand : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                data.onToggleExpand?.();
              }
            }
          : undefined
      }
      aria-expanded={Boolean(data.expanded)}
      aria-label={clickable ? employeeAriaLabel(data) : undefined}
      title={data.label}
    >
      <span className="oc-icon oc-icon--emp" aria-hidden="true">
        <EmployeeIcon />
      </span>
      <div className="oc-body">
        {data.roleKind === "ceo" && <span className="oc-role-kicker">CEO</span>}
        {data.roleKind === "manager" && (
          <span className="oc-role-kicker oc-role-kicker--manager">Manager</span>
        )}
        <span className="oc-emp-title">
          <i
            className={`oc-status-dot oc-status-dot--${statusMeta.tone}${statusMeta.pulsing ? " is-pulsing" : ""}`}
            style={{ background: statusMeta.cssVar }}
            aria-hidden="true"
          />
          <span className="oc-emp-name">{data.label}</span>
        </span>
        <EmployeeChips data={data} />
        {heartbeatRel && (
          <span className="oc-heartbeat" title={`Heartbeat ${heartbeatRel}${heartbeatCadence ? ` · ${heartbeatCadence}` : ""}`}>
            Heartbeat {heartbeatRel}
            {heartbeatCadence ? ` · ${heartbeatCadence}` : ""}
          </span>
        )}
        <EmployeeWallet earnedUsdc={data.earnedUsdc} walletLabel={data.walletLabel} />
      </div>
      {clickable && (
        <span className={`oc-caret${data.expanded ? " is-open" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      )}
    </div>
  );
}

/**
 * Expanded flow peek. Rendered as an elevated popover anchored below the seat
 * card (absolute-positioned, so the node's measured bounds never change and
 * the precomputed chart layout stays untouched) — OrgChartCanvas raises the
 * expanded node's zIndex so this floats above every neighboring node instead
 * of sliding underneath later-rendered siblings.
 */
function NestedFlowPreview({ data }: { data: OrgChartNodeData }): React.JSX.Element | null {
  const nestedFlow = data.nestedFlow;
  if (!nestedFlow || nestedFlow.status === "idle") return null;

  let body: React.JSX.Element;
  if (nestedFlow.status === "loading") {
    body = <span className="oc-flowpop-note mono">Loading flow…</span>;
  } else if (nestedFlow.status === "error") {
    body = (
      <>
        <span className="oc-flowpop-note oc-flowpop-note--warning">Couldn&rsquo;t load this flow.</span>
        {data.studioHref && (
          <a className="oc-flowpop-link" href={data.studioHref}>Open in Studio</a>
        )}
      </>
    );
  } else {
    const nodes = nestedFlow.nodes ?? [];
    if (nodes.length > NESTED_FLOW_NODE_CAP) {
      body = (
        <>
          <span className="oc-flowpop-note">This flow has {nodes.length} steps.</span>
          {data.studioHref && (
            <a className="oc-flowpop-link" href={data.studioHref}>Open it in Studio to see the full graph</a>
          )}
        </>
      );
    } else {
      body = (
        <>
          <div className="oc-flowpop-list">
            {nodes.map((node) => (
              <div key={node.id} className="oc-flowpop-node">
                <span className="oc-flowpop-dot" aria-hidden="true" />
                <div className="oc-flowpop-node-text">
                  <div className="oc-flowpop-node-label">{node.label}</div>
                  <div className="oc-flowpop-node-type mono">{node.nodeType}</div>
                </div>
              </div>
            ))}
          </div>
          {data.studioHref && (
            <a className="oc-flowpop-link" href={data.studioHref}>Open in Studio</a>
          )}
        </>
      );
    }
  }

  return (
    <div className="oc-flowpop" role="group" aria-label={`${data.label} flow preview`}>
      {body}
    </div>
  );
}

export default function OrgChartNode({ data }: { data: OrgChartNodeData }): React.JSX.Element {
  const accentStyle = data.accentVar
    ? ({ "--oc-accent": data.accentVar } as React.CSSProperties)
    : undefined;
  return (
    <div
      className="oc-node"
      style={accentStyle}
      onKeyDown={
        data.kind === "employee" && data.expanded
          ? (event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                data.onToggleExpand?.();
              }
            }
          : undefined
      }
    >
      <Handle type="target" position={Position.Top} className="oc-handle" isConnectable={false} />
      {data.kind === "company" && <CompanyCard data={data} />}
      {data.kind === "department" && <DepartmentCard data={data} />}
      {data.kind === "employee" && <EmployeeCard data={data} />}
      {data.kind === "employee" && data.expanded && <NestedFlowPreview data={data} />}
      <Handle type="source" position={Position.Bottom} className="oc-handle" isConnectable={false} />
    </div>
  );
}
