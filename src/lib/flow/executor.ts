/** Node execution contracts. Every node executor implements NodeExecutor. */
import type { ZodTypeAny } from "zod";
import type { FlowNode, FlowNodeV2, NodeType, SupportedFlowGraph } from "./types";
import type { SecretReferenceResolver } from "./value-bindings";
import type { X402Client } from "../rails/x402-client";
import type { LlmClient } from "../llm";
import type { RunLogger } from "../log";
import type { NodeDefinitionV2, NodeGroup } from "./node-definition-types";
import type { SubflowResolver } from "./subflow-resolver";
import type { OwnerFundedRegistryAuthorization } from "../registry/suede-registry";
import type { OwnerScopedResourcePackResolver } from "../projects/resource-dependencies";
import { getNodeDefinition } from "./node-definitions";
import {
  createValidatedNodePortResolver,
  resolveNodePorts,
  type ResolvedNodePorts,
  type StaticNodeDefinitionResolver,
} from "./node-ports";

export type { NodeGroup } from "./node-definition-types";

export interface WalletCtx {
  address: string | null;
  network: "base-mainnet" | "base-sepolia";
}

/**
 * The in-run cost ceiling ledger. One instance is created per run (in
 * buildRunContext / test helpers) and shared BY REFERENCE across every
 * nesting level of that run: `runFlow` spreads `ctx` into `childCtx` for
 * subflow/loop nodes (`{...ctx, depth: ctx.depth + 1}`), which copies the
 * reference, not the value, so a cost incurred three loop-subflow levels
 * deep is visible to the ceiling check at every level, including the root.
 *
 * `spentUsdc` is incremented exactly once per genuinely cost-bearing leaf
 * node execution (see `isCostBearingNode`), regardless of nesting depth.
 * Aggregator nodes (loop, subflow) never increment it directly — their own
 * bubbled-up `costUsdc` is just a rollup of leaf costs the ledger already
 * counted, so adding it again would double-count.
 */
export interface CostCeiling {
  /** Effective ceiling for the whole run: min(absolute per-run ceiling, agent's remaining daily budget at run start). */
  limitUsdc: number;
  /** Cumulative real cost incurred so far, across every nesting level of this run. */
  spentUsdc: number;
  /** Projected price synchronously held by in-flight leaves. Actual provider cost may exceed estimates. */
  reservedUsdc?: number;
}

export interface NodeContext {
  runId: string;
  dryRun: boolean;
  /** Cooperative cancellation shared by the root run and every nested run. */
  signal?: AbortSignal;
  /**
   * Owner of the flow this run belongs to (same value run-context.ts
   * receives), for nodes that attribute output to the Studio owner — e.g.
   * registerIp's on-chain metadata. Optional: test/manual contexts may omit
   * it. Anonymous owner ids are bearer secrets; anything writing this to a
   * public surface must go through registerIp.ts's publicOwnerRef.
   */
  ownerId?: string | null;
  /**
   * Opaque, owner-funded authority for a bounded registerIp write. Normal
   * editor, API, scheduled, webhook, and worker contexts intentionally omit
   * this. A future owner-wallet flow must create it explicitly for one owner
   * and one run; the capability carries both transaction and gas-fee quotas.
   */
  registerIpAuthorization?: OwnerFundedRegistryAuthorization;
  wallet: WalletCtx;
  x402: X402Client;
  llm: LlmClient;
  logger: RunLogger;
  /** Loads a referenced flow for subflow nodes. */
  loadSubflow: (flowId: string, signal?: AbortSignal) => Promise<SupportedFlowGraph>;
  /** Resolves strict typed draft/pinned references through owner-scoped stores. */
  resolveSubflow: SubflowResolver;
  /** Resolves one exact approved/Live Resource Pack without exposing owner scope to graph params. */
  resolveResourcePack: OwnerScopedResourcePackResolver;
  /** The node registry, so subflow nodes can re-enter the engine. */
  registry: NodeRegistry;
  /** Nesting depth; engine guards against runaway recursion. */
  depth: number;
  /** Immutable-by-convention authoritative flow row identities for recursion checks. */
  flowAncestry: readonly string[];
  /** In-run cost ceiling ledger; see `CostCeiling`. Enforced in engine.ts. */
  costCeiling: CostCeiling;
  /** Request-scoped values keyed by graph variable id. */
  runVariables?: Readonly<Record<string, unknown>>;
  /** Resolves an opaque connection reference without storing a secret in the graph. */
  resolveSecretReference?: SecretReferenceResolver;
}

