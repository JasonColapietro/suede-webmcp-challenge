/**
 * POST /api/webmcp/buy — one paid agent call, authorized by the browser session.
 *
 * NEW AUTHORITY, STATED PLAINLY. Before this route, spending workspace credit
 * required possession of the workspace key as a bearer secret. After it, a
 * same-origin cookie session is sufficient — scoped to spending the caller's
 * OWN workspace credit and nothing else. That is a real widening and it is
 * deliberate: it is what lets an agent operating inside a signed-in visitor's
 * browser complete a purchase without a key ever being minted.
 *
 * It is needed because neither existing charge path is reachable from page JS:
 *   - POST /api/agents/[agent]/run answers a priced non-dryRun call with 402
 *     and an x402 challenge the page cannot sign.
 *   - POST /api/mcp needs a bare-UUID Bearer that the httpOnly agx_owner
 *     cookie exists specifically to hide from scripts.
 *
 * ADR 0003's "common run path" means the AP2/x402 authorization surface bound
 * to the canonical run URL, not every path that can execute a published agent.
 * The shared execution path is the MCP credit rail, which this route reuses
 * exactly as /api/mcp has since it shipped. No gate is reimplemented here.
 *
 * This route is absent from ALLOWED_API_PATH_PREFIXES in
 * src/lib/google-play-access-only.ts, so it stays unreachable from the Play
 * host by that module's deny-by-default rule.
 */
import { z } from "zod";
import { privateJson, validateMutationHeaders } from "@/lib/runtime/api-contract";
import { resolveOwnerId } from "@/lib/auth";
import { buildCatalog } from "@/lib/catalog";
import { createMcpDeps } from "@/lib/mcp/service";
import { toolNameForSlug } from "@/lib/mcp/tools";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { guardBuyRequest } from "@/lib/webmcp/buy-guard";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

const buyBodySchema = z.object({
  slug: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()).default({}),
  confirmedPriceUsdc: z.number().finite().min(0),
}).strict();

/**
 * Tighter than the shared agent-run bucket. A browser-reachable spend endpoint
 * gets less burst than a keyed machine caller.
 */
const BUY_LIMIT = { capacity: 5, refillPerSec: 0.2 } as const;

export async function POST(req: Request): Promise<Response> {
  // Cheap, allocation-free rejections first, before any owner or catalog read.
  const headerFailure = validateMutationHeaders(req);
  if (headerFailure !== null) {
    return privateJson(
      { error: headerFailure === 403 ? "forbidden" : "unsupported media type" },
      headerFailure,
    );
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return privateJson({ error: "request body too large" }, 413);
  }

  let ownerId: string;
  try {
    ownerId = await resolveOwnerId();
  } catch {
    return privateJson({ error: "authentication required" }, 401);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return privateJson({ error: "invalid request" }, 400);
  }

  const parsed = buyBodySchema.safeParse(raw);
  if (!parsed.success) {
    return privateJson({ error: "invalid request" }, 400);
  }

  try {
    // Freshly read server-side price and buyability. The client's cached copy
    // is never trusted for either.
    const entry = (await buildCatalog()).find((row) => row.slug === parsed.data.slug);
    if (!entry) {
      return privateJson({ error: "not found" }, 404);
    }

    const limit = checkRateLimit(`webmcp-buy:${ownerId}:${ipFromRequest(req)}`, BUY_LIMIT);
    const verdict = guardBuyRequest({
      request: req,
      listedPriceUsdc: entry.priceUsdc,
      confirmedPriceUsdc: parsed.data.confirmedPriceUsdc,
      buyable: entry.acceptsPayment && entry.publishedLive,
      rateLimitAllowed: limit.allowed,
      retryAfterSec: limit.retryAfterSec,
    });
    if (!verdict.ok) {
      return privateJson(
        { error: verdict.error },
        verdict.status,
        verdict.retryAfterSec === undefined
          ? {}
          : { "Retry-After": String(verdict.retryAfterSec) },
      );
    }

    // resolveOwnerId may return `sb:<userId>` for an ecosystem session. That is
    // correct here and must NOT be routed through bearerWorkspaceKey(), which
    // rejects the sb: namespace by design.
    const deps = await createMcpDeps();
    const result = await deps.callTool({
      name: toolNameForSlug(entry.slug),
      arguments: parsed.data.input,
      workspaceKey: ownerId,
    });

    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();

    return privateJson(
      { ok: result.isError !== true, slug: entry.slug, result: text },
      result.isError === true ? 422 : 200,
    );
  } catch (error: unknown) {
    // Opaque on the money path, matching /api/agents/[agent]/run and /api/mcp.
    console.error("webmcp buy route failed", error);
    return privateJson({ error: "internal error" }, 500);
  }
}
