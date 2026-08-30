/**
 * Unit tests for the org-chart layout adapter (src/lib/company/chart-graph.ts):
 * reporting-mode tree shape (company apex, CEO beneath, reports cascading),
 * orphan re-parenting, cycle breaking, and the departments-mode fallback that
 * keeps template previews and legacy companies on the existing rendering.
 */
import { describe, it, expect } from "vitest";
import {
  companyChartGraph,
  companyChartLayout,
  companyChartMode,
} from "@/lib/company/chart-graph";
import type {
  CompanyRecord,
  DepartmentRecord,
  EmployeeRecord,
} from "@/lib/company/types";

const company: CompanyRecord = {
  id: "co-1",
  ownerId: "owner-1",
  name: "Acme Autonomous",
  mission: "Run the business around the clock.",
  status: "active",
  fireCostThresholdUsdc: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const departments: DepartmentRecord[] = [
  { id: "dept-1", companyId: "co-1", name: "Operations", monthlyBudgetUsdc: null },
];

function makeEmployee(overrides: Partial<EmployeeRecord> & { agentId: string }): EmployeeRecord {
  return {
    companyId: "co-1",
    departmentId: "dept-1",
    jobDescription: "Does the work.",
    publishGated: false,
    monthlyBudgetUsdc: null,
    payTo: null,
    role: null,
    reportsTo: null,
    lifecycleStatus: "idle",
    heartbeatEnabled: false,
    heartbeatIntervalSeconds: null,
    lastHeartbeatAt: null,
    ...overrides,
  };
}

describe("companyChartMode", () => {
  it("returns departments when no employee has reportsTo or a stored ceo role", () => {
    const employees = [makeEmployee({ agentId: "a1" }), makeEmployee({ agentId: "a2" })];
    expect(companyChartMode(employees)).toBe("departments");
  });

  it("returns reporting when any employee has a non-null reportsTo", () => {
    const employees = [
      makeEmployee({ agentId: "a1" }),
      makeEmployee({ agentId: "a2", reportsTo: "a1" }),
    ];
    expect(companyChartMode(employees)).toBe("reporting");
  });

  it("returns reporting when any employee has a stored ceo role", () => {
    const employees = [makeEmployee({ agentId: "a1", role: "ceo" })];
    expect(companyChartMode(employees)).toBe("reporting");
  });
});

describe("companyChartLayout (departments fallback)", () => {
  it("matches the existing department-grouped graph and reports no CEO", () => {
    const employees = [makeEmployee({ agentId: "a1" }), makeEmployee({ agentId: "a2" })];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.mode).toBe("departments");
    expect(layout.ceoAgentId).toBeNull();
    expect(layout.parentByAgentId.size).toBe(0);
    expect(layout.graph).toEqual(companyChartGraph(company, departments, employees));
    expect(layout.graph.nodes.some((n) => n.id === "dept:dept-1")).toBe(true);
    for (const node of layout.graph.nodes) {
      expect(layout.positions[node.id]).toBeDefined();
    }
  });
});