export type NodeResult =
  | { ok: true; outputs: Record<string, unknown>; costUsdc: number }
  | {
      ok: false;
      error: string;
      costUsdc: number;
      /**
       * Set when this failure is a run-cost-ceiling abort (see engine.ts)
       * rather than an ordinary node failure. A loop/subflow node sets this
       * on its own result when a nested run it kicked off was aborted for
       * the same reason, so the abort propagates up instead of being
       * swallowed as a per-element/per-subflow failure.
       */
      costCeilingExceeded?: true;
    };

/** Opaque authority handle. Secret values live only in this module's WeakMap. */
export type NodeExecutionProvenance = object;

export interface ResolvedNodeExecutionParams {
  readonly params: unknown;
  readonly provenance: NodeExecutionProvenance;
}

export type NodeExecutor = (
  ctx: NodeContext,
  rawParams: unknown,
  inputs: Readonly<Record<string, unknown>>,
  provenance?: NodeExecutionProvenance,
) => Promise<NodeResult>;

export interface SelectedNodeDispatch {
  readonly kind: "real" | "dry-run-stub";
  readonly executor: NodeExecutor;
}

const PROVENANCE_SECRETS = new WeakMap<
  NodeExecutionProvenance,
  Readonly<Record<string, unknown>>
>();

function frozenNullRecord(entries: readonly (readonly [string, unknown])[]): Readonly<Record<string, unknown>> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) record[key] = value;
  return Object.freeze(record);
}

const EMPTY_SECRET_RECORD = frozenNullRecord([]);
const EMPTY_PROVENANCE: NodeExecutionProvenance = Object.freeze(Object.create(null) as object);
PROVENANCE_SECRETS.set(EMPTY_PROVENANCE, EMPTY_SECRET_RECORD);

function deepFreezeSecretValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeSecretValue(item, seen);
    return Object.freeze(value);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Provenance secret value must be a plain structured value");
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreezeSecretValue(item, seen);
  }
  return Object.freeze(value);
}

function cloneFrozenSecretValue(value: unknown): unknown {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch {
    throw new TypeError("Provenance secret value could not be safely cloned");
  }
  return deepFreezeSecretValue(cloned, new WeakSet<object>());
}

/** Create the only provenance handle recognized by node executors. */
export function createNodeExecutionProvenance(
  secretValues: Readonly<Record<string, unknown>>,
): NodeExecutionProvenance {
  const entries = Object.entries(secretValues);
  if (entries.length === 0) return EMPTY_PROVENANCE;
  const secrets = frozenNullRecord(
    entries.map(([key, value]) => [key, cloneFrozenSecretValue(value)] as const),
  );
  const handle: NodeExecutionProvenance = Object.freeze(Object.create(null) as object);
  PROVENANCE_SECRETS.set(handle, secrets);
  return handle;
}

function canonicalProvenance(
  provenance: NodeExecutionProvenance | undefined,
): NodeExecutionProvenance {
  return provenance !== undefined && PROVENANCE_SECRETS.has(provenance)
    ? provenance
    : EMPTY_PROVENANCE;
}

export function readProvenanceSecret(
  provenance: NodeExecutionProvenance | undefined,
  key: string,
): unknown | undefined {
  return PROVENANCE_SECRETS.get(canonicalProvenance(provenance))?.[key];
}

export function listProvenanceSecretKeys(
  provenance: NodeExecutionProvenance | undefined,
): readonly string[] {
  return Object.freeze(
    Object.keys(PROVENANCE_SECRETS.get(canonicalProvenance(provenance)) ?? EMPTY_SECRET_RECORD).sort(),
  );
}

