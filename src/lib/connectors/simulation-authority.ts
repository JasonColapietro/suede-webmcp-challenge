import { types as utilTypes } from "node:util";
import type { ConnectorOperationClosure } from "./repository";
import type { ConnectorSchemaV1, SystemPolicyV1 } from "./types";
import type { ApiOperationReference } from "@/lib/flow/api-operation-reference";
import type { ApiOperationPortProjection } from "@/lib/flow/operation-port-resolver";
import type { PlannedFlowTestScope } from "@/lib/flow/test-scope";
import type { FlowGraphV2, JsonValue } from "@/lib/flow/types";
import type { DependencyPinInput } from "@/lib/projects/types";

declare const simulationAuthorityBrand: unique symbol;
declare const simulationLeaseBrand: unique symbol;

export interface SimulationAuthority { readonly [simulationAuthorityBrand]: true }
export interface SimulationLease { readonly [simulationLeaseBrand]: true }

export interface SimulationAuthorityFacts {
  readonly ownerId: string;
  readonly actorId: string;
  readonly flowId: string;
  readonly flowUpdatedAt: number;
  readonly environmentId: string;
  readonly context: SimulationProjectContextFacts;
  readonly nodeId: string;
  readonly scope: { readonly kind: "node" | "from-node"; readonly nodeId: string };
  readonly signal: AbortSignal;
  readonly deadlineGeneration: number;
  readonly deadlineAtMs: number;
  readonly graph: FlowGraphV2;
  readonly plan: PlannedFlowTestScope;
  readonly pinnedInputs: Readonly<Record<string, JsonValue>>;
  readonly reference: ApiOperationReference;
  readonly closure: ConnectorOperationClosure;
  readonly lifecycleRevision: number;
  readonly archivedAt: number | null;
  readonly dependencyPins: readonly DependencyPinInput[];
  readonly portProjection: ApiOperationPortProjection;
  readonly requestSchema: ConnectorSchemaV1;
  readonly resultSchema: ConnectorSchemaV1;
  readonly systemPolicy: SystemPolicyV1;
}

export interface SimulationProjectContextFacts {
  readonly bindingCreatedAt: number;
  readonly environmentCreatedAt: number;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectUpdatedAt: number;
  readonly workbookId: string;
}

export interface SimulationRuntimeFacts {
  readonly graph: FlowGraphV2;
  readonly plan: PlannedFlowTestScope;
  readonly pinnedInputs: Readonly<Record<string, JsonValue>>;
  readonly requestSchema: ConnectorSchemaV1;
  readonly resultSchema: ConnectorSchemaV1;
  readonly nodeId: string;
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
}

type LeaseState = "active" | "finalized" | "abandoned";
interface LeaseRecord { readonly facts: SimulationAuthorityFacts; state: LeaseState }

const AUTHORITIES = new WeakMap<object, SimulationAuthorityFacts>();
const LEASES = new WeakMap<object, LeaseRecord>();

const FACT_KEYS = [
  "actorId", "archivedAt", "closure", "context", "deadlineAtMs", "deadlineGeneration", "dependencyPins", "environmentId",
  "flowId", "flowUpdatedAt", "graph", "lifecycleRevision", "nodeId", "ownerId", "pinnedInputs",
  "plan", "portProjection", "reference", "requestSchema", "resultSchema", "scope", "signal", "systemPolicy",
] as const;

function freezeCapabilityFree(value: unknown, signal: AbortSignal, seen = new WeakSet<object>()): void {
  if (typeof value === "function") throw new TypeError("Invalid simulation authority");
  if (value === null || typeof value !== "object" || value === signal || seen.has(value)) return;
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("Invalid simulation authority");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) throw new TypeError("Invalid simulation authority");
    freezeCapabilityFree(descriptor.value, signal, seen);
  }
  Object.freeze(value);
}

