"use client";

import React, { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { FlowImpactSummary } from "@/lib/flow/flow-mutation-service";

const MAX_DEPENDENTS = 50;
const MAX_NAME_LENGTH = 200;
const MAX_USE_COUNT = 50;
const MAX_TOTAL = 1_000;

export interface BoundedImpactView {
  readonly dependents: readonly {
    readonly name: string;
    readonly useCount: number;
  }[];
  readonly total: number;
  readonly truncated: boolean;
}

export function boundedImpactView(impact: FlowImpactSummary): BoundedImpactView {
  const dependents = impact.dependents.slice(0, MAX_DEPENDENTS).map((dependent) => ({
    name: dependent.name.slice(0, MAX_NAME_LENGTH) || "Unnamed flow",
    useCount: Math.min(dependent.nodeIds.length, MAX_USE_COUNT),
  }));
  const total = Math.min(Math.max(Number.isSafeInteger(impact.total) ? impact.total : 0, 0), MAX_TOTAL);
  return {
    dependents,
    total,
    truncated: impact.truncated ||
      impact.dependents.length > MAX_DEPENDENTS ||
      impact.total > MAX_TOTAL ||
      impact.total !== impact.dependents.length,
  };
}

export interface FlowImpactDialogProps {
  readonly open: boolean;
  readonly busy: boolean;
  readonly impact: FlowImpactSummary | null;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
  readonly triggerRef?: RefObject<HTMLElement | null>;
}

export function claimImpactConfirmation(latch: { current: boolean }): boolean {
  if (latch.current) return false;
  latch.current = true;
  return true;
}

export default function FlowImpactDialog({
  open,
  busy,
  impact,
  onConfirm,
  onDismiss,
  triggerRef,
}: FlowImpactDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const confirmationClaimedRef = useRef(false);
  const previousBusyRef = useRef(false);
  const [confirmationClaimed, setConfirmationClaimed] = useState(false);
  const visible = open && impact !== null;

  useEffect(() => {
    if (!visible) return;
    const activeElement = document.activeElement;
    const trigger = triggerRef?.current ?? (activeElement instanceof HTMLElement ? activeElement : null);
    queueMicrotask(() => {
      keepEditingRef.current?.focus();
      if (document.activeElement !== keepEditingRef.current) dialogRef.current?.focus();
    });
    return () => {
      queueMicrotask(() => {
        if (trigger?.isConnected) trigger.focus();
      });
    };
  }, [triggerRef, visible]);

  useEffect(() => {
    if (!visible) {
      confirmationClaimedRef.current = false;
      setConfirmationClaimed(false);
    }
  }, [visible]);

  useEffect(() => {
    const busyBegan = visible && busy && !previousBusyRef.current;
    previousBusyRef.current = busy;
    if (busyBegan) queueMicrotask(() => dialogRef.current?.focus());
  }, [busy, visible]);

  if (!visible || !impact) return null;
  const view = boundedImpactView(impact);
  const locked = busy || confirmationClaimed;

  return <div
    className="flow-impact-dialog__backdrop"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !locked) onDismiss();
    }}
  >
    <div
      ref={dialogRef}
      className="flow-impact-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={locked}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !locked) {
          event.preventDefault();
          onDismiss();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [])];
        if (focusable.length === 0) {
          event.preventDefault();
          dialogRef.current?.focus();
          return;
        }
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
        <span className="eyebrow">Breaking change review</span>
        <h2 id={titleId}>Review affected flows</h2>
        <p id={descriptionId}>
          This callable interface changed. Confirming saves this exact revision and may require the flows below to be updated.
        </p>
      </header>

      <section className="flow-impact-dialog__summary" aria-label="Affected flow summary">
        <strong>{view.total} total affected {view.total === 1 ? "flow" : "flows"}</strong>
        {view.dependents.length > 0 ? <ul>
          {view.dependents.map((dependent, index) => <li key={`${index}-${dependent.name}`}>
            <span>{dependent.name}</span>
            <small>{dependent.useCount} {dependent.useCount === 1 ? "use" : "uses"}</small>
          </li>)}
        </ul> : <p>No named dependent flows were returned.</p>}
        {view.truncated ? <p className="flow-impact-dialog__warning">
          The server limited this list. Confirm only if you are ready to review every affected flow.
        </p> : null}
      </section>

      <div className="flow-impact-dialog__actions">
        <button
          ref={keepEditingRef}
          type="button"
          disabled={locked}
          onClick={() => { if (!locked) onDismiss(); }}
        >Keep editing</button>
        <button
          type="button"
          className="flow-impact-dialog__confirm"
          disabled={locked}
          onClick={() => {
            if (busy || !claimImpactConfirmation(confirmationClaimedRef)) return;
            setConfirmationClaimed(true);
            queueMicrotask(() => dialogRef.current?.focus());
            onConfirm();
          }}
        >Confirm exact save</button>
      </div>
      {locked ? <p className="flow-impact-dialog__status" role="status" aria-live="polite" aria-atomic="true">
        Saving confirmed changes…
      </p> : null}
    </div>
  </div>;
}
