import { auditCorrelationId, type AuditCorrelation, type ControlAuditEventInput } from "@/lib/audit/repository";
import type { AuditErrorCode } from "@/lib/audit/types";
import type { FlowRepo } from "@/lib/db/repo";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import {
  createApiOperationPortResolver,
  createValidatedApiOperationNodePortResolver,
} from "@/lib/flow/operation-port-resolver";
import { createValidatedNodePortResolver } from "@/lib/flow/node-ports";
import { planFlowTestScope, type PlannedFlowTestScope } from "@/lib/flow/test-scope";
import type { FlowEdgeV2, FlowGraphV2, FlowNodeV2, JsonValue, ValueBinding } from "@/lib/flow/types";
import type { FlowProjectContext, ProjectRepo } from "@/lib/projects/repo";
import {
  connectorDependencyPinsForSnapshot,
} from "@/lib/projects/connector-dependencies";
import {
  parseApiOperationReference,
  validateApiOperationReference,
  type OperationClosureSnapshot,
} from "./operation-closure";
import type { ConnectorRepository } from "./repository";
import {
  AUDIT_UNAVAILABLE,
  SIMULATION_CANCELLED,
  SIMULATION_DRIFT_REFUSED,
  SIMULATION_INPUT_REFUSED,
  SIMULATION_INVALID_REQUEST,
  SIMULATION_NOT_FOUND,
  SIMULATION_POLICY_REFUSED,
  SIMULATION_REFUSED,
  SIMULATION_TIMEOUT,
  SIMULATION_UNAVAILABLE,
  UNSUPPORTED_FIXTURE_INPUT,
  buildApiOperationSimulationReceipt,
  parseApiOperationSimulationRequest,
  validateConnectorValue,
  type ApiOperationSimulationFailureCode,
  type ApiOperationSimulationReceiptV1,
} from "./simulation-contract";
import {
  abandonSimulationLease,
  assertActiveSimulationLease,
  consumeSimulationAuthority,
  createSimulationAuthority,
  finalizeSimulationLease,
  type SimulationAuthorityFacts,
  type SimulationLease,
  type SimulationProjectContextFacts,
} from "./simulation-authority";
import {
  resolveApiOperationSimulationRequestValue,
  runLocalApiOperationSimulation,
} from "./simulation-runtime";

export type ApiOperationSimulationServiceResult =
  | Readonly<{ ok: true; receipt: ApiOperationSimulationReceiptV1 }>
  | Readonly<{ ok: false; code: ApiOperationSimulationFailureCode; correlationId?: string }>;

export interface ApiOperationSimulationServiceDependencies {
  readonly flowRepo: Pick<FlowRepo, "getOwnedFlow">;
  readonly projectRepo: Pick<ProjectRepo, "getFlowContext">;
  readonly connectorRepository: ConnectorRepository;
  readonly now?: () => number;
}

export interface ApiOperationSimulationServiceInput {
  readonly ownerId: string;
  readonly actorId: string;
  readonly flowId: string;
  readonly request: unknown;
  readonly correlation: AuditCorrelation;
  readonly simulationId: string;
  readonly signal: AbortSignal;
  readonly deadlineGeneration: number;
  readonly deadlineAtMs: number;
}

class SimulationTerminalError extends Error {
  constructor(readonly code: ApiOperationSimulationFailureCode) { super(code); }
}

class SimulationAbortError extends Error {
  constructor(readonly code: typeof SIMULATION_CANCELLED | typeof SIMULATION_TIMEOUT) { super(code); }
}

export function simulationAbortCode(signal: AbortSignal): typeof SIMULATION_CANCELLED | typeof SIMULATION_TIMEOUT {
  return signal.reason === SIMULATION_TIMEOUT ||
    (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError")
    ? SIMULATION_TIMEOUT
    : SIMULATION_CANCELLED;
}

function awaitWithSimulationSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(new SimulationAbortError(simulationAbortCode(signal)));
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      work();
    };
    const abort = (): void => finish(() => reject(new SimulationAbortError(simulationAbortCode(signal))));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
}

