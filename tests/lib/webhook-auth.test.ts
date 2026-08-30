/**
 * Tests for src/lib/webhook-auth.ts: secret generation, HMAC sign/verify,
 * and timestamp-freshness (replay) checks backing POST
 * /api/agents/[agent]/webhook.
 */
import { describe, it, expect } from "vitest";
import {
  generateWebhookSecret,
  signWebhookRequest,
  verifyWebhookSignature,
  isTimestampFresh,
  webhookSignatureBase,
  WEBHOOK_MAX_SKEW_MS,
} from "@/lib/webhook-auth";

describe("generateWebhookSecret", () => {
  it("returns a 64-char lowercase hex digest", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different secret on every call", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});

describe("webhookSignatureBase", () => {
  it("joins timestamp and raw body with a single dot", () => {
    expect(webhookSignatureBase("12345", '{"a":1}')).toBe('12345.{"a":1}');
  });
});

describe("signWebhookRequest / verifyWebhookSignature", () => {
  const secret = "test-secret-32-bytes-padded-12345678";

  it("returns a sha256=<hex> prefixed signature", () => {
    const sig = signWebhookRequest("1000", "body", secret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("verifies a valid signature", () => {
    const body = JSON.stringify({ event: "push" });
    const timestamp = "1720000000000";
    const sig = signWebhookRequest(timestamp, body, secret);
    expect(verifyWebhookSignature(timestamp, body, secret, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = "1720000000000";
    const sig = signWebhookRequest(timestamp, "original", secret);
    expect(verifyWebhookSignature(timestamp, "tampered", secret, sig)).toBe(false);
  });

  it("rejects a tampered timestamp (timestamp is bound into the signature)", () => {
    const body = "body";
    const sig = signWebhookRequest("1000", body, secret);
    expect(verifyWebhookSignature("2000", body, secret, sig)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const timestamp = "1000";
    const sig = signWebhookRequest(timestamp, "body", secret);
    expect(verifyWebhookSignature(timestamp, "body", "wrong-secret", sig)).toBe(false);
  });

  it("rejects a malformed signature (no sha256= prefix)", () => {
    expect(verifyWebhookSignature("1000", "body", secret, "deadbeef")).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyWebhookSignature("1000", "body", secret, "")).toBe(false);
  });

  it("uses a constant-time compare that doesn't throw on a short signature", () => {
    expect(verifyWebhookSignature("1000", "body", secret, "sha256=short")).toBe(false);
  });
});

describe("isTimestampFresh", () => {
  const now = 1_720_000_000_000;

  it("accepts a timestamp exactly at now", () => {
    expect(isTimestampFresh(String(now), now)).toBe(true);
  });

  it("accepts a timestamp just inside the skew window", () => {
    expect(isTimestampFresh(String(now - (WEBHOOK_MAX_SKEW_MS - 1000)), now)).toBe(true);
    expect(isTimestampFresh(String(now + (WEBHOOK_MAX_SKEW_MS - 1000)), now)).toBe(true);
  });

  it("rejects a stale timestamp past the skew window (replay defense)", () => {
    expect(isTimestampFresh(String(now - (WEBHOOK_MAX_SKEW_MS + 1000)), now)).toBe(false);
  });

  it("rejects a timestamp too far in the future", () => {
    expect(isTimestampFresh(String(now + (WEBHOOK_MAX_SKEW_MS + 1000)), now)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(isTimestampFresh("not-a-number", now)).toBe(false);
  });

  it("respects a custom skew window", () => {
    expect(isTimestampFresh(String(now - 10_000), now, 5_000)).toBe(false);
    expect(isTimestampFresh(String(now - 3_000), now, 5_000)).toBe(true);
  });
});
