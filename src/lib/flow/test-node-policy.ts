import { getNodeDefinition } from "./node-definitions";
import { requiresDryRunStub, type CanonicalNodeDef, type NodeRegistry } from "./executor";
import { NODE_DEFS } from "./nodes";
import { planFlowTestScope, type PlannedFlowTestScope } from "./test-scope";
import type { FlowGraphV2, NodeType } from "./types";

export type TestNodePolicyAction = "native" | "scoped-stub-required" | "refused";

export type TestNodePolicyDecision =
  | { readonly ok: true; readonly action: TestNodePolicyAction }
  | { readonly ok: false; readonly code: "invalid-test-node-policy" };

export type PlannedTestNodePolicyResult =
  | {
      readonly ok: true;
      /** Actions align exactly with plan.executionOrder and contain no runtime objects. */
      readonly actions: readonly Exclude<TestNodePolicyAction, "refused">[];
    }
  | {
      readonly ok: false;
      readonly code: "invalid-test-node-policy" | "test-node-refused";
    };

interface DefinitionFacts {
  readonly type: NodeType;
  readonly testMode: "native" | "stub" | "refuse";
  readonly capabilityMode: "static" | "config-dependent" | "inherits-graph";
  readonly costKind: "free" | "estimated" | "variable";
  readonly effects: readonly string[];
}

interface RuntimeFacts {
  readonly type: NodeType;
  readonly definition: object;
  // Only ever compared by identity against the registry's own executor; this
  // module never invokes it. `never[]` params keep it uncallable by accident.
  readonly executor: (...args: never[]) => unknown;
  readonly dryRunStub: unknown;
  readonly costBearing: unknown;
  readonly sideEffecting: unknown;
}

interface CanonicalAuthority {
  readonly runtime: CanonicalNodeDef;
  readonly runtimeFacts: RuntimeFacts;
  readonly definitionFacts: DefinitionFacts;
  readonly guarded: boolean;
}

const INVALID = Object.freeze({ ok: false, code: "invalid-test-node-policy" } as const);
const REFUSED = Object.freeze({ ok: false, code: "test-node-refused" } as const);

function oneOf(value: unknown, allowed: readonly unknown[]): boolean {
  return allowed.includes(value);
}

function dataValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const descriptor = descriptors[key];
  return descriptor && "value" in descriptor
    ? { ok: true, value: descriptor.value }
    : { ok: false };
}

function optionalDataValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const descriptor = descriptors[key];
  if (descriptor === undefined) return { ok: true, value: undefined };
  return "value" in descriptor ? { ok: true, value: descriptor.value } : { ok: false };
}

function readRuntimeFacts(value: unknown): RuntimeFacts | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const type = dataValue(descriptors, "type");
  const definition = dataValue(descriptors, "definition");
  const executor = dataValue(descriptors, "executor");
  const dryRunStub = optionalDataValue(descriptors, "dryRunStub");
  const costBearing = optionalDataValue(descriptors, "costBearing");
  const sideEffecting = optionalDataValue(descriptors, "sideEffecting");
  if (!type.ok || typeof type.value !== "string" || !definition.ok ||
      definition.value === null || typeof definition.value !== "object" ||
      !executor.ok || typeof executor.value !== "function" || !dryRunStub.ok ||
      !costBearing.ok || !sideEffecting.ok) return null;
  return {
    type: type.value as NodeType,
    definition: definition.value,
    // Runtime-verified as a function directly above; `typeof` only narrows an
    // `unknown` as far as `Function`, which carries no call signature.
    executor: executor.value as (...args: never[]) => unknown,
    dryRunStub: dryRunStub.value,
    costBearing: costBearing.value,
    sideEffecting: sideEffecting.value,
  };
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const length = dataValue(descriptors, "length");
  if (!length.ok || !Number.isSafeInteger(length.value) || (length.value as number) < 0) return null;
  const result: string[] = [];
  for (let index = 0; index < (length.value as number); index += 1) {
    const item = dataValue(descriptors, String(index));
    if (!item.ok || typeof item.value !== "string") return null;
    result.push(item.value);
  }
  return Object.freeze(result);
}