function errorCode(code: ApiOperationSimulationFailureCode): AuditErrorCode {
  if (code === SIMULATION_INVALID_REQUEST) return "PARSE_REFUSED";
  if (code === UNSUPPORTED_FIXTURE_INPUT || code === SIMULATION_POLICY_REFUSED) return "POLICY_REFUSED";
  if (code === SIMULATION_NOT_FOUND || code === SIMULATION_DRIFT_REFUSED) return "DRIFT_REFUSED";
  if (code === SIMULATION_TIMEOUT) return "TIMEOUT_REFUSED";
  if (code === SIMULATION_UNAVAILABLE) return "PERSISTENCE_REFUSED";
  return "SIMULATION_REFUSED";
}

function duration(startedAt: number, now: number): number {
  return Number.isSafeInteger(now) && now >= startedAt ? Math.min(now - startedAt, 86_400_000) : 0;
}

function samePins(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fixedThrownCode(
  error: unknown,
  fallback: typeof SIMULATION_POLICY_REFUSED | typeof SIMULATION_DRIFT_REFUSED,
): typeof SIMULATION_POLICY_REFUSED | typeof SIMULATION_DRIFT_REFUSED {
  return error instanceof Error && error.message === SIMULATION_DRIFT_REFUSED
    ? SIMULATION_DRIFT_REFUSED
    : fallback;
}

function hasSecretInPlan(graph: FlowGraphV2, plan: PlannedFlowTestScope): boolean {
  const included = new Set(plan.nodeIds);
  return graph.nodes.some((node) => included.has(node.id) &&
    Object.values(node.bindings).some((binding) => binding.kind === "secret" ||
      (binding.kind === "variable" && graph.variables.find(({ id }) => id === binding.variableId)?.sensitive === true))) ||
    graph.edges.some((edge) => {
      const condition = edge.condition;
      return included.has(edge.target) && (condition?.kind === "secret" ||
        (condition?.kind === "variable" && graph.variables.find(({ id }) => id === condition.variableId)?.sensitive === true));
    });
}

function cloneJson<Value extends JsonValue>(value: Value): Value {
  return structuredClone(value) as Value;
}

function pointer(value: JsonValue, path: string | undefined): JsonValue {
  if (path === undefined || path === "") return cloneJson(value);
  if (!path.startsWith("/")) throw new TypeError(SIMULATION_POLICY_REFUSED);
  let current: JsonValue = value;
  for (const raw of path.slice(1).split("/")) {
    if (/~(?![01])/u.test(raw)) throw new TypeError(SIMULATION_POLICY_REFUSED);
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new TypeError(SIMULATION_POLICY_REFUSED);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length) throw new TypeError(SIMULATION_POLICY_REFUSED);
      current = current[Number(key)]!;
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, key)) {
      current = (current as Readonly<Record<string, JsonValue>>)[key]!;
    } else {
      throw new TypeError(SIMULATION_POLICY_REFUSED);
    }
  }
  return cloneJson(current);
}

function pinValue(
  plan: PlannedFlowTestScope,
  pins: Readonly<Record<string, JsonValue>>,
  match: (pin: PlannedFlowTestScope["boundaryPins"][number]) => boolean,
): JsonValue {
  const matches = plan.boundaryPins.filter(match);
  if (matches.length !== 1 || !Object.hasOwn(pins, matches[0]!.key)) throw new TypeError(SIMULATION_DRIFT_REFUSED);
  return cloneJson(pins[matches[0]!.key]!);
}

function localBinding(
  binding: ValueBinding,
  graph: FlowGraphV2,
  plan: PlannedFlowTestScope,
  pins: Readonly<Record<string, JsonValue>>,
  nodeId: string,
  bindingKey: string,
  included: ReadonlySet<string>,
): ValueBinding {
  if (binding.kind === "secret") throw new TypeError(SIMULATION_POLICY_REFUSED);
  if (binding.kind === "literal") return Object.freeze({ kind: "literal", value: cloneJson(binding.value) });
  if (binding.kind === "variable") {
    const variable = graph.variables.find(({ id }) => id === binding.variableId);
    if (!variable || variable.sensitive === true || !Object.hasOwn(variable, "default")) throw new TypeError(SIMULATION_POLICY_REFUSED);
    return Object.freeze({ kind: "literal", value: pointer(variable.default!, binding.path) });
  }
  if (!included.has(binding.nodeId)) {
    pinValue(plan, pins, (pin) => pin.kind === "node-binding" &&
      pin.targetNodeId === nodeId && pin.bindingKey === bindingKey);
  }
  return Object.freeze({ ...binding });
}

