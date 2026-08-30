/**
 * Webhook trigger authentication — secret generation + HMAC sign/verify for
 * inbound third-party events (GitHub, Stripe, Slack, ...) hitting
 * POST /api/agents/[agent]/webhook.
 *
 * This is deliberately a different trust direction than src/lib/relay.ts:
 * relay.ts signs OUTBOUND calls Suede makes to a creator's own server (Suede
 * holds the secret and calls out). Here an external, un-trusted third party
 * calls INTO Suede and must prove it holds a secret Suede handed the agent's
 * owner once at launch — a public URL that runs a paid flow on an
 * unauthenticated POST is a free-compute faucet (the exact bug class this
 * codebase already fixed for the dryRun flag on /api/agents/[agent]/run).
 *
 * ── Secret storage: why "hashed at rest" and a working HMAC coexist ────────
 * A textbook one-way password hash (bcrypt/scrypt) is fundamentally
 * incompatible with HMAC verification: HMAC requires the verifier to hold
 * the *exact* key used to sign, and a true one-way hash cannot be reversed
 * to recover the original signing key server-side. Reconciling "stored
 * hashed" with "can still verify" therefore means one of two designs:
 *   (a) reversible encryption (AES-GCM under a separate KMS/env master key)
 *       so the plaintext can be decrypted at verify time, or
 *   (b) never persist a "more secret" upstream value at all — derive the
 *       credential itself via a one-way hash of fresh CSPRNG output, and
 *       store (and use as the HMAC key) that hash directly.
 * This module implements (b): generateWebhookSecret() feeds
 * crypto.randomBytes(32) through SHA-256 and returns the digest. That
 * digest — not the raw CSPRNG bytes — is the one and only credential: it is
 * shown to the owner once, stored in webhook_endpoints.secret_hash, and
 * used directly as the HMAC-SHA256 key. The raw randomBytes output is
 * never persisted or transmitted anywhere. This is not weaker than storing
 * raw randomBytes hex as the secret (both are 256 bits of CSPRNG-derived
 * entropy with no dictionary/rainbow-table exposure — the concern one-way
 * hashing normally defends against for low-entropy human passwords does
 * not apply here), and it means a bug that ever logs "the secret" logs a
 * value that is provably a hash output, never raw generator bytes. True
 * reversible-encryption storage (option a) would let the same value be
 * regenerated in front of the owner again later, at the cost of a
 * KMS/master-key dependency this codebase does not otherwise have; that is
 * a reasonable follow-up but out of scope here.
 */
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying the HMAC-SHA256 signature, format `sha256=<hex>`. */
export const WEBHOOK_SIGNATURE_HEADER = "x-suede-webhook-signature";

/** Header carrying the signing timestamp (Unix ms, as a decimal string). */
export const WEBHOOK_TIMESTAMP_HEADER = "x-suede-webhook-timestamp";

/** Requests signed more than this far from "now" (either direction) are rejected as stale/replayed. */
export const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/** Fixed-shape dummy secret used to keep the auth-failure code path uniform
 *  when no real agent/secret exists, so response timing doesn't leak
 *  whether an agent id/slug is registered. Never a real credential. */
export const WEBHOOK_DUMMY_SECRET = "0".repeat(64);

/**
 * Generate a new webhook secret: crypto.randomBytes(32) fed through SHA-256.
 * The returned hex digest IS the credential — the caller must store it as
 * `secret_hash` and show it to the owner exactly once (it cannot be
 * recovered later; a relaunch that finds an existing endpoint row leaves it
 * untouched rather than silently rotating it out from under any already
 * configured third-party sender).
 */
export function generateWebhookSecret(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

/**
 * The exact string an inbound caller must HMAC-SHA256 with the shared
 * secret: the timestamp header value, a literal ".", then the raw request
 * body bytes (as received, before any JSON parsing) — binding the
 * timestamp into the signature itself so a captured (body, signature) pair
 * cannot be replayed with a forged/refreshed timestamp without also
 * forging a new signature.
 */
export function webhookSignatureBase(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Compute the `sha256=<hex>` signature for a (timestamp, rawBody) pair under `secret`. */
export function signWebhookRequest(timestamp: string, rawBody: string, secret: string): string {
  const base = webhookSignatureBase(timestamp, rawBody);
  return `sha256=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

/**
 * Constant-time verify of a `sha256=<hex>` signature. Returns false (never
 * throws) on any malformed input, length mismatch, or wrong secret.
 */
export function verifyWebhookSignature(
  timestamp: string,
  rawBody: string,
  secret: string,
  signature: string,
): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = signWebhookRequest(timestamp, rawBody, secret);
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(signature, "utf-8");
  if (expectedBuf.length !== providedBuf.length) {
    // Constant-time-safe rejection: still run a timingSafeEqual of matching
    // length so a length mismatch doesn't take a measurably different path.
    try {
      timingSafeEqual(expectedBuf, expectedBuf);
    } catch {
      // ignore
    }
    return false;
  }
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Whether `timestamp` (Unix ms, decimal string) is within `maxSkewMs` of
 * `nowMs` in either direction. Rejects non-numeric/missing timestamps.
 * This is the replay defense: a captured, validly-signed request can only
 * be replayed inside this window, not indefinitely.
 */
export function isTimestampFresh(
  timestamp: string,
  nowMs: number = Date.now(),
  maxSkewMs: number = WEBHOOK_MAX_SKEW_MS,
): boolean {
  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) return false;
  return Math.abs(nowMs - tsMs) <= maxSkewMs;
}
