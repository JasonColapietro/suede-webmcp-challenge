"use client";

import React, { useEffect, useId, useRef, type RefObject } from "react";
import type { FlowVersionRecord, FlowVersionSemanticDiff, VersionDiffEntry } from "@/lib/projects/types";

export type VersionReviewDiffState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly diff: FlowVersionSemanticDiff }
  | { readonly status: "error"; readonly message?: string };

export type VersionReviewAction = "restore" | "test" | "live";

export function claimVersionReviewAction(latch: { current: boolean }): boolean {
  if (latch.current) return false;
  latch.current = true;
  return true;
}

interface FocusTarget {
  focus(): void;
}

interface ReturnFocusTarget extends FocusTarget {
  readonly isConnected: boolean;
}

export function focusVersionReview(
  cancelRef: { readonly current: FocusTarget | null },
  dialogRef: { readonly current: FocusTarget | null },
  activeElement: () => unknown,
): void {
  cancelRef.current?.focus();
  if (activeElement() !== cancelRef.current) dialogRef.current?.focus();
}

export function restoreVersionReviewFocus(trigger: ReturnFocusTarget | null): void {
  if (trigger?.isConnected) trigger.focus();
}

export function dismissVersionReviewOnEscape(
  event: { readonly key: string; preventDefault(): void },
  locked: boolean,
  onDismiss: () => void,
): boolean {
  if (event.key !== "Escape" || locked) return false;
  event.preventDefault();
  onDismiss();
  return true;
}

export function dismissVersionReviewOnCancel(
  event: { preventDefault(): void },
  locked: boolean,
  onDismiss: () => void,
): boolean {
  event.preventDefault();
  if (locked) return false;
  onDismiss();
  return true;
}

export function activateVersionReviewAction(
  latch: { current: boolean },
  locked: boolean,
  action: () => void,
): boolean {
  if (locked || !claimVersionReviewAction(latch)) return false;
  action();
  return true;
}

const BUCKETS: readonly {
  readonly kind: VersionDiffEntry["kind"];
  readonly label: string;
}[] = [
  { kind: "node", label: "Nodes" },
  { kind: "edge", label: "Edges" },
  { kind: "variable", label: "Variables" },
  { kind: "dependency", label: "Dependencies" },
];