function localCondition(
  condition: ValueBinding | undefined,
  graph: FlowGraphV2,
  plan: PlannedFlowTestScope,
  pins: Readonly<Record<string, JsonValue>>,
  edge: FlowEdgeV2,
  included: ReadonlySet<string>,
): ValueBinding | undefined {
  if (!condition) return undefined;
  if (condition.kind === "port" && !included.has(condition.nodeId)) {
    const value = pinValue(plan, pins, (pin) => pin.kind === "edge-condition" &&
      pin.edgeId === edge.id && pin.targetNodeId === edge.target);
    if (typeof value !== "boolean") throw new TypeError(SIMULATION_DRIFT_REFUSED);
    return Object.freeze({ ...condition });
  }
  return localBinding(condition, graph, plan, pins, edge.target, `condition:${edge.id}`, included);
}

function localParams(node: FlowNodeV2): Record<string, JsonValue> {
  if (node.type === "api.operation") {
    const keys = [
      "connectorDefinitionVersionId", "operationVersionId", "operationId",
      "connectorProjectionHash", "operationProjectionHash", "schemaHash",
    ] as const;
    const params: Record<string, JsonValue> = {};
    for (const key of keys) {
      const value = node.params[key];
      if (typeof value !== "string") throw new TypeError(SIMULATION_DRIFT_REFUSED);
      params[key] = value;
    }
    return Object.freeze(params);
  }
  if (node.type === "output") return Object.freeze({});
  if (node.type === "transform") {
    if (typeof node.params.expression !== "string") throw new TypeError(SIMULATION_POLICY_REFUSED);
    return Object.freeze({ expression: node.params.expression });
  }
  if (node.type === "branch") {
    const params: Record<string, JsonValue> = {};
    if (typeof node.params.field === "string") params.field = node.params.field;
    if (Object.hasOwn(node.params, "equals")) params.equals = cloneJson(node.params.equals!);
    if (typeof node.params.truthy === "boolean") params.truthy = node.params.truthy;
    return Object.freeze(params);
  }
  throw new TypeError(SIMULATION_POLICY_REFUSED);
}

function detachedGraph(
  graph: FlowGraphV2,
  plan: PlannedFlowTestScope,
  pins: Readonly<Record<string, JsonValue>>,
): FlowGraphV2 {
  const included = new Set(plan.nodeIds);
  const bindings = new Map<string, Record<string, ValueBinding>>();
  const nodes = graph.nodes.filter(({ id }) => included.has(id)).map((node) => {
    const projected: Record<string, ValueBinding> = {};
    for (const [key, binding] of Object.entries(node.bindings)) {
      projected[key] = localBinding(binding, graph, plan, pins, node.id, key, included);
    }
    bindings.set(node.id, projected);
    return Object.freeze({
      id: node.id,
      type: node.type,
      params: localParams(node),
      bindings: projected,
      position: Object.freeze({ x: 0, y: 0 }),
    }) as FlowNodeV2;
  });
  const edges: FlowEdgeV2[] = [];
  for (const edge of graph.edges.filter(({ target }) => included.has(target))) {
    const condition = localCondition(edge.condition, graph, plan, pins, edge, included);
    if (!included.has(edge.source)) {
      pinValue(plan, pins, (pin) => pin.kind === "edge-input" &&
        pin.edgeId === edge.id && pin.targetNodeId === edge.target);
    }
    edges.push(Object.freeze({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      ...(condition ? { condition } : {}),
    }));
  }
  return Object.freeze({
    schemaVersion: 2,
    id: graph.id,
    name: "Scoped API operation simulation",
    nodes: Object.freeze(nodes.map((node) => Object.freeze({ ...node, bindings: Object.freeze(bindings.get(node.id)!) }))),
    edges: Object.freeze(edges),
    variables: Object.freeze([]),
    groups: Object.freeze([]),
    annotations: Object.freeze([]),
  });
}

