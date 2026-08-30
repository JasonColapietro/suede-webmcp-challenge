/**
 * Generic HTTP request node. This is the single node type that lets a flow
 * call any REST API (Slack, Stripe, a CRM, a customer webhook, ...) instead
 * of being limited to hardcoded Suede endpoints. It is a free node (like
 * input/branch) - the flow author pays for whatever the target API charges,
 * not Suede.
 *
 * Because this fetches a URL the flow author (or an upstream node's output)
 * controls, it is the app's primary SSRF surface. See ../../net/safe-url.ts
 * for the scheme/IP-range validation applied before the initial request AND
 * before following any redirect. Unlike the relay (https-only), this node
 * must permit plain http as well, so it passes an explicit allowlist rather
 * than relying on the module's https-only default.
 */
import { z } from "zod";
import {
  defineExecutableNode,
  readProvenanceSecret,
  type NodeExecutionProvenance,
  type NodeExecutor,
} from "../executor";
import { getNodeDefinition } from "../node-definitions";
import { errMessage, interpolate } from "./_util";
import {
  createPinnedDispatcher,
  resolveSafeUrl,
  UnsafeUrlError,
  type DnsLookup,
  defaultLookup,
  type PinnedDispatcherFactory,
  type PinnedTransport,
} from "../../net/safe-url";
import type { Dispatcher } from "undici";