export interface NodeDef {
  type: NodeType;
  label: string;
  group: NodeGroup;
  /** USDC list price surfaced in the palette/ledger (0 for local nodes). */
  priceUsdc?: number;
  /**
   * Explicit cost-bearing / external-call marker used by the dry-run gate
   * (see `isCostBearingNode` / `withDryRunGuard` below). `true` forces the
   * gate on even for a type that would otherwise be treated as free; `false`
   * forces it off (the node is local-only and safe to run unconditionally).
   * Omit to fall back to the `FREE_NODE_TYPES` allowlist.
   */
  costBearing?: boolean;
  /**
   * Marks a node that reaches an external system (a third-party HTTP
   * endpoint, a webhook delivery, ...) even when it costs the platform
   * nothing. `costBearing` alone is not a sufficient predicate for the
   * dry-run gate: a node can be free ($0, `priceUsdc: 0`) and still cause a
   * real side effect at a third party, which is exactly what `http` is (a
   * caller-triggered dry run must not let it POST/PUT/DELETE against
   * whatever URL the flow author wired up). Set this to `true` on any node
   * whose real executor talks to the outside world regardless of cost. See
   * `requiresDryRunStub`, which ORs this together with `isCostBearingNode`.
   */
  sideEffecting?: boolean;
  /**
   * Synthetic executor run instead of `executor` whenever
   * `requiresDryRunStub(this)` is true and `ctx.dryRun` is true. Required
   * for every node that is cost-bearing and/or `sideEffecting` — see
   * `requiresDryRunStub` and `engine.ts`'s `executeNode`, the single place
   * that actually chooses between `executor` and `dryRunStub`. A node that
   * needs one and does not declare one is refused at runtime (fail closed)
   * and flagged by the enumeration test in
   * tests/flow/dryrun-enumeration.test.ts.
   */
  dryRunStub?: NodeExecutor;
  paramsSchema: ZodTypeAny;
  inputs: string[];
  outputs: string[];
  /** Runtime-authoritative input cardinality. Omitted ports default to one. */
  inputCardinality?: Readonly<Record<string, "one" | "many">>;
  executor: NodeExecutor;
}

export interface CanonicalNodeDef extends NodeDef {
  readonly definition: NodeDefinitionV2;
}

export type ExecutableNodeRuntime = Pick<NodeDef, "paramsSchema" | "executor"> &
  Partial<Pick<NodeDef, "dryRunStub">>;

export function defineExecutableNode(
  definition: NodeDefinitionV2,
  runtime: ExecutableNodeRuntime,
): CanonicalNodeDef {
  const guarded = definition.testMode !== "native";
  const costBearing =
    guarded &&
    (definition.testMode === "refuse" ||
      definition.cost.kind !== "free" ||
      definition.effects.includes("spend") ||
      definition.effects.includes("settle"));
  const sideEffecting =
    guarded &&
    definition.effects.some((effect) =>
      ["write", "delete", "send", "publish", "settle"].includes(effect),
    );

  return {
    definition,
    type: definition.type,
    label: definition.label,
    group: definition.category,
    ...(definition.cost.kind === "estimated" &&
    definition.cost.amount !== undefined &&
    Number.isFinite(definition.cost.amount)
      ? { priceUsdc: definition.cost.amount }
      : {}),
    costBearing,
    sideEffecting,
    paramsSchema: runtime.paramsSchema,
    inputs: definition.inputPorts.map((port) => port.id),
    outputs: definition.outputPorts.map((port) => port.id),
    inputCardinality: Object.fromEntries(
      definition.inputPorts.map((port) => [port.id, port.cardinality]),
    ),
    executor: runtime.executor,
    ...(runtime.dryRunStub ? { dryRunStub: runtime.dryRunStub } : {}),
  };
}

export type NodeRegistry = Partial<Record<NodeType, NodeDef>>;