function contextFacts(context: FlowProjectContext, environmentId: string): SimulationProjectContextFacts | null {
  const environment = context.environments.find(({ id }) => id === environmentId);
  if (!environment || environment.kind !== "test" || environment.projectId !== context.project.id ||
      context.binding.projectId !== context.project.id || context.binding.workbookId !== context.workbook.id ||
      context.workbook.projectId !== context.project.id || context.project.workspaceId !== context.workspace.id ||
      context.workspace.organizationId !== context.organization.id) return null;
  return Object.freeze({
    bindingCreatedAt: context.binding.createdAt,
    environmentCreatedAt: environment.createdAt,
    organizationId: context.organization.id,
    workspaceId: context.workspace.id,
    projectId: context.project.id,
    projectUpdatedAt: context.project.updatedAt,
    workbookId: context.workbook.id,
  });
}

function sameContext(left: SimulationProjectContextFacts, right: SimulationProjectContextFacts | null): boolean {
  return right !== null && JSON.stringify(left) === JSON.stringify(right);
}

interface CompiledSimulationScope {
  readonly graph: FlowGraphV2;
  readonly plan: PlannedFlowTestScope;
  readonly portProjection: Readonly<{
    reference: OperationClosureSnapshot["reference"];
    requestSchema: OperationClosureSnapshot["requestSchema"];
    resultSchema: OperationClosureSnapshot["resultSchema"];
  }>;
}

function compileSimulationScope(
  graph: FlowGraphV2,
  nodeId: string,
  scopeKind: "node" | "from-node",
  pins: Readonly<Record<string, JsonValue>>,
  snapshot: OperationClosureSnapshot,
): CompiledSimulationScope {
  const selected = graph.nodes.find((node) => node.id === nodeId);
  if (!selected || selected.type !== "api.operation") throw new TypeError(SIMULATION_NOT_FOUND);
  const portProjection = Object.freeze({
    reference: snapshot.reference,
    requestSchema: snapshot.requestSchema,
    resultSchema: snapshot.resultSchema,
  });
  const dynamic = createApiOperationPortResolver(new Map([[nodeId, portProjection]]));
  const resolver = createValidatedNodePortResolver(
    graph,
    undefined,
    (node) => node.id === nodeId ? dynamic(node) : undefined,
  );
  const planned = planFlowTestScope(graph, { kind: scopeKind, nodeId }, resolver);
  if (planned.status !== "planned") throw new TypeError(SIMULATION_POLICY_REFUSED);
  const included = new Set(planned.nodeIds);
  const apiNodes = graph.nodes.filter((node) => included.has(node.id) && node.type === "api.operation");
  if (apiNodes.length !== 1 || apiNodes[0]!.id !== nodeId || hasSecretInPlan(graph, planned)) {
    throw new TypeError(SIMULATION_POLICY_REFUSED);
  }
  const expectedPins = planned.boundaryPins.map(({ key }) => key).sort();
  const actualPins = Object.keys(pins).sort();
  if (expectedPins.length !== actualPins.length || expectedPins.some((key, index) => key !== actualPins[index])) {
    throw new TypeError(SIMULATION_DRIFT_REFUSED);
  }
  const projected = detachedGraph(graph, planned, pins);
  // This resolver validates exactly the planned nodes and the one operation closure.
  const scopedResolver = createValidatedApiOperationNodePortResolver(
    Object.freeze({ ...projected, edges: Object.freeze(projected.edges.filter(({ source }) => included.has(source))) }),
    new Map([[nodeId, portProjection]]),
  );
  for (const node of projected.nodes) scopedResolver(node);
  return Object.freeze({ graph: projected, plan: planned, portProjection });
}

function sameCompiledScope(left: CompiledSimulationScope, right: CompiledSimulationScope): boolean {
  return JSON.stringify(left.graph) === JSON.stringify(right.graph) &&
    JSON.stringify(left.plan) === JSON.stringify(right.plan) &&
    JSON.stringify(left.portProjection) === JSON.stringify(right.portProjection);
}

function requestNames(snapshot: OperationClosureSnapshot, key: "path" | "query" | "headers"): readonly string[] {
  return Object.freeze(Object.keys(snapshot.requestSchema.properties?.[key]?.properties ?? {}).sort());
}

