/**
 * POST /api/gateway/llm
 *
 * Metered LLM proxy for external SDK agents.
 * Auth: Authorization: Bearer <workspaceKey>
 * Body: { system?: string; prompt: string; model?: string }
 * Returns: { text: string; tokens: number; costUsdc: number }
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getRepo } from "@/lib/db/repo";
import { ipFromRequest } from "@/lib/rate-limit";
import { GatewayLlmBodySchema, handleGatewayLlm } from "@/lib/gateway/llm-handler";

export const runtime = "nodejs";

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const h = await headers();
    // Gateway requires an explicit Bearer token — do NOT fall through to the
    // middleware-injected x-owner-id header, which is auto-minted for every
    // browser visitor and would grant unauthenticated gateway access.
    const ownerId = extractBearer(h.get("Authorization"));
    if (!ownerId) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = GatewayLlmBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.issues },
        { status: 400 },
      );
    }

    const repo = await getRepo();
    const result = await handleGatewayLlm(ownerId, parsed.data, repo, Date.now(), ipFromRequest(req));

    if (!result.ok) {
      const body: Record<string, unknown> = { error: result.error };
      if (result.status === 402 && result.topup) {
        body.topup = result.topup;
      }
      return NextResponse.json(body, { status: result.status });
    }

    return NextResponse.json({
      text: result.text,
      tokens: result.tokens,
      costUsdc: result.costUsdc,
    });
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("gateway llm route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
