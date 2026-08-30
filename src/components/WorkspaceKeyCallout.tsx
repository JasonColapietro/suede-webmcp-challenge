"use client";

/**
 * Surfaces the workspace key at the moment a creator is most likely to need
 * it: right after a flow goes live. The `agx_owner` cookie IS the workspace
 * identity (see src/lib/auth.ts) and this key is the only way to recover a
 * workspace on another browser or device — until now it was shown only at
 * the bottom of /flows. Mirrors the reveal/copy pattern there
 * (src/app/flows/dashboard.tsx handleCopyKey / keyShown).
 */
import { useCallback, useEffect, useState } from "react";

export interface WorkspaceKeyCalloutProps {
  /** Matches the visual language of the surface this renders inside. */
  variant: "studio" | "guided";
}

interface MeKeyResponse {
  ownerId: string;
}

function isMeKeyResponse(v: unknown): v is MeKeyResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).ownerId === "string"
  );
}

export default function WorkspaceKeyCallout({
  variant,
}: WorkspaceKeyCalloutProps): React.JSX.Element | null {
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [shown, setShown] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (!cancelled && isMeKeyResponse(body)) setOwnerId(body.ownerId);
      } catch {
        // The callout just stays hidden if /api/me is unreachable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (!ownerId) return;
    try {
      await navigator.clipboard.writeText(ownerId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setShown(true);
    }
  }, [ownerId]);

  if (!ownerId) return null;

  if (variant === "studio") {
    return (
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--hairline)",
        }}
      >
        <div
          className="mono"
          style={{ fontSize: "var(--text-xs)", color: "var(--text-warning)" }}
        >
          Save your workspace key
        </div>
        <div
          className="mono"
          style={{
            marginTop: 3,
            fontSize: "var(--text-xs)",
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          It is the only way back into this flow from another browser or
          device. Copy it now.
        </div>
        {shown && (
          <div
            className="mono"
            style={{
              marginTop: 6,
              fontSize: "var(--text-xs)",
              color: "var(--text-primary)",
              wordBreak: "break-all",
            }}
          >
            {ownerId}
          </div>
        )}
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="lp-btn lp-btn--ghost lp-btn--sm"
          style={{ marginTop: 6 }}
        >
          {copied ? "Copied ✓" : "Copy workspace key"}
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: "0.75rem",
        background: "var(--surface-raised)",
        borderRadius: 10,
        padding: "0.875rem 1rem",
        border: "1px solid var(--border)",
      }}
    >
      <p
        style={{
          fontWeight: 600,
          fontSize: "var(--text-sm)",
          marginBottom: "0.35rem",
        }}
      >
        One key runs your whole workspace.
      </p>
      <p
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--text-muted)",
          marginBottom: "0.6rem",
        }}
      >
        Suede set up a workspace for you behind the scenes. It holds this
        agent, everything it earns, and any agents you build next. This key is
        how you reach it from another browser or device. Copy it now and keep
        it somewhere safe; it can&apos;t be recovered later.
      </p>
      {shown && (
        <div
          className="mono"
          style={{
            fontSize: "0.75rem",
            wordBreak: "break-all",
            marginBottom: "0.6rem",
          }}
        >
          {ownerId}
        </div>
      )}
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="lp-btn lp-btn--ghost lp-btn--sm"
      >
        {copied ? "Copied ✓" : "Copy workspace key"}
      </button>
    </div>
  );
}