function credential(snapshot: OperationClosureSnapshot): ApiOperationSimulationReceiptV1["operation"]["credentialPlaceholder"] {
  const auth = snapshot.authentication;
  if (auth.kind === "none") return null;
  return Object.freeze({
    kind: auth.kind,
    headerName: auth.kind === "api_key_header" ? auth.headerName : "authorization",
    value: "[redacted]" as const,
  });
}

interface SimulationAuditEvidence {
  readonly versionId: string;
  readonly projectionHash: string;
  readonly schemaHash: string;
}

function simulationEvidence(snapshot: OperationClosureSnapshot): SimulationAuditEvidence {
  return Object.freeze({
    versionId: snapshot.operation.id,
    projectionHash: snapshot.operation.operationProjectionHash,
    schemaHash: snapshot.operation.schemaHash,
  });
}

export class ApiOperationSimulationService {
  readonly #flowRepo: ApiOperationSimulationServiceDependencies["flowRepo"];
  readonly #projectRepo: ApiOperationSimulationServiceDependencies["projectRepo"];
  readonly #connectorRepository: ConnectorRepository;
  readonly #now: () => number;

  constructor(dependencies: ApiOperationSimulationServiceDependencies) {
    this.#flowRepo = dependencies.flowRepo;
    this.#projectRepo = dependencies.projectRepo;
    this.#connectorRepository = dependencies.connectorRepository;
    this.#now = dependencies.now ?? Date.now;
  }

  recordRefusal(
    input: Omit<ApiOperationSimulationServiceInput, "request">,
    code: ApiOperationSimulationFailureCode,
  ): ApiOperationSimulationServiceResult {
    return this.#refuse({ ...input, request: Object.freeze({}) }, code, this.#now());
  }

