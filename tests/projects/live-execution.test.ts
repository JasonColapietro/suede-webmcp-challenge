import { describe, expect, it, vi } from "vitest";
import type {
  FlowCallableInterface,
  FlowGraphV2,
  SubflowReference,
  SupportedFlowGraph,
} from "@/lib/flow/types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { hashFlowGraph } from "@/lib/projects/hash";
import { derivePinnedFlowDependencies } from "@/lib/projects/subflow-dependencies";
import type { FlowProjectContext, ProjectRepo } from "@/lib/projects/repo";
import type {
  DependencyPin,
  DeploymentRecord,
  FlowVersionRecord,
} from "@/lib/projects/types";
import { resolveActiveLiveExecution } from "@/lib/projects/live-execution";
import { API_OPERATION_LIVE_UNAVAILABLE } from "@/lib/connectors/operation-closure";
import {
  bindPreparedPublishedLiveResourceSnapshot,
  disposePreparedPublishedLiveExecution,
  consumePreparedPublishedLiveRelay,
  preparePublishedLiveExecution,
  preparedPublishedLiveExecutionReceipt,
  preparedPublishedLiveRelaySnapshot,
  runPreparedPublishedLiveToCompletion,
  runPreparedPublishedLiveDryRunToCompletion,
  runPublishedLiveToCompletion,
  runToCompletion,
} from "@/lib/run-service";
import { resourcePack } from "../resources/fixture";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";

const runnerState = vi.hoisted(() => ({
  projectRepo: null as ProjectRepo | null,
  connectionRepository: {
    close: vi.fn(),
    dispose: vi.fn(),
    resolveHeaders: vi.fn(),
  },
  secretResolver: vi.fn(),
  provider: vi.fn(),
  resolverFactory: vi.fn(),
  runFlow: vi.fn(),
  buildRunContext: vi.fn(),
}));

vi.mock("@/lib/projects/provider", () => ({
  getProjectRepo: vi.fn(async () => runnerState.projectRepo),
}));
vi.mock("@/lib/connections/provider", () => ({
  getConnectionRepository: (...args: unknown[]) => runnerState.provider(...args),
}));
vi.mock("@/lib/connections/runtime-resolver", () => ({
  createConnectionSecretResolver: (...args: unknown[]) => runnerState.resolverFactory(...args),
}));
vi.mock("@/lib/flow/engine", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/flow/engine")>(),
  runCostCeilingUsdc: () => 25,
  runFlow: (...args: unknown[]) => runnerState.runFlow(...args),
}));
vi.mock("@/lib/run-context", () => ({
  buildRunContext: (...args: unknown[]) => runnerState.buildRunContext(...args),
}));

const runRepository = vi.hoisted(() => ({
  sumAgentCostSince: vi.fn(async () => 0),
  createRun: vi.fn(async () => ({ id: "run-1" })),
  getRun: vi.fn(),
  getFlow: vi.fn(async () => ({ ownerId: "owner-1" })),
  appendStep: vi.fn(async () => undefined),
  finishRun: vi.fn(async () => undefined),
  getAgent: vi.fn<() => Promise<{
    id: string;
    flowId: string;
    status: string;
    priceUsdc: number;
  } | null>>(async () => null),
  getRelayEndpoint: vi.fn<() => Promise<{
    agentId: string;
    url: string;
    secret: string;
    protocolVersion: 1 | 2;
    createdAt: string;
  } | null>>(async () => null),
}));
vi.mock("@/lib/db/repo", () => ({ getRepo: vi.fn(async () => runRepository) }));

const OWNER = "owner-1";
const FLOW = "flow-1";
const PROJECT = "project-1";
const LIVE_ENVIRONMENT = "environment-live";

function graph(revision: number): SupportedFlowGraph {
  return {
    id: "graph-not-row-id",
    name: `Published revision ${revision}`,
    nodes: [{
      id: "input",
      type: "input",
      params: { revision },
      position: { x: revision, y: 0 },
    }],
    edges: [],
  };
}

const callableInterface: FlowCallableInterface = { inputs: [], outputs: [] };

function callableGraph(
  id: string,
  references: readonly SubflowReference[] = [],
): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id,
    name: id,
    nodes: references.map((reference, index) => ({
        id: `child-${index}`,
        type: "subflow" as const,
        params: { reference } as never,
        bindings: {},
        position: { x: index * 100, y: 0 },
      })),
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    callableInterface,
  };
}

function connectionGraph(id: string): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id,
    name: id,
    nodes: [{
      id: "http",
      type: "http",
      params: { method: "GET", url: "https://example.com" },
      bindings: {
        headers: { kind: "secret", connectionId: "connection-1", field: "headers" },
      },
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
  };
}

function apiOperationGraph(id: string): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id,
    name: id,
    nodes: [{
      id: "api",
      type: "api.operation",
      params: {
        connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000601",
        operationVersionId: "00000000-0000-4000-8000-000000000602",
        operationId: "createThing",
        connectorProjectionHash: "1".repeat(64),
        operationProjectionHash: "2".repeat(64),
        schemaHash: "3".repeat(64),
      },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [], variables: [], groups: [], annotations: [],
  };
}

const RESOURCE_PRODUCT = "resource-product-1";
const RESOURCE_VERSION = "resource-version-1";
const RESOURCE_CONTENT = resourcePack();
const RESOURCE_HASH = resourcePackSemanticHash(RESOURCE_CONTENT).semanticHash;

function resourceQueryGraph(id: string, callable = false): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id,
    name: id,
    nodes: [{
      id: "resource-query",
      type: "resource.query",
      params: {
        resourceProductId: RESOURCE_PRODUCT,
        packVersionId: RESOURCE_VERSION,
        resourcePackContentHash: RESOURCE_HASH,
        filterFields: [],
        returnFields: [],
      },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: [],
    groups: [],
    annotations: [],
    ...(callable ? { callableInterface } : {}),
  };
}

