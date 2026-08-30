/**
 * Domain-ownership verification for site-drafted agents.
 *
 * Anyone can point the crawler at any public website, so a drafted agent
 * starts UNLISTED: live at its own /a/<slug> URL for its owner to use, but
 * excluded from the public directory, the /api/catalog feed, the x402 index,
 * and the sitemap (they all flow through buildCatalog) until the workspace
 * proves it controls the domain the agent speaks for. The proof is the
 * classic one: place a one-line file on the domain.
 *
 *   https://<host>/.well-known/suede-agent.txt   containing the token below
 *
 * The token is an HMAC-shaped digest of (ownerId, host). ownerId is the
 * workspace key — a secret UUID — so the token is computable only by the
 * server and the owner's own session, publishing it reveals nothing, and a
 * token lifted from one site verifies neither another host nor another
 * workspace.
 *
 * KNOWN LIMIT (by design, documented in AI_HANDOFF): the "this is a site
 * agent" marker lives in owner-editable graph meta, so a determined owner
 * can strip it in the studio and get listed unverified — exactly as they
 * could by hand-building the same agent on the canvas. The gate exists to
 * make the default paste-a-URL path honest, not to be provenance-proof.
 *
 * Server-only: node:crypto, and callers hand it safeFetch.
 */
import { createHash } from "node:crypto";
import { safeFetch } from "@/lib/net/safe-url";

export const SITE_VERIFICATION_PATH = "/.well-known/suede-agent.txt";
const MAX_VERIFICATION_FILE_BYTES = 8_192;
const VERIFICATION_TIMEOUT_MS = 10_000;

export { SITE_AGENT_TEMPLATE_PREFIX, SITE_HOST_META_KEY } from "./blueprint-meta";

export function normalizeVerificationHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0] ?? "";
}

/** Deterministic per-(workspace, host) token. Publishing it leaks nothing. */
export function siteVerificationToken(ownerId: string, host: string): string {
  const digest = createHash("sha256")
    .update(`suede-site-claim:${ownerId}:${normalizeVerificationHost(host)}`, "utf8")
    .digest("hex");
  return `suede-verify-${digest.slice(0, 40)}`;
}

export type VerificationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type VerificationFetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: VerificationFetch = (url, init) =>
  safeFetch(url, init, { timeoutMs: VERIFICATION_TIMEOUT_MS });

/**
 * Fetch the well-known file over https and check it contains the token.
 * SSRF-safe by construction: the fetch goes through safeFetch, https-only.
 */
export async function checkSiteVerificationFile(
  host: string,
  token: string,
  fetchImpl: VerificationFetch = defaultFetch,
): Promise<VerificationCheck> {
  const normalized = normalizeVerificationHost(host);
  if (normalized === "" || !normalized.includes(".")) {
    return { ok: false, reason: "That is not a domain Suede can check." };
  }
  const url = `https://${normalized}${SITE_VERIFICATION_PATH}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "text/plain" },
    });
  } catch {
    return { ok: false, reason: `Couldn't reach ${url}. Is the file up and the site on https?` };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      reason: `${url} returned ${response.status}. Put the verification file there, then try again.`,
    };
  }

  let text: string;
  try {
    text = (await response.text()).slice(0, MAX_VERIFICATION_FILE_BYTES);
  } catch {
    return { ok: false, reason: `Couldn't read ${url}.` };
  }
  if (!text.includes(token)) {
    return {
      ok: false,
      reason: `${url} exists but doesn't contain your verification token yet.`,
    };
  }
  return { ok: true };
}