  #appendRefusal(
    input: ApiOperationSimulationServiceInput,
    code: ApiOperationSimulationFailureCode,
    startedAt: number,
    evidence?: SimulationAuditEvidence,
  ): boolean {
    try {
      this.#connectorRepository.immediate((transaction) => {
        transaction.appendAudit({
          correlation: input.correlation,
          action: "connector.simulation",
          resource: {
            kind: "simulation",
            id: input.simulationId,
            versionId: evidence?.versionId ?? null,
            projectionHash: evidence?.projectionHash ?? null,
            schemaHash: evidence?.schemaHash ?? null,
          },
          outcome: "refused",
          errorCode: errorCode(code),
          connection: null,
          durationMs: duration(startedAt, this.#now()),
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  #refuse(
    input: ApiOperationSimulationServiceInput,
    code: ApiOperationSimulationFailureCode,
    startedAt: number,
    evidence?: SimulationAuditEvidence,
  ): ApiOperationSimulationServiceResult {
    return this.#appendRefusal(input, code, startedAt, evidence)
      ? Object.freeze({ ok: false, code, correlationId: auditCorrelationId(input.correlation) })
      : Object.freeze({ ok: false, code: AUDIT_UNAVAILABLE });
  }

  async simulate(input: ApiOperationSimulationServiceInput): Promise<ApiOperationSimulationServiceResult> {
    const startedAt = this.#now();
    const boundSignal = input.signal;
    const boundDeadlineGeneration = input.deadlineGeneration;
    const boundDeadlineAtMs = input.deadlineAtMs;
    if (boundSignal.aborted) return this.#refuse(input, simulationAbortCode(boundSignal), startedAt);
    const parsed = parseApiOperationSimulationRequest(input.request);
    if (!parsed.ok) return this.#refuse(input, parsed.code, startedAt);
    const request = parsed.value;

    let flow;
    let context;
    try {
      [flow, context] = await awaitWithSimulationSignal(Promise.all([
        this.#flowRepo.getOwnedFlow(input.flowId, input.ownerId),
        this.#projectRepo.getFlowContext(input.flowId, input.ownerId),
      ]), boundSignal);
    } catch (error) {
      if (error instanceof SimulationAbortError || boundSignal.aborted) {
        return this.#refuse(input, error instanceof SimulationAbortError ? error.code : simulationAbortCode(boundSignal), startedAt);
      }
      return this.#refuse(input, SIMULATION_UNAVAILABLE, startedAt);
    }
    if (boundSignal.aborted) return this.#refuse(input, simulationAbortCode(boundSignal), startedAt);
    if (!flow || !context || context.binding.flowId !== input.flowId ||
        context.binding.projectId !== context.project.id) return this.#refuse(input, SIMULATION_NOT_FOUND, startedAt);
    const initialContextFacts = contextFacts(context, request.environmentId);
    if (!initialContextFacts) return this.#refuse(input, SIMULATION_NOT_FOUND, startedAt);
    if (!isFlowGraphV2(flow.graph)) return this.#refuse(input, SIMULATION_POLICY_REFUSED, startedAt);
    const graph = flow.graph;
    const node = graph.nodes.find(({ id }) => id === request.nodeId);
    if (!node || node.type !== "api.operation") return this.#refuse(input, SIMULATION_NOT_FOUND, startedAt);

    let reference;
    try { reference = parseApiOperationReference(node.params); } catch {
      return this.#refuse(input, SIMULATION_DRIFT_REFUSED, startedAt);
    }
    let closure;
    try { closure = this.#connectorRepository.getOperationClosure(input.ownerId, reference.operationVersionId); } catch {
      return this.#refuse(input, SIMULATION_UNAVAILABLE, startedAt);
    }
    if (!closure) return this.#refuse(input, SIMULATION_NOT_FOUND, startedAt);
    let snapshot: OperationClosureSnapshot;
    try { snapshot = validateApiOperationReference(reference, closure); } catch {
      return this.#refuse(input, SIMULATION_DRIFT_REFUSED, startedAt, {
        versionId: reference.operationVersionId,
        projectionHash: reference.operationProjectionHash,
        schemaHash: reference.schemaHash,
      });
    }
    const evidence = simulationEvidence(snapshot);
    if (snapshot.identity.archivedAt !== null) return this.#refuse(input, SIMULATION_DRIFT_REFUSED, startedAt, evidence);

    const scope = { kind: request.scope, nodeId: request.nodeId } as const;
    let compiledScope: CompiledSimulationScope;
    try {
      compiledScope = compileSimulationScope(graph, node.id, request.scope, request.pinnedInputs, snapshot);
    } catch (error) {
      return this.#refuse(input, fixedThrownCode(error, SIMULATION_POLICY_REFUSED), startedAt, evidence);
    }
    let requestValue: unknown;
    try { requestValue = resolveApiOperationSimulationRequestValue({ graph: compiledScope.graph, plan: compiledScope.plan, pinnedInputs: request.pinnedInputs, nodeId: node.id }); } catch {
      return this.#refuse(input, SIMULATION_INPUT_REFUSED, startedAt, evidence);
    }
    if (!validateConnectorValue(snapshot.requestSchema, requestValue)) {
      return this.#refuse(input, SIMULATION_INPUT_REFUSED, startedAt, evidence);
    }

    let dependencyPins;
    try { dependencyPins = connectorDependencyPinsForSnapshot(snapshot); } catch {
      return this.#refuse(input, SIMULATION_DRIFT_REFUSED, startedAt, evidence);
    }
    const resultStatus = snapshot.resultSchema.properties?.status?.minimum;
    if (!Number.isSafeInteger(resultStatus)) return this.#refuse(input, SIMULATION_REFUSED, startedAt, evidence);
    try {
      buildApiOperationSimulationReceipt({
        correlationId: auditCorrelationId(input.correlation),
        simulationId: input.simulationId,
        operationVersionId: snapshot.operation.id,
        operationId: snapshot.operationId,
        connectorProjectionHash: snapshot.definition.connectorProjectionHash,
        operationProjectionHash: snapshot.operation.operationProjectionHash,
        schemaHash: snapshot.operation.schemaHash,
        method: snapshot.operation.projection.method,
        origin: snapshot.definition.projection.origin,
        pathTemplate: snapshot.operation.projection.path,
        pathParameterNames: requestNames(snapshot, "path"),
        queryParameterNames: requestNames(snapshot, "query"),
        requestHeaderNames: requestNames(snapshot, "headers"),
        hasBody: Object.hasOwn(snapshot.requestSchema.properties ?? {}, "body"),
        selectedStatus: resultStatus as number,
        credentialPlaceholder: credential(snapshot),
        systemPolicy: snapshot.systemPolicy,
        authorAnnotation: snapshot.authorAnnotation,
        plannedNodeCount: compiledScope.plan.nodeIds.length,
        completedNodeCount: compiledScope.plan.nodeIds.length,
        durationMs: 86_400_000,
      });
    } catch {
      return this.#refuse(input, SIMULATION_REFUSED, startedAt, evidence);
    }
    const authorityFacts: SimulationAuthorityFacts = {
      ownerId: input.ownerId,
      actorId: input.actorId,
      flowId: input.flowId,
      flowUpdatedAt: flow.updatedAt,
      environmentId: request.environmentId,
      context: initialContextFacts,
      nodeId: node.id,
      scope,
      signal: boundSignal,
      deadlineGeneration: boundDeadlineGeneration,
      deadlineAtMs: boundDeadlineAtMs,
      graph: compiledScope.graph,
      plan: compiledScope.plan,
      pinnedInputs: request.pinnedInputs,
      reference: snapshot.reference,
      closure: snapshot.closure,
      lifecycleRevision: snapshot.identity.lifecycleRevision,
      archivedAt: snapshot.identity.archivedAt,
      dependencyPins,
      portProjection: compiledScope.portProjection,
      requestSchema: snapshot.requestSchema,
      resultSchema: snapshot.resultSchema,
      systemPolicy: snapshot.systemPolicy,
    };
    let lease: SimulationLease;
    try { lease = consumeSimulationAuthority(createSimulationAuthority(authorityFacts)); } catch {
      return this.#refuse(input, SIMULATION_REFUSED, startedAt, evidence);
    }
    let runtime;
    try { runtime = await runLocalApiOperationSimulation(lease); } catch {
      try { abandonSimulationLease(lease); } catch { /* terminal refusal */ }
      return this.#refuse(input, SIMULATION_REFUSED, startedAt, evidence);
    }
    if (!runtime.ok) {
      try { abandonSimulationLease(lease); } catch { /* terminal refusal */ }
      return this.#refuse(input, runtime.code === SIMULATION_CANCELLED && boundSignal.aborted
        ? simulationAbortCode(boundSignal)
        : runtime.code, startedAt, evidence);
    }
    if (boundSignal.aborted) {
      try { abandonSimulationLease(lease); } catch { /* terminal refusal */ }
      return this.#refuse(input, simulationAbortCode(boundSignal), startedAt, evidence);
    }

    let terminalFlow;
    let terminalContext;
    try {
      [terminalFlow, terminalContext] = await awaitWithSimulationSignal(Promise.all([
        this.#flowRepo.getOwnedFlow(input.flowId, input.ownerId),
        this.#projectRepo.getFlowContext(input.flowId, input.ownerId),
      ]), boundSignal);
    } catch (error) {
      try { abandonSimulationLease(lease); } catch { /* terminal refusal */ }
      if (error instanceof SimulationAbortError || boundSignal.aborted) {
        return this.#refuse(input, error instanceof SimulationAbortError ? error.code : simulationAbortCode(boundSignal), startedAt, evidence);
      }
      return this.#refuse(input, SIMULATION_UNAVAILABLE, startedAt, evidence);
    }
    if (!terminalFlow || terminalFlow.updatedAt !== flow.updatedAt ||
        JSON.stringify(terminalFlow.graph) !== JSON.stringify(graph) ||
        !terminalContext || terminalContext.binding.flowId !== input.flowId ||
        !sameContext(initialContextFacts, contextFacts(terminalContext, request.environmentId)) ||
        input.signal !== boundSignal || input.deadlineGeneration !== boundDeadlineGeneration ||
        input.deadlineAtMs !== boundDeadlineAtMs) {
      try { abandonSimulationLease(lease); } catch { /* terminal refusal */ }
      return this.#refuse(input, SIMULATION_DRIFT_REFUSED, startedAt, evidence);
    }

    let receipt: ApiOperationSimulationReceiptV1;
    try {
      receipt = buildApiOperationSimulationReceipt({
        correlationId: auditCorrelationId(input.correlation),
        simulationId: input.simulationId,
        operationVersionId: snapshot.operation.id,
        operationId: snapshot.operationId,
        connectorProjectionHash: snapshot.definition.connectorProjectionHash,
        operationProjectionHash: snapshot.operation.operationProjectionHash,
        schemaHash: snapshot.operation.schemaHash,
        method: snapshot.operation.projection.method,
        origin: snapshot.definition.projection.origin,
        pathTemplate: snapshot.operation.projection.path,
        pathParameterNames: requestNames(snapshot, "path"),
        queryParameterNames: requestNames(snapshot, "query"),
        requestHeaderNames: requestNames(snapshot, "headers"),
        hasBody: Object.hasOwn(snapshot.requestSchema.properties ?? {}, "body"),
        selectedStatus: resultStatus as number,
        credentialPlaceholder: credential(snapshot),
        systemPolicy: snapshot.systemPolicy,
        authorAnnotation: snapshot.authorAnnotation,
        plannedNodeCount: runtime.plannedNodeCount,
        completedNodeCount: runtime.completedNodeCount,
        durationMs: duration(startedAt, this.#now()),
      });
    } catch {
      try { abandonSimulationLease(lease); } catch { /* terminal refusal */ }
      return this.#refuse(input, SIMULATION_REFUSED, startedAt, evidence);
    }

    try {
      this.#connectorRepository.immediate((transaction) => {
        const currentClosure = transaction.getOperationClosure(input.ownerId, reference.operationVersionId);
        if (!currentClosure) throw new SimulationTerminalError(SIMULATION_DRIFT_REFUSED);
        let current: OperationClosureSnapshot;
        try { current = validateApiOperationReference(reference, currentClosure); } catch {
          throw new SimulationTerminalError(SIMULATION_DRIFT_REFUSED);
        }
        if (current.identity.archivedAt !== null || current.identity.lifecycleRevision !== snapshot.identity.lifecycleRevision ||
            !samePins(connectorDependencyPinsForSnapshot(current), dependencyPins)) {
          throw new SimulationTerminalError(SIMULATION_DRIFT_REFUSED);
        }
        let currentCompiled: CompiledSimulationScope;
        try {
          currentCompiled = compileSimulationScope(
            terminalFlow.graph as FlowGraphV2,
            node.id,
            request.scope,
            request.pinnedInputs,
            current,
          );
        } catch {
          throw new SimulationTerminalError(SIMULATION_DRIFT_REFUSED);
        }
        if (!sameCompiledScope(compiledScope, currentCompiled) ||
            JSON.stringify(current.systemPolicy) !== JSON.stringify(snapshot.systemPolicy) ||
            input.signal !== boundSignal || input.deadlineGeneration !== boundDeadlineGeneration ||
            input.deadlineAtMs !== boundDeadlineAtMs) {
          throw new SimulationTerminalError(SIMULATION_DRIFT_REFUSED);
        }
        assertActiveSimulationLease(lease, authorityFacts);
        if (boundSignal.aborted) throw new SimulationTerminalError(simulationAbortCode(boundSignal));
        if (performance.now() >= boundDeadlineAtMs) throw new SimulationTerminalError(SIMULATION_TIMEOUT);
        const completed: ControlAuditEventInput = {
          correlation: input.correlation,
          action: "connector.simulation",
          resource: {
            kind: "simulation",
            id: input.simulationId,
            versionId: snapshot.operation.id,
            projectionHash: snapshot.operation.operationProjectionHash,
            schemaHash: snapshot.operation.schemaHash,
          },
          outcome: "completed",
          errorCode: null,
          connection: null,
          durationMs: receipt.durationMs,
        };
        transaction.appendAudit(completed);
        if (boundSignal.aborted) throw new SimulationTerminalError(simulationAbortCode(boundSignal));
        if (performance.now() >= boundDeadlineAtMs) throw new SimulationTerminalError(SIMULATION_TIMEOUT);
      });
    } catch (error) {
      try { abandonSimulationLease(lease); } catch { /* terminal refusal */ }
      const code = error instanceof SimulationTerminalError ? error.code : SIMULATION_UNAVAILABLE;
      return this.#refuse(input, code, startedAt, evidence);
    }
    finalizeSimulationLease(lease);
    return Object.freeze({ ok: true, receipt });
  }
}
