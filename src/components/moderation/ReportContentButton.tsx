"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { ModerationReason } from "@/lib/moderation/types";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type ReportSubject =
  | { readonly subjectType: "run_output"; readonly flowId: string; readonly runId: string; readonly nodeId?: string }
  | { readonly subjectType: "agent_output"; readonly agentId: string; readonly runId?: string }
  | { readonly subjectType: "agent"; readonly agentId: string };

const REASONS: readonly { readonly value: ModerationReason; readonly label: string }[] = [
  { value: "sexual_content", label: "Sexual content" },
  { value: "hate_or_harassment", label: "Hate or harassment" },
  { value: "violence_or_self_harm", label: "Violence or self-harm" },
  { value: "illegal_or_dangerous", label: "Illegal or dangerous activity" },
  { value: "privacy_or_personal_data", label: "Privacy or personal data" },
  { value: "deceptive_or_misleading", label: "Deceptive or misleading content" },
  { value: "other_unsafe_content", label: "Other unsafe content" },
];

export default function ReportContentButton({
  subject,
  label = "Report unsafe output",
}: {
  readonly subject: ReportSubject;
  readonly label?: string;
}): React.JSX.Element {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ModerationReason>("other_unsafe_content");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  // House dialog behavior (see FlowImpactDialog / portfolio Modal): focus
  // moves inside on open, Escape closes when not submitting, and focus
  // returns to the trigger on close.
  useEffect(() => {
    if (!open) return;
    // Capture the trigger while the effect runs: the cleanup reads it after
    // React may have already detached the ref, so reading .current there is
    // what react-hooks/exhaustive-deps flags. The trigger button stays
    // mounted for the dialog's whole lifetime, so this is the same element.
    const trigger = triggerRef.current;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busyRef.current) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    cardRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, [open]);

  const submit = async (): Promise<void> => {
    if (busy || submitted) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/moderation/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...subject,
          reason,
        }),
      });
      if (!response.ok) throw new Error("Report could not be submitted.");
      setSubmitted(true);
      setMessage("Report submitted to Suede moderation. Thank you.");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Report could not be submitted.");
    } finally {
      setBusy(false);
    }
  };

  return <div style={{ display: "inline-grid", gap: 6 }}>
    <button
      type="button"
      ref={triggerRef}
      onClick={() => { setOpen(true); setMessage(null); }}
      aria-haspopup="dialog"
      className="mono lp-touch"
      style={{
        border: "1px solid var(--hairline-visible)",
        borderRadius: "var(--radius-sm)",
        background: "transparent",
        color: "var(--text-muted)",
        cursor: "pointer",
        fontSize: "var(--text-label)",
        padding: "6px 9px",
      }}
    >
      {label}
    </button>
    {open ? <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "var(--scrim)",
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
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
      <section ref={cardRef} style={{
        width: "min(520px, 100%)",
        display: "grid",
        gap: 14,
        padding: 20,
        border: "1px solid var(--hairline-visible)",
        borderRadius: "var(--radius)",
        background: "var(--ink-panel)",
        boxShadow: "var(--shadow-lg)",
      }}>
        <div>
          <h2 id={titleId} style={{ margin: 0, fontSize: "var(--text-h3)" }}>Report unsafe content</h2>
          <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            Suede sends the selected reason and record IDs to moderation. Generated content, prompts, and credentials are not copied into the report.
          </p>
        </div>
        <label style={{ display: "grid", gap: 6 }}>
          <span className="eyebrow">Reason</span>
          <select
            value={reason}
            disabled={busy || submitted}
            onChange={(event) => setReason(event.target.value as ModerationReason)}
            style={{ minHeight: 42, border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", background: "var(--ink-control)", color: "var(--text-primary)", padding: "0 10px" }}
          >
            {REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {message ? <p role="status" aria-live="polite" style={{ margin: 0, color: submitted ? "var(--text-success)" : "var(--rights-red)" }}>{message}</p> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" disabled={busy} onClick={() => setOpen(false)}>{submitted ? "Close" : "Cancel"}</button>
          {!submitted ? <button type="button" className="lp-btn lp-btn--primary lp-btn--sm" disabled={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit report"}</button> : null}
        </div>
      </section>
    </div> : null}
  </div>;
}
