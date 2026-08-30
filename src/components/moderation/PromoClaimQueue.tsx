"use client";

import React, { useCallback, useEffect, useState } from "react";

export interface PromoClaimRow {
  readonly claim_id: string;
  readonly campaign_id: string;
  readonly campaign_title: string | null;
  readonly raider_handle: string | null;
  readonly status: string;
  readonly proof_url: string | null;
  readonly proof_post_id: string | null;
  readonly reward_usdc6: number | null;
  readonly claim_time: string | null;
  readonly appeal_at: string | null;
  readonly appeal_reason: string | null;
  readonly evidence_bundle: Record<string, unknown> | null;
}

type Resolution = "approved" | "rejected" | "forfeited";

const RESOLUTIONS: readonly { readonly value: Resolution; readonly label: string; readonly destructive: boolean }[] = [
  { value: "approved", label: "Approve", destructive: false },
  { value: "rejected", label: "Reject", destructive: true },
  { value: "forfeited", label: "Forfeit", destructive: true },
];

const control: React.CSSProperties = {
  minHeight: 38,
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--hairline)",
  background: "var(--ink-control)",
  color: "var(--text-primary)",
  padding: "8px 10px",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-xs)",
};

function formatReward(usdc6: number | null): string {
  if (typeof usdc6 !== "number") return "—";
  return `${(usdc6 / 1_000_000).toFixed(2)} USDC`;
}

function proofHref(claim: PromoClaimRow): string | null {
  if (claim.proof_url) return claim.proof_url;
  if (claim.proof_post_id) return `https://x.com/i/web/status/${claim.proof_post_id}`;
  return null;
}

function failedChecks(bundle: Record<string, unknown> | null): string[] {
  const checks = bundle?.checks;
  if (!checks || typeof checks !== "object") return [];
  return Object.entries(checks as Record<string, unknown>)
    .filter(([, value]) => value === false || value === "fail" || value === "inconclusive")
    .map(([name]) => name);
}

export default function PromoClaimQueue(): React.JSX.Element {
  const [claims, setClaims] = useState<readonly PromoClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/moderation/promo-claims?status=inconclusive,disputed", {
        cache: "no-store",
      });
      if (response.status === 403) throw new Error("Reviewer access required.");
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = body && typeof body === "object" ? Reflect.get(body, "error") : null;
        throw new Error(typeof detail === "string" ? detail : "Claims could not be loaded.");
      }
      const rows = body && typeof body === "object" ? Reflect.get(body, "claims") : null;
      setClaims(Array.isArray(rows) ? (rows as PromoClaimRow[]) : []);
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : "Claims could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (claim: PromoClaimRow, resolution: Resolution): Promise<void> => {
    if (busyId) return;
    setBusyId(claim.claim_id);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[claim.claim_id];
      return next;
    });
    try {
      const note = notes[claim.claim_id]?.trim();
      const response = await fetch("/api/moderation/promo-claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claimId: claim.claim_id,
          resolution,
          ...(note ? { note } : {}),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = body && typeof body === "object" ? Reflect.get(body, "error") : null;
        const message = detail === "claim_not_reviewable"
          ? "Promo already resolved this claim. Refreshing."
          : typeof detail === "string" ? detail : "Decision could not be saved.";
        setRowErrors((current) => ({ ...current, [claim.claim_id]: message }));
        if (detail === "claim_not_reviewable") void load();
        return;
      }
      setClaims((current) => current.filter((row) => row.claim_id !== claim.claim_id));
    } catch (error: unknown) {
      setRowErrors((current) => ({
        ...current,
        [claim.claim_id]: error instanceof Error ? error.message : "Decision could not be saved.",
      }));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <p role="status">Loading claims from Promo…</p>;
  if (loadError) return <p role="alert">{loadError}</p>;
  if (claims.length === 0) return <p>No claims waiting for review.</p>;

  return <section aria-labelledby="promo-claim-queue-heading" style={{ display: "grid", gap: 16 }}>
    <h2 id="promo-claim-queue-heading">Claims awaiting review</h2>
    {claims.map((claim) => {
      const href = proofHref(claim);
      const failed = failedChecks(claim.evidence_bundle);
      const busy = busyId === claim.claim_id;
      return <article
        key={claim.claim_id}
        className="border hairline rounded-sm p-5"
        style={{ display: "grid", gap: 12, background: "var(--ink-panel)" }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <strong className="mono">{claim.campaign_title ?? claim.campaign_id} · {claim.status}</strong>
          <span className="mono">{formatReward(claim.reward_usdc6)}</span>
        </header>
        <dl className="mono" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, fontSize: "var(--text-xs)" }}>
          <div><dt>Creator</dt><dd>{claim.raider_handle ? `@${claim.raider_handle}` : "—"}</dd></div>
          <div><dt>Claimed</dt><dd>{claim.claim_time ? new Date(claim.claim_time).toLocaleString() : "—"}</dd></div>
          <div><dt>Proof</dt><dd>{href
            ? <a href={href} target="_blank" rel="noopener noreferrer">View post</a>
            : "—"}</dd></div>
          <div><dt>Failed checks</dt><dd>{failed.length > 0 ? failed.join(", ") : "none recorded"}</dd></div>
        </dl>
        {claim.appeal_reason ? <p style={{ fontSize: "var(--text-xs)" }}>
          <span className="eyebrow">Appeal</span> {claim.appeal_reason}
        </p> : null}
        {claim.evidence_bundle ? <details>
          <summary className="mono" style={{ fontSize: "var(--text-xs)" }}>Evidence bundle</summary>
          <pre className="mono" style={{ fontSize: "var(--text-xs)", overflowX: "auto" }}>
            {JSON.stringify(claim.evidence_bundle, null, 2)}
          </pre>
        </details> : null}
        <label style={{ display: "grid", gap: 6 }}>
          <span className="eyebrow">Reviewer note (optional)</span>
          <input
            type="text"
            style={{ ...control, width: "100%" }}
            value={notes[claim.claim_id] ?? ""}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setNotes((current) => ({ ...current, [claim.claim_id]: event.target.value }))}
          />
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {RESOLUTIONS.map((option) => <button
            key={option.value}
            type="button"
            className={option.destructive ? "lp-btn lp-btn--ghost lp-btn--sm" : "lp-btn lp-btn--primary lp-btn--sm"}
            style={option.destructive ? { color: "var(--rights-red)" } : undefined}
            disabled={busy}
            onClick={() => void resolve(claim, option.value)}
          >{busy ? "Saving…" : option.label}</button>)}
        </div>
        {rowErrors[claim.claim_id] ? <p role="alert" style={{ fontSize: "var(--text-xs)" }}>
          {rowErrors[claim.claim_id]}
        </p> : null}
      </article>;
    })}
  </section>;
}
