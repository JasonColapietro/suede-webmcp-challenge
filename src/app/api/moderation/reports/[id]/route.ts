import { NextResponse } from "next/server";
import { getRepo } from "@/lib/db/repo";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";
import { ModerationReportReviewSchema } from "@/lib/moderation/report-contract";
import { resolveModerationReviewer } from "@/lib/moderation/reviewer";
import { validateModerationMutation } from "@/lib/moderation/request";

export const runtime = "nodejs";
const PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const boundaryFailure = validateModerationMutation(request);
    if (boundaryFailure === 403) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: PRIVATE_HEADERS });
    }
    if (boundaryFailure === 415) {
      return NextResponse.json(
        { error: "Unsupported media type" },
        { status: 415, headers: PRIVATE_HEADERS },
      );
    }
    const reviewer = await resolveModerationReviewer();
    if (!reviewer) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: PRIVATE_HEADERS });
    }
    const { id } = await params;
    if (id.length < 1 || id.length > 256) {
      return NextResponse.json({ error: "not found" }, { status: 404, headers: PRIVATE_HEADERS });
    }
    const body = await readBoundedJsonRequest(request);
    const parsed = body.ok ? ModerationReportReviewSchema.safeParse(body.data) : null;
    if (!parsed?.success) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const repo = await getRepo();
    if (!repo.updateModerationReport) {
      return NextResponse.json(
        { error: "moderation unavailable" },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }
    const report = await repo.updateModerationReport(id, {
      status: parsed.data.status,
      reviewerNotes: parsed.data.reviewerNotes,
      reviewedBy: reviewer,
    });
    if (!report) {
      return NextResponse.json({ error: "not found" }, { status: 404, headers: PRIVATE_HEADERS });
    }
    return NextResponse.json({ report }, { headers: PRIVATE_HEADERS });
  } catch (error: unknown) {
    console.error("moderation queue update failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: PRIVATE_HEADERS });
  }
}
