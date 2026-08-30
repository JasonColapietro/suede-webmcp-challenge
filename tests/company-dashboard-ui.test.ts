import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/app/company/page.tsx", "utf8");
const companyStyles = readFileSync("src/app/company/company.css", "utf8");
const signedOutSource = readFileSync(
  "src/components/company/CompanySignedOutStory.tsx",
  "utf8",
);
const companyOgSource = readFileSync("src/app/company/opengraph-image.tsx", "utf8");

describe("company dashboard governance and books source contract", () => {
  it("makes the founder command path explicit without inventing a CEO chart node", () => {
    expect(source).toContain("Build the company. Direct the CEO. Approve the work.");
    expect(source).toContain("Direct the CEO. Operate the whole org.");
    expect(source).toContain("Set direction");
    expect(source).toContain("Shape the org");
    expect(source).toContain("Delegate work");
    expect(source).toContain("Stay in control");
    expect(source).toContain('href="#company-ceo"');
    expect(source).toContain('href="#company-approvals"');
    expect(source).toContain('id="company-ceo"');
    expect(source).toContain('id="company-approvals"');
    expect(source).not.toContain('id: `ceo:${company.id}`');
  });

  it("keeps paid-call and ledger facts visible while sharpening governance language", () => {
    expect(source).toContain("formatPricePerCall");
    expect(source).toContain("priced per call");
    expect(source).toContain("Live selling on");
    expect(source).toContain("totalCreatorUsdc");
    expect(source).toContain("totalGrossUsdc");
    expect(source).toContain("https://basescan.org/tx/");
    expect(source).toContain("Review approvals");
    expect(source).toContain("Company evidence");
  });

  it("keeps the founder-command framing responsive and consistent in public previews", () => {
    expect(companyStyles).toContain(".co-operating-loop");
    expect(companyStyles).toContain(".co-command-deck");
    expect(companyStyles).toContain("@media (max-width: 900px)");
    expect(companyStyles).toContain("@media (max-width: 560px)");
    expect(signedOutSource).toContain("Build a company of agents. Stay the founder.");
    expect(companyOgSource).toContain("Direct the CEO. Run the org.");
    expect(companyOgSource).toContain("budgets, approvals, and activity visible");
  });

  it("keeps all three manual fire scopes and explains guardrail reason codes", () => {
    expect(source).toContain('handleFire("company")');
    expect(source).toContain('handleFire("department", department.id)');
    expect(source).toContain('handleFire("employee", employee.agentId)');
    expect(source).toContain("Budget reached for this month");
    expect(source).toContain("Waiting for your approval");
  });

  it("wires founder-owned governance actions to the existing HTTP surface", () => {
    expect(source).toContain('method: "PATCH"');
    expect(source).toContain('/departments`');
    expect(source).toContain('/approvals`');
    expect(source).toContain('/settlement`');
    expect(source).toContain('/departments/${encodeURIComponent(targetId)}`');
    expect(source).toContain('/employees/${encodeURIComponent(targetId)}`');
    expect(source).toContain("monthlyBudgetUsdc");
    expect(source).toContain("Review and activate");
    expect(source).toContain("Pause company");
    expect(source).toContain("Resume company");
    expect(source).toContain("enable_live_selling");
    expect(source).toContain("Rename company");
    expect(source).toContain('{ name }, "rename"');
  });

  it("keeps every employee connected to the three exact platform settings", () => {
    expect(source).toContain('/start?flow=${encodeURIComponent(employee.agent.flowId)}');
    expect(source).toContain('/build/${encodeURIComponent(employee.agent.flowId)}');
    expect(source).toContain('/code/${encodeURIComponent(employee.agent.flowId)}');
    expect(source).toContain("Guided");
    expect(source).toContain("Studio");
    expect(source).toContain("Code");
  });

  it("renders monthly receipt-grounded books without held take-rate copy", () => {
    expect(source).toContain('type="month"');
    expect(source).toContain("Company books, grounded in the ledgers.");
    expect(source).not.toContain("Every number has a receipt");
    expect(source).toContain("https://basescan.org/tx/");
    expect(source).toContain("no receipt returned");
    expect(source).not.toContain("Keep 95%");
    expect(source).not.toContain("take rate");
  });

  it("surfaces operating controls from persisted state", () => {
    expect(source).toContain('method: "DELETE"');
    expect(source).toContain("Public execution will stop");
    expect(source).toContain("company history are preserved");
    expect(source).toContain("Paused for budget");
    expect(source).toContain("employee.monthSpendUsdc >= employee.monthlyBudgetUsdc");
    expect(source).toContain("department.monthSpendUsdc >= department.monthlyBudgetUsdc");
    expect(source).toContain('/activity?${query.toString()}');
    expect(source).toContain("All departments");
    expect(source).toContain("All employees");
    expect(source).toContain("All statuses");
    expect(source).toContain("A durable record of what happened.");
    expect(source).toContain("Load older activity");
    expect(source).toContain('query.set("cursor", options.cursor)');
  });

  it("treats a list failure as terminal instead of leaving a loading state behind", () => {
    expect(source).toContain("{!listError && (");
    expect(source).toContain("Loading your companies…");
  });

  it("shows the durable action and truthful cost basis before a decision", () => {
    expect(source).toContain("approval.actionSummary");
    expect(source).toContain("Quoted");
    expect(source).toContain("Estimated");
    expect(source).toContain("Cost not available");
    expect(source).toContain("Execution cost is not quoted before this run.");
    expect(source).not.toContain("last run cost");
  });
});
