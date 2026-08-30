import { applyGraphCommand } from "./graph-command-reducer";
import { parseGraphCommand } from "./graph-command-schema";
import type { GraphCommand, Point } from "./graph-command-types";
import { commandForPaste, type GraphFragmentV1 } from "./graph-fragment";
import { sha256Utf8 } from "./subflow-reference";
import {
  materializeResolvedPendingNodes,
  stripTypedReferencesForPendingResolution,
  type DetachedPendingNodeSet,
  type PendingSubflowReference,
  type ResolvedPendingSubflowReference,
} from "./subflow-reference-ledger";
import type { SupportedFlowGraph } from "./types";

const MAX_PENDING_REFERENCES = 100;
const MAX_FRAGMENT_NODES = 500;

export interface PendingSubflowPasteInput {
  readonly parentFlowId: string;
  readonly fragment: GraphFragmentV1;
  readonly commandId: string;
  readonly targetOrigin: Point;
  readonly targetGraph: SupportedFlowGraph;
}

interface PendingPlanContents {
  readonly parentFlowId: string;
  readonly detached: DetachedPendingNodeSet;
  readonly commandId: string;
  readonly nodeCommands: readonly {
    readonly id: string;
    readonly nodeId: string;
    readonly index?: number;
  }[];
  readonly edgeCommands: readonly Extract<GraphCommand, { kind: "edge.add" }>[];
  readonly targetFingerprint: string;
}

const PLAN_CONTENTS = new WeakMap<PendingSubflowPastePlan, PendingPlanContents>();

function graphFingerprint(graph: SupportedFlowGraph): string {
  return sha256Utf8(JSON.stringify(graph));
}

function planContents(plan: PendingSubflowPastePlan): PendingPlanContents {
  const contents = PLAN_CONTENTS.get(plan);
  if (!contents) throw new Error("Pending paste plan is invalid");
  return contents;
}

function cloneRequest(request: PendingSubflowReference): PendingSubflowReference {
  return structuredClone(request);
}

function preflightPendingReferenceLimit(fragment: GraphFragmentV1): void {
  const nodesDescriptor = Object.getOwnPropertyDescriptor(fragment, "nodes");
  if (!nodesDescriptor || !("value" in nodesDescriptor) || !nodesDescriptor.enumerable || !Array.isArray(nodesDescriptor.value)) {
    throw new Error("Pending paste fragment nodes must be a data array");
  }
  const nodes = nodesDescriptor.value;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(nodes, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 1 || lengthDescriptor.value > MAX_FRAGMENT_NODES) {
    throw new Error(`Pending paste fragment must contain 1 to ${MAX_FRAGMENT_NODES} nodes`);
  }
  let pending = 0;
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const nodeDescriptor = Object.getOwnPropertyDescriptor(nodes, String(index));
    if (!nodeDescriptor || !("value" in nodeDescriptor) || !nodeDescriptor.enumerable) {
      throw new Error("Pending paste fragment nodes must not be sparse or use accessors");
    }
    if (nodeDescriptor.value === null || typeof nodeDescriptor.value !== "object") continue;
    const typeDescriptor = Object.getOwnPropertyDescriptor(nodeDescriptor.value, "type");
    if (!typeDescriptor || !("value" in typeDescriptor) || (typeDescriptor.value !== "subflow" && typeDescriptor.value !== "loop")) continue;
    const paramsDescriptor = Object.getOwnPropertyDescriptor(nodeDescriptor.value, "params");
    if (!paramsDescriptor || !("value" in paramsDescriptor) || paramsDescriptor.value === null || typeof paramsDescriptor.value !== "object") continue;
    const referenceDescriptor = Object.getOwnPropertyDescriptor(paramsDescriptor.value, "reference");
    if (!referenceDescriptor || !("value" in referenceDescriptor)) continue;
    pending += 1;
    if (pending > MAX_PENDING_REFERENCES) {
      throw new Error(`Pending paste exceeds the ${MAX_PENDING_REFERENCES} reference limit`);
    }
  }
}

/**
 * Opaque client-only package. It deliberately exposes resolution requests but
 * never the detached invalid nodes or the pre-resolution graph command.
 */
export class PendingSubflowPastePlan {
  private constructor(contents: PendingPlanContents) {
    PLAN_CONTENTS.set(this, contents);
  }

  static create(contents: PendingPlanContents): PendingSubflowPastePlan {
    return new PendingSubflowPastePlan(contents);
  }

  requests(): readonly PendingSubflowReference[] {
    return planContents(this).detached.requests().map(cloneRequest);
  }

