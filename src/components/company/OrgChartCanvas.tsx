"use client";

import { useCallback, useMemo, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, Panel, type Node, type BuiltInEdge, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CompanyRecord, DepartmentRecord, EmployeeRecord } from "@/lib/company/types";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import { layoutGraph } from "@/lib/flow/graph-layout";
import { companyChartLayout, departmentAccentVar } from "@/lib/company/chart-graph";
import { SEAT_STATUS_LEGEND } from "@/lib/company/presentation";
import OrgChartNode, { type OrgChartNodeData } from "./OrgChartNode";
import "./orgchart.css";

type OrgChartRfNode = Node<OrgChartNodeData, "orgChart">;

const NODE_TYPES: NodeTypes = { orgChart: OrgChartNode };

export interface OrgChartEmployee extends EmployeeRecord {
  /** The real flow id behind this employee's agent, same field the existing
   * "Studio" link on the flat list view already reads. Undefined when the
   * employee's agent/flow no longer resolves. */
  flowId?: string;
  /** Real settled revenue attributed to this employee for the books period
   * currently loaded (summed creatorUsdc from the same ledger the Books
   * panel reads). Every employee settles to the shared company wallet
   * today — this is not a per-agent wallet balance, just this agent's share
   * of it, shown ahead of the per-agent wallet work. */
  earnedUsdc?: number;
  /** True when this employee's agent settles paid calls live (the dashboard's
   * "Live agents" stat reads the same flag). Drives the pulsing live dot. */
  live?: boolean;
  /** Per-call USDC price from the agent's paid-call trigger, when it has one. */
  priceUsdc?: number;
  /** Human-readable run cadence (e.g. "daily at 09:00 UTC") when the agent
   * ships a schedule trigger. */
  scheduleLabel?: string;
}

export interface OrgChartCanvasProps {
  company: CompanyRecord;
  departments: readonly DepartmentRecord[];
  employees: readonly OrgChartEmployee[];
  /**
   * Pre-computed nested-flow previews keyed by agentId. When an employee has
   * an entry here, expanding it shows this data directly instead of fetching
   * /api/flows/:id — used by the pre-founding template preview, whose
   * employees have no real flow yet.
   */
  staticNestedFlows?: Record<string, NestedFlowState>;
}

export type NestedFlowState = NonNullable<OrgChartNodeData["nestedFlow"]>;

