import { NextResponse } from "next/server";
import { buildCatalog } from "@/lib/catalog";
import { privateJson } from "@/lib/projects/api-response";
import { projectMobileResourcePackCatalog } from "@/lib/resources/mobile-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compact released Resource Pack feed for native clients. This route is
 * read-only: purchase metadata hands the caller to the existing external
 * WebMCP-capable agent-browser flow and never spends or creates checkout state.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const catalog = projectMobileResourcePackCatalog(await buildCatalog());
    return NextResponse.json(catalog, {
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch (error: unknown) {
    console.error("mobile Resource Pack catalog failed", error);
    return privateJson({ error: "internal error" }, 500);
  }
}
