/**
 * SSRF-safe URL validation and fetch.
 *
 * Any server-side fetch driven by a user-supplied URL — the self-hosted
 * agent relay (forwardToRelay in ../relay.ts, https-only) and the generic
 * HTTP flow node (../flow/nodes/http.ts, http+https) — must not be able to
 * reach the cloud metadata endpoint, localhost, or an internal/RFC1918
 * address. `new URL(x).hostname` is not enough — the hostname string can be
 * innocuous while the DNS answer is not (DNS rebinding), so this module
 * resolves the hostname and validates the ACTUAL address that will be
 * connected to.
 *
 * This is the single canonical SSRF guard for the app. Callers differ only
 * in which schemes they allow (`allowedProtocols`) — the IP-range and
 * hostname-literal blocklists are shared and must never diverge between
 * them, or a gap closed in one caller silently reopens in the other.
 *
 * Server-only. No browser bundle.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Injectable DNS resolver, mainly for tests that don't want to touch real DNS. */
export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PinnedTarget {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PinnedTransport {
  readonly dispatcher: Dispatcher;
  close(): Promise<void>;
}

export type PinnedDispatcherFactory = (target: PinnedTarget) => PinnedTransport;

export async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true });
}

export interface SafeUrlOptions {
  /** Allowed URL schemes. Defaults to ["https:"]. Pass ["http:", "https:"] for callers that must permit plain HTTP (e.g. the generic HTTP node). */
  allowedProtocols?: string[];
  /** Max redirects `safeFetch` will follow. Defaults to 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms, applied per hop. Defaults to 15000. */
  timeoutMs?: number;
  /** Injectable DNS resolver for tests. Defaults to a real `dns.lookup`. */
  lookupFn?: DnsLookup;
  /** Injectable pinned transport factory. Production uses an Undici Agent with a one-address lookup. */
  dispatcherFactory?: PinnedDispatcherFactory;
}

const DEFAULT_PROTOCOLS = ["https:"];
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

export function createPinnedDispatcher(target: PinnedTarget): PinnedTransport {
  const dispatcher = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options.all) {
          callback(null, [{ address: target.address, family: target.family }]);
          return;
        }
        callback(null, target.address, target.family);
      },
    },
  });
  return {
    dispatcher,
    close: async () => {
      await dispatcher.close();
    },
  };
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);
const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];

// ── IPv4 ─────────────────────────────────────────────────────────────────

