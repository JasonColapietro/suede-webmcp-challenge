import { describe, expect, it } from "vitest";
import { decideRetry, retryDelayMs } from "@/lib/runtime/retry-policy";

describe("durable retry policy", () => {
  it("uses bounded deterministic exponential backoff with job/attempt jitter", () => {
    const first = retryDelayMs({ jobId: "job-a", attemptNumber: 1 });
    expect(first).toBe(retryDelayMs({ jobId: "job-a", attemptNumber: 1 }));
    expect(retryDelayMs({ jobId: "job-a", attemptNumber: 2 })).toBeGreaterThan(first);
    expect(retryDelayMs({ jobId: "job-b", attemptNumber: 1 })).not.toBe(first);
    expect(retryDelayMs({ jobId: "job-a", attemptNumber: 100 })).toBeLessThanOrEqual(3_600_000);
  });

  it("retries only transient and timeout failures while budget remains", () => {
    expect(decideRetry({ classification: "transient", jobId: "j", attemptNumber: 1, maxAttempts: 2, now: 100 })).toMatchObject({ action: "retry" });
    expect(decideRetry({ classification: "timeout", jobId: "j", attemptNumber: 1, maxAttempts: 2, now: 100 })).toMatchObject({ action: "retry" });
    expect(decideRetry({ classification: "permanent", jobId: "j", attemptNumber: 1, maxAttempts: 2, now: 100 })).toEqual({ action: "fail" });
    expect(decideRetry({ classification: "policy", jobId: "j", attemptNumber: 1, maxAttempts: 2, now: 100 })).toEqual({ action: "fail" });
    expect(decideRetry({ classification: "cancelled", jobId: "j", attemptNumber: 1, maxAttempts: 2, now: 100 })).toEqual({ action: "cancel" });
    expect(decideRetry({ classification: "transient", jobId: "j", attemptNumber: 2, maxAttempts: 2, now: 100 })).toEqual({ action: "dead-letter" });
  });

  it("fails closed on hostile identifiers and unsafe integers", () => {
    expect(() => retryDelayMs({ jobId: "", attemptNumber: 1 })).toThrow(/retry policy/i);
    expect(() => retryDelayMs({ jobId: "j", attemptNumber: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/retry policy/i);
    expect(() => decideRetry({ classification: "transient", jobId: "j", attemptNumber: 2, maxAttempts: 1, now: 0 })).toThrow(/retry policy/i);
  });
});
