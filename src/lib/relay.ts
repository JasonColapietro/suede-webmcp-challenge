/**
 * Relay — HMAC sign/verify + HTTP forwarding for self-hosted agents.
 *
 * Self-hosted agents run on the creator's own infrastructure. The Suede platform
 * forwards x402-gated calls to the relay URL and records the run, so the agent
 * still earns through Suede's paid endpoint without needing to run on Suede's servers.
 *
 * Server-only. No browser bundle.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { safeFetch, UnsafeUrlError } from "@/lib/net/safe-url";

const MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB
const RELAY_TIMEOUT_MS = 15_000;

// ── Error type ──────────────────────────────────────────────────────────────

export class RelayError extends Error {
  public readonly status: number;

  constructor(message: string, status: number = 502) {
    super(message);
    this.name = "RelayError";
    this.status = status;
  }
}

// ── HMAC sign / verify ──────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 of `body` using `secret`.
 * Returns a string of the form `sha256=<64-char-hex>`.
 */
export function signRelayRequest(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Constant-time verify: check that the given `sig` (format `sha256=<hex>`)
 * matches `signRelayRequest(body, secret)`.
 * Returns false on any length mismatch or malformed input (no timing leak).
 */
export function verifyRelayRequest(body: string, secret: string, sig: string): boolean {
  if (!sig.startsWith("sha256=")) return false;
  const expected = signRelayRequest(body, secret);
  const expectedBuf = Buffer.from(expected, "utf-8");
  // Pad/trim the provided sig to the same byte length to allow timingSafeEqual.
  const providedHex = sig.slice(7); // strip "sha256="
  const expectedHex = expected.slice(7);
  if (providedHex.length !== expectedHex.length) {
    // Different lengths — constant-time padding: compare against expected twice
    // (always false, but doesn't branch on the input).
    const dummyBuf = Buffer.from(expected, "utf-8");
    try {
      timingSafeEqual(expectedBuf, dummyBuf);
    } catch {
      // ignore
    }
    return false;
  }
  const providedBuf = Buffer.from(`sha256=${providedHex}`, "utf-8");
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

// ── Secret generation ───────────────────────────────────────────────────────

/** Generate a cryptographically secure 32-byte random hex secret. */
export function generateRelaySecret(): string {
  return randomBytes(32).toString("hex");
}

// ── Forward to relay ────────────────────────────────────────────────────────

export interface RelayEndpoint {
  url: string;
  secret: string;
}

/**
 * POST `input` to the relay URL, signed with HMAC-SHA256.
 * - SSRF guard: the URL (and its DNS-resolved address) is re-validated
 *   immediately before this fetch via safeFetch — registration-time
 *   validation alone isn't enough because DNS can change after a relay is
 *   registered (rebinding), pointing a previously-safe URL at localhost,
 *   an RFC1918 address, or the cloud metadata endpoint.
 * - 15s timeout
 * - Non-200 → RelayError(502)
 * - Response body > 256 KB → RelayError(502)
 * - Network error / timeout / blocked URL → RelayError(502)
 * Returns the parsed JSON response body on success.
 */
export async function forwardToRelay(
  input: unknown,
  relay: RelayEndpoint,
  runId: string,
  slug: string,
): Promise<unknown> {
  const rawBody = JSON.stringify({ input, agent: slug, runId });
  const sig = signRelayRequest(rawBody, relay.secret);
  const timestamp = new Date().toISOString();

  let response: Response;
  try {
    response = await safeFetch(
      relay.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-suede-signature": sig,
          "x-suede-timestamp": timestamp,
        },
        body: rawBody,
      },
      { timeoutMs: RELAY_TIMEOUT_MS },
    );
  } catch (err: unknown) {
    if (err instanceof UnsafeUrlError) {
      throw new RelayError(`Relay request blocked: ${err.message}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RelayError(`Relay request failed: ${message}`);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RelayError(`Relay returned HTTP ${response.status}`);
  }

  // Read body with size guard
  const text = await response.text();
  if (Buffer.byteLength(text, "utf-8") > MAX_RESPONSE_BYTES) {
    throw new RelayError("Relay response exceeds 256 KB limit");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RelayError("Relay response is not valid JSON");
  }
}
