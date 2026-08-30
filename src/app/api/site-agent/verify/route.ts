/**
 * Domain-ownership verification for site-drafted agents.
 *
 * GET  ?host=<host>  → the workspace's verification token for that host,
 *                      where to put it, and whether the host is verified.
 * POST { host }      → fetch https://<host>/.well-known/suede-agent.txt via
 *                      the SSRF-safe fetcher, check it contains the token,
 *                      and record the proof. Until the proof exists, agents
 *                      drafted from that host stay out of the public
 *                      catalog (see lib/catalog.ts).
 *
 * Same auth posture as /api/site-agent: Bearer workspace key or a
 * same-origin cookie session; POST additionally sits behind BotID and a
 * tight per-owner budget because it makes an outbound request on demand.
 */
import { NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { z } from "zod";
import {
  resolveOwnerId,
  SUEDE_OWNER_PREFIX,
  UnauthenticatedOwnerError,
} from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { checkRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";
import { extractBearer, validateSessionMutation } from "@/lib/site/session-auth";
import {
  checkSiteVerificationFile,
  normalizeVerificationHost,
  SITE_VERIFICATION_PATH,
  siteVerificationToken,
} from "@/lib/site/verification";

export const runtime = "nodejs";

const VERIFY_METHOD = "file";

const RequestSchema = z.object({ host: z.string().min(1).max(255) }).strict();

function resolveHost(raw: string): string | null {
  const host = normalizeVerificationHost(raw);
  return host !== "" && host.includes(".") ? host : null;
}

async function resolveCaller(request: Request, mutation: boolean): Promise<
  { owner: string } | { failure: NextResponse }
> {
  const authorization = request.headers.get("authorization");
  const bearerOwner = extractBearer(authorization);
  if (authorization !== null && bearerOwner === null) {
    return { failure: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  }
  if (bearerOwner?.startsWith(SUEDE_OWNER_PREFIX)) {
    return { failure: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  }
  if (bearerOwner === null && mutation) {
    const requestFailure = validateSessionMutation(request);
    if (requestFailure === 403) {
      return { failure: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    if (requestFailure === 415) {
      return { failure: NextResponse.json({ error: "Unsupported media type" }, { status: 415 }) };
    }
  }
  return { owner: bearerOwner ?? await resolveOwnerId() };
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const caller = await resolveCaller(request, false);
    if ("failure" in caller) return caller.failure;

    const host = resolveHost(new URL(request.url).searchParams.get("host") ?? "");
    if (host === null) {
      return NextResponse.json({ error: "host is required" }, { status: 400 });
    }

    const repo = await getRepo();
    const verification = await repo.getSiteVerification?.(caller.owner, host).catch(() => null);
    return NextResponse.json({
      host,
      token: siteVerificationToken(caller.owner, host),
      path: SITE_VERIFICATION_PATH,
      url: `https://${host}${SITE_VERIFICATION_PATH}`,
      verified: verification != null,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("site verification status failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const caller = await resolveCaller(request, true);
    if ("failure" in caller) return caller.failure;

    const verification = await checkBotId();
    if (verification.isBot) {
      return NextResponse.json({ error: "automated_request_blocked" }, { status: 403 });
    }

    // 5/min per owner: each attempt is one outbound fetch to the claimed host.
    const rl = checkRateLimit(`site-verify:${caller.owner}`, { capacity: 5, refillPerSec: 5 / 60 });
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
    const host = resolveHost(parsed.data.host);
    if (host === null) {
      return NextResponse.json({ error: "That is not a domain Suede can check." }, { status: 400 });
    }

    const repo = await getRepo();
    if (!repo.upsertSiteVerification) {
      return NextResponse.json(
        { error: "Verification storage is not provisioned yet. Your agent stays reachable at its own link." },
        { status: 503 },
      );
    }

    const token = siteVerificationToken(caller.owner, host);
    const check = await checkSiteVerificationFile(host, token);
    if (!check.ok) {
      return NextResponse.json({ verified: false, reason: check.reason }, { status: 409 });
    }

    try {
      await repo.upsertSiteVerification({ ownerId: caller.owner, host, method: VERIFY_METHOD });
    } catch {
      // The file check passed but the proof can't be stored (table missing in
      // prod until the gated migration lands). Say so honestly — claiming
      // success here would list nothing and confuse everyone.
      return NextResponse.json(
        { error: "Verification storage is not provisioned yet. Your agent stays reachable at its own link." },
        { status: 503 },
      );
    }

    return NextResponse.json({ verified: true, host });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("site verification failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