function freezeFacts(facts: SimulationAuthorityFacts): SimulationAuthorityFacts {
  if (facts === null || typeof facts !== "object" || Array.isArray(facts) ||
      utilTypes.isProxy(facts) ||
      Object.getPrototypeOf(facts) !== Object.prototype || Object.getOwnPropertySymbols(facts).length !== 0) {
    throw new TypeError("Invalid simulation authority");
  }
  const descriptors = Object.getOwnPropertyDescriptors(facts);
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== FACT_KEYS.length || keys.some((key, index) => key !== [...FACT_KEYS].sort()[index]) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable) ||
      !(facts.signal instanceof AbortSignal) || facts.scope.nodeId !== facts.nodeId ||
      !Number.isSafeInteger(facts.deadlineGeneration) || facts.deadlineGeneration < 1 ||
      !Number.isFinite(facts.deadlineAtMs) || facts.deadlineAtMs < 0) {
    throw new TypeError("Invalid simulation authority");
  }
  const snapshot = { ...facts, scope: { ...facts.scope } };
  freezeCapabilityFree(snapshot, facts.signal);
  return snapshot;
}

export function createSimulationAuthority(facts: SimulationAuthorityFacts): SimulationAuthority {
  const authority = Object.freeze(Object.create(null) as object) as SimulationAuthority;
  AUTHORITIES.set(authority as object, freezeFacts(facts));
  return authority;
}

export function consumeSimulationAuthority(authority: SimulationAuthority): SimulationLease {
  const facts = AUTHORITIES.get(authority as object);
  if (!facts) throw new TypeError("Invalid simulation authority");
  AUTHORITIES.delete(authority as object);
  const lease = Object.freeze(Object.create(null) as object) as SimulationLease;
  LEASES.set(lease as object, { facts, state: "active" });
  return lease;
}

export function assertActiveSimulationLease(
  lease: SimulationLease,
  expected: SimulationAuthorityFacts,
): SimulationAuthorityFacts {
  const record = LEASES.get(lease as object);
  if (!record || record.state !== "active" || record.facts.ownerId !== expected.ownerId ||
      record.facts.actorId !== expected.actorId || record.facts.flowId !== expected.flowId ||
      record.facts.flowUpdatedAt !== expected.flowUpdatedAt || record.facts.environmentId !== expected.environmentId ||
      record.facts.context !== expected.context ||
      record.facts.nodeId !== expected.nodeId || record.facts.scope.kind !== expected.scope.kind ||
      record.facts.scope.nodeId !== expected.scope.nodeId || record.facts.signal !== expected.signal ||
      record.facts.deadlineGeneration !== expected.deadlineGeneration || record.facts.deadlineAtMs !== expected.deadlineAtMs ||
      record.facts.graph !== expected.graph ||
      record.facts.plan !== expected.plan || record.facts.pinnedInputs !== expected.pinnedInputs ||
      record.facts.reference !== expected.reference || record.facts.closure !== expected.closure ||
      record.facts.lifecycleRevision !== expected.lifecycleRevision || record.facts.archivedAt !== expected.archivedAt ||
      record.facts.dependencyPins !== expected.dependencyPins || record.facts.portProjection !== expected.portProjection ||
      record.facts.requestSchema !== expected.requestSchema || record.facts.resultSchema !== expected.resultSchema ||
      record.facts.systemPolicy !== expected.systemPolicy) throw new TypeError("Invalid simulation lease");
  return record.facts;
}

/** Private runtime boundary: expose only values needed by the capability-free interpreter. */
export function readSimulationRuntimeLease(lease: SimulationLease): SimulationRuntimeFacts {
  const record = LEASES.get(lease as object);
  if (!record || record.state !== "active") throw new TypeError("Invalid simulation lease");
  return Object.freeze({
    graph: record.facts.graph,
    plan: record.facts.plan,
    pinnedInputs: record.facts.pinnedInputs,
    requestSchema: record.facts.requestSchema,
    resultSchema: record.facts.resultSchema,
    nodeId: record.facts.nodeId,
    signal: record.facts.signal,
    deadlineAtMs: record.facts.deadlineAtMs,
  });
}

function transition(lease: SimulationLease, state: Exclude<LeaseState, "active">): void {
  const record = LEASES.get(lease as object);
  if (!record || record.state !== "active") throw new TypeError("Invalid simulation lease");
  record.state = state;
}

export function finalizeSimulationLease(lease: SimulationLease): void { transition(lease, "finalized"); }
export function abandonSimulationLease(lease: SimulationLease): void { transition(lease, "abandoned"); }
