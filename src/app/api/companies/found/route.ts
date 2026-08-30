/**
 * POST /api/companies/found — the description-first founding path. Mirrors
 * the checkBotId + rate-limit + body-validation shape of
 * src/app/api/guided/route.ts at company scope: checkBotId → resolveOwnerId
 * (401 pass-through — the funnel decision: sign-up precedes drafting) →
 * per-owner rate limit → body validation → runCompanyGuidedTurn.
 *
 * A turn either asks a clarifying question, or returns a company draft. A
 * draft is returned for on-screen review. Materialization is a separate
 * request carrying that exact reviewed draft; the server validates it with
 * CompanyDraftZod and never re-runs the non-deterministic guided brain.
 *
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 15, and docs/superpowers/plans/2026-07-17-autonomous-company-prd.md.
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
import { CompanyDraftZod, runCompanyGuidedTurn } from "@/lib/company/guided";
import { materializeCompanyDraft } from "@/lib/company/founding";
import { ConversationTurnSchema } from "@/lib/guided/draft";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";

export const runtime = "nodejs";

const BoundedConversationTurnSchema = ConversationTurnSchema.extend({
  content: z.string().min(1).max(4_000),
}).strict();

const DraftTurnRequestSchema = z
  .object({
    message: z.string().min(1).max(4_000),
    history: z.array(BoundedConversationTurnSchema).max(32),
    materialize: z.literal(false).optional(),
  })
  .strict();

const MaterializeRequestSchema = z
  .object({
    materialize: z.literal(true),
    company: CompanyDraftZod,
    notIncluded: z.array(z.string().max(500)).max(32).default([]),
  })
  .strict();

const RequestSchema = z.union([MaterializeRequestSchema, DraftTurnRequestSchema]);

function validateSessionMutation(request: Request): 403 | 415 | null {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return 403;
  }
  if (request.headers.get("origin") !== expectedOrigin) return 403;
  if (request.headers.get("sec-fetch-site") !== "same-origin") return 403;
  if (request.headers.has("content-encoding")) return 415;
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return contentType === "application/json" ? null : 415;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const requestFailure = validateSessionMutation(request);
    if (requestFailure === 403) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (requestFailure === 415) {
      return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
    }

    const verification = await checkBotId();
    if (verification.isBot) {
      return NextResponse.json({ error: "automated_request_blocked" }, { status: 403 });
    }

    // Sign-up precedes drafting: the description-first funnel requires an
    // identity before the guided brain runs at all.
    const owner = await resolveOwnerId();
    if (!owner.startsWith(SUEDE_OWNER_PREFIX)) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // Rate-limit: 6/min per owner key, same shape as /api/guided.
    const rl = checkRateLimit(`founding:${owner}`, { capacity: 6, refillPerSec: 0.1 });
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

    if (parsed.data.materialize === true) {
      const repo = await getRepo();
      const { companyId } = await materializeCompanyDraft(owner, parsed.data.company, repo);
      return NextResponse.json(
        { companyId, notIncluded: parsed.data.notIncluded },
        { status: 201 },
      );
    }

    // Billing context for the real brain. Without it founding answers from
    // its deterministic interview — a working path, not an error — so an
    // unpaid workspace still founds a company without spending the model key.
    const turn = await runCompanyGuidedTurn(parsed.data.message, parsed.data.history, {
      ownerId: owner,
      repo: await getRepo(),
      ip: ipFromRequest(request),
    });

    if (turn.clarifyingQuestion !== null) {
      return NextResponse.json({
        clarifyingQuestion: turn.clarifyingQuestion,
        notIncluded: turn.notIncluded,
      });
    }

    const { company, notIncluded } = turn;
    if (!company) {
      // CompanyGuidedResponseSchema's refine guarantees exactly one of
      // clarifyingQuestion/company is non-null — unreachable in practice.
      // Fail loudly rather than silently return an empty body.
      throw new Error("guided turn returned neither a clarifying question nor a company draft");
    }

    return NextResponse.json({ company, notIncluded });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Never surface raw error.message on the founding path — log
    // server-side, return an opaque error to the client (mirrors
    // src/app/api/companies/[id]/fire/route.ts).
    console.error("company founding failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
