/**
 * POST /api/site-agent — read a public website, return a launchable agent.
 *
 * The heavy half of the "paste your URL" path: it crawls up to a handful of
 * pages on the caller's chosen site, condenses them into a SiteProfile, and
 * compiles a priced `input → llm → output` manifest the client can send
 * straight to POST /api/flows and then the launch route (exactly the path
 * Guided already uses).
 *
 * This endpoint makes outbound requests on a caller's say-so, so it is
 * deliberately the most tightly bounded route in the app: same-origin or
 * Bearer auth, BotID, a 3/min per-owner budget (a crawl is worth several
 * Guided turns), a bounded request body, and a crawler that caps pages,
 * bytes, characters, and time. Address safety itself lives in safeFetch.
 */
import { NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { z } from "zod";
import {
  resolveOwnerId,
  SUEDE_OWNER_PREFIX,
  UnauthenticatedOwnerError,
} from "@/lib/auth";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { getRepo } from "@/lib/db/repo";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";
import { crawlSite, SiteCrawlError } from "@/lib/site/crawl";
import { buildSiteProfile } from "@/lib/site/profile";
import {
  BLUEPRINT_META,
  DEFAULT_BLUEPRINT,
  siteAgentPricing,
  siteProfileToManifest,
  SITE_AGENT_BLUEPRINTS,
} from "@/lib/site/blueprints";
import { resolveSiteAgentPriceUsdc } from "@/lib/site/pricing";
import { extractBearer, validateSessionMutation } from "@/lib/site/session-auth";

export const runtime = "nodejs";
/** A six-page crawl plus a refinement call needs more than the default budget. */
export const maxDuration = 120;

const MAX_URL_CHARS = 2_048;
const MAX_PRICE_USDC = 1_000;

const RequestSchema = z
  .object({
    url: z.string().min(1).max(MAX_URL_CHARS),
    blueprint: z.enum(SITE_AGENT_BLUEPRINTS).optional(),
    priceUsdc: z.number().nonnegative().max(MAX_PRICE_USDC).optional(),
  })
  .strict();

/** invalid-url is the caller's mistake; the rest are the target site's state. */
function statusForCrawlError(code: SiteCrawlError["code"]): 400 | 422 {
  return code === "invalid-url" ? 400 : 422;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const authorization = request.headers.get("authorization");
    const bearerOwner = extractBearer(authorization);
    if (authorization !== null && bearerOwner === null) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (bearerOwner?.startsWith(SUEDE_OWNER_PREFIX)) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (bearerOwner === null) {
      const requestFailure = validateSessionMutation(request);
      if (requestFailure === 403) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (requestFailure === 415) {
        return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
      }
    }

    const verification = await checkBotId();
    if (verification.isBot) {
      return NextResponse.json({ error: "automated_request_blocked" }, { status: 403 });
    }

    const owner = bearerOwner ?? await resolveOwnerId();

    // 3/min per owner, burst 4 — a crawl fans out to several outbound requests.
    const rl = checkRateLimit(`site-agent:${owner}`, { capacity: 4, refillPerSec: 0.05 });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded.", retryAfterSec: rl.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    const parsed = RequestSchema.safeParse(body.data);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    }

    const blueprint = parsed.data.blueprint ?? DEFAULT_BLUEPRINT;

    let crawl;
    try {
      crawl = await crawlSite(parsed.data.url);
    } catch (error) {
      if (error instanceof SiteCrawlError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: statusForCrawlError(error.code) },
        );
      }
      throw error;
    }

    // Billing context for the model refinement: an unpaid workspace still gets
    // the full crawl and a launchable deterministic draft, it just doesn't
    // spend the funded model key (see lib/site/refinement-billing.ts).
    const profile = await buildSiteProfile(crawl, {
      ownerId: owner,
      repo: await getRepo(),
      ip: ipFromRequest(request),
    });
    const pricing = siteAgentPricing(profile, blueprint);
    const manifest = siteProfileToManifest(profile, {
      blueprint,
      ...(parsed.data.priceUsdc === undefined ? {} : { priceUsdc: parsed.data.priceUsdc }),
    });

    // `knowledge` is the full page text; it already travels inside the
    // manifest's system prompt, so the summary copy keeps only its size.
    const { knowledge, ...profileSummary } = profile;

    return NextResponse.json({
      profile: { ...profileSummary, knowledgeChars: knowledge.length },
      blueprint: BLUEPRINT_META[blueprint],
      // The full pricing decision, so the review screen can show the owner
      // what a call costs and why the price is what it is. `priceUsdc` is
      // the final launch price after clamping any requested override to the
      // cost floor — "free" is not available for an agent that spends real
      // model time per call.
      pricing: {
        ...pricing,
        priceUsdc: resolveSiteAgentPriceUsdc(parsed.data.priceUsdc, pricing),
      },
      manifest,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("site-agent request failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
