/**
 * Adapts a CompanyTemplate into the synthetic CompanyRecord / DepartmentRecord /
 * OrgChartEmployee shapes OrgChartCanvas renders, so a template's pre-staffed
 * org chart can be shown live BEFORE founding. Nothing here is persisted or
 * run — ids are namespaced "preview:" and never reach an API. Each employee
 * also gets a nested-flow preview built from its manifest steps, reusing the
 * same layoutGraph the post-founding chart uses, so clicking an employee in
 * the preview shows the real flow they ship with.
 */
import type { CompanyTemplate } from "@/lib/company/templates";
import type { CompanyRecord, DepartmentRecord } from "@/lib/company/types";
import type { OrgChartEmployee } from "@/components/company/OrgChartCanvas";
import type { OrgChartNestedFlowNode } from "@/components/company/OrgChartNode";
import type { FlowGraphV1, NodeType, Point } from "@/lib/flow/types";
import { NODE_DEFINITION_BY_TYPE } from "@/lib/flow/node-definitions";
import { layoutGraph } from "@/lib/flow/graph-layout";
import type { ManifestStep, ManifestTrigger } from "@/lib/manifest/schema";
import { describeCron } from "@/lib/cron";

export interface TemplatePreviewNestedFlow {
  readonly status: "ready";
  readonly nodes: readonly OrgChartNestedFlowNode[];
  readonly positions?: Record<string, Point>;
}

export interface TemplateOrgPreview {
  readonly company: CompanyRecord;
  readonly departments: readonly DepartmentRecord[];
  readonly employees: readonly OrgChartEmployee[];
  /** Keyed by the synthetic agentId of each preview employee. */
  readonly nestedFlows: Record<string, TemplatePreviewNestedFlow>;
}

function isKnownNodeType(type: string): type is NodeType {
  return type in NODE_DEFINITION_BY_TYPE;
}

function afterSourceId(entry: ManifestStep["after"][number]): string {
  return typeof entry === "string" ? entry : entry.node;
}

/**
 * Build the nested-flow preview for one employee from its manifest steps.
 * Steps whose type isn't a known NodeType make the whole preview bail (return
 * null) rather than rendering a partial, misleading graph.
 */
function manifestNestedFlow(
  agentId: string,
  steps: readonly ManifestStep[],
): TemplatePreviewNestedFlow | null {
  const nodes: OrgChartNestedFlowNode[] = [];
  for (const step of steps) {
    if (!isKnownNodeType(step.type)) return null;
    nodes.push({
      id: step.id,
      label: step.label ?? NODE_DEFINITION_BY_TYPE[step.type].label,
      nodeType: step.type,
    });
  }
  const stepIds = new Set(steps.map((s) => s.id));
  const graph: FlowGraphV1 = {
    id: `preview-flow:${agentId}`,
    name: `preview-flow:${agentId}`,
    nodes: steps.map((step) => ({
      id: step.id,
      // Safe: every step.type was verified by isKnownNodeType above.
      type: step.type as NodeType,
      params: {},
      position: { x: 0, y: 0 },
    })),
    edges: steps.flatMap((step) =>
      step.after
        .map(afterSourceId)
        .filter((source) => stepIds.has(source))
        .map((source) => ({
          id: `e:${source}->${step.id}`,
          source,
          target: step.id,
        })),
    ),
  };
  try {
    return { status: "ready", nodes, positions: layoutGraph(graph) };
  } catch {
    // A layout failure (e.g. a cyclic template) degrades to the unpositioned
    // list rendering NestedFlowPreview already supports.
    return { status: "ready", nodes };
  }
}

export function templateOrgPreview(template: CompanyTemplate): TemplateOrgPreview {
  const company: CompanyRecord = {
    id: `preview:${template.slug}`,
    ownerId: "preview",
    name: template.name,
    mission: template.mission,
    status: "draft",
    fireCostThresholdUsdc: null,
    createdAt: new Date(0).toISOString(),
  };
  const departments: DepartmentRecord[] = template.departments.map((dept, index) => ({
    id: `preview:${template.slug}:dept:${index}`,
    companyId: company.id,
    name: dept.name,
    monthlyBudgetUsdc: dept.monthlyBudgetUsdc,
  }));
  // Every founded company opens with a CEO seat the founder directs, so the
  // preview models the same reporting cascade: CEO at the apex, every
  // pre-staffed seat reporting in. This is what flips the chart into
  // reporting mode (companyChartMode) instead of the departments fallback.
  const ceoAgentId = `preview:${template.slug}:emp:ceo`;
  const employees: OrgChartEmployee[] = [
    {
      agentId: ceoAgentId,
      companyId: company.id,
      departmentId: `preview:${template.slug}:dept:ceo`,
      jobDescription: "Chief Executive",
      publishGated: false,
      monthlyBudgetUsdc: null,
      payTo: null,
      role: "ceo",
      reportsTo: null,
    },
  ];
  const nestedFlows: Record<string, TemplatePreviewNestedFlow> = {};
  template.departments.forEach((dept, index) => {
    for (const emp of dept.employees) {
      const agentId = `preview:${template.slug}:emp:${emp.slug}`;
      // Surface the template's own commercial facts on the preview chart:
      // the per-call price and cadence each seat ships with. `live` stays
      // unset — nothing sells before founding.
      const paidCall = emp.manifest.triggers.find(
        (t): t is Extract<ManifestTrigger, { kind: "paidCall" }> => t.kind === "paidCall",
      );
      const schedule = emp.manifest.triggers.find(
        (t): t is Extract<ManifestTrigger, { kind: "schedule" }> => t.kind === "schedule",
      );
      employees.push({
        agentId,
        companyId: company.id,
        departmentId: departments[index].id,
        jobDescription: emp.jobDescription,
        publishGated: emp.publishGated ?? false,
        monthlyBudgetUsdc: emp.monthlyBudgetUsdc ?? null,
        payTo: null,
        reportsTo: ceoAgentId,
        priceUsdc: paidCall?.priceUsdc,
        scheduleLabel: schedule ? describeCron(schedule.cron) : undefined,
      });
      const nested = manifestNestedFlow(agentId, emp.manifest.steps);
      if (nested) nestedFlows[agentId] = nested;
    }
  });
  return { company, departments, employees, nestedFlows };
}
