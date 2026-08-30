/**
 * Suede ecosystem identity for Agent Studio.
 *
 * agents.suedeai.ai sits on the .suedeai.ai cookie apex, so a browser signed
 * in on app.suedeai.ai / social.suedeai.ai already carries the shared Suede
 * Supabase project's session cookie here. This module verifies that cookie
 * against the shared project's auth API and returns the Supabase user as the
 * ecosystem identity.
 *
 * It deliberately does NOT use @supabase/ssr to read the cookie: Suede
 * Social's browser client writes the auth-helpers JSON-tuple cookie format,
 * which @supabase/ssr cannot parse — a mismatch that already caused a
 * documented production outage in Suede-AI-App (see its supabase-ssr-server.ts
 * header). We parse the cookie by hand, accept both known formats, and verify
 * the access token with GET /auth/v1/user, so any format drift fails closed
 * to "not signed in" rather than mis-attributing a workspace.
 *
 * Feature-gated: when SUEDE_ID_SUPABASE_URL / SUEDE_ID_SUPABASE_ANON_KEY are
 * unset, every call returns null and Agent Studio behaves exactly as before.
 * These point at the SHARED identity project (drzuelosizfllruocmly), never at
 * Agent Studio's own Agentix data project (SUPABASE_URL).
 */
import { cookies } from "next/headers";

export interface SuedeIdentity {
  /** auth.users id on the shared Suede Supabase project. */
  userId: string;
  email: string | null;
}

const VERIFY_TIMEOUT_MS = 3000;
const HIT_TTL_MS = 5 * 60_000;
// Stale/invalid cookies would otherwise cost a network round-trip per request.
const MISS_TTL_MS = 60_000;
const CACHE_MAX = 500;

const cache = new Map<string, { identity: SuedeIdentity | null; expiresAt: number }>();

function config(): { url: string; anonKey: string; cookieBase: string } | null {
  const url = process.env.SUEDE_ID_SUPABASE_URL;
  const anonKey = process.env.SUEDE_ID_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  let ref: string;
  try {
    ref = new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return null;
  }
  if (!ref) return null;
  return { url: url.replace(/\/$/, ""), anonKey, cookieBase: `sb-${ref}-auth-token` };
}

/**
 * Reassemble a possibly-chunked Supabase auth cookie. Large sessions are
 * split into `<base>.0`, `<base>.1`, … by both supabase cookie storages.
 */
export function assembleCookieValue(
  get: (name: string) => string | undefined,
  base: string,
): string | null {
  const whole = get(base);
  if (whole) return whole;
  const parts: string[] = [];
  for (let i = 0; ; i++) {
    const part = get(`${base}.${i}`);
    if (part === undefined) break;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * Pull the access token out of a session cookie value. Two formats exist in
 * the wild on .suedeai.ai:
 * - auth-helpers (what Social's browser client writes): URI-encoded JSON
 *   array `["<access>","<refresh>",...]`
 * - @supabase/ssr: `base64-<base64url(JSON object with access_token)>`
 * Anything else returns null (fail closed).
 */
export function extractAccessToken(raw: string): string | null {
  let text = raw;
  if (text.startsWith("base64-")) {
    try {
      text = Buffer.from(text.slice("base64-".length), "base64url").toString("utf8");
    } catch {
      return null;
    }
  } else {
    try {
      text = decodeURIComponent(text);
    } catch {
      // Not URI-encoded — fall through and try parsing as-is.
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].length > 0) {
      return parsed[0];
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { access_token?: unknown }).access_token === "string"
    ) {
      return (parsed as { access_token: string }).access_token;
    }
  } catch {
    return null;
  }
  return null;
}

function cacheGet(token: string): { identity: SuedeIdentity | null } | null {
  const hit = cache.get(token);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(token);
    return null;
  }
  return hit;
}

function cacheSet(token: string, identity: SuedeIdentity | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(token, {
    identity,
    expiresAt: Date.now() + (identity ? HIT_TTL_MS : MISS_TTL_MS),
  });
}

async function verifyToken(
  token: string,
  cfg: { url: string; anonKey: string },
): Promise<SuedeIdentity | null> {
  const cached = cacheGet(token);
  if (cached) return cached.identity;

  let identity: SuedeIdentity | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    const res = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: { apikey: cfg.anonKey, authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (res.ok) {
      const user = (await res.json().catch(() => null)) as {
        id?: string;
        email?: string;
      } | null;
      if (user && typeof user.id === "string" && user.id.length > 0) {
        identity = { userId: user.id, email: typeof user.email === "string" ? user.email : null };
      }
    }
  } catch {
    // Network failure: treat as signed out for this request, but don't
    // negative-cache — the next request should retry.
    return null;
  }
  cacheSet(token, identity);
  return identity;
}

/**
 * The signed-in Suede user carried by this request's cookies, or null.
 * Never throws; every failure mode degrades to "not signed in".
 */
export async function resolveSuedeIdentity(): Promise<SuedeIdentity | null> {
  const cfg = config();
  if (!cfg) return null;
  try {
    const jar = await cookies();
    const raw = assembleCookieValue((name) => jar.get(name)?.value, cfg.cookieBase);
    if (!raw) return null;
    const token = extractAccessToken(raw);
    if (!token) return null;
    return await verifyToken(token, cfg);
  } catch {
    return null;
  }
}
