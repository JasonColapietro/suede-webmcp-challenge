/**
 * Body-size cap and content-type checks for POST /api/agents/[agent]/webhook.
 * Pulled out of the route file (which is thin per src/lib/webhook-handler.ts's
 * header comment) purely so vitest can exercise this logic directly with a
 * real, framework-free `Request` object — the repo's convention is not to
 * import route.ts files into vitest (see tests/api-run-dryrun.test.ts).
 *
 * Mirrors the capped-read pattern already used for outbound responses in
 * src/lib/flow/nodes/http.ts's readCappedBody, applied here to an inbound
 * request body instead.
 */

/** Generous for a JSON event payload (GitHub/Stripe/Slack events are typically a few KB). */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024; // 256 KB

/** True only for `application/json`, ignoring any `; charset=...` suffix. */
export function isJsonContentType(contentType: string | null): boolean {
  const bare = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return bare === "application/json";
}

/**
 * Content-Length-based fast reject, before any bytes are read. Best-effort
 * only — a caller can omit or lie about Content-Length, which is why
 * readCappedRequestBody enforces the same cap again while streaming.
 */
export function declaredLengthExceedsCap(contentLength: string | null, capBytes: number): boolean {
  const declared = Number(contentLength ?? "");
  return Number.isFinite(declared) && declared > capBytes;
}

/** Read a Request body, aborting once it exceeds the cap without buffering past it. */
export async function readCappedRequestBody(
  req: Request,
  capBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = req.body?.getReader();
  if (!reader) {
    const text = await req.text();
    return { text, truncated: Buffer.byteLength(text, "utf-8") > capBytes };
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > capBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort cancel
      }
      return { text: "", truncated: true };
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(""), truncated: false };
}
