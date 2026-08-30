import { describe, it, expect } from "vitest";
import {
  parseCron,
  mostRecentOccurrence,
  nextOccurrence,
  isDue,
  filterDue,
  describeCron,
} from "@/lib/cron";

// All cron math is UTC. 2026-06-10 is a Wednesday; 2026-06-08 a Monday.
const T = (h: number, m: number, day = 10): number => Date.UTC(2026, 5, day, h, m);

describe("parseCron", () => {
  it("accepts standard five-field expressions", () => {
    expect(parseCron("0 9 * * *")).not.toBeNull();
    expect(parseCron("*/15 * * * *")).not.toBeNull();
    expect(parseCron("0 13 * * 1")).not.toBeNull();
  });

  it("rejects garbage, wrong arity, and out-of-range fields", () => {
    expect(parseCron("bananas")).toBeNull();
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("61 9 * * *")).toBeNull();
    expect(parseCron("0 25 * * *")).toBeNull();
    expect(parseCron("")).toBeNull();
  });
});

describe("mostRecentOccurrence", () => {
  it("finds today's occurrence once it has passed", () => {
    expect(mostRecentOccurrence("0 9 * * *", T(14, 30))).toBe(T(9, 0));
  });

  it("falls back to yesterday before today's occurrence", () => {
    expect(mostRecentOccurrence("0 9 * * *", T(8, 59))).toBe(T(9, 0, 9));
  });

  it("treats an exact match as an occurrence (<= now)", () => {
    expect(mostRecentOccurrence("0 9 * * *", T(9, 0))).toBe(T(9, 0));
  });

  it("handles hourly and step expressions", () => {
    expect(mostRecentOccurrence("0 * * * *", T(14, 30))).toBe(T(14, 0));
    expect(mostRecentOccurrence("*/15 * * * *", T(14, 37))).toBe(T(14, 30));
  });

  it("handles weekly day-of-week schedules", () => {
    // Monday 13:00 before Wednesday 2026-06-10 → Mon 2026-06-08.
    expect(mostRecentOccurrence("0 13 * * 1", T(10, 0))).toBe(T(13, 0, 8));
  });

  it("returns null for invalid expressions", () => {
    expect(mostRecentOccurrence("nope", T(10, 0))).toBeNull();
  });
});

describe("nextOccurrence", () => {
  it("returns today's occurrence when still ahead", () => {
    expect(nextOccurrence("0 9 * * *", T(8, 0))).toBe(T(9, 0));
  });

  it("rolls to tomorrow once today's has passed (strictly after now)", () => {
    expect(nextOccurrence("0 9 * * *", T(14, 30))).toBe(T(9, 0, 11));
    expect(nextOccurrence("0 9 * * *", T(9, 0))).toBe(T(9, 0, 11));
  });

  it("returns null for invalid expressions", () => {
    expect(nextOccurrence("nope", T(10, 0))).toBeNull();
  });
});

describe("isDue", () => {
  it("is due when it has never run and an occurrence has passed", () => {
    expect(isDue("0 9 * * *", null, T(14, 30))).toBe(true);
  });

  it("is not due again within the same occurrence window", () => {
    // Daily at 09:00, last ran 09:05 — an hourly tick at 14:30 must NOT refire.
    expect(isDue("0 9 * * *", T(9, 5), T(14, 30))).toBe(false);
  });

  it("becomes due once a new occurrence passes", () => {
    // Ran yesterday 09:05; today 09:30 a new 09:00 occurrence exists.
    expect(isDue("0 9 * * *", T(9, 5, 9), T(9, 30))).toBe(true);
  });

  it("never fires an invalid expression", () => {
    expect(isDue("garbage", null, T(14, 30))).toBe(false);
  });
});

describe("filterDue", () => {
  it("keeps only enabled, due schedules", () => {
    const rows = [
      { id: "due", cron: "0 9 * * *", enabled: true, lastRunAt: null },
      { id: "ran", cron: "0 9 * * *", enabled: true, lastRunAt: T(9, 5) },
      { id: "off", cron: "0 9 * * *", enabled: false, lastRunAt: null },
      { id: "bad", cron: "garbage", enabled: true, lastRunAt: null },
    ];
    expect(filterDue(rows, T(14, 30)).map((r) => r.id)).toEqual(["due"]);
  });
});

describe("describeCron", () => {
  it("names the common shapes", () => {
    expect(describeCron("* * * * *")).toBe("every minute");
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("hourly");
    expect(describeCron("30 * * * *")).toBe("hourly at :30");
    expect(describeCron("0 9 * * *")).toBe("daily at 09:00 UTC");
    expect(describeCron("0 13 * * 1")).toBe("weekly on Mon at 13:00 UTC");
    expect(describeCron("0 0 1 * *")).toBe("monthly on day 1 at 00:00 UTC");
  });

  it("falls back to the raw expression", () => {
    expect(describeCron("1 2 3 4 5")).toBe("cron(1 2 3 4 5)");
    expect(describeCron("garbage")).toBe("cron(garbage)");
  });
});
