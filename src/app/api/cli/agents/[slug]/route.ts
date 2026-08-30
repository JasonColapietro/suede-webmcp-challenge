/**
 * /api/cli/agents/[slug]
 *
 * GET — pull an agent manifest by slug (owner-scoped)
 *
 * Auth: Authorization: Bearer <workspaceKey>
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getRepo } from "@/lib/db/repo";
import { handleCliAgentPull } from "@/lib/cli/agent-slug-handler";
import { API_OPERATION_V1_UNSUPPORTED } from "@/lib/flow/api-operation-contract";

export const runtime = "nodejs";

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const h = await headers();
    const ownerId = extractBearer(h.get("Authorization")) ?? h.get("x-owner-id");
    if (!ownerId) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }

    const repo = await getRepo();
    const result = await handleCliAgentPull(slug, ownerId, repo);
    if (!result) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null &&
        Reflect.get(error, "code") === API_OPERATION_V1_UNSUPPORTED) {
      return NextResponse.json({ error: API_OPERATION_V1_UNSUPPORTED }, { status: 409 });
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("cli agents route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
