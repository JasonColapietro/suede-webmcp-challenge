import { describe, it, expect } from "vitest";
import {
  checkRateLimit,
  ipFromRequest,
  peekTokenBudget,
  chargeTokenBudget,
  RATE_LIMIT_STATE_MAX_ENTRIES,
  RATE_LIMIT_STATE_TTL_MS,
} from "@/lib/rate-limit";

// Fixed base clock (ms). Tests advance it explicitly — no sleeping required.
const BASE_MS = Date.UTC(2026, 5, 11, 12, 0, 0);

// Each test uses unique key prefixes to avoid module-level Map cross-contamination.
let keySeq = 0;
function freshKey(prefix = "test"): string {
  return `${prefix}:${++keySeq}`;
}

describe("checkRateLimit — allows under limit", () => {
  it("allows the first request from a new key", () => {
    const result = checkRateLimit(freshKey(), {}, BASE_MS);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSec).toBe(0);
  });

  it("allows requests up to the burst capacity", () => {
    const key = freshKey();
    const capacity = 5;
    const opts = { capacity, refillPerSec: 0.5 };
    for (let i = 0; i < capacity; i++) {
      const r = checkRateLimit(key, opts, BASE_MS);
      expect(r.allowed).toBe(true);
    }
  });
});

describe("checkRateLimit — blocks over limit", () => {
  it("blocks the request that exceeds the burst capacity", () => {
    const key = freshKey();
    const capacity = 3;
    const opts = { capacity, refillPerSec: 0.5 };

    for (let i = 0; i < capacity; i++) {
      checkRateLimit(key, opts, BASE_MS);
    }

    const blocked = checkRateLimit(key, opts, BASE_MS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("returns a positive retryAfterSec when blocked", () => {
    const key = freshKey();
    // Drain the bucket completely (capacity=1).
    checkRateLimit(key, { capacity: 1, refillPerSec: 0.1 }, BASE_MS);
    const r = checkRateLimit(key, { capacity: 1, refillPerSec: 0.1 }, BASE_MS);
    expect(r.allowed).toBe(false);
    // At 0.1 req/s, 1 token takes 10 seconds — should ceil to 10.
    expect(r.retryAfterSec).toBe(10);
  });
});

describe("checkRateLimit — refills over time", () => {
  it("allows a request after sufficient time has elapsed for refill", () => {
    const key = freshKey();
    const opts = { capacity: 1, refillPerSec: 1 }; // 1 token per second

    // Drain the bucket.
    checkRateLimit(key, opts, BASE_MS);
    expect(checkRateLimit(key, opts, BASE_MS).allowed).toBe(false);

    // Advance clock by 1 second — should have refilled 1 token.
    const afterRefill = checkRateLimit(key, opts, BASE_MS + 1_000);
    expect(afterRefill.allowed).toBe(true);
  });

  it("does not exceed capacity when a long time passes", () => {
    const key = freshKey();
    const opts = { capacity: 3, refillPerSec: 1 };

    // Drain the bucket.
    for (let i = 0; i < 3; i++) checkRateLimit(key, opts, BASE_MS);
    expect(checkRateLimit(key, opts, BASE_MS).allowed).toBe(false);

    // Advance 1 hour — tokens should be clamped at capacity (3), not overflow.
    const r1 = checkRateLimit(key, opts, BASE_MS + 3_600_000);
    const r2 = checkRateLimit(key, opts, BASE_MS + 3_600_000);
    const r3 = checkRateLimit(key, opts, BASE_MS + 3_600_000);
    const r4 = checkRateLimit(key, opts, BASE_MS + 3_600_000);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    // 4th should be blocked — capacity is only 3.
    expect(r4.allowed).toBe(false);
  });
});

describe("checkRateLimit — independent keys", () => {
  it("tracks separate state per key", () => {
    const keyA = freshKey("a");
    const keyB = freshKey("b");
    const opts = { capacity: 1, refillPerSec: 0.5 };

    // Drain key A.
    checkRateLimit(keyA, opts, BASE_MS);
    expect(checkRateLimit(keyA, opts, BASE_MS).allowed).toBe(false);

    // Key B should still have its full bucket.
    expect(checkRateLimit(keyB, opts, BASE_MS).allowed).toBe(true);
  });

  it("blocking one key does not affect another", () => {
    const keys = [freshKey("x"), freshKey("y"), freshKey("z")];
    const opts = { capacity: 2, refillPerSec: 0.5 };

    // Drain the first key.
    checkRateLimit(keys[0]!, opts, BASE_MS);
    checkRateLimit(keys[0]!, opts, BASE_MS);
    expect(checkRateLimit(keys[0]!, opts, BASE_MS).allowed).toBe(false);

    // Other keys are unaffected.
    expect(checkRateLimit(keys[1]!, opts, BASE_MS).allowed).toBe(true);
    expect(checkRateLimit(keys[2]!, opts, BASE_MS).allowed).toBe(true);
  });
});

describe("checkRateLimit — bounded abuse state", () => {
  it("expires an idle bucket instead of retaining attacker-controlled keys forever", () => {
    const key = freshKey("expires");
    const opts = { capacity: 1, refillPerSec: 1e-12 };

    expect(checkRateLimit(key, opts, BASE_MS).allowed).toBe(true);
    expect(checkRateLimit(key, opts, BASE_MS).allowed).toBe(false);
    expect(checkRateLimit(key, opts, BASE_MS + RATE_LIMIT_STATE_TTL_MS + 1).allowed).toBe(true);
  });

  it("evicts the least-recently-used bucket when rotated keys reach the cardinality cap", () => {
    const original = freshKey("cardinality-original");
    const opts = { capacity: 1, refillPerSec: 1e-12 };

    expect(checkRateLimit(original, opts, BASE_MS).allowed).toBe(true);
    expect(checkRateLimit(original, opts, BASE_MS).allowed).toBe(false);
    for (let index = 0; index < RATE_LIMIT_STATE_MAX_ENTRIES; index += 1) {
      checkRateLimit(freshKey("cardinality-rotated"), opts, BASE_MS);
    }

    expect(checkRateLimit(original, opts, BASE_MS).allowed).toBe(true);
  });
});

describe("ipFromRequest", () => {
  function makeReq(headers: Record<string, string>): Request {
    return new Request("https://example.com/", { headers });
  }

  it("returns the first IP from x-forwarded-for", () => {
    const req = makeReq({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(ipFromRequest(req)).toBe("1.2.3.4");
  });

  it("handles a single IP without a comma", () => {
    const req = makeReq({ "x-forwarded-for": "9.10.11.12" });
    expect(ipFromRequest(req)).toBe("9.10.11.12");
  });

  it("trims whitespace around the IP", () => {
    const req = makeReq({ "x-forwarded-for": "  203.0.113.1 , 198.51.100.1" });
    expect(ipFromRequest(req)).toBe("203.0.113.1");
  });

  it("falls back to 'unknown' when header is absent", () => {
    const req = makeReq({});
    expect(ipFromRequest(req)).toBe("unknown");
  });

  it("prefers x-real-ip (Vercel-set, harder to spoof) over x-forwarded-for", () => {
    const req = makeReq({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(ipFromRequest(req)).toBe("9.9.9.9");
  });
});

describe("peekTokenBudget / chargeTokenBudget", () => {
  it("a fresh key starts at full capacity", () => {
    const r = peekTokenBudget(freshKey("tb"), { capacity: 1000 }, BASE_MS);
    expect(r.remaining).toBe(1000);
  });

  it("charging reduces the remaining budget by the amount", () => {
    const key = freshKey("tb");
    const opts = { capacity: 1000 };
    chargeTokenBudget(key, 400, opts, BASE_MS);
    expect(peekTokenBudget(key, opts, BASE_MS).remaining).toBe(600);
  });

  it("refills continuously toward capacity over a day", () => {
    const key = freshKey("tb");
    const opts = { capacity: 86_400 }; // default refill = capacity/86400 = 1 token/sec
    chargeTokenBudget(key, 86_400, opts, BASE_MS); // drain to 0
    expect(peekTokenBudget(key, opts, BASE_MS).remaining).toBeCloseTo(0, 5);
    // 10 seconds later → ~10 tokens refilled
    expect(peekTokenBudget(key, opts, BASE_MS + 10_000).remaining).toBeCloseTo(10, 5);
  });

  it("never refills above capacity", () => {
    const key = freshKey("tb");
    const opts = { capacity: 100 };
    expect(peekTokenBudget(key, opts, BASE_MS + 86_400_000).remaining).toBe(100);
  });

  it("floors a large overcharge at -capacity (bounded lockout)", () => {
    const key = freshKey("tb");
    const opts = { capacity: 100 };
    chargeTokenBudget(key, 10_000, opts, BASE_MS);
    expect(peekTokenBudget(key, opts, BASE_MS).remaining).toBe(-100);
  });

  it("tracks independent budgets per key", () => {
    const a = freshKey("tba");
    const b = freshKey("tbb");
    const opts = { capacity: 100 };
    chargeTokenBudget(a, 100, opts, BASE_MS);
    expect(peekTokenBudget(a, opts, BASE_MS).remaining).toBe(0);
    expect(peekTokenBudget(b, opts, BASE_MS).remaining).toBe(100);
  });
});
