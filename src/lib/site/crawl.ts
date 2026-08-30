/**
 * A small, bounded read of a public website — the front half of "paste your
 * URL, get an agent". It visits the home page plus a handful of the pages a
 * stranger would open to learn what a business does (about, products,
 * pricing, FAQ, contact) and returns their readable text.
 *
 * Three properties are load-bearing and must survive any edit:
 *
 *  1. **SSRF-safe.** Every request goes through `safeFetch`, which re-resolves
 *     DNS and rejects internal/reserved addresses before each hop, including
 *     redirects. This module never calls `fetch` directly.
 *  2. **Bounded.** Page count, bytes per page, total characters, and per-hop
 *     timeout are all capped, and pages are fetched sequentially. A hostile or
 *     enormous site costs a fixed amount of work, not an unbounded one.
 *  3. **Consented.** robots.txt is fetched first and obeyed. A site that
 *     disallows us is reported as blocked, not crawled anyway.
 *
 * Server-only: `safeFetch` pulls node:dns and undici. Never import from a
 * client component — the pure HTML helpers in ./html.ts are the client-safe
 * half.
 */
import { safeFetch, UnsafeUrlError } from "@/lib/net/safe-url";
import { extractPage, extractSameOriginLinks, type ExtractedPage } from "./html";
import { ALLOW_ALL, CRAWLER_USER_AGENT, parseRobots, type RobotsPolicy } from "./robots";

export const DEFAULT_MAX_PAGES = 6;
export const DEFAULT_MAX_PAGE_CHARS = 12_000;
export const DEFAULT_MAX_TOTAL_CHARS = 45_000;
export const DEFAULT_MAX_BYTES_PER_PAGE = 1_500_000;
export const DEFAULT_TIMEOUT_MS = 12_000;
const ROBOTS_MAX_BYTES = 64_000;
const ROBOTS_TIMEOUT_MS = 6_000;
/** Below this, the "page" is a shell (JS-rendered app, splash, cookie wall). */
const MIN_USEFUL_TEXT_CHARS = 120;

export type SiteCrawlErrorCode =
  | "invalid-url"
  | "unreachable"
  | "robots-blocked"
  | "unreadable";

export class SiteCrawlError extends Error {
  readonly code: SiteCrawlErrorCode;

  constructor(code: SiteCrawlErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SiteCrawlError";
    this.code = code;
  }
}

export interface CrawlPage extends ExtractedPage {
  readonly url: string;
}

export interface SiteCrawl {
  /** The terminal URL fetched for the home page, after normalization and redirects. */
  readonly homeUrl: string;
  readonly origin: string;
  readonly host: string;
  readonly pages: readonly CrawlPage[];
  /** Same-origin URLs skipped because robots.txt disallowed them. */
  readonly skippedByRobots: readonly string[];
  /** True when the page or character budget cut the read short. */
  readonly truncated: boolean;
}

export type CrawlFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CrawlOptions {
  readonly maxPages?: number;
  readonly maxPageChars?: number;
  readonly maxTotalChars?: number;
  readonly maxBytesPerPage?: number;
  readonly timeoutMs?: number;
  /** Explicit same-origin pages, prioritized inside the single aggregate budget. */
  readonly includeUrls?: readonly string[];
  /** Injectable transport. Defaults to the SSRF-hardened `safeFetch`. */
  readonly fetchImpl?: CrawlFetch;
}

const defaultFetch: CrawlFetch = (url, init) =>
  safeFetch(url, init, {
    allowedProtocols: ["http:", "https:"],
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

/**
 * Turn whatever a person typed into an absolute http(s) URL. A bare
 * "acme.com" or "www.acme.com/pricing" is the common case, so a missing
 * scheme is assumed to be https rather than rejected.
 */
export function normalizeSiteUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed === "") throw new SiteCrawlError("invalid-url", "Enter a website address.");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new SiteCrawlError("invalid-url", `"${raw.trim()}" is not a website address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SiteCrawlError("invalid-url", "Only http and https addresses can be read.");
  }
  if (url.hostname === "" || !url.hostname.includes(".")) {
    throw new SiteCrawlError("invalid-url", `"${raw.trim()}" is not a website address.`);
  }
  url.hash = "";
  return url;
}

/** Read at most `maxBytes` of a response body, then hang up. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const slice = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.length;
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function isReadableContentType(value: string | null): boolean {
  if (value === null) return true; // servers that omit it are usually serving HTML
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml" || type === "text/plain";
}

const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": `${CRAWLER_USER_AGENT} (+https://agents.suedeai.ai/docs)`,
  accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
  "accept-language": "en",
};

async function fetchDocument(
  url: string,
  fetchImpl: CrawlFetch,
  maxBytes: number,
  robotsForOrigin: (origin: string) => Promise<RobotsPolicy>,
): Promise<
  | { readonly kind: "document"; readonly url: URL; readonly html: string }
  | { readonly kind: "robots-blocked"; readonly url: URL }
  | null
> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { ...REQUEST_HEADERS } });
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error;
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const finalUrl = normalizeSiteUrl(response.url || url);
  const finalRobots = await robotsForOrigin(finalUrl.origin);
  if (!finalRobots.isAllowed(finalUrl.pathname)) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "robots-blocked", url: finalUrl };
  }
  if (!isReadableContentType(response.headers.get("content-type"))) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return {
    kind: "document",
    url: finalUrl,
    html: await readBoundedText(response, maxBytes),
  };
}

