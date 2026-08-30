/**
 * Integration test for hireEmployeeIntoCompany (src/lib/company/founding.ts)
 * against a real SqliteRepo(":memory:") — mirrors the harness in
 * tests/api-company-founding.test.ts.
 */
import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { materializeCompanyDraft, templateToDraft, hireEmployeeIntoCompany } from "@/lib/company/founding";
import { AgentManifestSchema } from "@/lib/manifest/schema";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

describe("hireEmployeeIntoCompany", () => {
  it("adds exactly one new active employee row via addEmployee, in the requested department", async () => {
    const repo = makeRepo();
    const draft = templateToDraft("content-studio");
    if (!draft) throw new Error("content-studio template missing");
    const { companyId } = await materializeCompanyDraft("owner-1", draft, repo);
    const departments = await repo.listDepartments(companyId);
    const marketing = departments.find((d) => d.name === "Marketing");
    if (!marketing) throw new Error("Marketing department missing from content-studio");

    const before = await repo.listEmployees(companyId);

    const manifest = AgentManifestSchema.parse({
      manifestVersion: 1,
      name: "Note Taker",
      description: "Takes notes on every campaign call.",
      triggers: [{ kind: "paidCall", priceUsdc: 0 }],
      steps: [
        { id: "n1", type: "llm", config: { prompt: "Take notes" }, after: [] },
        { id: "n2", type: "output", config: {}, after: ["n1"] },
      ],
      meta: { createdBy: "guided" },
    });

    const { agentId } = await hireEmployeeIntoCompany(
      "owner-1",
      {
        companyId,
        departmentId: marketing.id,
        slug: "note-taker",
        jobDescription: "Takes notes on every campaign call.",
        monthlyBudgetUsdc: 25,
        manifest,
      },
      repo,
    );

    const after = await repo.listEmployees(companyId);
    expect(after.length).toBe(before.length + 1);

    const hired = await repo.getEmployeeByAgent(agentId);
    expect(hired).not.toBeNull();
    expect(hired?.companyId).toBe(companyId);
    expect(hired?.departmentId).toBe(marketing.id);
    expect(hired?.jobDescription).toBe("Takes notes on every campaign call.");
    expect(hired?.monthlyBudgetUsdc).toBe(25);
    expect(hired?.publishGated).toBe(false);

    const agent = await repo.getAgent(agentId);
    expect(agent).not.toBeNull();
    expect(agent?.status).toBe("draft");
    expect(agent?.settlementLive).toBe(false);
  });
});