  toJSON(): undefined {
    return undefined;
  }
}

/**
 * Models cancellation and supersession synchronously. An external async
 * controller may resolve the bounded requests however it chooses, but only the
 * currently active plan can ever materialize a command.
 */
export class PendingSubflowPasteController {
  private active: PendingSubflowPastePlan | null = null;

  begin(input: PendingSubflowPasteInput): PendingSubflowPastePlan {
    if (typeof input.parentFlowId !== "string" || input.parentFlowId.length < 1 ||
        new TextEncoder().encode(input.parentFlowId).byteLength > 512) {
      throw new Error("Pending paste parent flow ID is invalid");
    }
    preflightPendingReferenceLimit(input.fragment);
    const template = commandForPaste(
      input.fragment,
      input.commandId,
      input.targetOrigin,
      input.targetGraph,
    );
    const nodes = template.commands.flatMap((command) =>
      command.kind === "node.add" ? [command.node] : []);
    const pendingCount = nodes.filter((node) =>
      (node.type === "subflow" || node.type === "loop") && Object.hasOwn(node.params, "reference")).length;
    if (pendingCount > MAX_PENDING_REFERENCES) {
      throw new Error(`Pending paste exceeds the ${MAX_PENDING_REFERENCES} reference limit`);
    }
    const detached = stripTypedReferencesForPendingResolution(nodes);
    const nodeCommands = template.commands.flatMap((command) => command.kind === "node.add"
      ? [{
          id: command.id,
          nodeId: command.node.id,
          ...(command.index === undefined ? {} : { index: command.index }),
        }]
      : []);
    const edgeCommands = template.commands.flatMap((command) =>
      command.kind === "edge.add" ? [structuredClone(command)] : []);
    if (nodeCommands.length + edgeCommands.length !== template.commands.length) {
      throw new Error("Pending paste template contains an unsupported command");
    }
    const plan = PendingSubflowPastePlan.create({
      parentFlowId: input.parentFlowId,
      detached,
      commandId: template.id,
      nodeCommands,
      edgeCommands,
      targetFingerprint: graphFingerprint(input.targetGraph),
    });
    this.active = plan;
    return plan;
  }

  hasActivePlan(): boolean {
    return this.active !== null;
  }

  isActive(plan: PendingSubflowPastePlan): boolean {
    return this.active === plan;
  }

  cancel(): void {
    this.active = null;
  }

  commit(
    plan: PendingSubflowPastePlan,
    resolutions: readonly ResolvedPendingSubflowReference[],
    context: {
      readonly parentFlowId: string;
      readonly currentTargetGraph: SupportedFlowGraph;
      readonly apply: (command: Extract<GraphCommand, { kind: "graph.batch" }>) => void;
    },
  ): void {
    if (this.active !== plan) {
      throw new Error("Pending paste plan is no longer active; it was cancelled, superseded, or consumed");
    }
    const contents = planContents(plan);
    if (context.parentFlowId !== contents.parentFlowId) {
      throw new Error("Pending paste parent flow changed while references were resolving");
    }
    if (contents.targetFingerprint !== graphFingerprint(context.currentTargetGraph)) {
      throw new Error("Pending paste target graph changed while references were resolving");
    }
    if (resolutions.length > MAX_PENDING_REFERENCES) {
      throw new Error(`Pending paste exceeds the ${MAX_PENDING_REFERENCES} resolution limit`);
    }

    const materialized = materializeResolvedPendingNodes(contents.detached, resolutions);
    const nodeById = new Map(materialized.map((node) => [node.id, node]));
    const nodeCommands = contents.nodeCommands.map((slot): GraphCommand => {
      const node = nodeById.get(slot.nodeId);
      if (!node) throw new Error(`Materialized pending node "${slot.nodeId}" is missing`);
      return {
        v: 1,
        id: slot.id,
        kind: "node.add",
        node,
        ...(slot.index === undefined ? {} : { index: slot.index }),
      };
    });
    if (nodeById.size !== contents.nodeCommands.length) {
      throw new Error("Materialized pending node set does not exactly match the paste plan");
    }
    const parsed = parseGraphCommand({
      v: 1,
      id: contents.commandId,
      kind: "graph.batch",
      commands: [...nodeCommands, ...contents.edgeCommands],
    });
    if (parsed.kind !== "graph.batch") throw new Error("Pending paste did not materialize a batch command");
    applyGraphCommand(context.currentTargetGraph, parsed);
    this.active = null;
    context.apply(parsed);
  }
}