function readDefinitionFacts(value: unknown): DefinitionFacts | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const type = dataValue(descriptors, "type");
  const testMode = dataValue(descriptors, "testMode");
  const capabilityMode = dataValue(descriptors, "capabilityMode");
  const effectsValue = dataValue(descriptors, "effects");
  const costValue = dataValue(descriptors, "cost");
  if (!type.ok || typeof type.value !== "string" || !testMode.ok ||
      !oneOf(testMode.value, ["native", "stub", "refuse"]) ||
      !capabilityMode.ok || !oneOf(capabilityMode.value, ["static", "config-dependent", "inherits-graph"]) ||
      !effectsValue.ok || !costValue.ok || costValue.value === null ||
      typeof costValue.value !== "object" || Array.isArray(costValue.value)) return null;
  const effects = readStringArray(effectsValue.value);
  let costDescriptors: Record<string, PropertyDescriptor>;
  try { costDescriptors = Object.getOwnPropertyDescriptors(costValue.value); } catch { return null; }
  const costKind = dataValue(costDescriptors, "kind");
  if (!effects || !costKind.ok || !oneOf(costKind.value, ["free", "estimated", "variable"])) return null;
  return Object.freeze({
    type: type.value as NodeType,
    testMode: testMode.value as DefinitionFacts["testMode"],
    capabilityMode: capabilityMode.value as DefinitionFacts["capabilityMode"],
    costKind: costKind.value as DefinitionFacts["costKind"],
    effects,
  });
}

function sameDefinitionFacts(left: DefinitionFacts, right: DefinitionFacts): boolean {
  return left.type === right.type && left.testMode === right.testMode &&
    left.capabilityMode === right.capabilityMode && left.costKind === right.costKind &&
    left.effects.length === right.effects.length &&
    left.effects.every((effect, index) => effect === right.effects[index]);
}

function sameRuntimeFacts(left: RuntimeFacts, right: RuntimeFacts): boolean {
  return left.type === right.type && left.definition === right.definition &&
    left.executor === right.executor && left.dryRunStub === right.dryRunStub &&
    left.costBearing === right.costBearing && left.sideEffecting === right.sideEffecting;
}

let authorityValid = true;
const AUTHORITY = new Map<NodeType, CanonicalAuthority>();
for (const runtime of NODE_DEFS) {
  const runtimeFacts = readRuntimeFacts(runtime);
  const definitionFacts = runtimeFacts ? readDefinitionFacts(runtimeFacts.definition) : null;
  const canonicalDefinition = runtimeFacts ? getNodeDefinition(runtimeFacts.type) : undefined;
  if (!runtimeFacts || !definitionFacts || runtimeFacts.definition !== canonicalDefinition ||
      AUTHORITY.has(runtimeFacts.type)) {
    authorityValid = false;
    continue;
  }
  AUTHORITY.set(runtimeFacts.type, Object.freeze({
    runtime,
    runtimeFacts: Object.freeze(runtimeFacts),
    definitionFacts,
    guarded: requiresDryRunStub(runtime),
  }));
}

/** Decide from the closed canonical runtime registry without dispatching any executor or stub. */
export function decideTestNodePolicy(value: unknown): TestNodePolicyDecision {
  if (!authorityValid) return INVALID;
  const currentRuntime = readRuntimeFacts(value);
  if (!currentRuntime) return INVALID;
  const authority = AUTHORITY.get(currentRuntime.type);
  if (!authority || value !== authority.runtime ||
      !sameRuntimeFacts(currentRuntime, authority.runtimeFacts)) return INVALID;
  const currentDefinition = readDefinitionFacts(currentRuntime.definition);
  if (!currentDefinition || !sameDefinitionFacts(currentDefinition, authority.definitionFacts)) return INVALID;

  const facts = authority.definitionFacts;
  if (facts.testMode === "native") {
    if (authority.guarded || authority.runtimeFacts.dryRunStub !== undefined) return INVALID;
    const inheritedContainer = (facts.type === "subflow" || facts.type === "loop") &&
      facts.capabilityMode === "inherits-graph";
    if (inheritedContainer) return { ok: true, action: "native" };
    const immutableResourceRead = facts.type === "resource.query" &&
      facts.capabilityMode === "static" && facts.costKind === "free" &&
      facts.effects.length === 1 && facts.effects[0] === "read";
    if (facts.capabilityMode === "inherits-graph" || facts.costKind !== "free" ||
        (facts.effects.length !== 0 && !immutableResourceRead)) return INVALID;
    return { ok: true, action: "native" };
  }
  if (facts.testMode === "stub") {
    return authority.guarded && typeof authority.runtimeFacts.dryRunStub === "function"
      ? { ok: true, action: "scoped-stub-required" }
      : INVALID;
  }
  return authority.guarded && authority.runtimeFacts.dryRunStub === undefined
    ? { ok: true, action: "refused" }
    : INVALID;
}

function exactDataDescriptors(
  value: unknown,
  keys: readonly string[],
): Record<string, PropertyDescriptor> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return exactDescriptorKeys(descriptors, keys) ? descriptors : null;
  } catch {
    return null;
  }
}

