/**
 * Google Play access-only runtime for the `ai.suede.agents` Android shell.
 *
 * The Capacitor Android build renders the live web app, so every commerce
 * surface Agent Studio publishes on the web would otherwise be reachable
 * inside a Play-distributed binary. Google Play's Payments policy treats an
 * in-app card checkout for in-app digital content as a removal-level
 * violation, not a rejection — so the Android shell loads a DEDICATED host
 * where those surfaces do not exist at all.
 *
 * Activation is host identity and nothing else. There is deliberately no
 * query flag, cookie, header, or env switch that can turn this mode on for
 * agents.suedeai.ai, because any such switch is a way for the restricted
 * runtime to leak onto the canonical host — or for the canonical host's
 * commerce to leak into the Play build. `sanitizeGooglePlaySearchParams`
 * actively strips the legacy `play_mode` param for exactly that reason.
 *
 * IMPORTANT: this app has no Google Play Billing integration. This module
 * makes the Android build policy-compliant (it cannot take a non-Play
 * payment); it does not make it able to sell anything. Adding Play Billing
 * is separate, larger work.
 */

export const GOOGLE_PLAY_MODE_QUERY_PARAM = "play_mode";

/**
 * Dedicated origin for the Play build. Named to mirror the estate's existing
 * `android-music.suedeai.ai` (Suede Social / `xyz.suedeai.app`) so the
 * convention reads the same across apps: `android-<app>.suedeai.ai` is always
 * "the access-only host for that app's Play shell". It must resolve to the
 * same deployment as agents.suedeai.ai — the gate is middleware, not a
 * separate build.
 */
export const GOOGLE_PLAY_ANDROID_HOST = "android-agents.suedeai.ai";
export const GOOGLE_PLAY_APP_ORIGIN = `https://${GOOGLE_PLAY_ANDROID_HOST}`;

/** Where a blocked navigation lands. The Play build's home surface. */
export const GOOGLE_PLAY_HOME_PATH = "/flows";

/**
 * Every route that moves money or funds spendable in-app credit.
 *
 * `/api/gateway/topup/stripe` is the actual violation: it mints a Stripe
 * Checkout session for gateway credit. `/api/gateway/topup` is the x402/USDC
 * path to the SAME balance — blocking only the card path would leave an
 * alternate purchase mechanism, which the policy also forbids. The Stripe
 * webhook is server-to-server from Stripe against the canonical host and is
 * never called from a browser, so denying it here costs nothing.
 */
const BLOCKED_PAYMENT_PATH_PREFIXES = [
  "/api/gateway/topup",
] as const;

/**
 * Agent-commerce discovery. Agent Studio exists to sell agent endpoints, so
 * this list is longer than the music app's and is enumerated from this repo's
 * actual route tree rather than copied.
 *
 * Blocking discovery matters as much as blocking checkout: a machine-readable
 * catalog, an x402 price quote, or an MCP/A2A manifest served inside the Play
 * binary is a documented route to paying for digital content outside Play
 * Billing. Dynamic per-agent surfaces are matched by pattern below.
 */
export const GOOGLE_PLAY_BLOCKED_COMMERCE_DISCOVERY_PATH_PREFIXES = [
  "/.well-known/agent-card.json",
  "/.well-known/ai-plugin.json",
  "/.well-known/x402",
  "/.well-known/x402.json",
  "/api/catalog",
  "/api/mobile/resource-packs",
  "/api/services",
  "/api/cli/agents",
  "/api/mcp",
  "/api/portfolio",
  "/llms.txt",
  "/llms-full.txt",
  "/openapi.json",
  "/sitemap.xml",
] as const;

/**
 * Per-agent commerce endpoints. `/api/agents/<slug>/...` carries the paid
 * surface (`run` is x402-priced, `settlement` moves earnings) and every
 * machine-discovery document (`.well-known/x402`, `.well-known/agent-card`,
 * `a2a`, `discovery`). The builder UI does not need any of them: it drives
 * flows through `/api/flows/*` and `/api/v2/*`.
 */
export const GOOGLE_PLAY_BLOCKED_COMMERCE_DISCOVERY_PATTERNS = [
  /^\/api\/agents\/[^/]+\/\.well-known(\/|$)/,
  /^\/api\/agents\/[^/]+\/(a2a|discovery|run|settlement)(\/|$)/,
] as const;

