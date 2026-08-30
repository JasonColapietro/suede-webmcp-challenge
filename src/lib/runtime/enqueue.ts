import { randomUUID } from "node:crypto";
import { admitDurableGraph, type DurableGraphAdmissionResolvers } from "./admission";
import { createDurableInvocation } from "./invocation";
import type { CreateExecutionResult, DurableRuntimeRepository } from "./repository";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import { durableRuntimePolicyFingerprint } from "./durable-policy";

export type EnqueueDurableExecutionResult = CreateExecutionResult | Readonly<{
  status: "admission-refused";
  code: string;
}>;

export async function enqueueDurableExecution(input: Readonly<{
  repository: DurableRuntimeRepository;
  ownerId: string;
  flowId: string;
  flowVersionId: string;
  definitionHash: string;
  graph: SupportedFlowGraph;
  resolvers?: DurableGraphAdmissionResolvers;
  triggerInput?: Readonly<Record<string, unknown>>;
  runVariables?: Readonly<Record<string, unknown>>;
  trigger: Readonly<{ type: "api" | "schedule" | "webhook" | "retry" | "fork"; id?: string }>;
  idempotency: Readonly<{ namespace: string; key: string; expiresAt: number }>;
  executionId?: string;
  jobId?: string;
  priority?: number;
  availableAt: number;
  maxAttempts: number;
  createdAt: number;
  deadlineAt?: number;
}>): Promise<EnqueueDurableExecutionResult> {
  const admission = await admitDurableGraph(input.graph, input.resolvers);
  if (!admission.ok) return Object.freeze({ status: "admission-refused", code: admission.code });
  const receipt = admission.executionPackage;
  const root = receipt.graphs.find((entry) => entry.key === receipt.rootKey && entry.identity.kind === "root");
  if (!root) return Object.freeze({ status: "admission-refused", code: "invalid-package" });

  const allowedVariables = new Set<string>();
  for (const graph of receipt.graphs.map((entry) => entry.graph)) {
    if (!isFlowGraphV2(graph)) continue;
    for (const variable of graph.variables) {
      if (variable.sensitive === true) return Object.freeze({ status: "admission-refused", code: "secret-binding" });
      allowedVariables.add(variable.id);
    }
  }
  if (Object.keys(input.runVariables ?? {}).some((key) => !allowedVariables.has(key))) {
    return Object.freeze({ status: "admission-refused", code: "variable-binding" });
  }

  let invocation: ReturnType<typeof createDurableInvocation>;
  try {
    invocation = createDurableInvocation({
      executionPackage: receipt,
      execution: { ownerId: input.ownerId, flowId: input.flowId, flowVersionId: input.flowVersionId },
      policyFingerprint: durableRuntimePolicyFingerprint(),
      triggerInput: input.triggerInput,
      runVariables: input.runVariables,
    });
  } catch {
    return Object.freeze({ status: "admission-refused", code: "invalid-json" });
  }
  return input.repository.createExecution({
    ownerId: input.ownerId,
    executionId: input.executionId ?? randomUUID(),
    jobId: input.jobId ?? randomUUID(),
    flowId: input.flowId,
    flowVersionId: input.flowVersionId,
    frozenDefinition: root.graph as never,
    definitionHash: input.definitionHash,
    trigger: input.trigger,
    priority: input.priority ?? 0,
    availableAt: input.availableAt,
    maxAttempts: input.maxAttempts,
    costBudgetMicroUsdc: 0,
    tokenBudget: 0,
    createdAt: input.createdAt,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    idempotency: input.idempotency,
    invocation: { json: invocation.json, hash: invocation.hash },
  });
}