function exactDescriptorKeys(
  descriptors: Record<string, PropertyDescriptor>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]) &&
    expected.every((key) => "value" in descriptors[key]! && descriptors[key]!.enumerable === true);
}

function snapshotStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = dataValue(descriptors, "length");
    if (!length.ok || !Number.isSafeInteger(length.value) || (length.value as number) < 0 ||
        Object.keys(descriptors).length !== (length.value as number) + 1) return null;
    const result: string[] = [];
    for (let index = 0; index < (length.value as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true ||
          typeof descriptor.value !== "string") return null;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function snapshotScope(value: unknown): PlannedFlowTestScope["scope"] | null {
  const descriptors = exactDataDescriptors(value, ["kind", "nodeId"]);
  if (!descriptors) return null;
  const kind = descriptors.kind!.value;
  const nodeId = descriptors.nodeId!.value;
  if (!["node", "to-node", "from-node"].includes(kind) || typeof nodeId !== "string") return null;
  return Object.freeze({ kind, nodeId }) as PlannedFlowTestScope["scope"];
}

function snapshotBoundaryPin(
  value: unknown,
): PlannedFlowTestScope["boundaryPins"][number] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const kindValue = dataValue(descriptors, "kind");
  if (!kindValue.ok) return null;
  const kind = kindValue.value;
  const base = ["kind", "key", "sourceNodeId", "sourcePortId", "targetNodeId"];
  const pathPresent = Object.hasOwn(descriptors, "path");
  const keys = kind === "edge-input"
    ? [...base, "edgeId", "targetPortId"]
    : kind === "node-binding"
      ? [...base, "bindingKey", ...(pathPresent ? ["path"] : [])]
      : kind === "edge-condition"
        ? [...base, "edgeId", "expected", ...(pathPresent ? ["path"] : [])]
        : [];
  if (keys.length === 0) return null;
  if (!exactDescriptorKeys(descriptors, keys) ||
      base.slice(1).some((key) => typeof descriptors[key]!.value !== "string")) return null;
  const common = {
    kind,
    key: descriptors.key!.value,
    sourceNodeId: descriptors.sourceNodeId!.value,
    sourcePortId: descriptors.sourcePortId!.value,
    targetNodeId: descriptors.targetNodeId!.value,
  } as const;
  if (kind === "edge-input") {
    if (typeof descriptors.edgeId!.value !== "string" || typeof descriptors.targetPortId!.value !== "string") return null;
    return Object.freeze({ ...common, kind, edgeId: descriptors.edgeId!.value, targetPortId: descriptors.targetPortId!.value });
  }
  if (pathPresent && typeof descriptors.path!.value !== "string") return null;
  if (kind === "node-binding") {
    if (typeof descriptors.bindingKey!.value !== "string") return null;
    return Object.freeze({
      ...common,
      kind,
      bindingKey: descriptors.bindingKey!.value,
      ...(pathPresent ? { path: descriptors.path!.value } : {}),
    });
  }
  if (typeof descriptors.edgeId!.value !== "string" || descriptors.expected!.value !== "boolean") return null;
  return Object.freeze({
    ...common,
    kind: "edge-condition",
    edgeId: descriptors.edgeId!.value,
    ...(pathPresent ? { path: descriptors.path!.value } : {}),
    expected: "boolean",
  });
}

function snapshotBoundaryPins(
  value: unknown,
): PlannedFlowTestScope["boundaryPins"] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = dataValue(descriptors, "length");
    if (!length.ok || !Number.isSafeInteger(length.value) || (length.value as number) < 0 ||
        Object.keys(descriptors).length !== (length.value as number) + 1) return null;
    const pins: PlannedFlowTestScope["boundaryPins"][number][] = [];
    for (let index = 0; index < (length.value as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
      const pin = snapshotBoundaryPin(descriptor.value);
      if (!pin) return null;
      pins.push(pin);
    }
    return Object.freeze(pins);
  } catch {
    return null;
  }
}

