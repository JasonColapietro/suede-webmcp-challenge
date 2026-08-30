/**
 * POST /api/agents/[agent]/settlement
 *
 * Flip the per-agent settlement_live boolean.
 * Auth: verified same-origin Suede session/cookie via resolveOwnerId(), or
 * Authorization: Bearer <anonymous workspaceKey> for programmatic callers.
 * Body: { live: boolean }
 *
 * ACTUAL BEHAVIOR (since 2026-07-20): new agents are created with an
 * explicit settlement_live=false, so a fresh launch cannot settle real
 * money until the owner opts in here with POST { live: true }. The DB
 * column default stays TRUE and NULL still reads as LIVE - that protects
 * pre-existing rows from the Phase 9 free-to-call regression (see
 * supabase-repo.ts toAgent). Flip an agent either way:
 *   POST { live: true|false } with the workspace Bearer key
 * Or directly in Supabase:
 *   UPDATE agents SET settlement_live = false WHERE slug = '<slug>';
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { getRepo } from "@/lib/db/repo";
import { handleSettlementToggle } from "@/lib/cli/settlement-handler";
import {
  resolveOwnerId,
  SUEDE_OWNER_PREFIX,
  UnauthenticatedOwnerError,
} from "@/lib/auth";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";

export const runtime = "nodejs";

const SettlementBodySchema = z.object({
  live: z.boolean(),
});

interface RouteContext {
  params: Promise<{ agent: string }>;
}

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

/**
 * Cookie-authenticated browser mutations must prove that they came from the
 * exact route origin. Programmatic Bearer callers intentionally do not send
 * browser Origin / Fetch Metadata headers, so this contract applies only to
 * the session-cookie lane.
 */
function validateSessionMutation(req: Request): 403 | 415 | null {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(req.url).origin;
  } catch {
    return 403;
  }
  if (req.headers.get("origin") !== expectedOrigin) return 403;
  if (req.headers.get("sec-fetch-site") !== "same-origin") return 403;
  if (req.headers.has("content-encoding")) return 415;
  const contentType = req.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return contentType === "application/json" ? null : 415;
}

export async function POST(req: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const h = await headers();
    const authorization = h.get("Authorization");
    const bearerOwner = extractBearer(authorization);
    if (authorization !== null && bearerOwner === null) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }
    // Signed-in `sb:` owners are only valid when derived from a verified
    // Suede session. Their public user ids must never work as bearer tokens.
    if (bearerOwner?.startsWith(SUEDE_OWNER_PREFIX)) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }
    if (bearerOwner === null) {
      const requestFailure = validateSessionMutation(req);
      if (requestFailure === 403) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (requestFailure === 415) {
        return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
      }
    }
    const ownerId = bearerOwner ?? await resolveOwnerId();

    const raw = await readBoundedJsonRequest(req);
    if (!raw.ok) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = SettlementBodySchema.safeParse(raw.data);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Body must be { live: boolean }" },
        { status: 400 },
      );
    }

    const { agent: agentParam } = await params;
    const repo = await getRepo();

    const result = await handleSettlementToggle(agentParam, ownerId, { live: parsed.data.live }, repo);

    if ("kind" in result) {
      if (result.kind === "not_found") {
        return NextResponse.json({ error: "agent not found" }, { status: 404 });
      }
      if (result.kind === "not_owner") {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      if (result.kind === "approval_required") {
        return NextResponse.json({ error: "approval_required" }, { status: 409 });
      }
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }

    return NextResponse.json({
      agentId: result.agentId,
      slug: result.slug,
      settlementLive: result.settlementLive,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("settlement toggle failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
