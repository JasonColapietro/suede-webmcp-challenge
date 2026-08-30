/**
 * POST /api/agents/[agent]/webhook — inbound trigger for third-party events
 * (GitHub, Stripe, Slack, ...). [agent] is an id or slug, same convention as
 * /api/agents/[agent]/run. See src/lib/webhook-auth.ts for the full auth
 * scheme and src/lib/webhook-handler.ts for the testable business logic;
 * this file only adapts Request/NextResponse and applies the streaming
 * body-size / content-type checks (src/lib/webhook-body.ts) that need the
 * raw Request before the handler ever sees a string body.
 *
 * DELETE on this same path is a different trust direction entirely: it is
 * the owner (not a third-party sender) revoking their own webhook endpoint —
 * see src/lib/webhook-rotate-handler.ts handleWebhookRevoke and the sibling
 * POST /api/agents/[agent]/webhook/rotate route for minting a fresh secret
 * instead of disabling inbound delivery outright.
 */
import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { handleInboundWebhook } from "@/lib/webhook-handler";
import { WEBHOOK_MUTATION_RATE_LIMIT, handleWebhookRevoke } from "@/lib/webhook-rotate-handler";
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from "@/lib/webhook-auth";
import {
  WEBHOOK_MAX_BODY_BYTES,
  declaredLengthExceedsCap,
  isJsonContentType,
  readCappedRequestBody,
} from "@/lib/webhook-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent: string }>;
}

export async function POST(req: Request, { params }: RouteContext): Promise<NextResponse> {
  const { agent: agentParam } = await params;

  // Two rate-limit buckets: one per source IP (blunt broad scanning) and
  // one per agent (a leaked secret still can't be hammered into unlimited
  // spend — this backstops the per-agent daily cost cap in run-service.ts,
  // which only trips after cost is actually incurred).
  const ip = ipFromRequest(req);
  const ipLimit = checkRateLimit(`webhook-ip:${ip}`, { capacity: 30, refillPerSec: 1 });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSec) } },
    );
  }
  const agentLimit = checkRateLimit(`webhook-agent:${agentParam}`, { capacity: 30, refillPerSec: 1 });
  if (!agentLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(agentLimit.retryAfterSec) } },
    );
  }

  // Fast-reject on a declared oversized body before reading any bytes.
  if (declaredLengthExceedsCap(req.headers.get("content-length"), WEBHOOK_MAX_BODY_BYTES)) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  if (!isJsonContentType(req.headers.get("content-type"))) {
    return NextResponse.json(
      { error: "unsupported content type, expected application/json" },
      { status: 415 },
    );
  }

  const { text: rawBody, truncated } = await readCappedRequestBody(req, WEBHOOK_MAX_BODY_BYTES);
  if (truncated) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  try {
    const result = await handleInboundWebhook({
      agentParam,
      signatureHeader: req.headers.get(WEBHOOK_SIGNATURE_HEADER),
      timestampHeader: req.headers.get(WEBHOOK_TIMESTAMP_HEADER),
      rawBody,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      runId: result.runId,
      status: result.status,
      totalCostUsdc: result.totalCostUsdc,
      outputs: result.outputs,
    });
  } catch (error: unknown) {
    // Never surface raw error.message on this path — see the identical
    // rationale in /api/agents/[agent]/run/route.ts.
    console.error("webhook run failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[agent]/webhook — owner-only revocation. Deletes the
 * webhook_endpoints row outright rather than minting a new secret, so a
 * compromised secret can be killed immediately even if the owner isn't
 * ready to reconfigure a third-party sender with a fresh one yet. Same
 * ownership/auth pattern as POST .../webhook/rotate.
 */
export async function DELETE(req: Request, { params }: RouteContext): Promise<NextResponse> {
  const { agent: agentParam } = await params;

  const ip = ipFromRequest(req);
  const ipLimit = checkRateLimit(`webhook-revoke-ip:${ip}`, WEBHOOK_MUTATION_RATE_LIMIT);
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSec) } },
    );
  }

  try {
    const owner = await resolveOwnerId();

    const agentLimit = checkRateLimit(`webhook-revoke:${owner}:${agentParam}`, WEBHOOK_MUTATION_RATE_LIMIT);
    if (!agentLimit.allowed) {
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(agentLimit.retryAfterSec) } },
      );
    }

    const repo = await getRepo();
    const result = await handleWebhookRevoke(agentParam, owner, repo);

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
      revoked: result.revoked,
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("agents webhook route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
