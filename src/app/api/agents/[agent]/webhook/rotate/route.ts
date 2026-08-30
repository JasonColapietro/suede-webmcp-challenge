/**
 * POST /api/agents/[agent]/webhook/rotate — owner-only webhook secret
 * rotation. [agent] is an id or slug, same convention as every other
 * /api/agents/[agent]/* route (see src/lib/agents.ts resolveAgent).
 *
 * This is the recourse a launched agent's owner has if a webhook secret
 * leaks: without it, the only option was rebuilding/relaunching the flow.
 * See src/lib/webhook-rotate-handler.ts for the testable business logic
 * (ownership check, existence check, atomic secret replacement) and
 * src/lib/webhook-auth.ts for why the returned hex digest IS the one-time
 * credential.
 *
 * Auth: resolveOwnerId() (the `x-owner-id` header / `agx_owner` cookie the
 * middleware sets — see src/lib/auth.ts), the same identity every
 * /api/flows/[id]/* route uses. A missing identity throws
 * UnauthenticatedOwnerError, mapped to 401 exactly like those routes. A
 * present-but-wrong owner gets the same 404 a nonexistent agent id/slug
 * gets (see handleWebhookRotate's `not_found` discriminant) so this
 * endpoint never confirms whether an agent id/slug belongs to someone else.
 */
import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { WEBHOOK_MUTATION_RATE_LIMIT, handleWebhookRotate } from "@/lib/webhook-rotate-handler";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ agent: string }>;
}

export async function POST(req: Request, { params }: RouteContext): Promise<NextResponse> {
  const { agent: agentParam } = await params;

  const ip = ipFromRequest(req);
  const ipLimit = checkRateLimit(`webhook-rotate-ip:${ip}`, WEBHOOK_MUTATION_RATE_LIMIT);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSec) } },
    );
  }

  try {
    const owner = await resolveOwnerId();

    const agentLimit = checkRateLimit(`webhook-rotate:${owner}:${agentParam}`, WEBHOOK_MUTATION_RATE_LIMIT);
    if (!agentLimit.allowed) {
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(agentLimit.retryAfterSec) } },
      );
    }

    const repo = await getRepo();
    const result = await handleWebhookRotate(agentParam, owner, repo);

    if ("kind" in result) {
      if (result.kind === "no_webhook") {
        return NextResponse.json(
          { error: "this agent has no webhook trigger configured" },
          { status: 400 },
        );
      }
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    return NextResponse.json({
      agentId: result.agentId,
      slug: result.slug,
      secret: result.secret,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("agents webhook rotate route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
