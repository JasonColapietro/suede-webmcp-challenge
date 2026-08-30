/**
 * OG-image color literals. Satori (next/og's renderer) cannot read CSS custom
 * properties, so every color is a plain hex string mirrored by hand from the
 * light theme in src/styles/tokens.css. Each constant names the token it
 * mirrors; if tokens.css changes, update these to match.
 */

/** Mirrors tokens.css --primary. */
export const OG_PRIMARY = "#4f46e5";

/** Mirrors tokens.css --text-primary. */
export const OG_INK = "#111317";

/** Mirrors tokens.css --text-muted. */
export const OG_MUTED = "#6b7280";

/** Mirrors tokens.css --text-secondary. */
export const OG_SECONDARY = "#475467";

/** Mirrors tokens.css --hairline. */
export const OG_HAIRLINE = "#e6e8ef";

/** Mirrors tokens.css --hairline-visible (graph-edge gray, 3:1 on white). */
export const OG_EDGE = "#818794";

/** Mirrors tokens.css --ink-deep / --on-primary (white surfaces). */
export const OG_WHITE = "#ffffff";

/** Mirrors tokens.css --canvas-bg (the flow-canvas pane). */
export const OG_CANVAS = "#f7f8fc";

/** Mirrors tokens.css --registry-cyan (Growth / Suede Tools accent). */
export const OG_CYAN = "#06b6d4";

/** Mirrors tokens.css --verified-emerald (Finance / paid / live accent). */
export const OG_EMERALD = "#10b981";

/** Mirrors tokens.css --violet (Engineering / Triggers accent). */
export const OG_VIOLET = "#8b5cf6";

/** Mirrors tokens.css --amber (Support Ops / Logic accent). */
export const OG_AMBER = "#f59e0b";

/** Mirrors tokens.css --category-docs (Docs & Data blue). */
export const OG_DOCS_BLUE = "#2563eb";