interface V4Range {
  base: number;
  mask: number;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function cidr4(cidr: string): V4Range {
  const [base, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) throw new Error(`Invalid CIDR literal: ${cidr}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: baseInt & mask, mask };
}

// 127.0.0.0/8 loopback; 10/8, 172.16/12, 192.168/16 RFC1918 private; 169.254/16
// link-local (this also serves the 169.254.169.254 cloud instance-metadata
// endpoint on AWS/GCP/Azure); 0.0.0.0/8 "this network"; 100.64.0.0/10 CGNAT /
// shared address space (RFC 6598) — not internet-routable, so treated the
// same as the other reserved ranges.
const BLOCKED_V4_RANGES: V4Range[] = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "100.64.0.0/10",
].map(cidr4);

export function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return BLOCKED_V4_RANGES.some((r) => (n & r.mask) === r.base);
}

// ── IPv6 ─────────────────────────────────────────────────────────────────

/** Parse a valid IPv6 literal into 8 16-bit words, honoring "::" compression. */
function ipv6ToWords(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  const doubleColonIndex = ip.indexOf("::");
  let headParts: string[];
  let tailParts: string[];
  if (doubleColonIndex !== -1) {
    const head = ip.slice(0, doubleColonIndex);
    const tail = ip.slice(doubleColonIndex + 2);
    headParts = head.length ? head.split(":") : [];
    tailParts = tail.length ? tail.split(":") : [];
  } else {
    headParts = ip.split(":");
    tailParts = [];
  }
  // An embedded IPv4 tail (e.g. "::ffff:127.0.0.1") shows up as the last
  // "part" containing dots; expand it into two 16-bit words.
  const expand = (parts: string[]): number[] | null => {
    const out: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const v4 = ipv4ToInt(part);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        const w = parseInt(part, 16);
        if (Number.isNaN(w)) return null;
        out.push(w);
      }
    }
    return out;
  };
  const head = expand(headParts);
  const tail = expand(tailParts);
  if (head === null || tail === null) return null;
  const missing = 8 - (head.length + tail.length);
  if (doubleColonIndex === -1) {
    return head.length === 8 ? head : null;
  }
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

/**
 * True if the IPv6 address is loopback, unspecified, link-local, or
 * unique-local, including both textual (`::ffff:a.b.c.d`) and WHATWG
 * hex-normalized (`::ffff:7f00:1`) IPv4-mapped forms. Fails closed: if the
 * platform itself says this is a valid IPv6 literal but we can't parse it
 * into words, treat it as blocked rather than risk letting it through.
 */
export function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Textual dotted-decimal form, e.g. "::ffff:127.0.0.1".
  const dottedMapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMapped) return isBlockedIPv4(dottedMapped[1]);

  const words = ipv6ToWords(lower);
  if (!words) return true; // fail closed on unparsable IPv6

  // Hex-normalized IPv4-mapped form, e.g. WHATWG URL parsing turns
  // "::ffff:127.0.0.1" into "::ffff:7f00:1" as `url.hostname`.
  const isMapped =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff;
  if (isMapped) {
    const a = (words[6] >> 8) & 0xff;
    const b = words[6] & 0xff;
    const c = (words[7] >> 8) & 0xff;
    const d = words[7] & 0xff;
    return isBlockedIPv4(`${a}.${b}.${c}.${d}`);
  }

  const isZero = words.every((w) => w === 0);
  if (isZero) return true; // "::" (unspecified)
  const isLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
  if (isLoopback) return true; // ::1
  if (words[0] >= 0xfe80 && words[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (words[0] >= 0xfc00 && words[0] <= 0xfdff) return true; // fc00::/7 unique-local
  return false;
}

/** True if `ip` (either family) is an internal/reserved address that must never be fetched server-side. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not a recognizable literal IP — fail closed
}

// ── Hostname literals ────────────────────────────────────────────────────

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Validate that `rawUrl` is safe to fetch server-side right now: allowed
 * scheme, not a blocked hostname literal, and resolves (via a fresh DNS
 * lookup) to a public, non-internal address. Throws `UnsafeUrlError`
 * otherwise. Returns the parsed URL on success.
 *
 * Call this both when a URL is first registered/stored AND again
 * immediately before every network hop (see `safeFetch`) — a hostname that
 * resolved safely at registration time can be repointed at an internal
 * address later ("DNS rebinding"), so registration-time validation alone
 * is not sufficient.
 */
export interface SafeUrlResolution {
  readonly url: URL;
  readonly target: PinnedTarget;
}

export async function resolveSafeUrl(
  rawUrl: string,
  options: SafeUrlOptions = {},
): Promise<SafeUrlResolution> {
  const allowedProtocols = options.allowedProtocols ?? DEFAULT_PROTOCOLS;
  const lookupFn = options.lookupFn ?? defaultLookup;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new UnsafeUrlError(
      `URL scheme "${url.protocol}" is not allowed; only ${allowedProtocols.join(", ")}`,
    );
  }

  // Strip brackets from an IPv6 literal host, e.g. "[::1]" -> "::1".
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isBlockedHostname(hostname)) {
    throw new UnsafeUrlError(`Requests to "${hostname}" are blocked`);
  }

  // A literal IP in the URL: validate it directly, no DNS involved.
  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new UnsafeUrlError(`Requests to blocked address "${hostname}" are not allowed`);
    }
    const family = isIP(hostname);
    if (family !== 4 && family !== 6) throw new UnsafeUrlError("Invalid IP address");
    return { url, target: { hostname, address: hostname, family } };
  }

  // Resolve the hostname now and validate EVERY returned address — a
  // hostname can round-robin between a public and an internal address.
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookupFn(hostname);
  } catch {
    throw new UnsafeUrlError(`Could not resolve hostname "${hostname}"`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Hostname "${hostname}" did not resolve to any address`);
  }
  let target: PinnedTarget | null = null;
  for (const { address } of addresses) {
    const family = isIP(address);
    if ((family !== 4 && family !== 6) || isBlockedIp(address)) {
      throw new UnsafeUrlError(`"${hostname}" resolves to a blocked address (${address})`);
    }
    target ??= { hostname, address, family };
  }
  if (!target) throw new UnsafeUrlError(`Hostname "${hostname}" did not resolve to any address`);
  return { url, target };
}

export async function assertSafeUrl(rawUrl: string, options: SafeUrlOptions = {}): Promise<URL> {
  return (await resolveSafeUrl(rawUrl, options)).url;
}

async function closeTransport(transport: PinnedTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Closing an already-failed socket is best effort and must not mask the request result.
  }
}

function withResponseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function responseWithTransport(
  response: Response,
  transport: PinnedTransport,
  url: string,
): Response {
  if (!response.body) {
    void closeTransport(transport);
    return withResponseUrl(response, url);
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeTransport(transport);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          await close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });
  return withResponseUrl(
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    url,
  );
}

/**
 * SSRF-safe fetch. Re-validates the URL (fresh DNS lookup) immediately
 * before every connection attempt, including each redirect hop, and caps
 * the number of redirects followed. `redirect: "manual"` is forced so a
 * 3xx response never lets undici/node follow a redirect without going
 * through validation first.
 *
 * The request URL remains unchanged for HTTP Host and TLS SNI, while an
 * Undici dispatcher replaces socket DNS with the exact address validated for
 * this hop. Redirects repeat validation and receive a fresh one-hop pin.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeUrlOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dispatcherFactory = options.dispatcherFactory ?? createPinnedDispatcher;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resolution = await resolveSafeUrl(currentUrl, options);
    const transport = dispatcherFactory(resolution.target);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...init,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        dispatcher: transport.dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });
    } catch (error) {
      await closeTransport(transport);
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        await response.body?.cancel().catch(() => undefined);
        await closeTransport(transport);
        throw new UnsafeUrlError("Redirect response missing a Location header");
      }
      if (hop === maxRedirects) {
        await response.body?.cancel().catch(() => undefined);
        await closeTransport(transport);
        throw new UnsafeUrlError(`Too many redirects (max ${maxRedirects})`);
      }
      await response.body?.cancel().catch(() => undefined);
      await closeTransport(transport);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    const terminalUrl = new URL(resolution.url);
    terminalUrl.hash = "";
    return responseWithTransport(response, transport, terminalUrl.toString());
  }

  throw new UnsafeUrlError(`Too many redirects (max ${maxRedirects})`);
}
