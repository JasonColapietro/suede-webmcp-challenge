"use client";

/**
 * Owner-only manage bar for the public agent page. Client-side on purpose:
 * /a/[slug] is ISR (revalidate = 60), so the server render must never read
 * request headers/cookies — doing so is a static-to-dynamic violation that
 * 500s every anonymous cache-miss (hit live 2026-08-09). The check runs after
 * hydration against /api/me, which is scoped by the caller's own cookie;
 * non-owners (and any fetch failure) render nothing, so buyer HTML is
 * byte-identical to the static shell.
 */
import { useEffect, useState } from "react";
import Link from "next/link";

export default function OwnerBar({ flowId }: { flowId: string }): React.JSX.Element | null {
  const [isOwner, setIsOwner] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok) return;
        const body: unknown = await res.json();
        const flows =
          typeof body === "object" && body !== null && Array.isArray((body as { flows?: unknown }).flows)
            ? ((body as { flows: unknown[] }).flows)
            : [];
        const owns = flows.some(
          (f) => typeof f === "object" && f !== null && (f as { id?: unknown }).id === flowId,
        );
        if (!cancelled && owns) setIsOwner(true);
      } catch {
        // Not the owner as far as this page is concerned.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  if (!isOwner) return null;
  return (
    <div className="state-panel ag-owner-bar" role="note">
      <span>This is your agent.</span>
      <Link href={`/flows/${encodeURIComponent(flowId)}`}>Open its record</Link>
      <Link href="/flows">Workspace</Link>
    </div>
  );
}
