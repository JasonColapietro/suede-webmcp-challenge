import { describe, it, expect } from "vitest";
import { schedule, paidCall, manual, webhook } from "../src/triggers.js";

describe("schedule()", () => {
  it("returns a schedule trigger with the cron string", () => {
    const t = schedule("0 13 * * *");
    expect(t.kind).toBe("schedule");
    expect((t as { kind: "schedule"; cron: string }).cron).toBe("0 13 * * *");
  });

  it("throws on an invalid cron expression", () => {
    expect(() => schedule("not-a-cron")).toThrow();
  });

  it("throws on wrong field count", () => {
    expect(() => schedule("* * * *")).toThrow();
  });

  it("throws on out-of-range minute", () => {
    expect(() => schedule("60 * * * *")).toThrow();
  });

  it("accepts all wildcard expression", () => {
    const t = schedule("* * * * *");
    expect(t.kind).toBe("schedule");
  });

  it("accepts complex step expression", () => {
    const t = schedule("*/15 * * * *");
    expect(t.kind).toBe("schedule");
  });
});

describe("paidCall()", () => {
  it("returns a paidCall trigger with priceUsdc", () => {
    const t = paidCall(0.25);
    expect(t.kind).toBe("paidCall");
    expect((t as { kind: "paidCall"; priceUsdc: number }).priceUsdc).toBe(0.25);
  });

  it("accepts zero price", () => {
    const t = paidCall(0);
    expect((t as { kind: "paidCall"; priceUsdc: number }).priceUsdc).toBe(0);
  });

  it("throws on negative price", () => {
    expect(() => paidCall(-0.01)).toThrow();
  });

  it("throws on non-number price", () => {
     
    expect(() => paidCall("0.25" as any)).toThrow();
  });
});

describe("manual()", () => {
  it("returns a manual trigger", () => {
    const t = manual();
    expect(t.kind).toBe("manual");
  });
});

describe("webhook()", () => {
  it("returns a webhook trigger", () => {
    const t = webhook();
    expect(t.kind).toBe("webhook");
  });
});
