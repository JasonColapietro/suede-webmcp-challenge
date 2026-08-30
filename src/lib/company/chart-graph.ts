/**
 * Adapts real Company/Department/Employee data into the synthetic
 * FlowGraphV1 shape layoutGraphTopDown requires, purely to reuse its tested
 * layered-DAG positioning for org-chart display. This synthetic graph is
 * never persisted, run, or exposed as an editable flow.
 */
import type { CompanyRecord, DepartmentRecord, EmployeeRecord } from "@/lib/company/types";
import type { FlowGraphV1, Point } from "@/lib/flow/types";
import { layoutGraphTopDown } from "@/lib/flow/graph-layout";
import { parseEmployeeRole, resolveEffectiveRole } from "@/lib/company/roles";

// layoutGraph/layoutGraphTopDown never read node.type — "input" is an
// arbitrary valid NodeType chosen only to satisfy the type checker.
const CHART_NODE_TYPE = "input" as const;

/**
 * Department accent palette — the same four category colors the landing page
 * cycles for its org-card mockups (see chrome.css --c usage). Cycled by
 * department index so every department gets a stable, deterministic accent
 * that its employee seats and edges inherit.
 */
export const DEPARTMENT_ACCENT_VARS = [
  "var(--registry-cyan)",
  "var(--violet)",
  "var(--amber)",
  "var(--verified-emerald)",
] as const;

export function departmentAccentVar(departmentIndex: number): string {
  const index = ((departmentIndex % DEPARTMENT_ACCENT_VARS.length) + DEPARTMENT_ACCENT_VARS.length) % DEPARTMENT_ACCENT_VARS.length;
  return DEPARTMENT_ACCENT_VARS[index];
}

/**
 * layoutGraphTopDown reuses the builder's pitch constants (150px between
 * siblings, 300px between ranks) — tuned for wide horizontal flow cards, not
 * org-chart seat cards. Seat cards are ~186px wide, so 150px sibling pitch
 * makes neighbors overlap; 300px rank pitch pushes a 3-level chart far
 * off-screen. Rescale: siblings get clearance, ranks tighten.
 */
const SIBLING_PITCH_SCALE = 1.45; // 150px -> ~218px between column centers
const RANK_PITCH_SCALE = 0.62; // 300px -> ~186px between levels

export function companyChartGraph(
  company: CompanyRecord,
  departments: readonly DepartmentRecord[],
  employees: readonly EmployeeRecord[],
): FlowGraphV1 {
  const rootId = `company:${company.id}`;
  const departmentIds = new Set(departments.map((d) => d.id));
  // Exclude employees referencing a department that no longer exists rather
  // than letting a dangling edge make layoutGraph throw and take down the
  // whole chart over one orphaned record.
  const validEmployees = employees.filter((e) => departmentIds.has(e.departmentId));

  const nodes: FlowGraphV1["nodes"] = [
    { id: rootId, type: CHART_NODE_TYPE, params: {}, position: { x: 0, y: 0 } },
    ...departments.map((d) => ({
      id: `dept:${d.id}`, type: CHART_NODE_TYPE, params: {}, position: { x: 0, y: 0 },
    })),
    ...validEmployees.map((e) => ({
      id: `emp:${e.agentId}`, type: CHART_NODE_TYPE, params: {}, position: { x: 0, y: 0 },
    })),
  ];
  const edges: FlowGraphV1["edges"] = [
    ...departments.map((d) => ({
      id: `e:${rootId}->dept:${d.id}`, source: rootId, target: `dept:${d.id}`,
    })),
    ...validEmployees.map((e) => ({
      id: `e:dept:${e.departmentId}->emp:${e.agentId}`,
      source: `dept:${e.departmentId}`,
      target: `emp:${e.agentId}`,
    })),
  ];
  return { id: `chart:${company.id}`, name: `${company.name} chart`, nodes, edges };
}

export function companyChartPositions(
  company: CompanyRecord,
  departments: readonly DepartmentRecord[],
  employees: readonly EmployeeRecord[],
): Record<string, Point> {
  return rescalePositions(layoutGraphTopDown(companyChartGraph(company, departments, employees)));
}

function rescalePositions(raw: Record<string, Point>): Record<string, Point> {
  return Object.fromEntries(
    Object.entries(raw).map(([id, point]) => [
      id,
      { x: point.x * SIBLING_PITCH_SCALE, y: point.y * RANK_PITCH_SCALE },
    ]),
  );
}

/**
 * Which chart shape a roster gets. "reporting" is the Paperclip-style tree —
 * company card at the apex, CEO directly beneath, reports cascading down —
 * and applies as soon as any employee carries an explicit reporting link or a
 * stored 'ceo' role. Rosters with neither (template previews, legacy
 * companies whose rows predate the org-chart columns) keep the existing
 * department-grouped rendering unchanged.
 */
