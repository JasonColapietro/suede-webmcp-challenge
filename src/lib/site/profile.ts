/**
 * A crawled site, condensed into the facts an agent needs to speak for the
 * business: who they are, what they sell, who they sell it to, how they
 * sound, and the raw page text to answer from.
 *
 * Two brains, same contract as the Guided builder (see lib/guided/draft.ts):
 * a deterministic derivation that works with no API key at all, and an
 * optional LLM refinement layered on top that fills the fields no regex can
 * infer (audience, tone, FAQs). The LLM never replaces a field with an empty
 * one, and any failure falls straight back to the deterministic profile — so
 * this path has no hard dependency on a model being reachable.
 *
 * Server-only: imports the crawler's types and (lazily) the AI SDK.
 */
import { z } from "zod";
import type { CrawlPage, SiteCrawl } from "./crawl";
import {
  recordModelSpend,
  modelSpendEntitlement,
  type ModelSpendBilling,
} from "@/lib/gateway/model-spend";

export const MAX_OFFERINGS = 8;
export const MAX_FAQS = 6;
export const MAX_SUMMARY_CHARS = 400;
/** What gets baked into the launched agent's system prompt, per call. */
export const MAX_KNOWLEDGE_CHARS = 24_000;
/** What gets sent to the refinement model. Smaller: it only needs the gist. */
export const MAX_REFINE_CHARS = 18_000;
const MIN_OFFERING_CHARS = 3;
const MAX_OFFERING_CHARS = 90;

export const SiteFaqSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

export const SiteProfileSchema = z.object({
  /** Home page URL actually read. */
  url: z.string().min(1),
  host: z.string().min(1),
  siteName: z.string().min(1),
  /** One-line positioning. May be empty when the site states none. */
  tagline: z.string(),
  summary: z.string(),
  offerings: z.array(z.string()).max(MAX_OFFERINGS),
  /**
   * True only when a model read the pages and confirmed these are the things
   * the business sells. The deterministic derivation just lifts headings, and
   * headings are often section titles ("How we started", "Our guarantee"), so
   * unverified offerings must never be presented to the agent as products.
   */
  offeringsVerified: z.boolean(),
  audience: z.string(),
  tone: z.string(),
  faqs: z.array(SiteFaqSchema).max(MAX_FAQS),
  sources: z.array(z.object({ url: z.string().min(1), title: z.string() })),
  /** Bounded page text the agent answers from. */
  knowledge: z.string(),
  /** True when the crawl budget cut the site short. */
  truncated: z.boolean(),
  /**
   * True when a model actually read the pages. False means this is the
   * deterministic profile — still a real, launchable agent, just without the
   * audience/tone/FAQ read that a paid workspace gets.
   */
  refined: z.boolean().default(false),
});

export type SiteProfile = z.infer<typeof SiteProfileSchema>;
export type SiteFaq = z.infer<typeof SiteFaqSchema>;

/** Separators sites put between the page name and the brand in <title>. */
const TITLE_SEPARATORS = /\s+[|·•—–-]\s+/;

