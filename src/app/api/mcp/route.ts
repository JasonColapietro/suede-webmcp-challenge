/**
 * The MCP endpoint — currently eligible published agents as MCP tools.
 *
 * POST /api/mcp. Speaks protocol revision 2026-07-28: no `initialize`
 * handshake, no sessions, no GET stream. Paid tools bill the pre-funded
 * workspace credit of the bearer key on the request.
 *
 * All logic lives in src/lib/mcp/*; this route is transport plumbing.
 */
import { NextResponse } from "next/server";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { jsonRpcError, JSONRPC_PARSE_ERROR, JSONRPC_INTERNAL_ERROR } from "@/lib/mcp/protocol";
import { handleMcpHttpRequest } from "@/lib/mcp/server";
import { createMcpDeps } from "@/lib/mcp/service";

export const runtime = "nodejs";

/** Matches the agent-run bucket: 10 burst, 0.5 req/s refill. */
function rateLimited(req: Request): NextResponse | null {
  const limit = checkRateLimit(`mcp:${ipFromRequest(req)}`);
  if (limit.allowed) return null;
  return NextResponse.json(
    jsonRpcError(null, JSONRPC_INTERNAL_ERROR, `Too many requests. Retry after ${limit.retryAfterSec}s.`),
    { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  const limited = rateLimited(req);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      jsonRpcError(null, JSONRPC_PARSE_ERROR, "Request body is not valid JSON."),
      { status: 400 },
    );
  }

  try {
    const result = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: req.headers,
      body,
      deps: await createMcpDeps(),
    });
    if (result.body === null) {
      return new NextResponse(null, { status: result.status });
    }
    return NextResponse.json(result.body, { status: result.status });
  } catch (error: unknown) {
    // Opaque on the money path, matching /api/agents/[agent]/run.
    console.error("mcp route failed", error);
    return NextResponse.json(
      jsonRpcError(null, JSONRPC_INTERNAL_ERROR, "Internal error."),
      { status: 500 },
    );
  }
}

/** This revision removed the GET stream and DELETE session teardown. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    jsonRpcError(null, JSONRPC_INTERNAL_ERROR, "This MCP endpoint accepts POST only."),
    { status: 405 },
  );
}

export const DELETE = GET;
