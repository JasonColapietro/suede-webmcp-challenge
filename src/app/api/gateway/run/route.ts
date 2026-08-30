/**
 * POST /api/gateway/run
 *
 * Executes ONE platform node server-side via the registry/executors.
 * Auth: Authorization: Bearer <workspaceKey>
 * Body: { nodeType: string; config?: Record<string, unknown> }
 * Returns: { output: unknown; costUsdc: number }
 *
 * Paid-rail nodes (priceUsdc > 0 in NODE_META) require gateway credit.
 * Free-tier nodes are metered against the monthly gateway token allowance.
 * Returns 503 with { error: "billing not provisioned" } when the credits
 * table is absent (dark-deploy safe — no disruption to existing agents).
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getRepo } from "@/lib/db/repo";
import { ipFromRequest } from "@/lib/rate-limit";
import { GatewayRunBodySchema, handleGatewayRun } from "@/lib/gateway/run-handler";
import { isNodeTypeAvailable } from "@/lib/flow/node-definitions";
import { CONNECTOR_LAB_FLAG } from "@/lib/connectors/flags";

export const runtime = "nodejs";

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const h = await headers();
    const ownerId = extractBearer(h.get("Authorization")) ?? h.get("x-owner-id");
    if (!ownerId) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = GatewayRunBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.issues },
        { status: 400 },
      );
    }
    if (!isNodeTypeAvailable(parsed.data.nodeType, CONNECTOR_LAB_FLAG, "executable")) {
      return NextResponse.json({ error: "Unknown or unavailable node type" }, { status: 400 });
    }

    const repo = await getRepo();
    const result = await handleGatewayRun(ownerId, parsed.data, repo, Date.now(), ipFromRequest(req));

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      output: result.output,
      costUsdc: result.costUsdc,
    });
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("gateway run route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
