import { describe, expect, it } from "vitest";
import { Ap2ProjectionError, sanitizeAp2Json } from "@/lib/rails/ap2-sanitize";

describe("AP2 durable response projection", () => {
  it("redacts credential-bearing fields while preserving ordinary output", () => {
    expect(sanitizeAp2Json({
      result: { approved: true, score: 91 },
      authorization: "Bearer private",
      checkoutJwt: "header.payload.signature",
      nested: { api_key: "private", note: "safe" },
    })).toEqual({
      result: { approved: true, score: 91 },
      authorization: "[REDACTED]",
      checkoutJwt: "[REDACTED]",
      nested: { api_key: "[REDACTED]", note: "safe" },
    });
  });

  it("redacts private keys and long SD-JWT presentations even under innocuous keys", () => {
    const sdJwt = `${"a".repeat(100)}.${"b".repeat(100)}.${"c".repeat(100)}~${"d".repeat(100)}~`;
    expect(sanitizeAp2Json({ pem: "-----BEGIN PRIVATE KEY-----\nprivate", value: sdJwt }))
      .toEqual({ pem: "[REDACTED]", value: "[REDACTED]" });
  });

  it("rejects cyclic, deep, wide, long, non-finite, and oversized projections", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      cyclic,
      { one: { two: { three: true } } },
      { values: [1, 2, 3] },
      { value: "too long" },
      { value: Number.NaN },
      { left: "123456", right: "123456" },
    ]) {
      expect(() => sanitizeAp2Json(value, {
        maxDepth: 2,
        maxCollectionItems: 2,
        maxStringBytes: 4,
        maxBytes: 10,
      })).toThrow(Ap2ProjectionError);
    }
  });
});
