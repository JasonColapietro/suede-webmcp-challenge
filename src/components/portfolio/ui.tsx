/**
 * Small presentational primitives for the portfolio dashboard. Self-contained:
 * uses the builder's base tokens directly (no Agentix-specific alias tokens).
 */
import type { AgentStatus } from "@/lib/portfolio/types";
import { categoryColor } from "@/lib/portfolio/category";
import { signedPct } from "@/lib/portfolio/format";

// Canonical status→token mapping (matches src/app/flows/dashboard.tsx run-status pills
// and src/components/canvas/RunDock.tsx ledgerStatusColor): the label text itself
// carries the semantic status color via contrast-safe --text-* tokens, not a
// decorative fill. Anything unmapped falls back to --text-muted.
const STATUS_META: Record<AgentStatus, { label: string; color: string }> = {
  live: { label: "Live", color: "var(--text-success)" },
  degraded: { label: "Degraded", color: "var(--text-warning)" },
  down: { label: "Down", color: "var(--rights-red)" },
  draft: { label: "Draft", color: "var(--text-muted)" },
  paused: { label: "Paused", color: "var(--text-muted)" },
};

export function StatusBadge({ status, size = "sm" }: { status: AgentStatus; size?: "sm" | "md" }) {
  const meta = STATUS_META[status] ?? { label: status, color: "var(--text-muted)" };
  return (
    <span
      className="mono inline-flex items-center whitespace-nowrap"
      style={{ fontSize: size === "md" ? "var(--text-xs)" : "var(--text-label)", color: meta.color }}
    >
      {meta.label}
    </span>
  );
}

export function CategoryTag({ category }: { category: string }) {
  const color = categoryColor(category);
  return (
    <span className="inline-flex items-center gap-1.5" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 2, background: color, display: "inline-block" }} />
      {category}
    </span>
  );
}

export function DeltaPill({ fraction, className = "" }: { fraction: number; className?: string }) {
  const isNew = !Number.isFinite(fraction);
  const up = fraction > 0;
  const flat = fraction === 0;
  const color = isNew ? "var(--registry-cyan)" : up ? "var(--verified-emerald)" : flat ? "var(--text-muted)" : "var(--rights-red)";
  const glyph = isNew ? "✦" : up ? "▲" : flat ? "→" : "▼";
  const text = isNew ? "new" : signedPct(fraction);
  return (
    <span
      className={`mono inline-flex items-center gap-1 ${className}`}
      style={{
        fontSize: "var(--text-xs)",
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        padding: "2px 7px",
        borderRadius: 999,
        lineHeight: 1.2,
      }}
      data-numeric
    >
      <span aria-hidden="true" style={{ fontSize: 9 }}>{glyph}</span>
      {text}
    </span>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}
