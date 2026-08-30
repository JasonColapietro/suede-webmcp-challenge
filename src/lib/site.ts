/**
 * Canonical site origin for absolute URLs (metadata, feeds, discovery docs).
 * agents.suedeai.ai is THIS app; agentix.suedeai.ai is the separate grader
 * microsite (Vercel project `site`) — never point canonicals there.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://agents.suedeai.ai";

/** Canonical site-wide social preview image. */
export const OG_IMAGE = `${SITE_URL}/opengraph-image`;

/**
 * One freshness date for the whole site. Bump it whenever homepage copy or
 * structure meaningfully changes. Read by the footer's visible "Site last
 * updated" line and the sitemap's `/` entry.
 */
export const SITE_LAST_UPDATED = "2026-08-26";