function cleanSegment(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The brand name. `og:site_name` when the site states one, else the shortest
 * segment of the home page <title> (the brand is almost always the short half
 * of "Fast, fair moving quotes | Acme Movers"), else the bare hostname.
 */
export function deriveSiteName(page: CrawlPage, host: string): string {
  if (page.siteName) return cleanSegment(page.siteName);
  const title = page.title ?? "";
  if (title) {
    const segments = title.split(TITLE_SEPARATORS).map(cleanSegment).filter(Boolean);
    if (segments.length > 1) {
      const shortest = segments.reduce((best, segment) =>
        segment.length < best.length ? segment : best,
      );
      if (shortest.length >= 2) return shortest;
    }
    if (segments.length === 1 && segments[0]!.length <= 60) return segments[0]!;
  }
  return host.replace(/^www\./i, "");
}

/**
 * The one-line positioning, taken from og:title, the first h1, or <title>.
 *
 * A separated title is almost always "Brand <sep> the actual promise"
 * ("Linear – The system for product development"), so segments matching the
 * brand are dropped and the first surviving one wins. Taking segment zero
 * blindly returns the brand name back as its own tagline, which is what this
 * did before real sites were run through it.
 */
function deriveTagline(page: CrawlPage, siteName: string): string {
  const brand = siteName.toLowerCase();
  const candidates = [page.ogTitle ?? "", page.headings[0] ?? "", page.title ?? ""];
  for (const candidate of candidates) {
    const cleaned = cleanSegment(candidate);
    if (cleaned === "" || cleaned.toLowerCase() === brand || cleaned.length > 140) continue;
    const segments = cleaned
      .split(TITLE_SEPARATORS)
      .map(cleanSegment)
      .filter((segment) => segment !== "" && segment.toLowerCase() !== brand);
    // Every segment was the brand: this candidate says nothing. Try the next.
    if (segments.length === 0) continue;
    return segments[0]!;
  }
  return "";
}

function deriveSummary(page: CrawlPage): string {
  const described = cleanSegment(page.description ?? page.ogDescription ?? "");
  if (described.length >= 40) return described.slice(0, MAX_SUMMARY_CHARS);
  const text = page.text.slice(0, MAX_SUMMARY_CHARS * 2);
  const sentences = text.split(/(?<=[.!?])\s+/);
  let summary = "";
  for (const sentence of sentences) {
    if (summary.length + sentence.length > MAX_SUMMARY_CHARS) break;
    summary += (summary === "" ? "" : " ") + sentence.trim();
  }
  return cleanSegment(summary || text).slice(0, MAX_SUMMARY_CHARS);
}

/**
 * What the business appears to sell, read off the headings of the pages a
 * buyer would open. Home-page headings come last: they are usually slogans,
 * while a /products or /services page names the actual things.
 */
export function deriveOfferings(crawl: SiteCrawl): string[] {
  const seen = new Set<string>();
  const offerings: string[] = [];
  const ordered = [...crawl.pages.slice(1), ...crawl.pages.slice(0, 1)];

  for (const page of ordered) {
    for (const heading of page.headings) {
      const cleaned = cleanSegment(heading);
      const key = cleaned.toLowerCase();
      if (cleaned.length < MIN_OFFERING_CHARS || cleaned.length > MAX_OFFERING_CHARS) continue;
      if (/^(menu|navigation|skip to|search|newsletter|follow us|cookies?|share this)\b/i.test(cleaned)) {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      offerings.push(cleaned);
      if (offerings.length >= MAX_OFFERINGS) return offerings;
    }
  }
  return offerings;
}

/** The crawled text, labelled by source page and capped for prompt use. */
export function buildKnowledge(crawl: SiteCrawl, maxChars: number): string {
  const sections: string[] = [];
  let used = 0;
  for (const page of crawl.pages) {
    if (page.text.trim() === "") continue;
    const header = `--- ${page.title ?? page.url} (${page.url}) ---\n`;
    const remaining = maxChars - used - header.length;
    if (remaining <= 0) break;
    const body = page.text.slice(0, remaining);
    sections.push(header + body);
    used += header.length + body.length;
  }
  return sections.join("\n\n");
}

/** The deterministic profile. No network, no model, always available. */
export function deriveSiteProfile(crawl: SiteCrawl): SiteProfile {
  const home = crawl.pages[0]!;
  const siteName = deriveSiteName(home, crawl.host);
  return SiteProfileSchema.parse({
    url: crawl.homeUrl,
    host: crawl.host,
    siteName,
    tagline: deriveTagline(home, siteName),
    summary: deriveSummary(home),
    offerings: deriveOfferings(crawl),
    offeringsVerified: false,
    audience: "",
    tone: "",
    faqs: [],
    sources: crawl.pages.map((page) => ({ url: page.url, title: page.title ?? "" })),
    knowledge: buildKnowledge(crawl, MAX_KNOWLEDGE_CHARS),
    truncated: crawl.truncated,
  });
}

// ── LLM refinement ───────────────────────────────────────────────────────────

const RefinementSchema = z.object({
  siteName: z.string(),
  tagline: z.string(),
  summary: z.string(),
  offerings: z.array(z.string()),
  audience: z.string(),
  tone: z.string(),
  faqs: z.array(SiteFaqSchema),
});

function refinementPrompt(base: SiteProfile): string {
  return [
    "You are reading a company's own website to brief an AI agent that will answer questions on that company's behalf.",
    "",
    "Return only what the page text actually supports. Rules:",
    "- Never invent prices, guarantees, credentials, locations, or availability.",
    "- If the site does not say who it is for, return an empty string for audience.",
    "- `tone` describes how the site writes (e.g. \"plain and direct, short sentences, no hype\"), in one line.",
    "- `offerings` are the concrete products or services, named as the site names them. Empty array if unclear.",
    "- `faqs` are only questions the site itself answers, with answers drawn from its own words. Empty array if none.",
    "- `summary` is at most three sentences describing what the business does.",
    "",
    `Site: ${base.siteName} (${base.host})`,
    "",
    "Page text:",
    base.knowledge.slice(0, MAX_REFINE_CHARS),
  ].join("\n");
}

function preferNonEmpty(candidate: string, fallback: string): string {
  const cleaned = cleanSegment(candidate);
  return cleaned === "" ? fallback : cleaned;
}

/**
 * Layer model-read fields over the deterministic profile. Returns `base`
 * unchanged when no key is configured or anything at all goes wrong — this
 * is an enhancement, never a dependency.
 *
 * The refinement spends the funded model key, so it is metered and gated on
 * the caller having paid (see ./refinement-billing.ts). Passing no `billing`
 * skips the model entirely: callers without a billing context get the
 * deterministic profile, never an unbilled model call.
 */
export async function refineSiteProfile(
  base: SiteProfile,
  billing?: ModelSpendBilling,
): Promise<SiteProfile> {
  if (!process.env.ANTHROPIC_API_KEY) return base;
  if (!billing) return base;

  const entitlement = await modelSpendEntitlement(billing);
  if (!entitlement.allowed) return base;

  try {
    const { generateObject } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const result = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: RefinementSchema,
      prompt: refinementPrompt(base),
    });

    await recordModelSpend(
      billing,
      entitlement,
      result.usage?.totalTokens ?? 0,
      "site-agent:refine",
    );

    const refined = result.object;
    const offerings = refined.offerings
      .map(cleanSegment)
      .filter((offering) => offering.length >= MIN_OFFERING_CHARS && offering.length <= MAX_OFFERING_CHARS)
      .slice(0, MAX_OFFERINGS);

    return SiteProfileSchema.parse({
      ...base,
      siteName: preferNonEmpty(refined.siteName, base.siteName),
      tagline: preferNonEmpty(refined.tagline, base.tagline),
      summary: preferNonEmpty(refined.summary, base.summary).slice(0, MAX_SUMMARY_CHARS),
      offerings: offerings.length > 0 ? offerings : base.offerings,
      // Only the model's own list is a confirmed product list. Falling back to
      // the derived headings keeps them labelled as headings downstream.
      offeringsVerified: offerings.length > 0,
      audience: cleanSegment(refined.audience),
      tone: cleanSegment(refined.tone),
      faqs: refined.faqs
        .map((faq) => ({
          question: cleanSegment(faq.question),
          answer: cleanSegment(faq.answer),
        }))
        .filter((faq) => faq.question !== "" && faq.answer !== "")
        .slice(0, MAX_FAQS),
    });
  } catch {
    return base;
  }
}

/** Crawl output to finished profile: deterministic first, model-refined if possible. */
export async function buildSiteProfile(
  crawl: SiteCrawl,
  billing?: ModelSpendBilling,
): Promise<SiteProfile> {
  const base = deriveSiteProfile(crawl);
  const profile = await refineSiteProfile(base, billing);
  // `refined` is the honest signal for the UI: a paid workspace gets the
  // model-read fields, an unpaid one gets a real but plainer agent.
  return { ...profile, refined: profile !== base };
}