/**
 * Reachable page routes, deny-by-default. Everything absent is unreachable,
 * which is what keeps the purchase and marketing surfaces out without a
 * second blocklist to maintain: `/pricing`, `/a/<slug>` (the public buy-this-
 * agent page), `/x402-agent-builder`, `/ai-agent-marketplace-payments`,
 * `/docs/payments`, `/compare/*` and the rest are simply not here.
 *
 * `/privacy` and `/account-deletion` are required Play listing destinations
 * and must stay reachable inside the app.
 */
const ALLOWED_APP_PATH_PREFIXES = [
  "/account-deletion",
  "/build",
  "/code",
  "/company",
  "/connections",
  "/contact",
  "/fit",
  "/flows",
  "/grade",
  "/privacy",
  "/runs",
  "/security",
  "/start",
  "/status",
  "/templates",
] as const;

/**
 * API prefixes the in-app builder genuinely needs. Also deny-by-default: an
 * API route added later is unreachable from the Play host until someone puts
 * it here on purpose, so a future commerce endpoint cannot quietly become
 * callable from inside the Android binary.
 *
 * `/api/gateway/llm` and `/api/gateway/run` are listed individually rather
 * than as `/api/gateway` so the topup block above cannot be shadowed.
 */
const ALLOWED_API_PATH_PREFIXES = [
  "/api/companies",
  "/api/flows",
  "/api/gateway/llm",
  "/api/gateway/run",
  "/api/grade",
  "/api/guided",
  "/api/health",
  "/api/identity",
  "/api/me",
  "/api/site-agent",
  "/api/templates",
  "/api/v2",
  "/api/v3",
  "/api/verification",
] as const;

/**
 * Per-agent routes the builder does need: publishing a template and managing
 * the launch webhook. Deliberately narrower than "all of /api/agents".
 */
const ALLOWED_API_PATH_PATTERNS = [
  /^\/api\/agents\/[^/]+\/(template|webhook)(\/|$)/,
] as const;

/** Platform plumbing that is not app surface and not commerce. */
const INFRASTRUCTURE_PATH_PREFIXES = [
  "/_next",
  "/.well-known/assetlinks.json",
  "/favicon.ico",
  "/robots.txt",
  "/site.webmanifest",
] as const;

export const GOOGLE_PLAY_DESTINATION_QUERY_PARAMS = [
  "returnTo",
  "next",
  "redirect",
  "redirectTo",
  "redirect_to",
  "redirectUri",
  "redirect_uri",
  "callbackUrl",
  "continue",
] as const;

export const GOOGLE_PLAY_PURCHASE_QUERY_PARAMS = [
  "plan",
  "payment",
  "tier",
  "topup",
  "checkout",
] as const;

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Google Play access-only behavior belongs to one isolated runtime host.
 * Accept the exact hostname with an optional valid numeric port for local
 * and integration testing; suffixes, subdomains, and malformed ports fail.
 */
export function isGooglePlayAccessOnlyHost(
  host: string | null | undefined,
): boolean {
  if (!host) return false;

  const normalized = host.trim().toLowerCase();
  if (normalized === GOOGLE_PLAY_ANDROID_HOST) return true;

  const portMatch = normalized.match(
    new RegExp(
      `^${GOOGLE_PLAY_ANDROID_HOST.replaceAll(".", "\\.")}:(\\d{1,5})$`,
    ),
  );
  if (!portMatch) return false;

  const port = Number(portMatch[1]);
  return port >= 1 && port <= 65535;
}

export function isGooglePlayBlockedPaymentPath(pathname: string): boolean {
  return matchesPrefix(pathname, BLOCKED_PAYMENT_PATH_PREFIXES);
}

export function isGooglePlayBlockedCommerceDiscoveryPath(
  pathname: string,
): boolean {
  if (matchesPrefix(pathname, GOOGLE_PLAY_BLOCKED_COMMERCE_DISCOVERY_PATH_PREFIXES)) {
    return true;
  }
  return GOOGLE_PLAY_BLOCKED_COMMERCE_DISCOVERY_PATTERNS.some((pattern) =>
    pattern.test(pathname),
  );
}