describe("companyChartLayout (reporting mode)", () => {
  it("puts the company at the apex, the CEO beneath it, and reports below the CEO", () => {
    const employees = [
      makeEmployee({ agentId: "ceo", role: "ceo" }),
      makeEmployee({ agentId: "mgr", role: "manager", reportsTo: "ceo" }),
      makeEmployee({ agentId: "wrk", role: "worker", reportsTo: "mgr" }),
    ];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.mode).toBe("reporting");
    expect(layout.ceoAgentId).toBe("ceo");
    expect(layout.parentByAgentId.get("ceo")).toBe("company:co-1");
    expect(layout.parentByAgentId.get("mgr")).toBe("emp:ceo");
    expect(layout.parentByAgentId.get("wrk")).toBe("emp:mgr");

    // No dept: nodes in reporting mode; one edge per employee.
    expect(layout.graph.nodes.some((n) => n.id.startsWith("dept:"))).toBe(false);
    expect(layout.graph.edges.length).toBe(employees.length);
    expect(layout.graph.edges).toContainEqual({
      id: "e:company:co-1->emp:ceo",
      source: "company:co-1",
      target: "emp:ceo",
    });

    // Ranks cascade: company above CEO, CEO above manager, manager above worker.
    const p = layout.positions;
    expect(p["company:co-1"].y).toBeLessThan(p["emp:ceo"].y);
    expect(p["emp:ceo"].y).toBeLessThan(p["emp:mgr"].y);
    expect(p["emp:mgr"].y).toBeLessThan(p["emp:wrk"].y);
  });

  it("re-parents an orphan (reportsTo names a departed agent) to the CEO", () => {
    const employees = [
      makeEmployee({ agentId: "ceo", role: "ceo" }),
      makeEmployee({ agentId: "orphan", role: "worker", reportsTo: "gone" }),
    ];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.parentByAgentId.get("orphan")).toBe("emp:ceo");
  });

  it("re-parents a self-reporting employee to the CEO", () => {
    const employees = [
      makeEmployee({ agentId: "ceo", role: "ceo" }),
      makeEmployee({ agentId: "loner", role: "worker", reportsTo: "loner" }),
    ];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.parentByAgentId.get("loner")).toBe("emp:ceo");
  });

  it("falls back to the company root when no CEO exists", () => {
    // Every role here is stored (no NULLs), so resolveEffectiveRole cannot
    // promote anyone: the roster genuinely has no CEO, and reportsTo links
    // still put it in reporting mode.
    const employees = [
      makeEmployee({ agentId: "m1", role: "manager", reportsTo: null }),
      makeEmployee({ agentId: "w2", role: "worker", reportsTo: "m1" }),
      makeEmployee({ agentId: "w1", role: "worker", reportsTo: "gone" }),
    ];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.mode).toBe("reporting");
    expect(layout.ceoAgentId).toBeNull();
    expect(layout.parentByAgentId.get("m1")).toBe("company:co-1");
    expect(layout.parentByAgentId.get("w2")).toBe("emp:m1");
    expect(layout.parentByAgentId.get("w1")).toBe("company:co-1");
  });

  it("breaks reporting cycles by re-parenting cycle members to the CEO", () => {
    const employees = [
      makeEmployee({ agentId: "ceo", role: "ceo" }),
      makeEmployee({ agentId: "a", role: "manager", reportsTo: "b" }),
      makeEmployee({ agentId: "b", role: "manager", reportsTo: "a" }),
    ];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.parentByAgentId.get("a")).toBe("emp:ceo");
    // Every employee still appears exactly once and the graph lays out.
    expect(layout.parentByAgentId.size).toBe(3);
    for (const node of layout.graph.nodes) {
      expect(layout.positions[node.id]).toBeDefined();
    }
  });

  it("includes employees whose department no longer exists", () => {
    const employees = [
      makeEmployee({ agentId: "ceo", role: "ceo" }),
      makeEmployee({ agentId: "stray", role: "worker", reportsTo: "ceo", departmentId: "deleted" }),
    ];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.graph.nodes.some((n) => n.id === "emp:stray")).toBe(true);
    expect(layout.parentByAgentId.get("stray")).toBe("emp:ceo");
  });

  it("resolves a legacy NULL-role roster's earliest hire as CEO when a reporting link exists", () => {
    const employees = [
      makeEmployee({ agentId: "first" }),
      makeEmployee({ agentId: "second", reportsTo: "first" }),
    ];
    const layout = companyChartLayout(company, departments, employees);
    expect(layout.mode).toBe("reporting");
    expect(layout.ceoAgentId).toBe("first");
    expect(layout.parentByAgentId.get("first")).toBe("company:co-1");
    expect(layout.parentByAgentId.get("second")).toBe("emp:first");
  });
});
