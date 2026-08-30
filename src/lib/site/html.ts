/**
 * Pure HTML reading for the "build an agent from a website" path: pull the
 * few things that describe a brand (title, meta/OG description, headings,
 * readable body text) plus the same-origin links worth visiting next.
 *
 * No network, no node builtins, no DOM — every function here is a string
 * transform, so it unit-tests without fixtures or a browser and is safe to
 * import from either side of the client/server split.
 *
 * Every regex is linear (no nested quantifiers over overlapping classes) and
 * every caller feeds it input already capped by the crawler's byte budget, so
 * a hostile page cannot turn this into a CPU sink.
 */

/** A minimal, bounded set of HTML entities worth decoding for readable text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Headings past this count are noise for a brand summary. */
export const MAX_HEADINGS = 24;
/** Links past this count are noise for crawl planning. */
export const MAX_LINKS = 200;
const MAX_HEADING_CHARS = 160;

export interface PageMetadata {
  readonly title: string | null;
  readonly description: string | null;
  readonly siteName: string | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly canonical: string | null;
}

export interface ExtractedPage extends PageMetadata {
  /** Readable body text, whitespace-collapsed and truncated to `maxTextChars`. */
  readonly text: string;
  /** h1/h2/h3 contents in document order, de-duplicated. */
  readonly headings: readonly string[];
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    const named = NAMED_ENTITIES[key];
    if (named !== undefined) return named;
    if (key.startsWith("#x")) return safeFromCodePoint(Number.parseInt(key.slice(2), 16)) || match;
    if (key.startsWith("#")) return safeFromCodePoint(Number.parseInt(key.slice(1), 10)) || match;
    return match;
  });
}

function collapse(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** Read one attribute off a single tag's attribute string. */
function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(tag);
  if (!match) return null;
  const raw = match[2] ?? match[3] ?? match[4] ?? "";
  const value = decodeEntities(raw).trim();
  return value === "" ? null : value;
}

/** Every `<meta>` tag's (name-or-property, content) pair, lowercased keys. */
function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, "property") ?? attribute(tag, "name");
    const content = attribute(tag, "content");
    if (key === null || content === null) continue;
    const lowered = key.toLowerCase();
    if (!tags.has(lowered)) tags.set(lowered, content);
  }
  return tags;
}

export function extractMetadata(html: string): PageMetadata {
  const cleaned = stripNonContent(html);
  const meta = metaTags(cleaned);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(cleaned);
  const canonicalTag = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i.exec(cleaned);

  const value = (key: string): string | null => {
    const found = meta.get(key);
    if (found === undefined) return null;
    const collapsed = collapse(found);
    return collapsed === "" ? null : collapsed;
  };

  const title = titleMatch ? collapse(titleMatch[1]) : "";

  return {
    title: title === "" ? null : title,
    description: value("description") ?? value("og:description") ?? null,
    siteName: value("og:site_name") ?? value("application-name") ?? null,
    ogTitle: value("og:title") ?? null,
    ogDescription: value("og:description") ?? null,
    canonical: canonicalTag ? attribute(canonicalTag[0], "href") : null,
  };
}

export function extractHeadings(html: string): string[] {
  const cleaned = stripNonContent(html);
  const seen = new Set<string>();
  const headings: string[] = [];
  for (const match of cleaned.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const text = collapse(match[2]).slice(0, MAX_HEADING_CHARS);
    if (text === "" || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    headings.push(text);
    if (headings.length >= MAX_HEADINGS) break;
  }
  return headings;
}

/**
 * Readable body text: non-content blocks removed, block-level tags turned into
 * spaces so words don't fuse across elements, entities decoded, whitespace
 * collapsed, and the result hard-truncated to `maxChars`.
 */
export function htmlToText(html: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html);
  return collapse(stripNonContent(body ? body[1] : html)).slice(0, maxChars);
}

/**
 * Same-origin links worth crawling next, absolutised against `baseUrl` and
 * de-duplicated by href with the fragment removed. Off-origin links, non-HTTP
 * schemes, and obvious file downloads are dropped here rather than at fetch
 * time so the crawler's page budget is only ever spent on real pages.
 */
export function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const cleaned = stripNonContent(html);
  const seen = new Set<string>();
  const links: string[] = [];

  for (const match of cleaned.matchAll(/<a\b[^>]*>/gi)) {
    const href = attribute(match[0], "href");
    if (href === null || href.startsWith("#")) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (resolved.host !== base.host) continue;
    if (/\.(pdf|zip|dmg|exe|png|jpe?g|gif|svg|webp|avif|mp[34]|mov|css|js|json|xml|rss)$/i.test(resolved.pathname)) {
      continue;
    }

    resolved.hash = "";
    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(key);
    if (links.length >= MAX_LINKS) break;
  }

  return links;
}

export function extractPage(html: string, maxTextChars: number): ExtractedPage {
  return {
    ...extractMetadata(html),
    text: htmlToText(html, maxTextChars),
    headings: extractHeadings(html),
  };
}
