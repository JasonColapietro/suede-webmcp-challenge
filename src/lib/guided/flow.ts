// SERVER-ONLY — the manifest compilers pull node:crypto through their server graph.
// Client components receive the serializable GuidedFlowData shape from /start.
import type { FlowRepo } from "@/lib/db/repo";
import { getRepo } from "@/lib/db/repo";
import { FlowMutationService } from "@/lib/flow/flow-mutation-service";
import { requireFlowGraphV1 } from "@/lib/flow/graph-schema";
import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/flow/types";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import type { AgentManifest } from "@/lib/manifest/schema";
import { isDeepStrictEqual } from "node:util";
import { ZodError } from "zod";

export interface GuidedFlowData {
  flowId: string;
  name: string;
  updatedAt: number;
  manifest: AgentManifest;
}

export class EmptyGuidedFlowError extends Error {
  constructor(cause: unknown) {
    super("Guided editing requires at least one non-schedule step", { cause });
    this.name = "EmptyGuidedFlowError";
  }
}

export type SaveGuidedFlowResult =
  | { status: "saved"; flow: GuidedFlowData }
  | { status: "not-found" }
  | { status: "conflict" };

function paidCallPrice(manifest: AgentManifest): number {
  const trigger = manifest.triggers.find((candidate) => candidate.kind === "paidCall");
  return trigger?.kind === "paidCall" ? trigger.priceUsdc : 0;
}

function nonScheduleTriggers(manifest: AgentManifest): AgentManifest["triggers"] {
  return manifest.triggers.filter((trigger) => trigger.kind !== "schedule");
}

function scheduleTrigger(
  manifest: AgentManifest,
): Extract<AgentManifest["triggers"][number], { kind: "schedule" }> | undefined {
  return manifest.triggers.find(
    (trigger): trigger is Extract<AgentManifest["triggers"][number], { kind: "schedule" }> =>
      trigger.kind === "schedule",
  );
}

function dependencyKey(edge: Pick<FlowEdge, "source" | "sourceHandle" | "target">): string {
  return JSON.stringify([edge.source, edge.sourceHandle ?? null, edge.target]);
}

function uniqueEdgeId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}#${suffix}`)) suffix += 1;
  return `${base}#${suffix}`;
}

/**
 * Apply only fields represented by a changed Guided manifest to an existing
 * Studio graph. Reusing matching graph objects is deliberate: target handles,
 * edge/node ids, layout, selection state, and future passthrough metadata are
 * not representable in a v1 manifest and therefore remain Studio/Code-owned.
 */
export function patchGuidedManifestOntoFlow(
  existing: FlowGraph,
  manifest: AgentManifest,
): FlowGraph {
  const baseline = flowToManifest(existing);
  const generated = manifestToFlow(manifest);
  const baselineSteps = new Map(baseline.steps.map((step) => [step.id, step]));
  const existingNodes = new Map(existing.nodes.map((node) => [node.id, node]));
  const generatedNodes = new Map(generated.nodes.map((node) => [node.id, node]));
  const existingSchedule = existing.nodes.find((node) => node.type === "schedule");
  const baselineSchedule = scheduleTrigger(baseline);
  const nextSchedule = scheduleTrigger(manifest);

  const patchedById = new Map<string, FlowNode>();
  for (const step of manifest.steps) {
    const current = existingNodes.get(step.id);
    const before = baselineSteps.get(step.id);
    if (current && before) {
      patchedById.set(
        step.id,
        isDeepStrictEqual(before, step)
          ? current
          : {
              ...current,
              type: step.type as FlowNode["type"],
              params: isDeepStrictEqual(before.config, step.config)
                ? current.params
                : { ...step.config },
            },
      );
    } else {
      const created = generatedNodes.get(step.id);
      if (!created) throw new TypeError(`Guided step ${step.id} could not be materialized`);
      patchedById.set(step.id, created);
    }
  }

  if (nextSchedule) {
    if (existingSchedule && baselineSchedule) {
      patchedById.set(
        existingSchedule.id,
        baselineSchedule.cron === nextSchedule.cron
          ? existingSchedule
          : {
              ...existingSchedule,
              params: { ...existingSchedule.params, cron: nextSchedule.cron },
            },
      );
    } else {
      const created = generated.nodes.find((node) => node.type === "schedule");
      if (!created) throw new TypeError("Guided schedule could not be materialized");
      patchedById.set(created.id, created);
    }
  }

  // Keep the canvas's original node ordering for survivors. New Guided nodes
  // are appended in manifest order using the compiler's bounded layout.
  const nodes: FlowNode[] = [];
  for (const current of existing.nodes) {
    const patched = patchedById.get(current.id);
    if (patched) {
      nodes.push(patched);
      patchedById.delete(current.id);
    }
  }
  for (const step of manifest.steps) {
    const created = patchedById.get(step.id);
    if (created) {
      nodes.push(created);
      patchedById.delete(step.id);
    }
  }
  for (const created of patchedById.values()) nodes.push(created);

  const topology = (value: AgentManifest): readonly string[] => value.steps
    .map((step) => JSON.stringify([
      step.id,
      step.after
        .map((after) => typeof after === "string"
          ? [after, null]
          : [after.node, after.handle ?? null])
        .sort(),
    ]))
    .sort();
  const baselineTopology = topology(baseline);
  const nextTopology = topology(manifest);
  const scheduleShapeChanged = Boolean(baselineSchedule) !== Boolean(nextSchedule);
  let edges = existing.edges;
  if (!isDeepStrictEqual(baselineTopology, nextTopology) || scheduleShapeChanged) {
    const scheduleId = nodes.find((node) => node.type === "schedule")?.id;
    const desired: Array<Pick<FlowEdge, "source" | "sourceHandle" | "target">> = [];
    for (const step of manifest.steps) {
      for (const after of step.after) {
        desired.push({
          source: typeof after === "string" ? after : after.node,
          ...(typeof after === "string" || after.handle === undefined
            ? {}
            : { sourceHandle: after.handle }),
          target: step.id,
        });
      }
      if (scheduleId && step.after.length === 0) {
        desired.push({ source: scheduleId, target: step.id });
      }
    }

    const reusable = new Map<string, FlowEdge[]>();
    for (const edge of existing.edges) {
      const key = dependencyKey(edge);
      const values = reusable.get(key) ?? [];
      values.push(edge);
      reusable.set(key, values);
    }
    const usedIds = new Set<string>();
    edges = desired.map((dependency) => {
      const match = reusable.get(dependencyKey(dependency))?.shift();
      if (match && !usedIds.has(match.id)) {
        usedIds.add(match.id);
        return match;
      }
      const handlePart = dependency.sourceHandle ? `:${dependency.sourceHandle}` : "";
      const id = uniqueEdgeId(`${dependency.source}${handlePart}->${dependency.target}`, usedIds);
      usedIds.add(id);
      return { id, ...dependency, targetHandle: "in" };
    });
  }

  let meta = existing.meta;
  const mutableMeta = (): Record<string, unknown> => {
    if (meta === existing.meta) meta = { ...(existing.meta ?? {}) };
    return meta!;
  };
  if (baseline.description !== manifest.description) {
    mutableMeta().description = manifest.description;
  }
  if (baseline.payoutAddress !== manifest.payoutAddress) {
    if (manifest.payoutAddress === undefined) delete mutableMeta().payoutAddress;
    else mutableMeta().payoutAddress = manifest.payoutAddress;
  }
  if (baseline.meta.template !== manifest.meta.template) {
    if (manifest.meta.template === undefined) delete mutableMeta().template;
    else mutableMeta().template = manifest.meta.template;
  }
  if (baseline.meta.createdBy !== manifest.meta.createdBy) {
    if (manifest.meta.createdBy === undefined) delete mutableMeta().createdBy;
    else mutableMeta().createdBy = manifest.meta.createdBy;
  }
  if (!isDeepStrictEqual(nonScheduleTriggers(baseline), nonScheduleTriggers(manifest))) {
    const triggers = nonScheduleTriggers(manifest);
    if (triggers.length === 0) delete mutableMeta().triggers;
    else mutableMeta().triggers = triggers;
  }

  return {
    ...existing,
    name: baseline.name === manifest.name ? existing.name : manifest.name,
    nodes,
    edges,
    ...(meta === existing.meta ? {} : { meta }),
  };
}

