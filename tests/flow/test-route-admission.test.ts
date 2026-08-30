import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TEST_ROUTE_ADMISSION_LIMITS,
  createTestRouteAdmission,
  validateTestRouteHeaders,
} from "@/lib/flow/test-route-admission";

function browserRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://agents.suedeai.ai/api/v2/test-runs", {
    method: "POST",
    headers: {
      origin: "https://agents.suedeai.ai",
      "content-type": "application/json",
      ...headers,
    },
    body: "{}",
  });
}

function acquire(
  admission: ReturnType<typeof createTestRouteAdmission>,
  ownerId: string,
  ip: string,
) {
  return admission.tryAcquire({ ownerId, ip });
}

describe("ephemeral test route header admission", () => {
  it("allows only exact-origin browser JSON requests", () => {
    expect(validateTestRouteHeaders(browserRequest())).toEqual({ ok: true });
    expect(validateTestRouteHeaders(browserRequest({
      "content-type": "Application/JSON; charset=utf-8",
    }))).toEqual({ ok: true });
  });

  it.each([
    ["authorization header", { authorization: "Bearer workspace-secret" }, 403],
    ["blank authorization header", { authorization: "" }, 403],
    ["missing origin", { origin: "" }, 403],
    ["null origin", { origin: "null" }, 403],
    ["cross origin", { origin: "https://attacker.example" }, 403],
    ["sibling origin", { origin: "https://social.suedeai.ai" }, 403],
    ["content encoding", { "content-encoding": "gzip" }, 415],
    ["identity encoding", { "content-encoding": "identity" }, 415],
    ["wrong media type", { "content-type": "text/plain" }, 415],
    ["missing media type", { "content-type": "" }, 415],
  ] as const)("rejects %s without returning request data", (_name, headers, status) => {
    const result = validateTestRouteHeaders(browserRequest(headers));
    expect(result).toEqual({ ok: false, status });
    expect(JSON.stringify(result)).not.toMatch(/workspace-secret|attacker|social|gzip/u);
  });
});

