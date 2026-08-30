/** Server-controlled target forwarded by middleware for authentication redirects. */
export const REQUEST_TARGET_HEADER = "x-suede-studio-request-target";

/**
 * The released Capacitor shell identifies as an iOS mobile WebKit WebView,
 * without Safari's product token. User-Agent is client-supplied and forgeable,
 * so this is an Edge-safe routing hint only; it must never grant access.
 */
export function isReleasedIosShell(userAgent: string | null): boolean {
  if (!userAgent) return false;

  return /\b(?:iPhone|iPad|iPod)\b/u.test(userAgent)
    && /\bAppleWebKit\/\d/u.test(userAgent)
    && /\bMobile\/\S+/u.test(userAgent)
    && !/\bSafari\//u.test(userAgent);
}
