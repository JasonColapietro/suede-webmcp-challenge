/**
 * Read-only "Fetch a URL" node. A first-party, GET-only companion to the
 * generic `http` node: it needs no hand-configured method, headers, or body,
 * and it post-processes the response into extraction-ready output — bounded
 * plain text stripped from HTML, parsed JSON, or a single price number — that
 * an LLM step can consume directly.
 *
 * It builds NO second network path. The request is delegated to http.ts's
 * SSRF-hardened executor (scheme/IP validation before the initial request and
 * before every redirect, response-size cap, redirect cap, timeout); this node
 * only forces method GET, hands the resolved URL to createHttpExecutor(), and
 * reshapes the { status, body } result.
 *
 * Because it can reach an arbitrary caller-controlled URL, its canonical
 * descriptor (cost: variable) makes it cost-bearing, so the engine's central
 * dry-run gate substitutes `fetchUrlDryRunStub` while ctx.dryRun is true and
 * no request — not even a GET — leaves the server during a dry run.
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, interpolate } from "../_util";
import { createHttpExecutor, type HttpNodeResult } from "../http";

export const EXTRACT_MODES = ["text", "json", "raw"] as const;
export type ExtractMode = (typeof EXTRACT_MODES)[number];

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 200_000;
export const MAX_PRICE_PATTERN_CHARS = 120;
/**
 * Hard ceiling on the pattern actually compiled after {{...}} interpolation.
 * The raw param is bounded to MAX_PRICE_PATTERN_CHARS by the schema; this
 * guards against a token expanding into a longer, potentially pathological
 * pattern at run time. The pattern only ever runs against text already bounded
 * by `maxChars`, so a bounded pattern over bounded input is the practical
 * catastrophic-backtracking guard here (JS offers no regex-execution timeout).
 */
const MAX_COMPILED_PRICE_PATTERN_CHARS = 200;

export const fetchUrlParamsSchema = z.object({
  // Not z.string().url(): the raw value may still hold {{...}} tokens before
  // interpolation (e.g. "{{in.url}}"). The resolved URL's scheme and address
  // are validated by http.ts's SSRF-hardened executor, exactly like the http
  // node, which also stores its url as a plain min(1) string for this reason.
  url: z.string().min(1, "url is required"),
  extract: z.enum(EXTRACT_MODES).default("text"),
  pricePattern: z.string().max(MAX_PRICE_PATTERN_CHARS).optional(),
  maxChars: z.number().int().min(1).max(MAX_MAX_CHARS).optional(),
});

export type FetchUrlParams = z.infer<typeof fetchUrlParamsSchema>;

export interface FetchUrlResult {
  status: number;
  url: string;
  contentType: string | null;
  text?: string;
  json?: unknown;
  price?: number | null;
}

const DRY_RUN_NOTE =
  "Web fetch skipped during dry-run; no real request was made.";

/** A minimal, bounded set of HTML entities worth decoding for readable text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 512).trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    /<(body|head|div|p|span|a|table|ul|ol|li|h[1-6]|title|meta)[\s/>]/.test(head)
  );
}

function inferContentType(body: unknown): string | null {
  if (body !== null && typeof body === "object") return "application/json";
  if (typeof body !== "string" || body.length === 0) return null;
  return looksLikeHtml(body) ? "text/html" : "text/plain";
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    const named = NAMED_ENTITIES[key];
    if (named !== undefined) return named;
    if (key.startsWith("#x")) return safeFromCodePoint(Number.parseInt(key.slice(2), 16)) || match;
    if (key.startsWith("#")) return safeFromCodePoint(Number.parseInt(key.slice(1), 10)) || match;
    return match;
  });
}

/**
 * Strip HTML down to bounded, readable plain text. Every regex is linear
 * (no nested quantifiers over overlapping classes) and runs against a body
 * already capped at http.ts's MAX_RESPONSE_BYTES, so this stays fast.
 */
function htmlToText(html: string, maxChars: number): string {
  const withoutBlocks = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/**
 * Run the caller's regex over the extracted text and return the first numeric
 * match. The pattern's first capture group is treated as the number; with no
 * group, the whole match is used. Non-numeric characters (currency symbols,
 * thousands separators) are stripped before parsing. Returns null on an empty,
 * over-long, invalid, or non-numeric pattern/match.
 */
function extractPrice(pattern: string, text: string): number | null {
  if (pattern.length === 0 || pattern.length > MAX_COMPILED_PRICE_PATTERN_CHARS) return null;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return null;
  }
  const match = regex.exec(text);
  if (!match) return null;
  const captured = match[1] ?? match[0];
  const numeric = captured.replace(/[^0-9.]/g, "");
  if (numeric === "" || (numeric.match(/\./g)?.length ?? 0) > 1) return null;
  const value = Number.parseFloat(numeric);
  return Number.isFinite(value) ? value : null;
}

export function createFetchUrlExecutor(
  httpExecutor: NodeExecutor = createHttpExecutor(),
): NodeExecutor {
  return async (ctx, rawParams, inputs) => {
    let params: FetchUrlParams;
    try {
      params = fetchUrlParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    const url = interpolate(params.url, inputs);
    const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

    // Pre-resolve the URL and hand it to the SSRF-hardened executor with no
    // inputs, so it never re-interpolates and its errors (blocked address,
    // timeout, size cap, invalid URL) propagate verbatim.
    const httpResult = await httpExecutor(ctx, { method: "GET", url }, {}, undefined);
    if (!httpResult.ok) return httpResult;

    const { status, body } = httpResult.outputs.result as HttpNodeResult;
    const contentType = inferContentType(body);
    const rawText = typeof body === "string" ? body : safeStringify(body);

    const result: FetchUrlResult = { status, url, contentType };
    if (params.extract === "json") {
      result.json = body;
    } else if (params.extract === "raw") {
      result.text = rawText.slice(0, maxChars);
    } else {
      result.text =
        contentType === "text/html" ? htmlToText(rawText, maxChars) : rawText.slice(0, maxChars);
    }

    if (params.pricePattern !== undefined) {
      const priceText = result.text ?? rawText.slice(0, maxChars);
      result.price = extractPrice(interpolate(params.pricePattern, inputs), priceText);
    }

    return { ok: true, outputs: { result }, costUsdc: 0 };
  };
}

/**
 * Dry-run stub. Returns a clearly-marked placeholder in the same
 * { status, url, contentType, text?/json?, price? } envelope as the real
 * executor so a downstream node still typechecks and runs, without any request
 * leaving the server. It cannot know what the real target would have returned.
 */
export const fetchUrlDryRunStub: NodeExecutor = async (_ctx, rawParams) => {
  let params: FetchUrlParams;
  try {
    params = fetchUrlParamsSchema.parse(rawParams ?? {});
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
  const result: FetchUrlResult = { status: 200, url: params.url, contentType: null };
  if (params.extract === "json") result.json = { dryRun: true, note: DRY_RUN_NOTE };
  else result.text = DRY_RUN_NOTE;
  if (params.pricePattern !== undefined) result.price = null;
  return { ok: true, outputs: { result }, costUsdc: 0 };
};

export const fetchUrlNode = defineExecutableNode(getNodeDefinition("web.fetchUrl"), {
  paramsSchema: fetchUrlParamsSchema,
  executor: createFetchUrlExecutor(),
  dryRunStub: fetchUrlDryRunStub,
});
