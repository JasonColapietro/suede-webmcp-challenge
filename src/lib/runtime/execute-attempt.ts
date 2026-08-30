import { runFlow } from "@/lib/flow/engine";
import { getRegistry } from "@/lib/flow/registry";
import { hashFlowGraph } from "@/lib/projects/hash";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import { RunLogger } from "@/lib/log";
import type { NodeContext, NodeRegistry } from "@/lib/flow/executor";
import type { ResolvedSubflow } from "@/lib/flow/subflow-resolver";
import type { RunEvent, SubflowReference, SupportedFlowGraph } from "@/lib/flow/types";
import type { DurableJobClaim, DurableRuntimeRepository, LeaseIdentity, LeasedEventDraft, LeasedTransitionResult } from "./repository";
import type { DurableJsonValue } from "./types";
import { canonicalDurableJson } from "./invocation";
import { admitDurableGraph, type DurableExecutionPackage } from "./admission";
import { durableRuntimePolicyFingerprint } from "./durable-policy";

const RUNTIME_ERROR = "durable_runtime_error";
const NODE_ERROR = "durable_node_error";
const POLICY_ERROR = "durable_policy_refused";
class DurablePolicyError extends Error {}

export type CrashSeam = "afterClaim" | "afterLeasedEvent" | "beforeFinalization";
export class InjectedWorkerCrash extends Error {
  constructor(readonly seam: CrashSeam) { super(`Injected worker crash: ${seam}`); this.name = "InjectedWorkerCrash"; }
}

export type AttemptResult =
  | Readonly<{ status: "completed" | "failed" | "retry-scheduled" | "cancelled" | "paused" | "dead-lettered" }>
  | Readonly<{ status: "lost" | "crashed" }>;

function denied(): never { throw new DurablePolicyError(POLICY_ERROR); }
export function sanitizeDurableLog(value: string): string {
  const source = value || "durable node log";
  if (Buffer.byteLength(source, "utf8") <= 16 * 1024) return source;
  let result = ""; let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 16 * 1024) break;
    result += character; bytes += size;
  }
  return result || "durable node log";
}
function boundedOutput(value: unknown): DurableJsonValue {
  try { return canonicalDurableJson(value, 128 * 1024).value; } catch { throw new DurablePolicyError("Durable node output exceeded policy bounds"); }
}

function runtimeSubflowKey(reference: SubflowReference): string {
  return reference.kind === "draft"
    ? JSON.stringify(["draft", reference.flowId, reference.interfaceHash])
    : JSON.stringify(["pinned", reference.flowId, reference.versionId, reference.interfaceHash, reference.contentHash]);
}

function buildContext(claim: DurableJobClaim, signal: AbortSignal, registry: NodeRegistry): NodeContext {
  const graphs = new Map(claim.invocation.graphs.map((entry) => [entry.key, entry.graph]));
  const loadSubflow = async (flowId: string, childSignal?: AbortSignal): Promise<SupportedFlowGraph> => {
    childSignal?.throwIfAborted();
    const graph = graphs.get(JSON.stringify(["legacy", flowId]));
    if (!graph) return denied();
    return graph;
  };
  const resolveSubflow = async (reference: SubflowReference, childSignal?: AbortSignal): Promise<ResolvedSubflow> => {
    childSignal?.throwIfAborted();
    const graph = graphs.get(runtimeSubflowKey(reference));
    if (!graph || !isFlowGraphV2(graph) || !graph.callableInterface) return denied();
    return {
      graph,
      flowId: reference.flowId,
      ...(reference.kind === "pinned" ? { versionId: reference.versionId } : {}),
      semanticHash: reference.kind === "pinned" ? reference.contentHash : hashFlowGraph(graph, { semantic: true }),
      callableInterface: graph.callableInterface,
    };
  };
  const denyProxy = new Proxy({}, { get: () => () => denied() });
  return {
    runId: claim.executionId,
    ownerId: claim.ownerId,
    dryRun: false,
    signal,
    wallet: { address: null, network: "base-mainnet" },
    x402: denyProxy as NodeContext["x402"],
    llm: denyProxy as NodeContext["llm"],
    logger: new RunLogger(),
    loadSubflow,
    resolveSubflow,
    resolveResourcePack: async () => denied(),
    registry,
    depth: 0,
    flowAncestry: [claim.flowId],
    costCeiling: { limitUsdc: 0, spentUsdc: 0, reservedUsdc: 0 },
    runVariables: claim.invocation.runVariables,
    resolveSecretReference: async () => denied(),
  };
}

function samePackage(left: DurableExecutionPackage, right: DurableExecutionPackage): boolean {
  const rightByKey = new Map(right.graphs.map((entry) => [entry.key, entry]));
  return left.rootKey === right.rootKey && left.graphs.length === right.graphs.length && left.graphs.every((entry) => {
    const other = rightByKey.get(entry.key);
    return other?.key === entry.key && other.contentHash === entry.contentHash && other.canonicalJson === entry.canonicalJson && JSON.stringify(other.identity) === JSON.stringify(entry.identity);
  });
}

