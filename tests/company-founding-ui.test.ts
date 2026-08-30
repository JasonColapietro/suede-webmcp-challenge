import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/app/founding/page.tsx", "utf8");

describe("company founding review", () => {
  it("keeps every employee budget editable in the exact reviewed draft", () => {
    expect(source).toContain("Employee monthly cap (USDC)");
    expect(source).toContain('value={employee.monthlyBudgetUsdc ?? ""}');
    expect(source).toContain('monthlyBudgetUsdc: value === "" ? null : Number(value)');
    expect(source).toContain("company: review.company");
  });

  it("keeps schedule, price, and approval policy edits on the reviewed employee", () => {
    expect(source).toContain("updateEmployeeTrigger(di, ei, triggerIndex");
    expect(source).toContain("cron: event.target.value");
    expect(source).toContain("priceUsdc: Math.max(0, Number(event.target.value) || 0)");
    expect(source).toContain("updateEmployee(di, ei, { publishGated: event.target.checked })");
  });
});
