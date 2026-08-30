"use client";

import React from "react";

const HASH = /^[a-f0-9]{64}$/;

export type PinnedReferenceBannerState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly parentLabel: string;
      readonly versionLabel: string;
      readonly contentHash: string;
    };

function compactHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

export default function PinnedReferenceBanner({
  state,
  onOpenPinned,
}: {
  readonly state: PinnedReferenceBannerState;
  readonly onOpenPinned?: () => void;
}): React.JSX.Element | null {
  if (state.kind === "empty") return null;
  if (state.kind === "loading") {
    return <p role="status" aria-live="polite" className="mono">Checking parent reference…</p>;
  }
  const valid = state.kind === "ready" && state.parentLabel.trim() && state.versionLabel.trim() &&
    HASH.test(state.contentHash);
  if (!valid) {
    return <p role="status" aria-live="polite" className="mono">Pinned reference unavailable.</p>;
  }

  return (
    <aside
      role="note"
      aria-label="Immutable parent reference"
      className="mono"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 10,
        padding: "10px 12px",
        border: "1px solid var(--hairline-cyan)",
        borderRadius: "var(--radius)",
        background: "var(--ink-control)",
        color: "var(--text-primary)",
      }}
    >
      <span>
        <strong>{state.parentLabel}</strong> uses immutable version {state.versionLabel}, pinned to content hash{" "}
        <span title={state.contentHash}>{compactHash(state.contentHash)}</span>. This canvas shows the current draft and may differ.
      </span>
      {onOpenPinned ? (
        <button
          type="button"
          onClick={onOpenPinned}
          style={{ minHeight: 44, padding: "0 12px" }}
        >
          Open immutable version
        </button>
      ) : null}
    </aside>
  );
}
