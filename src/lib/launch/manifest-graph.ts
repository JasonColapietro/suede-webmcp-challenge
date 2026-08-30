/**
 * Manifest → the graph body that POST /api/flows accepts, in the browser.
 *
 * The canonical compilers live in @/lib/manifest/to-flow, but they pull
 * node:crypto and viem through their server graph and can never enter a
 * client bundle (see AGENTS.md's client/server split). Guided and the
 * build-from-a-website path both need to turn a drafted manifest into a flow
 * from the browser, so this is the one small, dependency-free version of that
 * translation they share.
 *
 * Layout matches the seed templates: left-to-right, 240px columns, one row.
 */

export interface LaunchTrigger {
  readonly kind: "manual" | "schedule" | "paidCall" | "webhook";
  readonly cron?: string;
  readonly priceUsdc?: number;
}

export interface LaunchStep {
  readonly id: string;
  readonly type: string;
  readonly config: Record<string, unknown>;
  readonly after: ReadonlyArray<string | { node: string; handle?: string }>;
}

export interface LaunchManifest {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly LaunchTrigger[];
  readonly steps: readonly LaunchStep[];
  readonly meta: { template?: string; createdBy?: string };
}

export interface LaunchGraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface LaunchGraphEdge {
  id: string;
  source: string;
  target: string;
  targetHandle: string;
  sourceHandle?: string;
}

export interface LaunchGraph {
  id: string;
  name: string;
  nodes: LaunchGraphNode[];
  edges: LaunchGraphEdge[];
  meta: Record<string, unknown>;
}

const ROW_Y = 120;
/* Node cards render up to 300px wide (SuedeNode maxWidth); 340 keeps a real
   gutter between wired columns instead of the old overlapping 240 pitch. */
const COL_X = 340;
const FIRST_X = 80;
export const SCHEDULE_NODE_ID = "trig-schedule";

/** The per-call price a paidCall trigger asks for, or 0 when the agent is free. */
export function launchPriceUsdc(manifest: LaunchManifest): number {
  const paid = manifest.triggers.find((trigger) => trigger.kind === "paidCall");
  return typeof paid?.priceUsdc === "number" ? paid.priceUsdc : 0;
}

/**
 * Build the flow graph for a drafted manifest. A schedule trigger becomes a
 * leading `schedule` node wired to every step that has no upstream, which is
 * how the launch route discovers the cron.
 */
export function buildLaunchGraph(manifest: LaunchManifest, graphId: string): LaunchGraph {
  const schedule = manifest.triggers.find((trigger) => trigger.kind === "schedule");
  const offset = schedule ? 1 : 0;

  const nodes: LaunchGraphNode[] = manifest.steps.map((step, index) => ({
    id: step.id,
    type: step.type,
    params: { ...step.config },
    position: { x: FIRST_X + (index + offset) * COL_X, y: ROW_Y },
  }));

  if (schedule) {
    nodes.unshift({
      id: SCHEDULE_NODE_ID,
      type: "schedule",
      params: { cron: schedule.cron ?? "" },
      position: { x: FIRST_X, y: ROW_Y },
    });
  }

  const edges: LaunchGraphEdge[] = manifest.steps.flatMap((step) =>
    step.after.map((entry) => {
      const source = typeof entry === "string" ? entry : entry.node;
      const sourceHandle = typeof entry === "string" ? undefined : entry.handle;
      return {
        id: sourceHandle ? `${source}:${sourceHandle}->${step.id}` : `${source}->${step.id}`,
        source,
        target: step.id,
        targetHandle: "in",
        ...(sourceHandle ? { sourceHandle } : {}),
      };
    }),
  );

  if (schedule) {
    for (const step of manifest.steps) {
      if (step.after.length > 0) continue;
      edges.push({
        id: `${SCHEDULE_NODE_ID}->${step.id}`,
        source: SCHEDULE_NODE_ID,
        target: step.id,
        targetHandle: "in",
      });
    }
  }

  return {
    id: graphId,
    name: manifest.name,
    nodes,
    edges,
    meta: { ...manifest.meta, description: manifest.description },
  };
}