function resourceDependency(versionId: string): DependencyPin {
  return {
    id: `resource-pin-${versionId}`,
    flowVersionId: versionId,
    kind: "resource",
    resourceId: RESOURCE_PRODUCT,
    version: RESOURCE_VERSION,
    contentHash: RESOURCE_HASH,
    createdAt: 1,
  };
}

function pinnedReference(
  child: FlowVersionRecord,
): Extract<SubflowReference, { readonly kind: "pinned" }> {
  return {
    kind: "pinned",
    flowId: child.flowId,
    versionId: child.id,
    interface: callableInterface,
    interfaceHash: hashCallableInterface(callableInterface),
    contentHash: child.semanticHash,
  };
}

function flowVersion(input: {
  id: string;
  flowId: string;
  graph: SupportedFlowGraph;
  dependencies?: readonly DependencyPin[];
}): FlowVersionRecord {
  let derived: readonly DependencyPin[] = [];
  try {
    derived = derivePinnedFlowDependencies(input.graph).map((dependency, index) => ({
      id: `pin-${input.id}-${index}`,
      flowVersionId: input.id,
      ...dependency,
      createdAt: 1,
    }));
  } catch {
    derived = [];
  }
  const dependencies = input.dependencies ?? derived;
  const inputs = dependencies.map(({ kind, resourceId, version: pinVersion, contentHash }) => ({
    kind,
    resourceId,
    version: pinVersion,
    ...(contentHash === undefined ? {} : { contentHash }),
  }));
  return {
    id: input.id,
    flowId: input.flowId,
    versionNumber: 1,
    schemaVersion: 1,
    graph: input.graph,
    semanticHash: hashFlowGraph(input.graph, { semantic: true }, inputs),
    fullHash: hashFlowGraph(input.graph, { semantic: false }, inputs),
    createdBy: OWNER,
    createdAt: 1,
    dependencies,
  };
}

function repositoryWithVersions(root: FlowVersionRecord, children: readonly FlowVersionRecord[]) {
  const projectRepo = repository({ version: root });
  const byId = new Map([root, ...children].map((item) => [item.id, item]));
  projectRepo.getFlowVersion.mockImplementation(async ({ flowId, versionId, ownerId }) => {
    const item = byId.get(versionId) ?? null;
    return ownerId === OWNER && item?.flowId === flowId ? item : null;
  });
  return projectRepo;
}

function dependency(versionId: string): DependencyPin {
  return {
    id: `pin-${versionId}`,
    flowVersionId: versionId,
    kind: "connector",
    resourceId: "connector-1",
    version: "2026-07-12",
    contentHash: "a".repeat(64),
    createdAt: 1,
  };
}

function version(
  versionId = "version-1",
  value = graph(1),
  dependencies: readonly DependencyPin[] = [dependency(versionId)],
): FlowVersionRecord {
  const dependencyInputs = dependencies.map(({ kind, resourceId, version: pinnedVersion, contentHash }) => ({
    kind,
    resourceId,
    version: pinnedVersion,
    ...(contentHash === undefined ? {} : { contentHash }),
  }));
  return {
    id: versionId,
    flowId: FLOW,
    versionNumber: Number(versionId.at(-1) ?? "1"),
    schemaVersion: 1,
    graph: value,
    semanticHash: hashFlowGraph(value, { semantic: true }, dependencyInputs),
    fullHash: hashFlowGraph(value, { semantic: false }, dependencyInputs),
    createdBy: OWNER,
    createdAt: 1,
    dependencies,
  };
}

function deployment(versionId = "version-1"): DeploymentRecord {
  return {
    id: `deployment-${versionId}`,
    flowId: FLOW,
    flowVersionId: versionId,
    environmentId: LIVE_ENVIRONMENT,
    status: "live",
    createdAt: 1,
  };
}

function context(): FlowProjectContext {
  return {
    binding: { flowId: FLOW, projectId: PROJECT, workbookId: "workbook-1", createdAt: 1 },
    organization: {
      id: "organization-1",
      personalOwnerId: OWNER,
      name: "Personal",
      kind: "personal",
      createdAt: 1,
    },
    workspace: {
      id: "workspace-1",
      organizationId: "organization-1",
      name: "Workspace",
      slug: "workspace",
      createdAt: 1,
    },
    project: {
      id: PROJECT,
      workspaceId: "workspace-1",
      name: "Project",
      slug: "project",
      createdAt: 1,
      updatedAt: 1,
    },
    workbook: {
      id: "workbook-1",
      projectId: PROJECT,
      name: "Workbook",
      slug: "workbook",
      position: 0,
      createdAt: 1,
    },
    environments: [
      { id: "environment-draft", projectId: PROJECT, name: "Draft", slug: "draft", kind: "draft", createdAt: 1 },
      { id: "environment-test", projectId: PROJECT, name: "Test", slug: "test", kind: "test", createdAt: 1 },
      { id: LIVE_ENVIRONMENT, projectId: PROJECT, name: "Live", slug: "live", kind: "live", createdAt: 1 },
    ],
  };
}

function repository(input: {
  deployment?: DeploymentRecord | null;
  context?: FlowProjectContext | null;
  version?: FlowVersionRecord | null;
} = {}) {
  const active = input.deployment === undefined ? deployment() : input.deployment;
  const flowContext = input.context === undefined ? context() : input.context;
  const pinned = input.version === undefined ? version() : input.version;
  return {
    getActiveDeployment: vi.fn(async () => active),
    getFlowContext: vi.fn(async () => flowContext),
    getFlowVersion: vi.fn(async () => pinned),
  } as unknown as ProjectRepo & {
    getActiveDeployment: ReturnType<typeof vi.fn>;
    getFlowContext: ReturnType<typeof vi.fn>;
    getFlowVersion: ReturnType<typeof vi.fn>;
  };
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value).every((key) => deeplyFrozen(Reflect.get(value, key), seen));
}