function snapshotPlan(value: unknown): PlannedFlowTestScope | null {
  const keys = [
    "status", "scope", "executionOrder", "nodeIds", "edgeIds", "boundaryPins",
    "boundaryNodeIds", "unreachableNodeIds", "disabledNodeIds",
  ];
  const descriptors = exactDataDescriptors(value, keys);
  if (!descriptors || descriptors.status!.value !== "planned") return null;
  const scope = snapshotScope(descriptors.scope!.value);
  const executionOrder = snapshotStringArray(descriptors.executionOrder!.value);
  const nodeIds = snapshotStringArray(descriptors.nodeIds!.value);
  const edgeIds = snapshotStringArray(descriptors.edgeIds!.value);
  const boundaryPins = snapshotBoundaryPins(descriptors.boundaryPins!.value);
  const boundaryNodeIds = snapshotStringArray(descriptors.boundaryNodeIds!.value);
  const unreachableNodeIds = snapshotStringArray(descriptors.unreachableNodeIds!.value);
  const disabledNodeIds = snapshotStringArray(descriptors.disabledNodeIds!.value);
  if (!scope || !executionOrder || !nodeIds || !edgeIds || !boundaryPins || !boundaryNodeIds ||
      !unreachableNodeIds || !disabledNodeIds) return null;
  return Object.freeze({
    status: "planned",
    scope,
    executionOrder,
    nodeIds,
    edgeIds,
    boundaryPins,
    boundaryNodeIds,
    unreachableNodeIds,
    disabledNodeIds,
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePin(
  left: PlannedFlowTestScope["boundaryPins"][number],
  right: PlannedFlowTestScope["boundaryPins"][number],
): boolean {
  if (left.kind !== right.kind || left.key !== right.key || left.sourceNodeId !== right.sourceNodeId ||
      left.sourcePortId !== right.sourcePortId || left.targetNodeId !== right.targetNodeId) return false;
  if (left.kind === "edge-input" && right.kind === "edge-input") {
    return left.edgeId === right.edgeId && left.targetPortId === right.targetPortId;
  }
  if (left.kind === "node-binding" && right.kind === "node-binding") {
    return left.bindingKey === right.bindingKey && left.path === right.path &&
      Object.hasOwn(left, "path") === Object.hasOwn(right, "path");
  }
  return left.kind === "edge-condition" && right.kind === "edge-condition" &&
    left.edgeId === right.edgeId && left.expected === right.expected && left.path === right.path &&
    Object.hasOwn(left, "path") === Object.hasOwn(right, "path");
}

function exactPlan(left: PlannedFlowTestScope, right: PlannedFlowTestScope): boolean {
  return left.status === right.status && left.scope.kind === right.scope.kind &&
    left.scope.nodeId === right.scope.nodeId && sameStrings(left.executionOrder, right.executionOrder) &&
    sameStrings(left.nodeIds, right.nodeIds) && sameStrings(left.edgeIds, right.edgeIds) &&
    left.boundaryPins.length === right.boundaryPins.length &&
    left.boundaryPins.every((pin, index) => samePin(pin, right.boundaryPins[index]!)) &&
    sameStrings(left.boundaryNodeIds, right.boundaryNodeIds) &&
    sameStrings(left.unreachableNodeIds, right.unreachableNodeIds) &&
    sameStrings(left.disabledNodeIds, right.disabledNodeIds);
}

/** Replan the graph, exact-compare the complete plan, then preflight every node before dispatch. */
export function preflightPlannedTestNodes(
  graph: FlowGraphV2,
  plan: PlannedFlowTestScope,
  registry: NodeRegistry,
): PlannedTestNodePolicyResult {
  try {
    const snapshot = snapshotPlan(plan);
    if (!snapshot || new Set(snapshot.nodeIds).size !== snapshot.nodeIds.length ||
        new Set(snapshot.executionOrder).size !== snapshot.executionOrder.length) return INVALID;
    const replanned = planFlowTestScope(graph, snapshot.scope);
    if (replanned.status !== "planned" || !exactPlan(replanned, snapshot)) return INVALID;
    const nodes = new Map<string, FlowGraphV2["nodes"][number]>();
    for (const node of graph.nodes) {
      if (nodes.has(node.id)) return INVALID;
      nodes.set(node.id, node);
    }
    let registryDescriptors: Record<string, PropertyDescriptor>;
    try { registryDescriptors = Object.getOwnPropertyDescriptors(registry); } catch { return INVALID; }
    const actions: Exclude<TestNodePolicyAction, "refused">[] = [];
    for (const nodeId of replanned.executionOrder) {
      const node = nodes.get(nodeId);
      const authority = node ? AUTHORITY.get(node.type) : undefined;
      const registered = node ? registryDescriptors[node.type] : undefined;
      if (!node || !authority || !registered || !("value" in registered) ||
          registered.value !== authority.runtime) return INVALID;
      const decision = decideTestNodePolicy(authority.runtime);
      if (!decision.ok) return decision;
      if (decision.action === "refused") return REFUSED;
      actions.push(decision.action);
    }
    return Object.freeze({ ok: true, actions: Object.freeze(actions) });
  } catch {
    return INVALID;
  }
}
