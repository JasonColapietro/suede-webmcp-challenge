/**
 * POST /api/grade — free agent grading for the Agentix iOS app's core action.
 *
 * No auth, no payment, no provider key in the client. Returns a wire-valid
 * GradeResult (HTTP 200) for valid input: a server LLM key produces a real
 * model-graded read; without one (or on any LLM error) it falls back to a
 * deterministic on-server grade. This is the server half of the App Store 2.1
 * fix — the reviewer's core action can never dead-end on a 402/401/5xx.
 */
import { NextResponse } from "next/server";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { createLlmFromEnv, type LlmClient } from "@/lib/llm";
import {
  GradeRequestSchema,
  GradeInputError,
  normalizeGradeInput,
  resolveGrade,
} from "@/lib/grade";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  // Rate-limit before any work. Default bucket: 10 burst, 0.5 req/s refill.
  const ip = ipFromRequest(req);
  const rl = checkRateLimit(`grade:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: `Too many requests. Retry after ${rl.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = GradeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.issues },
      { status: 400 },
    );
  }

  let input: string;
  try {
    input = normalizeGradeInput(parsed.data.input);
  } catch (e) {
    if (e instanceof GradeInputError) {
      return NextResponse.json({ error: "invalid input", kind: e.kind }, { status: 400 });
    }
    throw e;
  }

  // The LLM is best-effort enrichment. Construct it defensively so a missing key
  // or misconfigured provider degrades to the deterministic grade, not a 5xx.
  let llm: LlmClient | null = null;
  try {
    llm = createLlmFromEnv();
  } catch {
    llm = null;
  }

  const { result } = await resolveGrade(input, llm);
  return NextResponse.json(result, { status: 200 });
}