describe("active Live execution resolution", () => {
  it("returns only the exact deeply frozen owner-scoped Live version and dependency-bound receipt", async () => {
    const projectRepo = repository();
    const result = await resolveActiveLiveExecution({ flowId: FLOW, ownerId: OWNER, projectRepo });

    expect(projectRepo.getActiveDeployment).toHaveBeenCalledWith({
      flowId: FLOW,
      environmentKind: "live",
      ownerId: OWNER,
    });
    expect(projectRepo.getFlowContext).toHaveBeenCalledWith(FLOW, OWNER);
    expect(projectRepo.getFlowVersion).toHaveBeenCalledWith({
      flowId: FLOW,
      versionId: "version-1",
      ownerId: OWNER,
    });
    expect(result).toMatchObject({
      graph: graph(1),
      receipt: {
        ownerId: OWNER,
        flowId: FLOW,
        deploymentId: "deployment-version-1",
        environmentId: LIVE_ENVIRONMENT,
        flowVersionId: "version-1",
        semanticHash: version().semanticHash,
        fullHash: version().fullHash,
      },
    });
    expect(result?.subflowSnapshot).toEqual({
      loadSubflow: expect.any(Function),
      resolveSubflow: expect.any(Function),
    });
    expect(deeplyFrozen(result)).toBe(true);
  });

  it.each(["direct", "nested"] as const)(
    "classifies the exact %s resource.query dependency closure without changing receipt equality",
    async (placement) => {
      const leaf = flowVersion({
        id: "leaf-version",
        flowId: "leaf-flow",
        graph: resourceQueryGraph("resource-leaf", true),
        dependencies: [resourceDependency("leaf-version")],
      });
      const root = placement === "direct"
        ? flowVersion({
            id: "version-1",
            flowId: FLOW,
            graph: resourceQueryGraph("resource-root"),
            dependencies: [resourceDependency("version-1")],
          })
        : flowVersion({
            id: "version-1",
            flowId: FLOW,
            graph: callableGraph("root", [pinnedReference(leaf)]),
          });
      const projectRepo = repositoryWithVersions(root, placement === "nested" ? [leaf] : []);

      const result = await resolveActiveLiveExecution({ flowId: FLOW, ownerId: OWNER, projectRepo });

      expect(result?.resourceDependencies).toEqual([{
        resourceProductId: RESOURCE_PRODUCT,
        packVersionId: RESOURCE_VERSION,
        contentHash: RESOURCE_HASH,
      }]);
      expect(result?.receipt).toEqual({
        ownerId: OWNER,
        flowId: FLOW,
        deploymentId: "deployment-version-1",
        environmentId: LIVE_ENVIRONMENT,
        flowVersionId: "version-1",
        semanticHash: root.semanticHash,
        fullHash: root.fullHash,
      });
      expect(Object.hasOwn(result!.receipt, "resourceDependencies")).toBe(false);
    },
  );

  it("uses a fresh preloaded deployment but still confirms it before returning", async () => {
    const projectRepo = repository();
    const initialDeployment = deployment();
    const result = await resolveActiveLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
      projectRepo,
      initialDeployment,
    });

    expect(result?.receipt.deploymentId).toBe(initialDeployment.id);
    expect(projectRepo.getActiveDeployment).toHaveBeenCalledTimes(1);
    expect(projectRepo.getActiveDeployment).toHaveBeenCalledWith({
      flowId: FLOW,
      environmentKind: "live",
      ownerId: OWNER,
    });
  });

  it("pins the active version across Draft edits and moves only after Live promotion", async () => {
    const v1 = version("version-1", graph(1));
    const v2 = version("version-2", graph(2));
    const projectRepo = repository({ version: v1 });

    const beforePromotion = await resolveActiveLiveExecution({ flowId: FLOW, ownerId: OWNER, projectRepo });
    expect(beforePromotion?.graph).toEqual(graph(1));

    projectRepo.getActiveDeployment.mockResolvedValue(deployment("version-2"));
    projectRepo.getFlowVersion.mockResolvedValue(v2);
    const afterPromotion = await resolveActiveLiveExecution({ flowId: FLOW, ownerId: OWNER, projectRepo });
    expect(afterPromotion?.receipt.flowVersionId).toBe("version-2");
    expect(afterPromotion?.graph).toEqual(graph(2));
  });

  it("uses the exact stored dependency pins in both hash checks", async () => {
    const pinned = version();
    const missingDependencies = { ...pinned, dependencies: [] };
    const mutatedDependencies = {
      ...pinned,
      dependencies: [{ ...pinned.dependencies[0]!, version: "attacker-version" }],
    };

    await expect(resolveActiveLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
      projectRepo: repository({ version: missingDependencies }),
    })).resolves.toBeNull();
    await expect(resolveActiveLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
      projectRepo: repository({ version: mutatedDependencies }),
    })).resolves.toBeNull();
  });

  it("refuses a promotion race instead of executing the deployment that just became stale", async () => {
    const projectRepo = repository();
    projectRepo.getActiveDeployment
      .mockResolvedValueOnce(deployment("version-1"))
      .mockResolvedValueOnce(deployment("version-2"));

    await expect(resolveActiveLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
      projectRepo,
    })).resolves.toBeNull();
  });

  it("refuses an exact published api.operation version before subflow closure or revalidation work", async () => {
    const published = version("version-1", apiOperationGraph("api-root"));
    const projectRepo = repository({ version: published });

    await expect(resolveActiveLiveExecution({ flowId: FLOW, ownerId: OWNER, projectRepo }))
      .rejects.toMatchObject({ code: API_OPERATION_LIVE_UNAVAILABLE });
    expect(projectRepo.getFlowVersion).toHaveBeenCalledTimes(1);
    expect(projectRepo.getActiveDeployment).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing deployment", { deployment: null }],
    ["retired deployment", { deployment: { ...deployment(), status: "retired" as const, retiredAt: 2 } }],
    ["Test-only deployment", { deployment: { ...deployment(), status: "test" as const, environmentId: "environment-test" } }],
    ["foreign deployment flow", { deployment: { ...deployment(), flowId: "foreign-flow" } }],
    ["missing context", { context: null }],
    ["foreign binding", { context: { ...context(), binding: { ...context().binding, flowId: "foreign-flow" } } }],
    ["foreign owner context", { context: { ...context(), organization: { ...context().organization, personalOwnerId: "foreign-owner" } } }],
    ["unbound environment", { deployment: { ...deployment(), environmentId: "environment-foreign" } }],
    ["non-Live environment", { deployment: { ...deployment(), environmentId: "environment-test" } }],
    ["missing version", { version: null }],
    ["wrong version id", { version: { ...version(), id: "version-foreign" } }],
    ["wrong version flow", { version: { ...version(), flowId: "foreign-flow" } }],
    ["wrong semantic hash", { version: { ...version(), semanticHash: "0".repeat(64) } }],
    ["wrong full hash", { version: { ...version(), fullHash: "0".repeat(64) } }],
  ] as const)("privately refuses %s", async (_label, overrides) => {
    await expect(resolveActiveLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
      projectRepo: repository(overrides),
    })).resolves.toBeNull();
  });
});