export default function VersionReviewDialog({
  open,
  readOnly,
  busyAction,
  version,
  diffState,
  activeTestVersionId,
  livePhrase,
  onLivePhraseChange,
  onDismiss,
  onRestore,
  onPromoteTest,
  onPromoteLive,
  triggerRef,
  restoreDisabledReason,
  testDisabledReason,
  liveDisabledReason,
}: {
  readonly open: boolean;
  readonly readOnly: boolean;
  readonly busyAction: VersionReviewAction | null;
  readonly version: FlowVersionRecord | null;
  readonly diffState: VersionReviewDiffState;
  readonly activeTestVersionId: string | null;
  readonly livePhrase: string;
  readonly onLivePhraseChange: (value: string) => void;
  readonly onDismiss: () => void;
  readonly onRestore: () => void;
  readonly onPromoteTest: () => void;
  readonly onPromoteLive: () => void;
  readonly triggerRef?: RefObject<HTMLElement | null>;
  readonly restoreDisabledReason: string | null;
  readonly testDisabledReason: string | null;
  readonly liveDisabledReason: string | null;
}): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const actionClaimedRef = useRef(false);
  const visible = open;
  const locked = busyAction !== null;
  const reviewReady = version !== null && diffState.status === "ready";
  const liveEligible = Boolean(version && activeTestVersionId === version.id);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!visible || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const activeElement = document.activeElement;
    const trigger = triggerRef?.current ?? (activeElement instanceof HTMLElement ? activeElement : null);
    queueMicrotask(() => {
      focusVersionReview(cancelRef, dialogRef, () => document.activeElement);
    });
    return () => {
      queueMicrotask(() => {
        restoreVersionReviewFocus(trigger);
      });
    };
  }, [triggerRef, visible]);

  useEffect(() => {
    if (!visible || busyAction === null) actionClaimedRef.current = false;
  }, [busyAction, version?.id, visible]);

  if (!visible) return null;

  const claim = (action: () => void): void => {
    activateVersionReviewAction(actionClaimedRef, locked, action);
  };

  return <dialog
    ref={dialogRef}
    className="version-review-dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    aria-busy={locked}
    tabIndex={-1}
    onCancel={(event) => {
      dismissVersionReviewOnCancel(event, locked, onDismiss);
    }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !locked) {
        if (dismissVersionReviewOnEscape(event, locked, onDismiss)) return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
    <header className="version-review-dialog__header">
      <span className="eyebrow">Immutable version receipt</span>
      <h2 id={titleId}>{version ? `Review v${version.versionNumber}` : "Review version"}</h2>
      <p id={descriptionId}>Compare this saved receipt before restoring the mutable draft or promoting the exact version.</p>
      {version?.label ? <strong>{version.label}</strong> : null}
      {version?.description ? <p>{version.description}</p> : null}
    </header>

    {version ? <dl className="version-review-dialog__hashes">
      <div><dt>Semantic hash</dt><dd>{version.semanticHash}</dd></div>
      <div><dt>Full hash</dt><dd>{version.fullHash}</dd></div>
    </dl> : null}

    <section className="version-review-dialog__receipt" aria-label="Structural change receipt">
      {diffState.status === "loading" || !version ? <p>Loading exact version receipt…</p> : null}
      {diffState.status === "error" ? <p role="alert">Version review is unavailable. Close and try again.</p> : null}
      {diffState.status === "ready" ? <>
        <div className="version-review-dialog__summary">
          <strong>{diffState.diff.visualOnly
            ? "Layout-only change"
            : diffState.diff.entries.length === 0
              ? "No structural changes"
              : `${diffState.diff.counts.added} added · ${diffState.diff.counts.removed} removed · ${diffState.diff.counts.changed} changed`}</strong>
          <span>Compared with v{diffState.diff.to.versionNumber}</span>
        </div>
        <div className="version-review-dialog__buckets">
          {BUCKETS.map((bucket) => {
            const entries = diffState.diff.entries.filter((entry) => entry.kind === bucket.kind);
            return <section key={bucket.kind} aria-label={bucket.label}>
              <h3>{bucket.label}</h3>
              {entries.length > 0 ? <ul>{entries.map((entry) => <li key={entry.id}>
                <span>{entry.id}</span>
                <strong>{entry.change}</strong>
                {entry.fields.length > 0 ? <small>{entry.fields.join(", ")}</small> : null}
              </li>)}</ul> : <p>None</p>}
            </section>;
          })}
        </div>
        {diffState.diff.truncated ? <p className="version-review-dialog__notice">This receipt is capped at 200 structural entries.</p> : null}
      </> : null}
    </section>

    {!readOnly ? <section className="version-review-dialog__promotions" aria-label="Version actions">
      <div className="version-review-dialog__action-row">
        <div><strong>Draft</strong><p>Restore to the mutable draft without saving. Undo remains available.</p></div>
        <button type="button" disabled={!reviewReady || locked || restoreDisabledReason !== null} onClick={() => claim(onRestore)}>
          {busyAction === "restore" ? "Restoring…" : "Restore to draft"}
        </button>
      </div>
      {restoreDisabledReason ? <p className="version-review-dialog__notice">{restoreDisabledReason}</p> : null}
      <div className="version-review-dialog__action-row">
        <div><strong>Test</strong><p>Creates an immutable Test receipt for this exact version.</p></div>
        <button type="button" disabled={!reviewReady || locked || testDisabledReason !== null} onClick={() => claim(onPromoteTest)}>
          {busyAction === "test" ? "Promoting…" : "Confirm Promote to Test"}
        </button>
      </div>
      {testDisabledReason ? <p className="version-review-dialog__notice">{testDisabledReason}</p> : null}
      <p className="version-review-dialog__notice">An active Test deployment is a version receipt, not proof that a scoped test passed.</p>
      <p className="version-review-dialog__notice">If promotion state changes, refresh environment status before retrying.</p>
      {liveEligible ? <div className="version-review-dialog__live-confirmation">
        <label htmlFor={`${titleId}-live`}>Type <strong>PROMOTE LIVE</strong> to promote this active Test version.</label>
        <input
          id={`${titleId}-live`}
          name="live-confirmation"
          value={livePhrase}
          autoComplete="off"
          spellCheck={false}
          disabled={locked}
          onChange={(event) => onLivePhraseChange(event.currentTarget.value)}
        />
        <button type="button" disabled={!reviewReady || locked || liveDisabledReason !== null || livePhrase !== "PROMOTE LIVE"} onClick={() => claim(onPromoteLive)}>
          {busyAction === "live" ? "Promoting…" : "Promote to Live"}
        </button>
        {liveDisabledReason ? <p className="version-review-dialog__notice">{liveDisabledReason}</p> : null}
      </div> : <p className="version-review-dialog__notice">{liveDisabledReason ?? "Promote this exact version to Test before Live is available."}</p>}
    </section> : <p className="version-review-dialog__notice">Version review is read-only on this screen size.</p>}

    <footer className="version-review-dialog__footer">
      <button ref={cancelRef} type="button" disabled={locked} onClick={() => { if (!locked) onDismiss(); }}>Cancel</button>
      <p role="status" aria-live="polite" aria-atomic="true">
        {busyAction === "restore" ? "Restoring this version to the draft…" : busyAction === "test" ? "Promoting this version to Test…" : busyAction === "live" ? "Promoting this version to Live…" : ""}
      </p>
    </footer>
  </dialog>;
}