const ALLOWED_SCHEMES = ["http:", "https:"];
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HEADER_CONTROL = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_CONNECTION_HEADERS = new Set([
  "__proto__", "connection", "constructor", "cookie", "host", "keep-alive",
  "prototype", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const CONNECTION_HEADER_ERROR = "Connection headers unavailable";
const CONNECTION_COLLISION_ERROR = "Connection headers conflict with static headers";
const AUTHENTICATED_REDIRECT_ERROR = "Authenticated redirect refused";
const AUTHENTICATED_RESPONSE_ERROR = "Authenticated response unavailable";
const INVALID_REQUEST_URL_ERROR = "Invalid request URL";
const INVALID_REDIRECT_ERROR = "Invalid redirect location";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_REDIRECTS = 5;

export const httpParamsSchema = z.object({
  method: z.enum(HTTP_METHODS).default("GET"),
  url: z.string().min(1, "url is required"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type HttpParams = z.infer<typeof httpParamsSchema>;

export interface HttpNodeResult {
  status: number;
  body: unknown;
}

function connectionHeaders(
  provenance: NodeExecutionProvenance | undefined,
): Readonly<Record<string, string>> | null {
  const value = readProvenanceSecret(provenance, "headers");
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(CONNECTION_HEADER_ERROR);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(CONNECTION_HEADER_ERROR);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(CONNECTION_HEADER_ERROR);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length < 1 || names.length > 16) throw new Error(CONNECTION_HEADER_ERROR);
  const seen = new Set<string>();
  const result = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const descriptor = descriptors[name];
    const folded = name.toLowerCase();
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
        name.length < 1 || name.length > 64 || !HEADER_TOKEN.test(name) ||
        FORBIDDEN_CONNECTION_HEADERS.has(folded) || seen.has(folded) ||
        typeof descriptor.value !== "string" || descriptor.value.length === 0 ||
        Buffer.byteLength(descriptor.value, "utf8") > 8_192 || HEADER_CONTROL.test(descriptor.value)) {
      throw new Error(CONNECTION_HEADER_ERROR);
    }
    seen.add(folded);
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

function requestUrl(raw: string, redirect: boolean): URL {
  try {
    const parsed = new URL(raw);
    if (parsed.username !== "" || parsed.password !== "") throw new Error();
    return parsed;
  } catch {
    throw new Error(redirect ? INVALID_REDIRECT_ERROR : INVALID_REQUEST_URL_ERROR);
  }
}

function normalizedOrigin(url: URL): string {
  const effectivePort = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return `${url.protocol}//${url.hostname.toLowerCase()}:${effectivePort}`;
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

/** Read a response body, aborting once it exceeds the cap without buffering past it. */
async function readCappedBody(
  res: Response,
  capBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    const truncated = Buffer.byteLength(text, "utf-8") > capBytes;
    return { text: truncated ? "" : text, truncated };
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

function parseBody(text: string, contentType: string | null, requireValidJson = false): unknown {
  if (!isJsonContentType(contentType)) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (requireValidJson) throw new Error(AUTHENTICATED_RESPONSE_ERROR);
    return text;
  }
}

function addCredentialCanary(canaries: Set<string>, value: string): void {
  if (value.length === 0) return;
  canaries.add(value);
  const serialized = JSON.stringify(value);
  if (serialized.length >= 2) canaries.add(serialized.slice(1, -1));
}

function credentialCanaries(headers: Readonly<Record<string, string>>): readonly string[] {
  const canaries = new Set<string>();
  for (const value of Object.values(headers)) {
    addCredentialCanary(canaries, value);
    const bearer = /^Bearer[\t ]+(.+)$/iu.exec(value);
    if (bearer?.[1]) addCredentialCanary(canaries, bearer[1]);
    const basic = /^Basic[\t ]+([A-Za-z0-9+/]+={0,2})$/iu.exec(value);
    if (basic?.[1]) {
      addCredentialCanary(canaries, basic[1]);
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      addCredentialCanary(canaries, decoded);
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        addCredentialCanary(canaries, decoded.slice(0, separator));
        addCredentialCanary(canaries, decoded.slice(separator + 1));
      }
    }
  }
  return Object.freeze([...canaries]);
}

function credentialFreeString(value: string, canaries: readonly string[]): boolean {
  return canaries.every((canary) => !value.includes(canary));
}

/** Inspect parsed JSON without invoking getters or proxy-like prototypes. */
function credentialFreeValue(value: unknown, canaries: readonly string[]): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 64 || ++visited > 100_000) return false;
    if (typeof current.value === "string") {
      if (!credentialFreeString(current.value, canaries)) return false;
      continue;
    }
    if (current.value === null || typeof current.value === "boolean" || typeof current.value === "number") continue;
    if (typeof current.value !== "object" || seen.has(current.value)) return false;
    seen.add(current.value);
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(current.value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current.value) && key === "length") continue;
      if (!credentialFreeString(key, canaries) || !("value" in descriptor) || !descriptor.enumerable) return false;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return true;
}

function authenticatedResponseFailure() {
  return { ok: false as const, error: AUTHENTICATED_RESPONSE_ERROR, costUsdc: 0 };
}

export interface HttpExecutorOptions {
  /** Injectable for tests; defaults to the real global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to a real DNS lookup. */
  lookupFn?: DnsLookup;
  /** Injectable socket pinning seam; production uses one Undici Agent per validated hop. */
  dispatcherFactory?: PinnedDispatcherFactory;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

/**
 * Dry-run stub. This node makes no cost claim but IS classified as
 * side-effecting from its canonical effects because it can reach an arbitrary
 * third-party URL the flow author (or an upstream node's output) controls —
 * a POST/PUT/DELETE method fires a real effect at that third party. The
 * engine's central dry-run gate (engine.ts's executeNode) substitutes this
 * stub instead of ever invoking the real executor while ctx.dryRun is true,
 * so no request — not even a GET — leaves the server during a dry run.
 *
 * This cannot know what the real target would have returned (an arbitrary
 * third-party API, arbitrary shape); it only returns a clearly-marked
 * placeholder in the same { status, body } envelope as the real executor's
 * output, so a downstream node reading result.status / result.body still
 * typechecks and runs, but the body content itself does not and cannot
 * mimic any real response.
 */
export const httpDryRunStub: NodeExecutor = async (
  _ctx,
  rawParams,
  _inputs,
) => {
  let params: HttpParams;
  try {
    params = httpParamsSchema.parse(rawParams ?? {});
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
  const result: HttpNodeResult = {
    status: 200,
    body: {
      dryRun: true,
      note: "HTTP request skipped during dry-run; no real request was made.",
      method: params.method,
      url: params.url,
    },
  };
  return { ok: true, outputs: { result }, costUsdc: 0 };
};

export function createHttpExecutor(
  opts: HttpExecutorOptions = {},
): NodeExecutor {
  const fetchFn = opts.fetchFn ?? fetch;
  const lookupFn = opts.lookupFn ?? defaultLookup;
  const dispatcherFactory = opts.dispatcherFactory ?? createPinnedDispatcher;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const maxResponseBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  return async (_ctx, rawParams, inputs, provenance) => {
    let params: HttpParams;
    try {
      params = httpParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    const url = interpolate(params.url, inputs);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(params.headers ?? {})) {
      headers[key] = interpolate(value, inputs);
    }
    let protectedHeaders: Readonly<Record<string, string>> | null;
    try {
      protectedHeaders = connectionHeaders(provenance);
      if (protectedHeaders) {
        const staticNames = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
        for (const [name, value] of Object.entries(protectedHeaders)) {
          if (staticNames.has(name.toLowerCase())) {
            return { ok: false, error: CONNECTION_COLLISION_ERROR, costUsdc: 0 };
          }
          headers[name] = value;
        }
      }
    } catch {
      return { ok: false, error: CONNECTION_HEADER_ERROR, costUsdc: 0 };
    }
    const responseCanaries = protectedHeaders ? credentialCanaries(protectedHeaders) : null;
    const body =
      params.body !== undefined ? interpolate(params.body, inputs) : undefined;
    const timeoutMs = Math.min(
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    let initialUrl: URL;
    try {
      initialUrl = requestUrl(url, false);
    } catch {
      return { ok: false, error: INVALID_REQUEST_URL_ERROR, costUsdc: 0 };
    }
    const authenticatedOrigin = protectedHeaders ? normalizedOrigin(initialUrl) : null;
    let currentUrl = initialUrl.toString();
    let currentMethod: HttpMethod = params.method;
    let currentBody = body;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      let transport: PinnedTransport;
      try {
        const resolution = await resolveSafeUrl(currentUrl, {
          allowedProtocols: ALLOWED_SCHEMES,
          lookupFn,
        });
        transport = dispatcherFactory(resolution.target);
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          return { ok: false, error: e.message, costUsdc: 0 };
        }
        throw e;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetchFn(currentUrl, {
          method: currentMethod,
          headers,
          // The Fetch spec forbids a body on GET requests; DELETE may carry one.
          body: currentMethod === "GET" ? undefined : currentBody,
          redirect: "manual",
          signal: controller.signal,
          dispatcher: transport.dispatcher,
        } as RequestInit & { dispatcher: Dispatcher });
      } catch (e) {
        clearTimeout(timer);
        try {
          await transport.close();
        } catch {
          // Best effort after a failed request.
        }
        if (controller.signal.aborted) {
          return {
            ok: false,
            error: `Request timed out after ${timeoutMs}ms`,
            costUsdc: 0,
          };
        }
        return {
          ok: false,
          error: protectedHeaders ? "Authenticated request failed" : `Request failed: ${errMessage(e)}`,
          costUsdc: 0,
        };
      }
      clearTimeout(timer);

      try {
        const isRedirect = res.status >= 300 && res.status < 400;
        const location = res.headers.get("location");
        if (isRedirect && location) {
          if (responseCanaries && !credentialFreeString(location, responseCanaries)) {
            return authenticatedResponseFailure();
          }
          if (hop === maxRedirects) {
            await res.body?.cancel().catch(() => undefined);
            return {
              ok: false,
              error: `Too many redirects (max ${maxRedirects})`,
              costUsdc: 0,
            };
          }
          let nextUrl: URL;
          try {
            nextUrl = requestUrl(new URL(location, currentUrl).toString(), true);
          } catch {
            return { ok: false, error: INVALID_REDIRECT_ERROR, costUsdc: 0 };
          }
          if (authenticatedOrigin !== null && normalizedOrigin(nextUrl) !== authenticatedOrigin) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false, error: AUTHENTICATED_REDIRECT_ERROR, costUsdc: 0 };
          }
          await res.body?.cancel().catch(() => undefined);
          currentUrl = nextUrl.toString();
          // Redirects for non-GET/HEAD conventionally re-issue as GET for 303,
          // and preserve method for 307/308; keep it simple and safe by
          // preserving method/body except for 303 (See Other).
          if (res.status === 303) {
            currentMethod = "GET";
            currentBody = undefined;
          }
          continue;
        }

        const { text, truncated } = await readCappedBody(res, maxResponseBytes);
        if (truncated) {
          return {
            ok: false,
            error: `Response exceeded the ${maxResponseBytes}-byte size cap`,
            costUsdc: 0,
          };
        }

        const parsedBody = parseBody(text, res.headers.get("content-type"), responseCanaries !== null);
        if (responseCanaries &&
            (!credentialFreeString(text, responseCanaries) || !credentialFreeValue(parsedBody, responseCanaries))) {
          return authenticatedResponseFailure();
        }
        const result: HttpNodeResult = { status: res.status, body: parsedBody };
        return { ok: true, outputs: { result }, costUsdc: 0 };
      } catch (error) {
        if (protectedHeaders) return authenticatedResponseFailure();
        throw error;
      } finally {
        try {
          await transport.close();
        } catch {
          // Closing an already-consumed or failed socket is best effort.
        }
      }
    }

    return {
      ok: false,
      error: `Too many redirects (max ${maxRedirects})`,
      costUsdc: 0,
    };
  };
}

export const httpNode = defineExecutableNode(getNodeDefinition("http"), {
  // Free ($0 to Suede) but NOT free of side effects — see httpDryRunStub's
  // comment. The canonical variable-cost descriptor derives costBearing:
  // false and sideEffecting: true, which makes the engine gate dry runs.
  paramsSchema: httpParamsSchema,
  executor: createHttpExecutor(),
  dryRunStub: httpDryRunStub,
});
