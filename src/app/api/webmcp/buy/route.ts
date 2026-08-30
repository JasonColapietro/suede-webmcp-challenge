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
import { privateJson, readBoundedJson, validateMutationHeaders } from "@/lib/runtime/api-contract";
import { resolveOwnerId } from "@/lib/auth";
import { buildCatalog } from "@/lib/catalog";
import { createMcpDeps } from "@/lib/mcp/service";
import { toolNameForSlug } from "@/lib/mcp/tools";
import { ipFromRequest } from "@/lib/rate-limit";
import { checkBuyRateLimits, guardBuyRequest } from "@/lib/webmcp/buy-guard";
import { isWebMcpBuyable, webMcpBuyBodySchema } from "@/lib/webmcp/buy-contract";

export const runtime = "nodejs";

/** Reads `structuredContent` for the fields the buyer needs to keep. */
function receiptFrom(structured: unknown): { runId?: string; chargedUsdc?: number } {
  if (structured === null || typeof structured !== "object") return {};
  const row = structured as { runId?: unknown; chargedUsdc?: unknown };
  return {
    ...(typeof row.runId === "string" ? { runId: row.runId } : {}),
    ...(typeof row.chargedUsdc === "number" ? { chargedUsdc: row.chargedUsdc } : {}),
  };
}

export async function POST(req: Request): Promise<Response> {
  // Cheapest rejection first, before a body is read or an owner resolved.
  const headerFailure = validateMutationHeaders(req);
  if (headerFailure !== null) {
    return privateJson(
      { error: headerFailure === 403 ? "forbidden" : "unsupported media type" },
      headerFailure,
    );
  }

  /*
   * A real, streamed byte bound. The previous version read a caller-controlled
   * content-length, which an absent or lying header skipped entirely, and it
   * capped at 64 KB against the preview path's 256 KB — a 4x asymmetry that let
   * a document preview cleanly and then fail to buy. readBoundedJson counts
   * actual bytes at the same 256 KB ceiling, so both halves of the funnel now
   * accept the same payload.
   */
  const raw = await readBoundedJson(req);
  if (raw === null) {
    return privateJson({ error: "request body was invalid or too large" }, 413);
  }

  const parsed = webMcpBuyBodySchema.safeParse(raw);
  if (!parsed.success) {
    // Name the offending field: `.strict()` rejects an extra key and a
    // stringified number identically, and "invalid request" alone gave the
    // agent nothing to correct.
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    return privateJson(
      { error: path ? `invalid request at "${path}": ${issue?.message}` : "invalid request" },
      400,
    );
  }

  /*
   * Rate limit BEFORE resolveOwnerId() and buildCatalog(), because the work
   * being protected is downstream of both: callTool runs eligibleEntries(),
   * which issues two uncached queries per catalog entry.
   */
  const limited = checkBuyRateLimits(ipFromRequest(req), parsed.data.slug);
  if (limited !== null) {
    return privateJson(
      { error: limited.error, retryAfterSec: limited.retryAfterSec },
      limited.status,
      { "Retry-After": String(limited.retryAfterSec ?? 1) },
    );
  }

  let ownerId: string;
  try {
    ownerId = await resolveOwnerId();
  } catch {
    return privateJson({ error: "authentication required" }, 401);
  }

  try {
    // Freshly read server-side price and buyability. The client's cached copy
    // is never trusted for either.
    const entry = (await buildCatalog()).find((row) => row.slug === parsed.data.slug);
    if (!entry) {
      return privateJson({ error: "not found" }, 404);
    }

    const verdict = guardBuyRequest({
      request: req,
      listedPriceUsdc: entry.priceUsdc,
      confirmedPriceUsdc: parsed.data.confirmedPriceUsdc,
      buyable: isWebMcpBuyable(entry),
    });
    if (!verdict.ok) {
      return privateJson({ error: verdict.error }, verdict.status);
    }

    // resolveOwnerId may return `sb:<userId>` for an ecosystem session. That is
    // correct here and must NOT be routed through bearerWorkspaceKey(), which
    // rejects the sb: namespace by design.
    const deps = await createMcpDeps();
    const result = await deps.callTool({
      name: toolNameForSlug(entry.slug),
      arguments: parsed.data.input,
      workspaceKey: ownerId,
      // The echo above was checked against THIS request's catalog read; the
      // charge happens on a later one. This ceiling is what actually binds it.
      maxPriceUsdc: parsed.data.confirmedPriceUsdc,
    });

    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();

    /*
     * runId and chargedUsdc ride in structuredContent, and the first version
     * dropped it — so a buyer paid, received a response clamped to the tool
     * output budget, and had no id with which to retrieve the rest. They are
     * small and they are the receipt; they go first.
     */
    return privateJson(
      {
        ok: result.isError !== true,
        slug: entry.slug,
        ...receiptFrom(result.structuredContent),
        result: text,
      },
      result.isError === true ? 422 : 200,
    );
  } catch (error: unknown) {
    // Opaque on the money path, matching /api/agents/[agent]/run and /api/mcp.
    console.error("webmcp buy route failed", error);
    return privateJson({ error: "internal error" }, 500);
  }
}
