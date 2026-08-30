/**
 * Public machine-readable catalog of live agents.
 * GET /api/catalog — JSON feed for crawlers, agent frameworks, and directories.
 */
import { NextResponse } from "next/server";
import {
  buildCatalog,
  type CatalogBuildTiming,
} from "@/lib/catalog";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    const timings: CatalogBuildTiming[] = [];
    const entries = await buildCatalog({
      onTiming: (timing) => timings.push(timing),
    });
    const serverTiming = timings
      .map(({ name, durationMs }) => `${name};dur=${durationMs.toFixed(1)}`)
      .join(", ");
    return NextResponse.json(
      {
        service: "Suede Agent Studio",
        description:
          "Published agent flows with current payment availability and preview readiness reported per agent.",
        site: SITE_URL,
        count: entries.length,
        agents: entries.map((e) => ({
          ...e,
          urls: Object.fromEntries(
            Object.entries(e.urls).map(([k, v]) => [k, `${SITE_URL}${v}`]),
          ),
        })),
      },
      {
        headers: {
          "cache-control": "public, max-age=60",
          "server-timing": serverTiming,
          "x-catalog-profile": serverTiming,
        },
      },
    );
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("catalog route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
