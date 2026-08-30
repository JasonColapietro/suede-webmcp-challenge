import { checkBotId } from "botid/server";
import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { checkRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";
import {
  ModerationQueueQuerySchema,
  ModerationReportSubmissionSchema,
} from "@/lib/moderation/report-contract";
import { createModerationReport } from "@/lib/moderation/report-service";
import { resolveModerationReviewer } from "@/lib/moderation/reviewer";
import { validateModerationMutation } from "@/lib/moderation/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;

export async function POST(request: Request): Promise<NextResponse> {
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

    const verification = await checkBotId();
    if (verification.isBot) {
      return NextResponse.json(
        { error: "automated_request_blocked" },
        { status: 403, headers: PRIVATE_HEADERS },
      );
    }

    const reporterOwnerId = await resolveOwnerId();
    const limit = checkRateLimit(`moderation-report:${reporterOwnerId}`, {
      capacity: 6,
      refillPerSec: 0.1,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded.", retryAfterSec: limit.retryAfterSec },
        {
          status: 429,
          headers: { ...PRIVATE_HEADERS, "Retry-After": String(limit.retryAfterSec) },
        },
      );
    }

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const parsed = ModerationReportSubmissionSchema.safeParse(body.data);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }

    const result = await createModerationReport(await getRepo(), reporterOwnerId, parsed.data);
    if (result.status === "not-found") {
      return NextResponse.json({ error: "not found" }, { status: 404, headers: PRIVATE_HEADERS });
    }
    if (result.status === "unavailable") {
      return NextResponse.json(
        { error: "moderation unavailable" },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }
    return NextResponse.json(
      { id: result.report.id, status: result.report.status },
      { status: 201, headers: PRIVATE_HEADERS },
    );
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: PRIVATE_HEADERS });
    }
    console.error("moderation report submission failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: PRIVATE_HEADERS });
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const reviewer = await resolveModerationReviewer();
    if (!reviewer) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: PRIVATE_HEADERS });
    }
    const url = new URL(request.url);
    const rawQuery = Object.fromEntries(url.searchParams.entries());
    const query = ModerationQueueQuerySchema.safeParse(rawQuery);
    if (!query.success) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const repo = await getRepo();
    if (!repo.listModerationReports) {
      return NextResponse.json(
        { error: "moderation unavailable" },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }
    const reports = await repo.listModerationReports(query.data);
    return NextResponse.json({ reports }, { headers: PRIVATE_HEADERS });
  } catch (error: unknown) {
    console.error("moderation queue read failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: PRIVATE_HEADERS });
  }
}