function OrgChartCanvasInner({ company, departments, employees, staticNestedFlows }: OrgChartCanvasProps): React.JSX.Element {
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [nestedFlowByAgentId, setNestedFlowByAgentId] = useState<Record<string, NestedFlowState>>({});

  const layout = useMemo(() => {
    try {
      return { data: companyChartLayout(company, departments, employees), error: false as const };
    } catch {
      return { data: null, error: true as const };
    }
  }, [company, departments, employees]);

  const loadNestedFlow = useCallback(async (agentId: string, flowId: string) => {
    setNestedFlowByAgentId((current) => ({ ...current, [agentId]: { status: "loading" } }));
    try {
      const response = await fetch(`/api/flows/${flowId}`);
      if (!response.ok) {
        setNestedFlowByAgentId((current) => ({ ...current, [agentId]: { status: "error" } }));
        return;
      }
      const { flow } = (await response.json()) as { flow: SupportedFlowGraph };
      const nodes = flow.nodes.map((node) => ({
        id: node.id,
        label: getNodeDefinition(node.type).label,
        nodeType: node.type,
      }));
      // Skip laying out an oversized flow entirely — OrgChartNode caps
      // display past 12 nodes anyway, so don't spend layout work a capped
      // preview will never render.
      const positions = nodes.length <= 12 ? layoutGraph(flow) : undefined;
      setNestedFlowByAgentId((current) => ({
        ...current,
        [agentId]: { status: "ready", nodes, positions },
      }));
    } catch {
      setNestedFlowByAgentId((current) => ({ ...current, [agentId]: { status: "error" } }));
    }
  }, []);

  const toggleExpand = useCallback((employee: OrgChartEmployee) => {
    const agentId = employee.agentId;
    setExpandedAgentId((current) => (current === agentId ? null : agentId));
    if (nestedFlowByAgentId[agentId]) return;
    const staticFlow = staticNestedFlows?.[agentId];
    if (staticFlow) {
      setNestedFlowByAgentId((current) => ({ ...current, [agentId]: staticFlow }));
      return;
    }
    if (employee.flowId) {
      void loadNestedFlow(agentId, employee.flowId);
    }
  }, [loadNestedFlow, nestedFlowByAgentId, staticNestedFlows]);

  /** Department id -> accent CSS var, cycled deterministically by department
   * index — the accent every seat and edge in that branch inherits. */
  const accentByDepartmentId = useMemo(
    () => new Map(departments.map((d, index) => [d.id, departmentAccentVar(index)])),
    [departments],
  );

  const rfNodes = useMemo<OrgChartRfNode[]>(() => {
    if (!layout.data) return [];
    const { mode, positions, ceoAgentId, parentByAgentId } = layout.data;
    const nodes: OrgChartRfNode[] = [
      {
        id: `company:${company.id}`,
        type: "orgChart",
        position: positions[`company:${company.id}`] ?? { x: 0, y: 0 },
        data: { kind: "company", label: company.name, subtitle: company.mission },
      },
    ];
    if (mode === "departments") {
      const departmentEmployeeCounts = new Map<string, number>();
      for (const e of employees) {
        departmentEmployeeCounts.set(e.departmentId, (departmentEmployeeCounts.get(e.departmentId) ?? 0) + 1);
      }
      for (const d of departments) {
        const count = departmentEmployeeCounts.get(d.id) ?? 0;
        nodes.push({
          id: `dept:${d.id}`,
          type: "orgChart",
          position: positions[`dept:${d.id}`] ?? { x: 0, y: 0 },
          data: {
            kind: "department",
            label: d.name,
            subtitle: `${count} seat${count === 1 ? "" : "s"}`,
            accentVar: accentByDepartmentId.get(d.id),
          },
        });
      }
    }
    // In reporting mode every parentByAgentId value that points at a seat
    // marks that seat as somebody's manager.
    const managerNodeIds = new Set<string>();
    if (mode === "reporting") {
      for (const parentNodeId of parentByAgentId.values()) managerNodeIds.add(parentNodeId);
    }
    const departmentIds = new Set(departments.map((d) => d.id));
    for (const e of employees) {
      // Departments mode keeps its orphan filter (matches chart-graph's own);
      // reporting mode renders every seat — a dangling departmentId only
      // costs the seat its department accent.
      if (mode === "departments" && !departmentIds.has(e.departmentId)) continue;
      const position = positions[`emp:${e.agentId}`];
      if (!position) continue;
      const expanded = expandedAgentId === e.agentId;
      nodes.push({
        id: `emp:${e.agentId}`,
        type: "orgChart",
        position,
        // Only one node expands at a time; raising it above every sibling is
        // what lets the flow-peek popover float over the chart instead of
        // sliding under later-rendered nodes.
        zIndex: expanded ? 50 : 0,
        data: {
          kind: "employee",
          label: e.jobDescription,
          accentVar: accentByDepartmentId.get(e.departmentId) ?? "var(--primary)",
          expanded,
          onToggleExpand: () => toggleExpand(e),
          studioHref: e.flowId ? `/build/${e.flowId}` : undefined,
          nestedFlow: expanded ? nestedFlowByAgentId[e.agentId] : undefined,
          live: e.live ?? false,
          priceUsdc: e.priceUsdc,
          scheduleLabel: e.scheduleLabel,
          earnedUsdc: e.earnedUsdc,
          walletLabel: e.payTo ? `Own wallet ${e.payTo.slice(0, 6)}…${e.payTo.slice(-4)}` : undefined,
          lifecycleStatus: e.lifecycleStatus,
          agentMissing: e.flowId === undefined,
          roleKind:
            mode === "reporting"
              ? e.agentId === ceoAgentId
                ? ("ceo" as const)
                : managerNodeIds.has(`emp:${e.agentId}`)
                  ? ("manager" as const)
                  : ("worker" as const)
              : undefined,
          lastHeartbeatAt: e.lastHeartbeatAt,
          heartbeatEnabled: e.heartbeatEnabled,
          heartbeatIntervalSeconds: e.heartbeatIntervalSeconds,
        },
      });
    }
    return nodes;
  }, [layout.data, company, departments, employees, accentByDepartmentId, expandedAgentId, nestedFlowByAgentId, toggleExpand]);

  /** Employee agentId -> department accent, for coloring reporting-mode
   * edges by the CHILD seat's department. */
  const accentByAgentId = useMemo(
    () => new Map(employees.map((e) => [e.agentId, accentByDepartmentId.get(e.departmentId) ?? "var(--primary)"])),
    [employees, accentByDepartmentId],
  );

  const rfEdges = useMemo<BuiltInEdge[]>(
    () => (layout.data?.graph.edges ?? []).map((edge): BuiltInEdge => {
      if (layout.data?.mode === "reporting") {
        // Root->CEO edge reads as the trunk; manager->report edges as leaves.
        // Accent comes from the CHILD seat's department so a manager's
        // reports still color by their own branch.
        const isTrunkEdge = edge.source.startsWith("company:");
        const childAgentId = edge.target.slice("emp:".length);
        const accent = accentByAgentId.get(childAgentId) ?? "var(--primary)";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "smoothstep",
          pathOptions: { borderRadius: 8 },
          style: isTrunkEdge
            ? { stroke: accent, strokeWidth: 2, strokeOpacity: 0.85 }
            : { stroke: accent, strokeWidth: 1.4, strokeOpacity: 0.55 },
        };
      }
      // company->dept edges target "dept:{id}"; dept->emp edges source it.
      const isTrunkEdge = edge.target.startsWith("dept:");
      const departmentId = isTrunkEdge
        ? edge.target.slice("dept:".length)
        : edge.source.slice("dept:".length);
      const accent = accentByDepartmentId.get(departmentId) ?? "var(--hairline-cyan)";
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        // Tighter corner radius than the default reads as a drawn org-chart
        // elbow rather than a soft flow curve.
        pathOptions: { borderRadius: 8 },
        style: isTrunkEdge
          ? { stroke: accent, strokeWidth: 2, strokeOpacity: 0.85 }
          : { stroke: accent, strokeWidth: 1.4, strokeOpacity: 0.55 },
      };
    }),
    [layout.data, accentByDepartmentId, accentByAgentId],
  );

  /** Seats actually rendered — in reporting mode every employee gets a seat;
   * in departments mode only employees in a department that still exists.
   * Gates the no-seats hint so it never shows over a populated chart. */
  const seatCount = useMemo(() => {
    if (layout.data?.mode === "reporting") return employees.length;
    const ids = new Set(departments.map((d) => d.id));
    return employees.reduce((sum, e) => (ids.has(e.departmentId) ? sum + 1 : sum), 0);
  }, [layout.data, departments, employees]);

  if (layout.error) {
    return (
      <div className="oc-error" role="alert">
        Couldn&rsquo;t build this chart.
      </div>
    );
  }

  return (
    <div className="oc-canvas">
      <ReactFlow<OrgChartRfNode, BuiltInEdge>
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnScroll
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        style={{ background: "var(--canvas-bg)" }}
      >
        <Background color="var(--canvas-dot)" gap={22} size={1} />
        <Controls
          position="bottom-left"
          showInteractive={false}
          style={{
            background: "var(--ink-panel)",
            border: "1px solid var(--hairline)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-sm)",
          }}
        />
        <Panel position="top-right" className="oc-legend">
          <span className="oc-legend-item">
            <i className="oc-swatch oc-swatch--company" aria-hidden="true" />
            Company
          </span>
          {layout.data?.mode === "departments" && (
            <span className="oc-legend-item">
              <i className="oc-swatch oc-swatch--dept" aria-hidden="true" />
              Department
            </span>
          )}
          {SEAT_STATUS_LEGEND.map((meta) => (
            <span key={meta.tone} className="oc-legend-item">
              <i
                className={`oc-swatch oc-swatch--status${meta.pulsing ? " is-pulsing" : ""}`}
                style={{ background: meta.cssVar }}
                aria-hidden="true"
              />
              {meta.label}
            </span>
          ))}
          <span className="oc-legend-item">
            <i className="oc-swatch oc-swatch--live" aria-hidden="true" />
            Live
          </span>
          <span className="oc-legend-item">
            <i className="oc-swatch oc-swatch--earning" aria-hidden="true" />
            Earning
          </span>
        </Panel>
        {seatCount === 0 && (
          <Panel position="top-center" className="oc-empty-hint">
            No agent seats yet. Hire your first employee and it appears here.
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

export default function OrgChartCanvas(props: OrgChartCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <OrgChartCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