/**
 * Resource Foundry writes can create and publish paid agent inventory, so the
 * Play access-only host must never reach them through the broad `/api/v2`
 * builder allowlist. Owner-scoped reads remain available.
 */
export function isGooglePlayBlockedResourceMutation(
  pathname: string,
  method: string,
): boolean {
  if (!matchesPrefix(pathname, ["/api/v2/resources"])) return false;
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function isGooglePlayInfrastructurePath(pathname: string): boolean {
  return matchesPrefix(pathname, INFRASTRUCTURE_PATH_PREFIXES);
}

export function isGooglePlayAllowedApiPath(pathname: string): boolean {
  if (isGooglePlayBlockedPaymentPath(pathname)) return false;
  if (isGooglePlayBlockedCommerceDiscoveryPath(pathname)) return false;
  if (matchesPrefix(pathname, ALLOWED_API_PATH_PREFIXES)) return true;
  return ALLOWED_API_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function isGooglePlayAllowedAppPath(pathname: string): boolean {
  if (isGooglePlayBlockedPaymentPath(pathname)) return false;
  if (isGooglePlayBlockedCommerceDiscoveryPath(pathname)) return false;
  return matchesPrefix(pathname, ALLOWED_APP_PATH_PREFIXES);
}

/**
 * Restrict an auth/return handoff destination to the canonical Play origin
 * and the small set of routes the access-only runtime exposes, so a crafted
 * `?next=` cannot walk the Play build onto a purchase page or off-origin.
 */
export function sanitizeGooglePlayAppDestination(
  destination: string | null | undefined,
): string | null {
  if (!destination || destination.includes("\\")) return null;

  let parsed: URL;
  try {
    parsed = new URL(destination, GOOGLE_PLAY_APP_ORIGIN);
  } catch {
    return null;
  }

  if (parsed.origin !== GOOGLE_PLAY_APP_ORIGIN) return null;
  if (!isGooglePlayAllowedAppPath(parsed.pathname)) return null;

  parsed.searchParams.delete(GOOGLE_PLAY_MODE_QUERY_PARAM);
  for (const param of GOOGLE_PLAY_DESTINATION_QUERY_PARAMS) {
    parsed.searchParams.delete(param);
  }
  for (const param of GOOGLE_PLAY_PURCHASE_QUERY_PARAMS) {
    parsed.searchParams.delete(param);
  }

  return parsed.toString();
}

/**
 * Mutate a Play-host URL query into the safe subset. Destination params are
 * retained only when they resolve to the Play origin and an allowed route;
 * purchase-intent params are always dropped.
 */
export function sanitizeGooglePlaySearchParams(searchParams: URLSearchParams): {
  changed: boolean;
  removedPurchaseIntent: boolean;
  removedUnsafeDestination: boolean;
} {
  let changed = false;
  let removedPurchaseIntent = false;
  let removedUnsafeDestination = false;

  // Host identity is the only activation mechanism. Normalize the legacy
  // launch flag away without letting it affect any other origin.
  if (searchParams.has(GOOGLE_PLAY_MODE_QUERY_PARAM)) {
    searchParams.delete(GOOGLE_PLAY_MODE_QUERY_PARAM);
    changed = true;
  }

  for (const param of GOOGLE_PLAY_DESTINATION_QUERY_PARAMS) {
    const values = searchParams.getAll(param);
    if (values.length === 0) continue;

    const safeValues: string[] = [];
    for (const value of values) {
      const safe = sanitizeGooglePlayAppDestination(value);
      if (safe) {
        safeValues.push(safe);
      } else {
        removedUnsafeDestination = true;
      }
    }

    const normalizedChanged =
      safeValues.length !== values.length ||
      safeValues.some((value, index) => value !== values[index]);
    if (!normalizedChanged) continue;

    searchParams.delete(param);
    for (const safe of safeValues) searchParams.append(param, safe);
    changed = true;
  }

  for (const param of GOOGLE_PLAY_PURCHASE_QUERY_PARAMS) {
    if (searchParams.has(param)) {
      changed = true;
      removedPurchaseIntent = true;
      searchParams.delete(param);
    }
  }

  return { changed, removedPurchaseIntent, removedUnsafeDestination };
}
