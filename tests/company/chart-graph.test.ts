import { describe, expect, it } from "vitest";
import { companyChartGraph, companyChartPositions } from "@/lib/company/chart-graph";
import type { CompanyRecord, DepartmentRecord, EmployeeRecord } from "@/lib/company/types";

const company: CompanyRecord = {
  id: "co1",
  ownerId: "owner1",
  name: "Acme",
  mission: "Ship things",
  status: "active",
  fireCostThresholdUsdc: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function department(id: string): DepartmentRecord {
  return { id, companyId: company.id, name: id, monthlyBudgetUsdc: null };
}

function employee(agentId: string, departmentId: string): EmployeeRecord {
  return {
    agentId,
    companyId: company.id,
    departmentId,
    jobDescription: agentId,
    publishGated: false,
    monthlyBudgetUsdc: null,
    payTo: null,
  };
}

describe("companyChartGraph", () => {
  it("builds a root, one node per department, and one node per employee, with matching edges", () => {
    const departments = [department("empty"), department("staffed")];
    const employees = [employee("emp-a", "staffed"), employee("emp-b", "staffed")];
    const graph = companyChartGraph(company, departments, employees);

    expect(graph.nodes).toHaveLength(5);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      ["company:co1", "dept:empty", "dept:staffed", "emp:emp-a", "emp:emp-b"].sort(),
    );
    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(
      [
        "company:co1->dept:empty",
        "company:co1->dept:staffed",
        "dept:staffed->emp:emp-a",
        "dept:staffed->emp:emp-b",
      ].sort(),
    );
  });

  it("excludes an employee whose department no longer exists instead of producing a dangling edge", () => {
    const departments = [department("real")];
    const employees = [employee("emp-a", "real"), employee("orphan", "deleted-department")];
    const graph = companyChartGraph(company, departments, employees);

    expect(graph.nodes.map((n) => n.id)).not.toContain("emp:orphan");
    expect(graph.edges.some((e) => e.target === "emp:orphan")).toBe(false);
  });

  it("produces just the root for an empty company, no edges", () => {
    const graph = companyChartGraph(company, [], []);
    expect(graph.nodes).toEqual([
      { id: "company:co1", type: "input", params: {}, position: { x: 0, y: 0 } },
    ]);
    expect(graph.edges).toEqual([]);
  });
});

describe("companyChartPositions", () => {
  it("positions the root above every department, and every department above its employees", () => {
    const departments = [department("d1")];
    const employees = [employee("emp-a", "d1")];
    const positions = companyChartPositions(company, departments, employees);

    expect(Object.keys(positions).sort()).toEqual(
      ["company:co1", "dept:d1", "emp:emp-a"].sort(),
    );
    expect(positions["company:co1"]!.y).toBeLessThan(positions["dept:d1"]!.y);
    expect(positions["dept:d1"]!.y).toBeLessThan(positions["emp:emp-a"]!.y);
  });

  it("does not throw for an empty company", () => {
    expect(() => companyChartPositions(company, [], [])).not.toThrow();
  });
});
