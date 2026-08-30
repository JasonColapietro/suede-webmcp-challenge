import { NextResponse } from "next/server";
import { isSafeCaptureRuntime } from "@/lib/verification/capture-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const supplied = request.headers.get("x-suede-capture-session");
  if (
    !isSafeCaptureRuntime() ||
    supplied === null ||
    supplied !== process.env.PHASE0_CAPTURE_SESSION
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ safe: true });
}
