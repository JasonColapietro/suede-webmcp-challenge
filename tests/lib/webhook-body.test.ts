/**
 * Tests for src/lib/webhook-body.ts — the body-size cap and content-type
 * checks POST /api/agents/[agent]/webhook applies before ever handing a
 * body to src/lib/webhook-handler.ts. Uses the platform's built-in Request
 * (no next/server import), matching this repo's convention of not
 * importing route.ts files into vitest.
 */
import { describe, it, expect } from "vitest";
import {
  WEBHOOK_MAX_BODY_BYTES,
  declaredLengthExceedsCap,
  isJsonContentType,
  readCappedRequestBody,
} from "@/lib/webhook-body";

describe("isJsonContentType", () => {
  it("accepts application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true);
  });
  it("accepts application/json with a charset suffix", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });
  it("rejects text/plain", () => {
    expect(isJsonContentType("text/plain")).toBe(false);
  });
  it("rejects application/x-www-form-urlencoded", () => {
    expect(isJsonContentType("application/x-www-form-urlencoded")).toBe(false);
  });
  it("rejects a null content type", () => {
    expect(isJsonContentType(null)).toBe(false);
  });
});

describe("declaredLengthExceedsCap", () => {
  it("false when under the cap", () => {
    expect(declaredLengthExceedsCap("100", 1000)).toBe(false);
  });
  it("true when over the cap", () => {
    expect(declaredLengthExceedsCap("2000", 1000)).toBe(true);
  });
  it("false when missing (no fast-reject without a declared length)", () => {
    expect(declaredLengthExceedsCap(null, 1000)).toBe(false);
  });
  it("false when non-numeric", () => {
    expect(declaredLengthExceedsCap("not-a-number", 1000)).toBe(false);
  });
});

describe("readCappedRequestBody", () => {
  it("reads a small JSON body fully", async () => {
    const body = JSON.stringify({ event: "push", ref: "main" });
    const req = new Request("https://x/webhook", { method: "POST", body });
    const { text, truncated } = await readCappedRequestBody(req, WEBHOOK_MAX_BODY_BYTES);
    expect(truncated).toBe(false);
    expect(text).toBe(body);
  });

  it("truncates a body larger than the cap without buffering all of it", async () => {
    const big = "x".repeat(1000);
    const req = new Request("https://x/webhook", { method: "POST", body: big });
    const { truncated, text } = await readCappedRequestBody(req, 100);
    expect(truncated).toBe(true);
    expect(text).toBe("");
  });

  it("accepts a body exactly at the cap", async () => {
    const exact = "y".repeat(100);
    const req = new Request("https://x/webhook", { method: "POST", body: exact });
    const { truncated, text } = await readCappedRequestBody(req, 100);
    expect(truncated).toBe(false);
    expect(text).toBe(exact);
  });
});