/** Load one exact v1 flow as its Guided manifest, filtering by owner before graph hydration. */
export async function getGuidedFlowData(
  flowId: string,
  ownerId: string,
  repo?: FlowRepo,
): Promise<GuidedFlowData | null> {
  const resolvedRepo = repo ?? (await getRepo());
  const flow = await resolvedRepo.getOwnedFlow(flowId, ownerId);
  if (flow === null) return null;
  const graph = requireFlowGraphV1(flow.graph, "Guided editing");
  let manifest: AgentManifest;
  try {
    manifest = flowToManifest(graph);
  } catch (error) {
    const missingStepsOnly = error instanceof ZodError &&
      error.issues.length === 1 &&
      error.issues[0]?.code === "too_small" &&
      error.issues[0].path.length === 1 &&
      error.issues[0].path[0] === "steps";
    if (!graph.nodes.some((node) => node.type !== "schedule") && missingStepsOnly) {
      throw new EmptyGuidedFlowError(error);
    }
    throw error;
  }
  return { flowId: flow.id, name: flow.name, updatedAt: flow.updatedAt, manifest };
}

/**
 * Save a reviewed Guided manifest back to the same owner-scoped flow row.
 * The canonical compilers are the boundary in both directions, so switching
 * Guided → Studio → Code never forks or substitutes a second agent.
 */
export async function saveGuidedFlowManifest(
  flowId: string,
  ownerId: string,
  expectedUpdatedAt: number,
  manifest: AgentManifest,
  repo?: FlowRepo,
): Promise<SaveGuidedFlowResult> {
  const resolvedRepo = repo ?? (await getRepo());
  const current = await resolvedRepo.getOwnedFlow(flowId, ownerId);
  if (current === null) return { status: "not-found" };
  if (current.updatedAt !== expectedUpdatedAt) return { status: "conflict" };
  const guidedBoundary = resolvedRepo.mutateGuidedFlow;
  if (!guidedBoundary) return { status: "conflict" };

  const graph = patchGuidedManifestOntoFlow(
    requireFlowGraphV1(current.graph, "Guided editing"),
    manifest,
  );
  const schedule = manifest.triggers.find((candidate) => candidate.kind === "schedule");
  const atomicRepo = Object.create(resolvedRepo) as FlowRepo;
  atomicRepo.mutateFlow = (input) => guidedBoundary.call(resolvedRepo, {
    ...input,
    priceUsdc: paidCallPrice(manifest),
    scheduleCron: schedule?.kind === "schedule" ? schedule.cron : null,
  });
  const result = await new FlowMutationService(atomicRepo).save({
    id: flowId,
    mustExist: true,
    expectedUpdatedAt,
    ownerId,
    name: manifest.name,
    graph,
  });
  if (result.status === "not-found") return { status: "not-found" };
  if (result.status !== "saved") return { status: "conflict" };

  return {
    status: "saved",
    flow: {
      flowId: result.flow.id,
      name: result.flow.name,
      updatedAt: result.flow.updatedAt,
      manifest,
    },
  };
}
