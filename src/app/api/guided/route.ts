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
import { runGuidedTurn, ConversationTurnSchema } from "@/lib/guided/draft";
import { AgentManifestSchema } from "@/lib/manifest/schema";
import { getGuidedFlowData, saveGuidedFlowManifest } from "@/lib/guided/flow";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";

export const runtime = "nodejs";

const TurnRequestSchema = z
  .object({
    message: z.string().min(1),
    history: z.array(ConversationTurnSchema),
    flowId: z.string().min(1).optional(),
    expectedUpdatedAt: z.number().int().nonnegative().safe().optional(),
    currentManifest: AgentManifestSchema.optional(),
  })
  .strict()
  .refine((value) => value.currentManifest === undefined || value.flowId !== undefined, {
    message: "currentManifest requires flowId",
  })
  .refine((value) => value.flowId === undefined || value.expectedUpdatedAt !== undefined, {
    message: "expectedUpdatedAt is required with flowId",
  })
  .refine((value) => value.expectedUpdatedAt === undefined || value.flowId !== undefined, {
    message: "expectedUpdatedAt requires flowId",
  });

const SaveRequestSchema = z
  .object({
    action: z.literal("save"),
    flowId: z.string().min(1),
    expectedUpdatedAt: z.number().int().nonnegative().safe(),
    manifest: AgentManifestSchema,
  })
  .strict();

const RequestSchema = z.union([SaveRequestSchema, TurnRequestSchema]);

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

/**
 * Cookie-authenticated Guided mutations must prove exact same-origin JSON.
 * Programmatic callers use the anonymous workspace key as a Bearer token.
 */
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

    // Rate-limit: 6/min per owner key.
    // refillPerSec=0.1 → 6 tokens/min; capacity=6 burst.
    const rl = checkRateLimit(`guided:${owner}`, { capacity: 6, refillPerSec: 0.1 });
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

    if ("action" in parsed.data) {
      const result = await saveGuidedFlowManifest(
        parsed.data.flowId,
        owner,
        parsed.data.expectedUpdatedAt,
        parsed.data.manifest,
      );
      if (result.status === "not-found") {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      if (result.status === "conflict") {
        return NextResponse.json({ error: "guided save conflict" }, { status: 409 });
      }
      return NextResponse.json({ flow: result.flow });
    }

    let currentManifest = parsed.data.currentManifest;
    if (parsed.data.flowId !== undefined) {
      const flow = await getGuidedFlowData(parsed.data.flowId, owner);
      if (flow === null) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      if (flow.updatedAt !== parsed.data.expectedUpdatedAt) {
        return NextResponse.json({ error: "guided save conflict" }, { status: 409 });
      }
      currentManifest ??= flow.manifest;
    }

    // Billing context for the real brain. Without it Guided answers from its
    // deterministic interview — a working path, not an error — so an unpaid
    // workspace still builds an agent without spending the funded model key.
    const response = await runGuidedTurn(
      parsed.data.message,
      parsed.data.history,
      currentManifest,
      { ownerId: owner, repo: await getRepo(), ip: ipFromRequest(request) },
    );

    return NextResponse.json(response);
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("guided request failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