export type CompanyChartMode = "reporting" | "departments";

export interface CompanyChartLayout {
  readonly mode: CompanyChartMode;
  readonly graph: FlowGraphV1;
  readonly positions: Record<string, Point>;
  readonly ceoAgentId: string | null;
  readonly parentByAgentId: ReadonlyMap<string, string>;
}

export function companyChartMode(employees: readonly EmployeeRecord[]): CompanyChartMode {
  const hasReportingSignal = employees.some(
    (employee) => employee.reportsTo != null || parseEmployeeRole(employee.role) === "ceo",
  );
  return hasReportingSignal ? "reporting" : "departments";
}

/**
 * One layout for both chart shapes. Departments mode delegates to the
 * existing department-grouped graph untouched. Reporting mode builds a
 * synthetic tree from each employee's resolved reporting chain instead of
 * its department, so employees whose department was deleted still render —
 * the chain, not the department, is the structure.
 *
 * Deterministic and never-throwing: a reportsTo that is missing, inactive,
 * or self-referential falls back to the CEO (or, with no CEO, the company
 * root), and any cycle in the stored chain re-parents its members the same
 * way rather than producing an unwalkable graph.
 */
export function companyChartLayout(
  company: CompanyRecord,
  departments: readonly DepartmentRecord[],
  employees: readonly EmployeeRecord[],
): CompanyChartLayout {
  if (companyChartMode(employees) === "departments") {
    return {
      mode: "departments",
      graph: companyChartGraph(company, departments, employees),
      positions: companyChartPositions(company, departments, employees),
      ceoAgentId: null,
      parentByAgentId: new Map<string, string>(),
    };
  }

  const rootId = `company:${company.id}`;
  const activeIds = new Set(employees.map((e) => e.agentId));
  const ceo = employees.find(
    (employee) => resolveEffectiveRole(employee, employees) === "ceo",
  );
  const ceoAgentId = ceo?.agentId ?? null;

  // First pass: each employee's provisional parent AGENT id (null = the
  // company root). The CEO always hangs off the root; everyone else follows
  // reportsTo when it names another active employee, else the CEO.
  const provisionalParent = new Map<string, string | null>();
  for (const employee of employees) {
    if (employee.agentId === ceoAgentId) {
      provisionalParent.set(employee.agentId, null);
      continue;
    }
    const reportsTo = employee.reportsTo ?? null;
    const parentIsValid =
      reportsTo !== null && reportsTo !== employee.agentId && activeIds.has(reportsTo);
    provisionalParent.set(employee.agentId, parentIsValid ? reportsTo : ceoAgentId);
  }

  // Second pass: break cycles. Walk each employee's parent chain; anyone
  // whose chain revisits a node before reaching the root gets re-parented
  // to the CEO (or the company root when no CEO exists).
  for (const employee of employees) {
    const visited = new Set<string>([employee.agentId]);
    let cursor = provisionalParent.get(employee.agentId) ?? null;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        provisionalParent.set(employee.agentId, ceoAgentId === employee.agentId ? null : ceoAgentId);
        break;
      }
      visited.add(cursor);
      cursor = provisionalParent.get(cursor) ?? null;
    }
  }

  const parentByAgentId = new Map<string, string>();
  for (const employee of employees) {
    const parentAgentId = provisionalParent.get(employee.agentId) ?? null;
    parentByAgentId.set(
      employee.agentId,
      parentAgentId === null ? rootId : `emp:${parentAgentId}`,
    );
  }

  const nodes: FlowGraphV1["nodes"] = [
    { id: rootId, type: CHART_NODE_TYPE, params: {}, position: { x: 0, y: 0 } },
    ...employees.map((e) => ({
      id: `emp:${e.agentId}`, type: CHART_NODE_TYPE, params: {}, position: { x: 0, y: 0 },
    })),
  ];
  const edges: FlowGraphV1["edges"] = employees.map((e) => {
    const parentNodeId = parentByAgentId.get(e.agentId) ?? rootId;
    return {
      id: `e:${parentNodeId}->emp:${e.agentId}`,
      source: parentNodeId,
      target: `emp:${e.agentId}`,
    };
  });
  const graph: FlowGraphV1 = {
    id: `chart:${company.id}`,
    name: `${company.name} chart`,
    nodes,
    edges,
  };

  return {
    mode: "reporting",
    graph,
    positions: rescalePositions(layoutGraphTopDown(graph)),
    ceoAgentId,
    parentByAgentId,
  };
}
