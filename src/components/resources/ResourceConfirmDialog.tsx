"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

interface FocusTarget {
  readonly isConnected: boolean;
  focus(): void;
}

export function restoreResourceActionFocus(
  trigger: FocusTarget | null,
  fallback: FocusTarget | null = null,
): void {
  if (trigger?.isConnected) trigger.focus();
  else if (fallback?.isConnected) fallback.focus();
}

export default function ResourceConfirmDialog({
  open,
  title,
  confirmLabel,
  danger = false,
  busy,
  triggerRef,
  fallbackFocusRef,
  onCancel,
  onConfirm,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly busy: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly fallbackFocusRef?: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly children?: ReactNode;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    if (!open && wasOpenRef.current) {
      restoreResourceActionFocus(triggerRef.current, fallbackFocusRef?.current ?? null);
    }
    wasOpenRef.current = open;
  }, [fallbackFocusRef, open, triggerRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
    ) ?? [])];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="resource-confirm"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="resource-confirm-copy">{children}</div>
      <div className="resource-confirm-actions">
        <button ref={cancelRef} type="button" className="lp-btn lp-btn--ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className={`lp-btn lp-btn--primary${danger ? " resource-confirm-danger" : ""}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
