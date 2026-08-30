/**
 * /api/cli/agents/[slug]/relay
 *
 * POST { url: string } — register a relay endpoint; returns { secret } ONCE
 * GET                  — returns { url, linked: true } but NEVER the secret
 *
 * Auth: Authorization: Bearer <workspaceKey>
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { getRepo } from "@/lib/db/repo";
import { handleRelayPost, handleRelayGet } from "@/lib/cli/relay-handler";

export const runtime = "nodejs";

const PostBodySchema = z.object({
  url: z.string().url("url must be a valid URL"),
  protocolVersion: z.union([z.literal(1), z.literal(2)]).optional(),
});

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const h = await headers();
    const ownerId = extractBearer(h.get("Authorization")) ?? h.get("x-owner-id");
    if (!ownerId) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }

    const raw: unknown = await request.json().catch(() => null);
    const parsed = PostBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.message },
        { status: 400 },
      );
    }

    const repo = await getRepo();
    const result = await handleRelayPost(
      slug,
      ownerId,
      parsed.data.url,
      repo,
      parsed.data.protocolVersion ?? 1,
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: result.status });
    }

    return NextResponse.json({
      secret: result.secret,
      url: result.url,
      protocolVersion: result.protocolVersion,
    }, { status: 201 });
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("cli agents relay route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const h = await headers();
    const ownerId = extractBearer(h.get("Authorization")) ?? h.get("x-owner-id");
    if (!ownerId) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }

    const repo = await getRepo();
    const result = await handleRelayGet(slug, ownerId, repo);
    if (!result) {
      return NextResponse.json({ linked: false }, { status: 200 });
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("cli agents relay route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
