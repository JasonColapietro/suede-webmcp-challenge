import { describe, expect, it, vi } from "vitest";

import { companyServiceSupportsPublicAp2 } from "@/lib/rails/ap2-company-eligibility";

const paidGraph = {
  id: "graph-1",
  name: "Paid service",
  nodes: [{
    id: "input",
    type: "input" as const,
    params: {},
    position: { x: 0, y: 0 },
  }],
  edges: [],
};

function repo(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    getEmployeeByAgent: vi.fn(async () => null),
    getCompany: vi.fn(async () => ({ id: "company-1", status: "active" })),
    listDepartments: vi.fn(async () => [{ id: "department-1" }]),
    ...overrides,
  } as never;
}

const employee = {
  agentId: "agent-1",
  companyId: "company-1",
  departmentId: "department-1",
  publishGated: false,
};

describe("AP2 company-service discovery eligibility", () => {
  it("keeps ordinary published agents eligible", async () => {
    await expect(companyServiceSupportsPublicAp2({
      repo: repo(),
      agentId: "agent-1",
      graph: paidGraph,
    })).resolves.toBe(true);
  });

  it.each([
    ["paused company", {
      getEmployeeByAgent: vi.fn(async () => employee),
      getCompany: vi.fn(async () => ({ id: "company-1", status: "paused" })),
    }],
    ["publish approval gate", {
      getEmployeeByAgent: vi.fn(async () => ({ ...employee, publishGated: true })),
    }],
    ["missing department", {
      getEmployeeByAgent: vi.fn(async () => employee),
      listDepartments: vi.fn(async () => []),
    }],
    ["company store outage", {
      getEmployeeByAgent: vi.fn(async () => employee),
      getCompany: vi.fn(async () => { throw new Error("private store failure"); }),
    }],
  ])("fails discovery closed for a %s", async (_name, overrides) => {
    await expect(companyServiceSupportsPublicAp2({
      repo: repo(overrides),
      agentId: "agent-1",
      graph: paidGraph,
    })).resolves.toBe(false);
  });

  it("suppresses scheduled-only employees that the public paid-call route rejects", async () => {
    await expect(companyServiceSupportsPublicAp2({
      repo: repo({ getEmployeeByAgent: vi.fn(async () => employee) }),
      agentId: "agent-1",
      graph: {
        ...paidGraph,
        nodes: [{
          id: "schedule",
          type: "schedule" as const,
          params: { cron: "0 * * * *" },
          position: { x: 0, y: 0 },
        }],
      },
    })).resolves.toBe(false);
  });
});
