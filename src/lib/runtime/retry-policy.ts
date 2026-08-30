import { createHash } from "node:crypto";

export type FailureClassification = "transient" | "permanent" | "cancelled" | "timeout" | "policy";

export type RetryDecision =
  | Readonly<{ action: "retry"; availableAt: number; delayMs: number }>
  | Readonly<{ action: "fail" | "cancel" | "dead-letter" }>;

const MAX_ID_LENGTH = 256;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 3_600_000;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function invalid(): never {
  throw new TypeError("Invalid durable retry policy input");
}

export function retryDelayMs(input: Readonly<{ jobId: string; attemptNumber: number }>): number {
  if (!validId(input?.jobId) || !safeInteger(input?.attemptNumber, 1, 100)) return invalid();
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** Math.min(input.attemptNumber - 1, 20)));
  const digest = createHash("sha256")
    .update("durable-runtime:retry-jitter:v1\0", "utf8")
    .update(input.jobId, "utf8")
    .update("\0", "utf8")
    .update(String(input.attemptNumber), "ascii")
    .digest();
  const basisPoints = digest.readUInt16BE(0) % 2_501;
  return Math.min(MAX_DELAY_MS, Math.floor(exponential * (8_750 + basisPoints) / 10_000));
}

export function decideRetry(input: Readonly<{
  classification: FailureClassification;
  jobId: string;
  attemptNumber: number;
  maxAttempts: number;
  now: number;
}>): RetryDecision {
  if (!input || !["transient", "permanent", "cancelled", "timeout", "policy"].includes(input.classification) ||
      !validId(input.jobId) || !safeInteger(input.attemptNumber, 1, 100) ||
      !safeInteger(input.maxAttempts, input.attemptNumber, 100) || !safeInteger(input.now, 0)) return invalid();
  if (input.classification === "cancelled") return Object.freeze({ action: "cancel" });
  if (input.classification === "permanent" || input.classification === "policy") return Object.freeze({ action: "fail" });
  if (input.attemptNumber >= input.maxAttempts) return Object.freeze({ action: "dead-letter" });
  const delayMs = retryDelayMs(input);
  const availableAt = input.now + delayMs;
  if (!Number.isSafeInteger(availableAt)) return invalid();
  return Object.freeze({ action: "retry", availableAt, delayMs });
}