async function revalidatePersistedPolicy(claim: DurableJobClaim, signal: AbortSignal): Promise<SupportedFlowGraph> {
  let currentFingerprint: string;
  try { currentFingerprint = durableRuntimePolicyFingerprint(); }
  catch { throw new DurablePolicyError(POLICY_ERROR); }
  if (claim.invocation.policyFingerprint !== currentFingerprint) throw new DurablePolicyError(POLICY_ERROR);
  const root = claim.invocation.graphs.find((entry) => entry.key === claim.invocation.rootKey && entry.identity.kind === "root");
  if (!root) throw new DurablePolicyError(POLICY_ERROR);
  const context = buildContext(claim, signal, getRegistry());
  const admission = await admitDurableGraph(root.graph, { loadSubflow: context.loadSubflow, resolveSubflow: context.resolveSubflow, signal });
  let afterFingerprint: string;
  try { afterFingerprint = durableRuntimePolicyFingerprint(); }
  catch { throw new DurablePolicyError(POLICY_ERROR); }
  if (!admission.ok || !samePackage({ schemaVersion: 1, rootKey: claim.invocation.rootKey, graphs: claim.invocation.graphs.map((entry) => ({ ...entry, canonicalJson: JSON.stringify(entry.graph), byteLength: Buffer.byteLength(JSON.stringify(entry.graph), "utf8") })) }, admission.executionPackage) || afterFingerprint !== currentFingerprint) throw new DurablePolicyError(POLICY_ERROR);
  return root.graph;
}

function transitionStatus(result: LeasedTransitionResult): AttemptResult["status"] {
  if (result.status === "completed") return "completed";
  if (result.status === "retry-scheduled") return "retry-scheduled";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "dead-lettered") return "dead-lettered";
  if (result.status === "failed") return "failed";
  return "lost";
}

export async function executeDurableAttempt(input: {
  readonly repository: DurableRuntimeRepository;
  readonly claim: DurableJobClaim;
  readonly signal: AbortSignal;
  readonly crashAt?: CrashSeam;
}): Promise<AttemptResult> {
  const identity: LeaseIdentity = input.claim;
  if (input.crashAt === "afterClaim") throw new InjectedWorkerCrash("afterClaim");
  let sequence = input.claim.eventSequence;
  let appended = 0;
  const active = new Set<string>();
  const outputs: Record<string, DurableJsonValue> = {};
  const append = async (event: LeasedEventDraft): Promise<boolean> => {
    const result = await input.repository.appendLeasedEvent({ ...identity, expectedSequence: sequence, event });
    if (result.status === "budget-exhausted") throw new DurablePolicyError(POLICY_ERROR);
    if (result.status !== "appended") return false;
    sequence = result.execution.sequence;
    appended += 1;
    if (input.crashAt === "afterLeasedEvent" && appended === 1) throw new InjectedWorkerCrash("afterLeasedEvent");
    return true;
  };
  const ensureStarted = async (nodeId: string): Promise<boolean> => {
    if (active.has(nodeId)) return true;
    if (!await append({ schemaVersion: 1, type: "node.started", payload: { nodeId } })) return false;
    active.add(nodeId);
    return true;
  };
  try {
    const registry = getRegistry();
    const graph = await revalidatePersistedPolicy(input.claim, input.signal);
    const context = buildContext(input.claim, input.signal, registry);
    let final: Extract<RunEvent, { kind: "run:done" }> | null = null;
    for await (const event of runFlow(graph, context, registry, input.claim.invocation.triggerInput)) {
      input.signal.throwIfAborted();
      if (event.kind === "run:start") continue;
      if (event.kind === "run:done") { final = event; continue; }
      if (!await ensureStarted(event.nodeId)) return { status: "lost" };
      if (event.kind === "node:start") continue;
      if (event.kind === "node:log") {
        if (!await append({ schemaVersion: 1, type: "node.logged", payload: { nodeId: event.nodeId, level: event.level, message: sanitizeDurableLog(event.msg) } })) return { status: "lost" };
      } else if (event.kind === "node:done") {
        if (event.costUsdc !== 0 || input.claim.costBudgetMicroUsdc !== 0 || input.claim.tokenBudget !== 0) throw new DurablePolicyError("Durable zero-cost policy violated");
        const output = boundedOutput(event.outputs);
        if (!await append({ schemaVersion: 1, type: "node.completed", payload: { nodeId: event.nodeId, output, costMicroUsdc: 0, tokens: 0 } })) return { status: "lost" };
        outputs[event.nodeId] = output;
        active.delete(event.nodeId);
      } else {
        if (!await append({ schemaVersion: 1, type: "node.failed", payload: { nodeId: event.nodeId, error: NODE_ERROR } })) return { status: "lost" };
        active.delete(event.nodeId);
      }
    }
    if (!final) throw new Error(RUNTIME_ERROR);
    if (input.crashAt === "beforeFinalization") throw new InjectedWorkerCrash("beforeFinalization");
    const result = final.status === "done"
      ? await input.repository.completeAttempt({ ...identity, output: boundedOutput(outputs) })
      : await input.repository.failAttempt({ ...identity, classification: final.abortedReason === "cost-ceiling" ? "policy" : "transient", error: final.abortedReason === "cost-ceiling" ? POLICY_ERROR : RUNTIME_ERROR });
    return { status: transitionStatus(result) };
  } catch (error) {
    if (error instanceof InjectedWorkerCrash) throw error;
    if (input.signal.aborted) throw error;
    const policy = error instanceof DurablePolicyError;
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    const result = await input.repository.failAttempt({ ...identity, classification: policy ? "policy" : timeout ? "timeout" : "transient", error: policy ? POLICY_ERROR : timeout ? "durable_timeout" : RUNTIME_ERROR });
    return { status: transitionStatus(result) };
  }
}