describe("published Live run boundary", () => {
  function successfulEvents(runId = "run-1") {
    return (async function* () {
      yield { kind: "run:start", runId, flowId: FLOW } as const;
      yield { kind: "run:done", runId, status: "done", totalCostUsdc: 0 } as const;
    })();
  }

  function resetRunner(projectRepo: ProjectRepo): void {
    runnerState.projectRepo = projectRepo;
    runnerState.connectionRepository.close.mockReset();
    runnerState.connectionRepository.dispose.mockReset();
    runnerState.provider.mockReset().mockResolvedValue(runnerState.connectionRepository);
    runnerState.secretResolver.mockReset().mockResolvedValue({ Authorization: "Bearer live" });
    runnerState.resolverFactory.mockReset().mockReturnValue(runnerState.secretResolver);
    runnerState.runFlow.mockReset().mockImplementation((_flow, context) =>
      successfulEvents(context.runId));
    runnerState.buildRunContext.mockReset().mockImplementation((options) => ({
      ...options,
      loadSubflow: options.subflowSnapshot?.loadSubflow,
      resolveSubflow: options.subflowSnapshot?.resolveSubflow,
      costCeiling: { limitUsdc: 25, spentUsdc: 0 },
    }));
    for (const spy of Object.values(runRepository)) spy.mockClear();
  }

  it("creates Live secret authority only when the exact closure uses a connection", async () => {
    const published = version("version-1", connectionGraph("connection-root"));
    const projectRepo = repository({ version: published });
    resetRunner(projectRepo);

    await expect(runPublishedLiveToCompletion({
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "webhook",
      triggerInput: { topic: "launch" },
      runVariables: { audience: "fans" },
    })).resolves.toMatchObject({ runId: "run-1", status: "done" });

    expect(runnerState.provider).toHaveBeenCalledTimes(1);
    expect(runnerState.resolverFactory).toHaveBeenCalledWith({
      ownerId: OWNER,
      environment: "live",
      repository: runnerState.connectionRepository,
    });
    expect(runnerState.runFlow.mock.calls[0]?.[0]).toEqual(connectionGraph("connection-root"));
    expect(runnerState.runFlow.mock.calls[0]?.[3]).toEqual({ topic: "launch" });
    expect(runnerState.buildRunContext).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: false,
      ownerId: OWNER,
      rootFlowId: FLOW,
      runVariables: { audience: "fans" },
      resolveSecretReference: runnerState.secretResolver,
    }));
    expect(runnerState.connectionRepository.close).toHaveBeenCalledTimes(1);
  });

  it("runs a connection-free root and pinned closure without constructing the provider", async () => {
    const leaf = flowVersion({ id: "leaf-version", flowId: "leaf-flow", graph: callableGraph("leaf") });
    const root = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: callableGraph("root", [pinnedReference(leaf)]),
    });
    resetRunner(repositoryWithVersions(root, [leaf]));
    runnerState.provider.mockRejectedValue(new Error("connection service unavailable"));

    await expect(runPublishedLiveToCompletion({
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "webhook",
    })).resolves.toMatchObject({ status: "done" });

    expect(runnerState.provider).not.toHaveBeenCalled();
    expect(runnerState.resolverFactory).not.toHaveBeenCalled();
  });

  it("detects a connection binding inside the exact pinned closure before execution", async () => {
    const childGraph = { ...connectionGraph("connection-child"), callableInterface };
    const child = flowVersion({ id: "child-version", flowId: "child-flow", graph: childGraph });
    const root = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: callableGraph("root", [pinnedReference(child)]),
    });
    resetRunner(repositoryWithVersions(root, [child]));

    await expect(runPublishedLiveToCompletion({
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "webhook",
    })).resolves.toMatchObject({ status: "done" });

    expect(runnerState.provider).toHaveBeenCalledTimes(1);
    expect(runnerState.resolverFactory).toHaveBeenCalledTimes(1);
  });

  it.each(["subflow", "loop"] as const)(
    "refuses api.operation in an exact pinned %s child before provider or execution",
    async (nodeType) => {
      const childGraph = { ...apiOperationGraph("api-child"), callableInterface };
      const child = flowVersion({ id: "child-version", flowId: "child-flow", graph: childGraph });
      const rootGraph: FlowGraphV2 = {
        ...callableGraph("root"),
        nodes: [{
          id: "child",
          type: nodeType,
          params: { reference: pinnedReference(child) } as never,
          bindings: {},
          position: { x: 0, y: 0 },
        }],
      };
      const root = flowVersion({ id: "version-1", flowId: FLOW, graph: rootGraph });
      resetRunner(repositoryWithVersions(root, [child]));

      await expect(resolveActiveLiveExecution({
        flowId: FLOW,
        ownerId: OWNER,
        projectRepo: runnerState.projectRepo!,
      })).rejects.toMatchObject({ code: API_OPERATION_LIVE_UNAVAILABLE });
      expect(runnerState.provider).not.toHaveBeenCalled();
      expect(runnerState.runFlow).not.toHaveBeenCalled();
      expect(runRepository.createRun).not.toHaveBeenCalled();
    },
  );

  it("returns unavailable before execution when a connection-bearing closure cannot open protection", async () => {
    const published = version("version-1", connectionGraph("connection-root"));
    resetRunner(repository({ version: published }));
    runnerState.provider.mockRejectedValue(new Error("connection service unavailable"));

    await expect(preparePublishedLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
    })).resolves.toBeNull();

    expect(runnerState.provider).toHaveBeenCalledTimes(1);
    expect(runnerState.resolverFactory).not.toHaveBeenCalled();
    expect(runnerState.runFlow).not.toHaveBeenCalled();
  });

  it("prepares one immutable owner-flow-bound handle and refuses forgery or reuse", async () => {
    const published = version("version-1", connectionGraph("connection-root"));
    resetRunner(repository({ version: published }));

    const prepared = await preparePublishedLiveExecution({ flowId: FLOW, ownerId: OWNER });
    expect(prepared).not.toBeNull();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared).toMatchObject({
      graph: { id: "connection-root" },
      release: {
        ownerId: OWNER,
        flowId: FLOW,
        deploymentId: "deployment-version-1",
        environmentId: "environment-live",
        flowVersionId: "version-1",
      },
      agent: null,
    });
    expect(Object.isFrozen(prepared!.graph)).toBe(true);
    expect(Object.isFrozen(prepared!.release)).toBe(true);
    expect(preparedPublishedLiveExecutionReceipt(prepared!)).toMatchObject({
      ownerId: OWNER,
      flowId: FLOW,
      deploymentId: "deployment-version-1",
      flowVersionId: "version-1",
      semanticHash: published.semanticHash,
      fullHash: published.fullHash,
    });
    expect(preparedPublishedLiveExecutionReceipt({} as never)).toBeNull();
    expect(runnerState.provider).toHaveBeenCalledTimes(1);

    await expect(runPreparedPublishedLiveToCompletion({} as never, {
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "agent",
    })).resolves.toBeNull();
    await expect(runPreparedPublishedLiveToCompletion(prepared!, {
      flowId: "foreign-flow",
      ownerId: OWNER,
      trigger: "agent",
    })).resolves.toBeNull();
    expect(runnerState.connectionRepository.close).toHaveBeenCalledTimes(1);
    await expect(runPreparedPublishedLiveToCompletion(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "agent",
    })).resolves.toBeNull();
    expect(runnerState.runFlow).not.toHaveBeenCalled();
  });

  it("binds one exact fresh Resource snapshot into execution without changing strict receipt identity", async () => {
    const published = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: resourceQueryGraph("resource-root"),
      dependencies: [resourceDependency("version-1")],
    });
    resetRunner(repositoryWithVersions(published, []));
    const prepared = await preparePublishedLiveExecution({ flowId: FLOW, ownerId: OWNER });
    const receipt = preparedPublishedLiveExecutionReceipt(prepared!);
    const resolved = Object.freeze({
      status: "live" as const,
      bundle: Object.freeze({
        resourceProductId: RESOURCE_PRODUCT,
        packVersionId: RESOURCE_VERSION,
        semanticHash: RESOURCE_HASH,
        freshness: "fresh" as const,
        content: RESOURCE_CONTENT,
      }),
    });

    expect(bindPreparedPublishedLiveResourceSnapshot(prepared!, [{
      reference: {
        resourceProductId: RESOURCE_PRODUCT,
        packVersionId: RESOURCE_VERSION,
        contentHash: RESOURCE_HASH,
      },
      resolved,
    }])).toBe(true);
    expect(preparedPublishedLiveExecutionReceipt(prepared!)).toBe(receipt);

    await expect(runPreparedPublishedLiveToCompletion(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "agent",
    })).resolves.toMatchObject({ status: "done" });

    const resolveResourcePack = runnerState.buildRunContext.mock.calls[0]?.[0]
      ?.resolveResourcePack as ((reference: unknown) => Promise<unknown>) | undefined;
    await expect(resolveResourcePack?.({
      resourceProductId: RESOURCE_PRODUCT,
      packVersionId: RESOURCE_VERSION,
      contentHash: RESOURCE_HASH,
    })).resolves.toBe(resolved);
  });

  it("reuses only the exact precreated paid run before executing the Live graph", async () => {
    const published = version("version-1", graph(1));
    resetRunner(repository({ version: published }));
    runRepository.getRun.mockResolvedValue({
      id: "paid-run-1",
      flowId: FLOW,
      agentId: "agent-1",
      trigger: "agent",
      status: "running",
      totalCostUsdc: 0,
      startedAt: 1,
      finishedAt: null,
      settledAt: "2026-08-14T00:00:00.000Z",
      triggerInput: { invoiceId: "inv-1" },
      runVariables: { policy: "strict" },
    });
    const prepared = await preparePublishedLiveExecution({ flowId: FLOW, ownerId: OWNER });

    const summary = await runPreparedPublishedLiveToCompletion(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "agent",
      agentId: "agent-1",
      triggerInput: { invoiceId: "inv-1" },
      runVariables: { policy: "strict" },
      precreatedRunId: "paid-run-1",
    });

    expect(summary?.runId).toBe("paid-run-1");
    expect(runRepository.createRun).not.toHaveBeenCalled();
    expect(runRepository.getRun).toHaveBeenCalledWith("paid-run-1");
    expect(runnerState.runFlow).toHaveBeenCalledOnce();
  });

  it("refuses a mismatched precreated run before provider execution", async () => {
    const published = version("version-1", graph(1));
    resetRunner(repository({ version: published }));
    runRepository.getRun.mockResolvedValue({
      id: "paid-run-1",
      flowId: FLOW,
      agentId: "other-agent",
      trigger: "agent",
      status: "running",
      triggerInput: { invoiceId: "inv-1" },
      runVariables: null,
    });
    const prepared = await preparePublishedLiveExecution({ flowId: FLOW, ownerId: OWNER });

    await expect(runPreparedPublishedLiveToCompletion(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "agent",
      agentId: "agent-1",
      triggerInput: { invoiceId: "inv-1" },
      precreatedRunId: "paid-run-1",
    })).rejects.toThrow(/Precreated run/u);

    expect(runRepository.createRun).not.toHaveBeenCalled();
    expect(runnerState.runFlow).not.toHaveBeenCalled();
  });

  it("disposes an unconsumed prepared provider with close fallback and idempotent reuse refusal", async () => {
    const published = version("version-1", connectionGraph("connection-root"));
    resetRunner(repository({ version: published }));
    runnerState.connectionRepository.close.mockImplementation(() => { throw new Error("close failed"); });
    const prepared = await preparePublishedLiveExecution({ flowId: FLOW, ownerId: OWNER });
    expect(prepared).not.toBeNull();

    disposePreparedPublishedLiveExecution(prepared!);
    disposePreparedPublishedLiveExecution(prepared!);

    expect(runnerState.connectionRepository.close).toHaveBeenCalledTimes(1);
    expect(runnerState.connectionRepository.dispose).toHaveBeenCalledTimes(1);
    await expect(runPreparedPublishedLiveToCompletion(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "agent",
    })).resolves.toBeNull();
  });

  it("captures a relay endpoint at preparation and consumes it once", async () => {
    const published = version("version-1", graph(1));
    resetRunner(repository({ version: published }));
    runRepository.getAgent.mockResolvedValue({
      id: "agent-1",
      flowId: FLOW,
      status: "live",
      priceUsdc: 1,
    });
    runRepository.getRelayEndpoint.mockResolvedValue({
      agentId: "agent-1",
      url: "https://live-relay.example.test/run",
      secret: "prepared-secret",
      protocolVersion: 2,
      createdAt: "2026-08-14T00:00:00.000Z",
    });

    const prepared = await preparePublishedLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
      agent: { id: "agent-1", priceUsdc: 1 },
    });

    expect(prepared).toMatchObject({ relay: true });
    expect(runRepository.getRelayEndpoint).toHaveBeenCalledWith("agent-1");
    expect(preparedPublishedLiveRelaySnapshot(prepared!)).toEqual({
      agentId: "agent-1",
      url: "https://live-relay.example.test/run",
      secret: "prepared-secret",
      protocolVersion: 2,
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    await expect(consumePreparedPublishedLiveRelay(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      agentId: "agent-1",
    })).resolves.toEqual({
      url: "https://live-relay.example.test/run",
      secret: "prepared-secret",
    });
    await expect(consumePreparedPublishedLiveRelay(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      agentId: "agent-1",
    })).resolves.toBeNull();
  });

  it("runs a relay-backed prepared authority locally for a dry preview", async () => {
    const published = version("version-1", graph(1));
    resetRunner(repository({ version: published }));
    runRepository.getAgent.mockResolvedValue({
      id: "agent-1",
      flowId: FLOW,
      status: "live",
      priceUsdc: 1,
    });
    runRepository.getRelayEndpoint.mockResolvedValue({
      agentId: "agent-1",
      url: "https://live-relay.example.test/run",
      secret: "prepared-secret",
      protocolVersion: 2,
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    const prepared = await preparePublishedLiveExecution({
      flowId: FLOW,
      ownerId: OWNER,
      agent: { id: "agent-1", priceUsdc: 1 },
    });

    await expect(runPreparedPublishedLiveDryRunToCompletion(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      agentId: "agent-1",
      trigger: "agent",
      dryRun: true,
    })).resolves.toMatchObject({ runId: "run-1", status: "done" });
    expect(runnerState.runFlow.mock.calls[0]?.[0]).toEqual(graph(1));
    await expect(consumePreparedPublishedLiveRelay(prepared!, {
      flowId: FLOW,
      ownerId: OWNER,
      agentId: "agent-1",
    })).resolves.toBeNull();
  });

  it.each([
    ["missing", { deployment: null }],
    ["retired", { deployment: { ...deployment(), status: "retired" as const, retiredAt: 2 } }],
    ["wrong owner", { context: { ...context(), organization: { ...context().organization, personalOwnerId: "foreign" } } }],
    ["wrong environment", { deployment: { ...deployment(), environmentId: "environment-test" } }],
    ["wrong version", { version: { ...version(), flowId: "foreign" } }],
    ["wrong hash", { version: { ...version(), fullHash: "0".repeat(64) } }],
  ] as const)("returns private null for %s Live state before provider, decrypt, fetch, or run", async (_label, overrides) => {
    resetRunner(repository(overrides));

    await expect(runPublishedLiveToCompletion({
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "schedule",
    })).resolves.toBeNull();

    expect(runnerState.provider).not.toHaveBeenCalled();
    expect(runnerState.resolverFactory).not.toHaveBeenCalled();
    expect(runnerState.secretResolver).not.toHaveBeenCalled();
    expect(runnerState.runFlow).not.toHaveBeenCalled();
    expect(runRepository.createRun).not.toHaveBeenCalled();
  });

  it("closes the Live provider when execution throws", async () => {
    resetRunner(repository({ version: version("version-1", connectionGraph("connection-root")) }));
    runnerState.runFlow.mockImplementation(() => (async function* () {
      throw new Error("execution failed");
    })());

    await expect(runPublishedLiveToCompletion({
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "webhook",
    })).rejects.toThrow("execution failed");
    expect(runnerState.connectionRepository.close).toHaveBeenCalledTimes(1);
  });

  it("refuses legacy and typed Draft child references before provider, decrypt, fetch, or run", async () => {
    const draftReference: SubflowReference = {
      kind: "draft",
      flowId: "child-draft",
      interface: callableInterface,
      interfaceHash: hashCallableInterface(callableInterface),
    };
    const typedDraftRoot = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: callableGraph("root", [draftReference]),
    });
    const legacyBase = callableGraph("root-legacy");
    const legacyGraph: FlowGraphV2 = {
      ...legacyBase,
      nodes: [{
        id: "legacy-child",
        type: "subflow",
        params: { flowId: "child-draft" },
        bindings: {},
        position: { x: 0, y: 0 },
      }, ...legacyBase.nodes],
    };
    const legacyRoot = flowVersion({ id: "version-1", flowId: FLOW, graph: legacyGraph });

    for (const root of [typedDraftRoot, legacyRoot]) {
      resetRunner(repositoryWithVersions(root, []));
      await expect(runPublishedLiveToCompletion({
        flowId: FLOW,
        ownerId: OWNER,
        trigger: "webhook",
      })).resolves.toBeNull();
      expect(runnerState.provider).not.toHaveBeenCalled();
      expect(runnerState.secretResolver).not.toHaveBeenCalled();
      expect(runnerState.runFlow).not.toHaveBeenCalled();
      expect(runRepository.createRun).not.toHaveBeenCalled();
    }
  });

  it("refuses a forged pinned callable-interface receipt before provider or execution", async () => {
    const child = flowVersion({ id: "child-version", flowId: "child-flow", graph: callableGraph("child") });
    const forged = { ...pinnedReference(child), interfaceHash: "0".repeat(64) };
    const root = flowVersion({ id: "version-1", flowId: FLOW, graph: callableGraph("root", [forged]) });
    resetRunner(repositoryWithVersions(root, [child]));

    await expect(runPublishedLiveToCompletion({ flowId: FLOW, ownerId: OWNER, trigger: "webhook" }))
      .resolves.toBeNull();
    expect(runnerState.provider).not.toHaveBeenCalled();
    expect(runnerState.runFlow).not.toHaveBeenCalled();
    expect(runRepository.createRun).not.toHaveBeenCalled();
  });

  it("refuses shared-DAG depth overflow even when the tail resolves shallow first", async () => {
    const leaf = flowVersion({ id: "leaf-version", flowId: "leaf-flow", graph: callableGraph("leaf") });
    const shared = flowVersion({
      id: "shared-version", flowId: "shared-flow",
      graph: callableGraph("shared", [pinnedReference(leaf)]),
    });
    const chain: FlowVersionRecord[] = [];
    let next = shared;
    for (let index = 62; index >= 0; index -= 1) {
      next = flowVersion({
        id: `dag-version-${index}`,
        flowId: `dag-flow-${index}`,
        graph: callableGraph(`dag-${index}`, [pinnedReference(next)]),
      });
      chain.push(next);
    }
    const root = flowVersion({
      id: "version-1", flowId: FLOW,
      graph: callableGraph("dag-root", [pinnedReference(next), pinnedReference(shared)]),
    });
    resetRunner(repositoryWithVersions(root, [leaf, shared, ...chain]));

    await expect(runPublishedLiveToCompletion({ flowId: FLOW, ownerId: OWNER, trigger: "webhook" }))
      .resolves.toBeNull();
    expect(runnerState.provider).not.toHaveBeenCalled();
    expect(runnerState.runFlow).not.toHaveBeenCalled();
    expect(runRepository.createRun).not.toHaveBeenCalled();
  });

  it("refuses pinned child graph tampering and dependency drift before provider access", async () => {
    const child = flowVersion({
      id: "child-version",
      flowId: "child-flow",
      graph: callableGraph("child"),
      dependencies: [{
        id: "child-pin",
        flowVersionId: "child-version",
        kind: "connector",
        resourceId: "connector-child",
        version: "v1",
        createdAt: 1,
      }],
    });
    const root = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: callableGraph("root", [pinnedReference(child)]),
    });
    const tamperedGraph = {
      ...child,
      graph: callableGraph("tampered-child"),
    };
    const tamperedDependencies = {
      ...child,
      dependencies: [{ ...child.dependencies[0]!, version: "v2" }],
    };

    for (const changedChild of [tamperedGraph, tamperedDependencies]) {
      resetRunner(repositoryWithVersions(root, [changedChild]));
      await expect(runPublishedLiveToCompletion({
        flowId: FLOW,
        ownerId: OWNER,
        trigger: "webhook",
      })).resolves.toBeNull();
      expect(runnerState.provider).not.toHaveBeenCalled();
      expect(runnerState.runFlow).not.toHaveBeenCalled();
    }
  });

  it("executes an unchanged nested pinned closure entirely from the immutable snapshot", async () => {
    const leaf = flowVersion({ id: "leaf-version", flowId: "leaf-flow", graph: callableGraph("leaf") });
    const child = flowVersion({
      id: "child-version",
      flowId: "child-flow",
      graph: callableGraph("child", [pinnedReference(leaf)]),
    });
    const root = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: callableGraph("root", [pinnedReference(child)]),
    });
    const projectRepo = repositoryWithVersions(root, [child, leaf]);
    resetRunner(projectRepo);
    runnerState.runFlow.mockImplementation((_graph, context) => (async function* () {
      const resolvedChild = await context.resolveSubflow(pinnedReference(child));
      const resolvedLeaf = await context.resolveSubflow(pinnedReference(leaf));
      expect(resolvedChild.graph).toEqual(child.graph);
      expect(resolvedLeaf.graph).toEqual(leaf.graph);
      expect(deeplyFrozen(resolvedChild)).toBe(true);
      expect(deeplyFrozen(resolvedLeaf)).toBe(true);
      yield { kind: "run:start", runId: "run-1", flowId: FLOW } as const;
      yield { kind: "run:done", runId: "run-1", status: "done", totalCostUsdc: 0 } as const;
    })());

    const nestedResult = await runPublishedLiveToCompletion({
      flowId: FLOW,
      ownerId: OWNER,
      trigger: "webhook",
    });
    expect(nestedResult).not.toBeNull();
    expect(nestedResult).toMatchObject({ status: "done" });
    expect(runnerState.provider).not.toHaveBeenCalled();
    expect(runnerState.buildRunContext).toHaveBeenCalledWith(expect.objectContaining({
      subflowSnapshot: expect.objectContaining({
        loadSubflow: expect.any(Function),
        resolveSubflow: expect.any(Function),
      }),
    }));
  });

  it("refuses pinned cycles and closure depth overflow before provider access", async () => {
    const aBase = flowVersion({ id: "a-version", flowId: "a-flow", graph: callableGraph("a") });
    const bBase = flowVersion({ id: "b-version", flowId: "b-flow", graph: callableGraph("b") });
    const aReference = pinnedReference(aBase);
    const bReference = pinnedReference(bBase);
    const a = flowVersion({ id: aBase.id, flowId: aBase.flowId, graph: callableGraph("a", [bReference]) });
    const b = flowVersion({ id: bBase.id, flowId: bBase.flowId, graph: callableGraph("b", [{ ...aReference, contentHash: a.semanticHash }]) });
    const rootCycle = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: callableGraph("root-cycle", [{ ...aReference, contentHash: a.semanticHash }]),
    });
    resetRunner(repositoryWithVersions(rootCycle, [a, b]));
    await expect(runPublishedLiveToCompletion({ flowId: FLOW, ownerId: OWNER, trigger: "webhook" }))
      .resolves.toBeNull();
    expect(runnerState.provider).not.toHaveBeenCalled();

    const chain: FlowVersionRecord[] = [];
    let next: FlowVersionRecord | null = null;
    for (let index = 66; index >= 0; index -= 1) {
      const current = flowVersion({
        id: `depth-version-${index}`,
        flowId: `depth-flow-${index}`,
        graph: callableGraph(`depth-${index}`, next ? [pinnedReference(next)] : []),
      });
      chain.push(current);
      next = current;
    }
    const first = next!;
    const rootDepth = flowVersion({
      id: "version-1",
      flowId: FLOW,
      graph: callableGraph("root-depth", [pinnedReference(first)]),
    });
    resetRunner(repositoryWithVersions(rootDepth, chain));
    await expect(runPublishedLiveToCompletion({ flowId: FLOW, ownerId: OWNER, trigger: "webhook" }))
      .resolves.toBeNull();
    expect(runnerState.provider).not.toHaveBeenCalled();
  });

  it("falls back to dispose when close fails without masking a result or the original run error", async () => {
    resetRunner(repository({ version: version("version-1", connectionGraph("connection-root")) }));
    runnerState.connectionRepository.close.mockImplementation(() => { throw new Error("close failed"); });
    await expect(runPublishedLiveToCompletion({ flowId: FLOW, ownerId: OWNER, trigger: "webhook" }))
      .resolves.toMatchObject({ status: "done" });
    expect(runnerState.connectionRepository.dispose).toHaveBeenCalledTimes(1);

    resetRunner(repository({ version: version("version-1", connectionGraph("connection-root")) }));
    runnerState.connectionRepository.close.mockImplementation(() => { throw new Error("close failed"); });
    runnerState.runFlow.mockImplementation(() => (async function* () {
      throw new Error("original run failure");
    })());
    await expect(runPublishedLiveToCompletion({ flowId: FLOW, ownerId: OWNER, trigger: "webhook" }))
      .rejects.toThrow("original run failure");
    expect(runnerState.connectionRepository.dispose).toHaveBeenCalledTimes(1);
  });

  it("makes caller-supplied secret resolvers inert on dry/unpublished primitives", async () => {
    resetRunner(repository());
    const attacker = vi.fn(async () => ({ Authorization: "Bearer attacker" }));
    runnerState.runFlow.mockImplementation((_flow, context) => (async function* () {
      await expect(context.resolveSecretReference({ connectionId: "connection-1", field: "headers" }))
        .rejects.toThrow("unavailable");
      yield { kind: "run:start", runId: "run-1", flowId: FLOW } as const;
      yield { kind: "run:done", runId: "run-1", status: "done", totalCostUsdc: 0 } as const;
    })());

    await runToCompletion(graph(1), {
      flowId: FLOW,
      trigger: "manual",
      resolveSecretReference: attacker,
    });

    expect(attacker).not.toHaveBeenCalled();
    expect(runnerState.provider).not.toHaveBeenCalled();
  });
});