function runtimeStaticResolver(registry: NodeRegistry): StaticNodeDefinitionResolver {
  return (type) => {
    const runtime = registry[type];
    const canonical = getNodeDefinition(type);
    if (!runtime) return canonical;
    const base = (runtime as Partial<CanonicalNodeDef>).definition ?? canonical;
    const inputPorts = runtime.inputs.map((id) => {
      const existing = base.inputPorts.find((port) => port.id === id);
      const cardinality = runtime.inputCardinality?.[id] ?? "one";
      return existing
        ? cardinality === existing.cardinality ? existing : { ...existing, cardinality }
        : { id, label: id, schema: {}, required: false, cardinality };
    });
    const outputPorts = runtime.outputs.map((id) => base.outputPorts.find((port) => port.id === id) ?? {
      id,
      label: id,
      schema: {},
      required: false,
      cardinality: "one" as const,
    });
    const unchangedInputs = inputPorts.length === base.inputPorts.length &&
      inputPorts.every((port, index) => port === base.inputPorts[index]);
    const unchangedOutputs = outputPorts.length === base.outputPorts.length &&
      outputPorts.every((port, index) => port === base.outputPorts[index]);
    if (unchangedInputs && unchangedOutputs) return base;
    return { ...base, inputPorts, outputPorts };
  };
}

/** Adapt a registered executor to the graph-specific handles without replacing it. */
function adaptRuntimeDefinition(
  node: FlowNode | FlowNodeV2,
  registry: NodeRegistry,
  ports: ResolvedNodePorts,
): NodeDef | undefined {
  const runtime = registry[node.type];
  if (!runtime) return undefined;
  const inputs = ports.inputPorts.map((port) => port.id);
  const outputs = ports.outputPorts.map((port) => port.id);
  const inputCardinality = Object.fromEntries(
    ports.inputPorts.map((port) => [port.id, port.cardinality]),
  );
  if (
    inputs.length === runtime.inputs.length &&
    outputs.length === runtime.outputs.length &&
    inputs.every((id, index) => id === runtime.inputs[index]) &&
    outputs.every((id, index) => id === runtime.outputs[index]) &&
    inputs.every((id) => (runtime.inputCardinality?.[id] ?? "one") === inputCardinality[id])
  ) {
    return runtime;
  }
  return { ...runtime, inputs, outputs, inputCardinality };
}

export type ValidatedNodeRuntimeDefinitionResolver = (
  node: FlowNode | FlowNodeV2,
) => NodeDef | undefined;

export function createValidatedNodeRuntimeDefinitionResolver(
  graph: SupportedFlowGraph,
  registry: NodeRegistry,
): ValidatedNodeRuntimeDefinitionResolver {
  const resolvePorts = createValidatedNodePortResolver(graph, runtimeStaticResolver(registry));
  return (node) => adaptRuntimeDefinition(node, registry, resolvePorts(node));
}

export function resolveNodeRuntimeDefinition(
  graph: SupportedFlowGraph,
  node: FlowNode | FlowNodeV2,
  registry: NodeRegistry,
): NodeDef | undefined {
  const ports = resolveNodePorts(graph, node, runtimeStaticResolver(registry));
  return adaptRuntimeDefinition(node, registry, ports);
}

/**
 * Node types that never make a paid or external call, regardless of
 * ctx.dryRun. Everything NOT in this list is treated as cost-bearing by
 * default (deny-by-default) unless a NodeDef explicitly opts out via
 * `costBearing: false`.
 */
export const FREE_NODE_TYPES: readonly NodeType[] = [
  "input",
  "output",
  "branch",
  "schedule",
  "webhook",
  "subflow",
  "transform",
  // Pure local reducers/routers: no cost, no network, no side effects.
  "logic.switch",
  "logic.aggregate",
];

/**
 * Whether a node must be gated from doing real work when ctx.dryRun is true.
 * Defaults to cost-bearing (safe/deny) unless the node explicitly declares
 * `costBearing: false` or its type is in `FREE_NODE_TYPES`. An explicit
 * `costBearing: true` always wins, even for a type in the allowlist.
 */
export function isCostBearingNode(
  def: Pick<NodeDef, "type" | "costBearing">,
): boolean {
  if (def.costBearing === true) return true;
  if (def.costBearing === false) return false;
  return !FREE_NODE_TYPES.includes(def.type);
}