async function loadRobots(origin: string, fetchImpl: CrawlFetch): Promise<RobotsPolicy> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/robots.txt`, {
      method: "GET",
      headers: { "user-agent": REQUEST_HEADERS["user-agent"]!, accept: "text/plain" },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
  } catch {
    // No robots.txt reachable is the same as no restriction. A site that is
    // genuinely unreachable fails again on the home-page fetch below, where
    // the error is accurate and actionable.
    return ALLOW_ALL;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return ALLOW_ALL;
  }
  return parseRobots(await readBoundedText(response, ROBOTS_MAX_BYTES));
}

/** Path fragments that mark a page as describing the business itself. */
const PATH_SIGNALS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^\/?(about|about-us|our-story|company|who-we-are)/i, 10],
  [/^\/?(products?|services?|solutions?|what-we-do|offerings?)/i, 9],
  [/^\/?(pricing|plans|packages)/i, 8],
  [/^\/?(faq|faqs|help|support|questions)/i, 8],
  [/^\/?(features|how-it-works|platform)/i, 6],
  [/^\/?(shop|store|collections?|catalog|menu)/i, 6],
  [/^\/?(contact|contact-us|book|booking|appointments?)/i, 5],
  [/^\/?(team|people|staff)/i, 3],
];

/** Pages that burn budget without describing the business. */
const PATH_PENALTIES: ReadonlyArray<RegExp> = [
  /^\/?(privacy|terms|legal|cookie|dmca|accessibility|sitemap)/i,
  /^\/?(login|signin|sign-in|signup|register|account|cart|checkout|basket)/i,
  /^\/?(blog|news|press|events|careers|jobs)\/.+/i,
  /^\/?(tag|tags|category|categories|author|archive|feed)\//i,
  /^\/?(wp-|cdn-cgi|_next|assets|static)/i,
];

/**
 * Rank candidate links by how much they are likely to say about the business.
 * Shallow paths outrank deep ones at equal signal, so "/pricing" beats
 * "/solutions/enterprise/manufacturing/overview".
 */
export function scoreCandidate(rawUrl: string): number {
  let path: string;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  if (path === "/" || path === "") return Number.NEGATIVE_INFINITY; // already the home page
  for (const penalty of PATH_PENALTIES) {
    if (penalty.test(path)) return Number.NEGATIVE_INFINITY;
  }
  let score = 0;
  for (const [pattern, weight] of PATH_SIGNALS) {
    if (pattern.test(path)) {
      score += weight;
      break;
    }
  }
  const depth = path.split("/").filter(Boolean).length;
  return score - depth;
}

/**
 * Read a site into pages of plain text.
 *
 * @throws {SiteCrawlError} invalid-url, robots-blocked, unreachable, or
 *   unreadable — each mapped to a specific message the UI can show verbatim.
 */
export async function crawlSite(rawUrl: string, options: CrawlOptions = {}): Promise<SiteCrawl> {
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const maxPageChars = options.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxBytesPerPage = options.maxBytesPerPage ?? DEFAULT_MAX_BYTES_PER_PAGE;
  const fetchImpl = options.fetchImpl ?? defaultFetch;

  const home = normalizeSiteUrl(rawUrl);
  const origin = home.origin;
  const robotsByOrigin = new Map<string, Promise<RobotsPolicy>>();
  const robotsForOrigin = (candidateOrigin: string): Promise<RobotsPolicy> => {
    let policy = robotsByOrigin.get(candidateOrigin);
    if (!policy) {
      policy = loadRobots(candidateOrigin, fetchImpl);
      robotsByOrigin.set(candidateOrigin, policy);
    }
    return policy;
  };
  const selected: string[] = [];
  for (const rawSelected of options.includeUrls ?? []) {
    const normalized = normalizeSiteUrl(rawSelected);
    if (normalized.origin !== origin) {
      throw new SiteCrawlError("invalid-url", "Selected pages must use the same site origin.");
    }
    const value = normalized.toString();
    if (!selected.includes(value)) selected.push(value);
  }
  if (selected.length > maxPages) {
    throw new SiteCrawlError("invalid-url", "Selected pages exceed the bounded crawl budget.");
  }

  const robots = await robotsForOrigin(origin);
  if (!robots.isAllowed(home.pathname)) {
    throw new SiteCrawlError(
      "robots-blocked",
      `${home.host} asks crawlers not to read this page. Point at a page its robots.txt allows, or update robots.txt.`,
    );
  }
  const skippedByRobots: string[] = [];
  const skippedByRobotsSet = new Set<string>();
  const recordRobotsSkip = (url: string): void => {
    if (skippedByRobots.length >= maxPages || skippedByRobotsSet.has(url)) return;
    skippedByRobotsSet.add(url);
    skippedByRobots.push(url);
  };
  const allowedSelected = selected.filter((url) => {
    const allowed = robots.isAllowed(new URL(url).pathname);
    if (!allowed) recordRobotsSkip(url);
    return allowed;
  });

  let homeDocument:
    | { readonly kind: "document"; readonly url: URL; readonly html: string }
    | { readonly kind: "robots-blocked"; readonly url: URL }
    | null;
  try {
    homeDocument = await fetchDocument(
      home.toString(),
      fetchImpl,
      maxBytesPerPage,
      robotsForOrigin,
    );
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new SiteCrawlError("invalid-url", `${home.host} can't be read from here.`, {
        cause: error,
      });
    }
    throw error;
  }
  if (homeDocument === null) {
    throw new SiteCrawlError("unreachable", `Couldn't load ${home.host}. Check the address and try again.`);
  }
  if (homeDocument.kind === "robots-blocked") {
    throw new SiteCrawlError(
      "robots-blocked",
      `${homeDocument.url.host} asks crawlers not to read this page. Point at a page its robots.txt allows, or update robots.txt.`,
    );
  }

  const finalHome = homeDocument.url;
  const homeHtml = homeDocument.html;
  const finalRobots = await robotsForOrigin(finalHome.origin);

  // The home page is bounded by the total budget too, not just the per-page
  // one — otherwise a single enormous home page blows past maxTotalChars.
  const homeBudget = Math.min(maxPageChars, maxTotalChars);
  const pages: CrawlPage[] = [{ url: finalHome.toString(), ...extractPage(homeHtml, homeBudget) }];
  let totalChars = pages[0]!.text.length;
  let truncated = false;

  const requested = new Set<string>([home.toString(), finalHome.toString()]);
  const visited = new Set<string>([finalHome.toString()]);
  const candidates: string[] = [];
  for (const link of extractSameOriginLinks(homeHtml, finalHome.toString())) {
    if (visited.has(link)) continue;
    let pathname: string;
    try {
      pathname = new URL(link).pathname;
    } catch {
      continue;
    }
    if (!finalRobots.isAllowed(pathname)) {
      recordRobotsSkip(link);
      continue;
    }
    candidates.push(link);
  }

  const rankedDiscovered = candidates
    .map((url) => ({ url, score: scoreCandidate(url) }))
    .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .map((entry) => entry.url);

  const ranked = [
    ...allowedSelected.filter((url) => url !== home.toString() && url !== finalHome.toString()),
    ...rankedDiscovered.filter((url) => !allowedSelected.includes(url)),
  ];

  if (ranked.length > maxPages - 1) truncated = true;

  for (const url of ranked) {
    if (pages.length >= maxPages || totalChars >= maxTotalChars) {
      truncated = true;
      break;
    }
    if (requested.has(url)) continue;
    requested.add(url);

    let document:
      | { readonly kind: "document"; readonly url: URL; readonly html: string }
      | { readonly kind: "robots-blocked"; readonly url: URL }
      | null;
    try {
      document = await fetchDocument(url, fetchImpl, maxBytesPerPage, robotsForOrigin);
    } catch (error) {
      // A single unsafe or failing sub-page never sinks the whole read.
      if (error instanceof UnsafeUrlError) continue;
      throw error;
    }
    if (document === null) continue;
    if (document.kind === "robots-blocked") {
      recordRobotsSkip(document.url.toString());
      continue;
    }
    const finalUrl = document.url.toString();
    if (visited.has(finalUrl)) continue;
    visited.add(finalUrl);

    const budget = Math.min(maxPageChars, maxTotalChars - totalChars);
    const page: CrawlPage = { url: finalUrl, ...extractPage(document.html, budget) };
    if (page.text.length < MIN_USEFUL_TEXT_CHARS && page.headings.length === 0) continue;
    pages.push(page);
    totalChars += page.text.length;
  }

  const readable = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (readable < MIN_USEFUL_TEXT_CHARS) {
    throw new SiteCrawlError(
      "unreadable",
      `${finalHome.host} returned a page with almost no readable text. Sites that render entirely in the browser can't be read this way.`,
    );
  }

  return {
    homeUrl: finalHome.toString(),
    origin: finalHome.origin,
    host: finalHome.host,
    pages,
    skippedByRobots,
    truncated,
  };
}