describe("ephemeral test route bounded admission", () => {
  it("publishes frozen fixed per-instance limits", () => {
    expect(TEST_ROUTE_ADMISSION_LIMITS).toEqual({
      ownerCapacity: 6,
      ownerRefillPerSec: 0.1,
      ipCapacity: 20,
      ipRefillPerSec: 0.5,
      ownerConcurrency: 2,
      globalConcurrency: 8,
      ownerKeyLimit: 256,
      ipKeyLimit: 256,
      keyTtlMs: 5 * 60 * 1_000,
      keyMaxBytes: 128,
    });
    expect(Object.isFrozen(TEST_ROUTE_ADMISSION_LIMITS)).toBe(true);
  });

  it("rate-limits owners with deterministic refill and generic retry", () => {
    let now = 1_000;
    const admission = createTestRouteAdmission({ now: () => now });
    for (let index = 0; index < TEST_ROUTE_ADMISSION_LIMITS.ownerCapacity; index += 1) {
      const lease = acquire(admission, "owner-rate", "198.51.100.1");
      expect(lease.ok).toBe(true);
      if (lease.ok) lease.release();
    }
    expect(acquire(admission, "owner-rate", "198.51.100.1")).toEqual({
      ok: false,
      retryAfterSec: 10,
    });
    now += 10_000;
    expect(acquire(admission, "owner-rate", "198.51.100.1").ok).toBe(true);
  });

  it("rate-limits shared IPs independently of owner rotation", () => {
    let now = 2_000;
    const admission = createTestRouteAdmission({ now: () => now });
    for (let index = 0; index < TEST_ROUTE_ADMISSION_LIMITS.ipCapacity; index += 1) {
      const lease = acquire(admission, `owner-ip-${index}`, "203.0.113.9");
      expect(lease.ok).toBe(true);
      if (lease.ok) lease.release();
    }
    expect(acquire(admission, "owner-ip-overflow", "203.0.113.9")).toEqual({
      ok: false,
      retryAfterSec: 2,
    });
    now += 2_000;
    expect(acquire(admission, "owner-ip-refilled", "203.0.113.9").ok).toBe(true);
  });

  it("enforces per-owner two and global eight synchronously with idempotent release", () => {
    const ownerAdmission = createTestRouteAdmission({ now: () => 3_000 });
    const first = acquire(ownerAdmission, "owner-concurrent", "192.0.2.1");
    const second = acquire(ownerAdmission, "owner-concurrent", "192.0.2.1");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(acquire(ownerAdmission, "owner-concurrent", "192.0.2.1")).toEqual({
      ok: false,
      retryAfterSec: 1,
    });
    if (first.ok) {
      first.release();
      first.release();
    }
    expect(acquire(ownerAdmission, "owner-concurrent", "192.0.2.1").ok).toBe(true);

    const globalAdmission = createTestRouteAdmission({ now: () => 4_000 });
    const leases = Array.from({ length: TEST_ROUTE_ADMISSION_LIMITS.globalConcurrency }, (_, index) =>
      acquire(globalAdmission, `owner-global-${index}`, `198.51.100.${index}`));
    expect(leases.every(({ ok }) => ok)).toBe(true);
    expect(acquire(globalAdmission, "owner-global-overflow", "198.51.100.99")).toEqual({
      ok: false,
      retryAfterSec: 1,
    });
    for (const lease of leases) if (lease.ok) lease.release();
    expect(acquire(globalAdmission, "owner-global-overflow", "198.51.100.99").ok).toBe(true);
  });

  it("bounds token-bucket maps with LRU eviction and TTL cleanup", () => {
    let now = 5_000;
    const admission = createTestRouteAdmission({ now: () => now });
    for (let index = 0; index < TEST_ROUTE_ADMISSION_LIMITS.ownerKeyLimit; index += 1) {
      const lease = acquire(admission, `owner-lru-${index}`, `192.0.2.${index}`);
      expect(lease.ok).toBe(true);
      if (lease.ok) lease.release();
    }
    expect(admission.sizes()).toEqual({
      ownerKeys: TEST_ROUTE_ADMISSION_LIMITS.ownerKeyLimit,
      ipKeys: TEST_ROUTE_ADMISSION_LIMITS.ipKeyLimit,
      activeOwners: 0,
      activeTotal: 0,
    });
    const touched = acquire(admission, "owner-lru-0", "192.0.2.0");
    if (touched.ok) touched.release();
    const added = acquire(admission, "owner-lru-new", "192.0.2.new");
    if (added.ok) added.release();
    expect(admission.sizes().ownerKeys).toBe(TEST_ROUTE_ADMISSION_LIMITS.ownerKeyLimit);
    expect(admission.sizes().ipKeys).toBe(TEST_ROUTE_ADMISSION_LIMITS.ipKeyLimit);

    now += TEST_ROUTE_ADMISSION_LIMITS.keyTtlMs + 1;
    const afterTtl = acquire(admission, "owner-after-ttl", "203.0.113.100");
    if (afterTtl.ok) afterTtl.release();
    expect(admission.sizes()).toEqual({ ownerKeys: 1, ipKeys: 1, activeOwners: 0, activeTotal: 0 });
  });

  it("rejects invalid or oversized keys and invalid clocks without retaining them", () => {
    const invalidClock = createTestRouteAdmission({ now: () => Number.NaN });
    expect(invalidClock.tryAcquire({ ownerId: "owner", ip: "192.0.2.1" })).toEqual({
      ok: false,
      retryAfterSec: 1,
    });
    expect(invalidClock.sizes()).toEqual({ ownerKeys: 0, ipKeys: 0, activeOwners: 0, activeTotal: 0 });

    const admission = createTestRouteAdmission({ now: () => 6_000 });
    for (const input of [
      { ownerId: "", ip: "192.0.2.1" },
      { ownerId: "owner", ip: "" },
      { ownerId: "owner\nsecret", ip: "192.0.2.1" },
      { ownerId: "x".repeat(TEST_ROUTE_ADMISSION_LIMITS.keyMaxBytes + 1), ip: "192.0.2.1" },
      { ownerId: 42, ip: "192.0.2.1" },
    ]) {
      expect(admission.tryAcquire(input)).toEqual({ ok: false, retryAfterSec: 1 });
    }
    expect(admission.sizes()).toEqual({ ownerKeys: 0, ipKeys: 0, activeOwners: 0, activeTotal: 0 });
  });

  it("has no DB, provider, network, environment, or persistence dependency", () => {
    const source = readFileSync("src/lib/flow/test-route-admission.ts", "utf8");
    expect(source).not.toMatch(/\b(?:fetch|process\.env|getRepo|getProjectRepo|createRun|appendStep|finishRun)\b/u);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:db|provider|rails|gateway|run-service|api)[^"']*["']/u);
  });
});