/**
 * Whether the engine must refuse to run this node's real `executor` and
 * substitute `dryRunStub` instead when `ctx.dryRun` is true. This is the
 * ONE predicate the engine's dispatch (see `executeNode` in engine.ts) and
 * the gateway's single-node dispatch (see run-handler.ts) both consult —
 * it is the actual structural gate, not `isCostBearingNode` alone, because
 * a node can cost the platform nothing and still reach an external system
 * (see `sideEffecting` above; `http` is the motivating example).
 *
 * A node needs guarding for either reason, independently:
 *   - it is cost-bearing (real money moves — the platform's API key or the
 *     agent's on-chain wallet), or
 *   - it is marked `sideEffecting: true` (a real external call happens,
 *     even at $0 cost to Suede).
 */
export function requiresDryRunStub(
  def: Pick<NodeDef, "type" | "costBearing" | "sideEffecting">,
): boolean {
  return isCostBearingNode(def) || def.sideEffecting === true;
}

/**
 * The sole dispatch classifier for real versus dry-run node execution.
 * Selection is deliberately pure so callers can choose it before resolving
 * bindings or evaluating any parameter factory.
 */
export function selectNodeDispatch(
  definition: NodeDef,
  context: Pick<NodeContext, "dryRun">,
): SelectedNodeDispatch {
  if (!context.dryRun || !requiresDryRunStub(definition)) {
    return Object.freeze({ kind: "real", executor: definition.executor });
  }
  if (definition.dryRunStub) {
    return Object.freeze({ kind: "dry-run-stub", executor: definition.dryRunStub });
  }
  const refuse: NodeExecutor = async () => ({
    ok: false,
    error:
      `Node type "${definition.type}" is cost-bearing or side-effecting and declares no dryRunStub. ` +
      "Refusing to run it for real during a dry run.",
    costUsdc: 0,
  });
  return Object.freeze({ kind: "dry-run-stub", executor: refuse });
}

/** Execute an already-selected node without reconsidering dispatch policy. */
export async function executeSelectedNode(
  selection: SelectedNodeDispatch,
  context: NodeContext,
  resolvedParams: ResolvedNodeExecutionParams,
  inputs: Readonly<Record<string, unknown>>,
): Promise<NodeResult> {
  context.signal?.throwIfAborted();
  const provenance = selection.kind === "dry-run-stub"
    ? EMPTY_PROVENANCE
    : canonicalProvenance(resolvedParams.provenance);
  return selection.executor(context, resolvedParams.params, inputs, provenance);
}

/**
 * Per-module dry-run wrapper. Wraps a NodeDef so that, whenever ctx.dryRun
 * is true AND the node is cost-bearing (see `isCostBearingNode`), the node's
 * real executor is never invoked — `stub` runs instead and the real
 * external/paid call never fires.
 *
 * HISTORICAL NOTE / WHY THIS IS NO LONGER THE PRIMARY GATE: this was
 * originally the only enforcement mechanism, applied per-module at NodeDef
 * construction time. That made gating an opt-in convention each node
 * author had to remember to call — and one node (http.ts) shipped without
 * it, so a dry run could still fire a real outbound request. The engine's
 * `executeNode` (engine.ts) and the gateway's single-node dispatch
 * (run-handler.ts) are now the actual, structural enforcement point: both
 * consult `requiresDryRunStub`/`dryRunStub` directly and never depend on a
 * module having called this function. `llm.ts` still calls `withDryRunGuard`
 * on top of that, purely as a second, redundant layer — kept because
 * existing tests call `llmNode.executor` directly, bypassing the engine
 * entirely, and rely on it self-gating. New nodes should NOT reach for this;
 * declare `dryRunStub` (and `costBearing`/`sideEffecting` as appropriate) on
 * the NodeDef instead and let the engine do the gating.
 */
export function withDryRunGuard<T extends NodeDef>(
  def: T,
  stub: NodeExecutor,
): T {
  const realExecutor = def.executor;
  return {
    ...def,
    executor: async (ctx, params, inputs, provenance) => {
      if (ctx.dryRun && isCostBearingNode(def)) {
        return stub(ctx, params, inputs, EMPTY_PROVENANCE);
      }
      return realExecutor(ctx, params, inputs, canonicalProvenance(provenance));
    },
  };
}
