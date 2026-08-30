/**
 * Brand color literals for Satori-rendered images (icon.tsx, apple-icon.tsx,
 * opengraph-image.tsx). next/og's Satori renderer can't read CSS custom
 * properties, so these are plain hex strings — kept in sync by hand with the
 * matching tokens in src/styles/tokens.css (--primary, --text-primary,
 * --text-muted, --hairline, --on-primary / white).
 */

/** Mirrors tokens.css --primary. */
export const BRAND_PRIMARY = "#4f46e5";

/** Mirrors tokens.css --text-primary. */
export const BRAND_INK = "#111317";

/** Mirrors tokens.css --text-muted. */
export const BRAND_MUTED = "#6b7280";

/** Mirrors tokens.css --hairline. */
export const BRAND_HAIRLINE = "#e6e8ef";

/** Mirrors tokens.css --on-primary / white surfaces. */
export const BRAND_WHITE = "#ffffff";
