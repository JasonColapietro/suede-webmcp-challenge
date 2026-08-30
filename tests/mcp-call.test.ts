/**
 * The MCP paid-call path (src/lib/mcp/call.ts).
 *
 * Pre-funded workspace credit is the settlement rail here: the bearer key on
 * the request identifies a workspace, the agent's price is debited from that
 * workspace's credit ledger before the flow runs, and the creator's workspace
 * is credited the same amount. There is no x402 challenge in an MCP session —
 * a model cannot answer a 402 mid-tool-call.
 *
 * Handler tests against a real in-memory SqliteRepo; the flow runner is
 * injected so these never touch the engine.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { callAgentTool, type McpCallDeps, type McpAgentRunner } from "@/lib/mcp/call";
import { catalogEntryToTool } from "@/lib/mcp/tools";
import type { CatalogEntry } from "@/lib/catalog";
import {
  RESOURCE_CONTRACT_EXTENSION_URI,
  type PublicServiceContract,
} from "@/lib/public-service-contract";
import { materializeResourceGraph } from "@/lib/resources/materialize";
import type {
  CreateResourceRunReceiptInput,
  ResourceRepository,
} from "@/lib/resources/repository";
import { resourcePack } from "./resources/fixture";
import { resourceRunEnvelopeAccepts } from "@/lib/resources/run-receipt";

const CALLER = "caller-workspace-0000-0000-000000000001";
const CREATOR = "creator-workspace-0000-0000-000000000002";

let repo: SqliteRepo;
let agentId: string;

/** A live, priced agent owned by CREATOR, plus its catalog entry. */
async function seedAgent(priceUsdc: number): Promise<CatalogEntry> {
  const flow = await repo.saveFlow({
    ownerId: CREATOR,
    name: "Lead Scorer",
    graph: {
      id: "graph-lead-scorer",
      name: "Lead Scorer",
      nodes: [
        { id: "in", type: "input", params: { fields: { lead: "" } }, position: { x: 0, y: 0 } },
        { id: "out", type: "output", params: {}, position: { x: 1, y: 0 } },
      ],
      edges: [{ id: "e", source: "in", target: "out" }],
    },
  });
  const agent = await repo.createAgent({
    flowId: flow.id,
    slug: "lead-scorer",
    status: "live",
    priceUsdc,
  });
  agentId = agent.id;
  return {
    id: agent.id,
    slug: agent.slug,
    name: flow.name,
    summary: "Input › Output",
    description: "Scores a lead.",
    priceUsdc,
    calls: 0,
    // Lane-5 buyer-truth fields (2026-08-09): CatalogEntry grew honest
    // settlement aggregates; the MCP settlement layer under test here reads
    // none of them, so the fixture pins the conservative defaults.
    settledCalls: 0,
    lastCallAt: null,
    settlementLive: false,
    acceptsPayment: false,
    paymentState: "preview",
    previewAvailable: true,
    createdAt: agent.createdAt,
    payTo: "0xabc",
    schedule: null,
    inputSchema: { type: "object", properties: { lead: { type: "string" } } },
    publishedLive: true,
    urls: {
      public: `/a/${agent.slug}`,
      run: `/api/agents/${agent.id}/run`,
      x402: `/api/agents/${agent.slug}/.well-known/x402`,
      agentCard: `/api/agents/${agent.slug}/.well-known/agent-card`,
      a2a: `/api/agents/${agent.slug}/a2a`,
    },
  };
}

const okRunner: McpAgentRunner = async () => ({
  runId: "run-1",
  status: "done",
  outputs: { score: 91 },
  totalCostUsdc: 0,
});

function preparedResourceRunner(
  service: PublicServiceContract | null,
  summary: Awaited<ReturnType<McpAgentRunner>>,
) {
  const execute = vi.fn(async () => summary);
  const dispose = vi.fn();
  const runner = Object.assign(vi.fn(async () => summary), {
    prepare: vi.fn(async () => ({ resourceService: service, execute, dispose })),
    execute,
    dispose,
  }) as McpAgentRunner & {
    prepare: NonNullable<McpAgentRunner["prepare"]>;
    execute: typeof execute;
    dispose: typeof dispose;
  };
  return runner;
}

function deps(
  entry: CatalogEntry,
  runner: McpAgentRunner = okRunner,
  resourceRepository?: Pick<ResourceRepository, "recordRunReceipt">,
): McpCallDeps {
  return {
    repo,
    loadCatalog: async () => [entry],
    runAgent: runner,
    ...(resourceRepository ? { resourceRepository } : {}),
  };
}

function exactResourceService(priceUsdc: number): PublicServiceContract {
  const content = resourcePack();
  const semanticHash = "a".repeat(64);
  const graph = materializeResourceGraph({
    product: {
      id: "resource-product-1",
      ownerId: CREATOR,
      name: "Pricing signals",
      slug: "lead-scorer",
      status: "live",
      executionAccess: priceUsdc > 0 ? "paid" : "free",
      discoveryAccess: "public",
    },
    pack: {
      resourceProductId: "resource-product-1",
      packVersionId: "pack-version-1",
      semanticHash,
      freshness: "fresh",
      content,
    },
    sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
  }).graph;
  return {
    kind: "resource",
    id: agentId,
    slug: "lead-scorer",
    name: "Pricing signals",
    description: content.jobContract.jobStatement,
    priceUsdc,
    graph,
    release: {
      ownerId: CREATOR,
      flowId: "resource-product-1",
      deploymentId: "deployment-live",
      environmentId: "environment-live",
      flowVersionId: "flow-version-live",
      semanticHash: "b".repeat(64),
      fullHash: "c".repeat(64),
    },
    inputSchema: content.jobContract.inputSchema,
    outputSchema: content.jobContract.outputSchema,
    exampleInput: { tier: "" },
    tags: ["resource"],
    urls: {
      public: "https://agents.suedeai.ai/a/lead-scorer",
      run: "https://agents.suedeai.ai/api/agents/lead-scorer/run",
      x402: "https://agents.suedeai.ai/api/agents/lead-scorer/.well-known/x402",
      agentCard: "https://agents.suedeai.ai/api/agents/lead-scorer/.well-known/agent-card.json",
      a2a: "https://agents.suedeai.ai/api/agents/lead-scorer/a2a",
    },
    resource: {
      extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
      resourceProductId: "resource-product-1",
      resourceVersion: "pack-version-1",
      semanticHash,
      freshness: "fresh",
      evidencePolicy: content.jobContract.evidenceRequirement,
      reviewBoundary: content.jobContract.reviewBoundary,
      access: { execution: priceUsdc > 0 ? "paid" : "free", discovery: "public" },
      sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
      jobContract: content.jobContract,
    },
  };
}

beforeEach(() => {
  repo = new SqliteRepo(":memory:");
});

describe("callAgentTool — tool resolution", () => {
  it("reports an unknown tool as a tool error the model can recover from", async () => {
    const entry = await seedAgent(0);
    const result = await callAgentTool(
      { name: "run_does-not-exist", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });
});

describe("callAgentTool — free agents", () => {
  it("runs a zero-price agent without a workspace key", async () => {
    const entry = await seedAgent(0);
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: null },
      deps(entry),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ outputs: { score: 91 } });
  });

  it("does not touch any credit ledger at the MCP settlement layer for a free call", async () => {
    // DELIBERATE pin update (2026-08-09, metered execution): this pin used to
    // read as "free calls are entirely ledger-free". That is no longer the
    // whole story — a free call's flow run now bills its model spend to the
    // flow OWNER's entitlement inside run-service/run-context (see
    // tests/metered-llm.test.ts), so free platform inference the owner's
    // entitlement does not cover degrades to a stub instead of running free.
    // What THIS test pins is the MCP settlement layer itself: a zero-price
    // call must not debit the caller or credit the creator. The runner is
    // injected here, so the owner-side metering path is deliberately out of
    // frame.
    const entry = await seedAgent(0);
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(await repo.getCreditBalance(CALLER)).toBe(0);
    expect(await repo.getCreditBalance(CREATOR)).toBe(0);
  });

  it("returns the normalized immutable-release result supplied by the runner", async () => {
    const entry = await seedAgent(0);
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: null },
      deps(entry, async () => ({
        runId: "run-immutable",
        status: "done",
        outputs: { draft: { score: 0 } },
        totalCostUsdc: 0,
        result: { score: 91 },
      })),
    );

    expect(result.structuredContent).toMatchObject({
      runId: "run-immutable",
      result: { score: 91 },
    });
  });

  it("never derives a result from the mutable Draft when a runner has none", async () => {
    const entry = await seedAgent(0);
    entry.slug = "po-match-gate-mkgu0";
    entry.name = "PO Match Gate";
    entry.inputSchema = { type: "object", properties: {} };
    const storedAgent = await repo.getAgent(agentId);
    const storedFlow = await repo.getFlow(storedAgent!.flowId);
    vi.spyOn(repo, "getFlow").mockResolvedValue({
      ...storedFlow!,
      graph: {
        id: "tpl-po-invoice-match",
        name: "Mutable Draft",
        nodes: [{ id: "out", type: "output", params: {}, position: { x: 0, y: 0 } }],
        edges: [],
      },
    });

    const result = await callAgentTool(
      { name: "run_po-match-gate-mkgu0", arguments: {}, workspaceKey: null },
      deps(entry, async () => ({
        runId: "run-no-contract",
        status: "done",
        outputs: {
          out: {
            matched: true,
            status: "pass",
            discrepancies: [],
            note: "The mutable Draft must not define this result.",
          },
        },
        totalCostUsdc: 0,
      })),
    );

    expect(result.structuredContent).toMatchObject({ runId: "run-no-contract" });
    expect(result.structuredContent).not.toHaveProperty("result");
  });
});

describe("callAgentTool — payment gate", () => {
  it("rejects malformed input before reading or moving workspace credit", async () => {
    const entry = await seedAgent(0.25);
    entry.inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["lead"],
      properties: { lead: { type: "string", minLength: 1 } },
    };
    await repo.createCredit({ ownerId: CALLER, deltaUsdc: 1, reason: "topup", tx: "0x1" });
    let ran = false;
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry, async () => {
        ran = true;
        return { runId: "r", status: "done", outputs: {}, totalCostUsdc: 0 };
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Nothing was charged");
    expect(ran).toBe(false);
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(1, 6);
  });

  it("refuses a priced call with no workspace key and says how to supply one", async () => {
    const entry = await seedAgent(0.25);
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: null },
      deps(entry),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Authorization: Bearer");
    // Extended (2026-08-09): the refusal names BOTH funding paths — the human
    // /pricing page stays, and the machine-payable x402 topup joins it.
    expect(result.content[0]?.text).toContain("/pricing");
    expect(result.content[0]?.text).toContain("POST /api/gateway/topup");
  });

  it("refuses a priced call when credit is short of the price", async () => {
    const entry = await seedAgent(0.25);
    await repo.createCredit({ ownerId: CALLER, deltaUsdc: 0.1, reason: "topup", tx: "0x1" });
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("0.25");
    // Extended (2026-08-09): insufficient-credit errors also point a machine
    // at the fundable endpoint, not just the human pricing page.
    expect(result.content[0]?.text).toContain("/pricing");
    expect(result.content[0]?.text).toContain("POST /api/gateway/topup");
  });

  it("leaves the balance untouched when it refuses for insufficient credit", async () => {
    const entry = await seedAgent(0.25);
    await repo.createCredit({ ownerId: CALLER, deltaUsdc: 0.1, reason: "topup", tx: "0x1" });
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(0.1, 6);
  });

  it("never runs the flow when the caller cannot pay", async () => {
    const entry = await seedAgent(0.25);
    let ran = false;
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry, async () => {
        ran = true;
        return { runId: "r", status: "done", outputs: {}, totalCostUsdc: 0 };
      }),
    );
    expect(ran).toBe(false);
  });
});

describe("callAgentTool — settlement", () => {
  beforeEach(async () => {
    await repo.createCredit({ ownerId: CALLER, deltaUsdc: 1, reason: "topup", tx: "0x1" });
  });

  it.each(["direct", "nested"] as const)(
    "prepares and refuses a cached markerless %s Resource closure before MCP credit, execution, or output work",
    async (placement) => {
      const entry = await seedAgent(0.25);
      const execute = vi.fn();
      const prepare = vi.fn(async () => {
        throw new Error(`${placement} markerless Resource closure`);
      });
      const runner = Object.assign(vi.fn(execute), { prepare }) as McpAgentRunner;
      const createCredit = vi.spyOn(repo, "createCredit");

      const result = await callAgentTool(
        { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: CALLER },
        deps(entry, runner),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("immutable");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(runner).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(createCredit).not.toHaveBeenCalled();
      expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(1, 6);
      expect(await repo.getCreditBalance(CREATOR)).toBeCloseTo(0, 6);
    },
  );

  it("debits the caller exactly the agent's price", async () => {
    const entry = await seedAgent(0.25);
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(0.75, 6);
  });

  it("credits the creator's workspace the full price, matching the 0% take rate", async () => {
    const entry = await seedAgent(0.25);
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(await repo.getCreditBalance(CREATOR)).toBeCloseTo(0.25, 6);
  });

  it("returns the same resource envelope with a credited fact, never a settled claim", async () => {
    const entry = await seedAgent(0.25);
    const service = exactResourceService(0.25);
    entry.extensions = { [RESOURCE_CONTRACT_EXTENSION_URI]: service.resource };
    entry.outputSchema = service.outputSchema as CatalogEntry["outputSchema"];
    const recordRunReceipt = vi.fn(async (input: CreateResourceRunReceiptInput) => ({
      id: "resource-receipt-mcp-1",
      ownerId: input.ownerId,
      packVersionId: input.packVersionId,
      agentId: input.agentId,
      runId: input.runId,
      flowVersionId: input.flowVersionId,
      deploymentId: input.deploymentId,
      paymentId: input.paymentId,
      paymentState: input.paymentState,
      priceUsdc: input.priceUsdc,
      ...input.receipt,
      createdAt: "2026-08-14T12:00:00.000Z",
    }));
    const resourceRepository = { recordRunReceipt };
    const runner = preparedResourceRunner(service, {
      runId: "run-resource-mcp-1",
      status: "done",
      totalCostUsdc: 0,
      outputs: {
        "resource-query": {
          result: [{ name: "Alpha", tier: "paid" }],
          resourceReceipt: {
            resourceProductId: "resource-product-1",
            resourceVersion: "pack-version-1",
            semanticHash: "a".repeat(64),
            freshness: "fresh",
            evidence: resourcePack().evidence,
            unknowns: [],
            conflicts: [],
            outputSchemaValid: true,
          },
        },
      },
    });
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: CALLER },
      deps(entry, runner, resourceRepository),
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      result: [{ name: "Alpha", tier: "paid" }],
      payment: {
        priceUsdc: 0.25,
        state: "credited",
        receiptId: "resource-receipt-mcp-1",
      },
    });
    expect(recordRunReceipt).toHaveBeenCalledWith(expect.objectContaining({
      paymentState: "credited",
      paymentId: expect.any(String),
      priceUsdc: 0.25,
    }));
    expect(result.structuredContent).not.toMatchObject({ payment: { state: "settled" } });
    expect(resourceRunEnvelopeAccepts(catalogEntryToTool(entry).outputSchema, result.structuredContent)).toBe(true);
    expect(runner.prepare).toHaveBeenCalledTimes(1);
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses a resource before billing or execution when receipt persistence is unavailable", async () => {
    const entry = await seedAgent(0.25);
    const service = exactResourceService(0.25);
    entry.extensions = { [RESOURCE_CONTRACT_EXTENSION_URI]: service.resource };
    const runner = vi.fn(okRunner);

    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: CALLER },
      deps(entry, runner),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("receipt store");
    expect(runner).not.toHaveBeenCalled();
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(1, 6);
    expect(await repo.getCreditBalance(CREATOR)).toBeCloseTo(0, 6);
  });

  it("refuses a resource with no prepared immutable contract before any ledger mutation", async () => {
    const entry = await seedAgent(0.25);
    const service = exactResourceService(0.25);
    entry.extensions = { [RESOURCE_CONTRACT_EXTENSION_URI]: service.resource };
    const recordRunReceipt = vi.fn();
    const createCredit = vi.spyOn(repo, "createCredit");

    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: CALLER },
      deps(entry, okRunner, { recordRunReceipt }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exact immutable resource contract");
    expect(recordRunReceipt).not.toHaveBeenCalled();
    expect(createCredit).not.toHaveBeenCalled();
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(1, 6);
    expect(await repo.getCreditBalance(CREATOR)).toBeCloseTo(0, 6);
  });

  it("refuses a mismatched prepared resource contract before any ledger mutation or execution", async () => {
    const entry = await seedAgent(0.25);
    const advertised = exactResourceService(0.25);
    entry.extensions = { [RESOURCE_CONTRACT_EXTENSION_URI]: advertised.resource };
    const prepared = preparedResourceRunner({
      ...advertised,
      resource: { ...advertised.resource!, semanticHash: "f".repeat(64) },
    }, {
      runId: "must-not-run", status: "done", outputs: {}, totalCostUsdc: 0,
    });
    const createCredit = vi.spyOn(repo, "createCredit");

    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: CALLER },
      deps(entry, prepared, { recordRunReceipt: vi.fn() }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exact immutable resource contract");
    expect(createCredit).not.toHaveBeenCalled();
    expect(prepared.execute).not.toHaveBeenCalled();
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
  });

  it("passes the tool arguments through to the flow as trigger input", async () => {
    const entry = await seedAgent(0.25);
    let seen: unknown = null;
    await callAgentTool(
      { name: "run_lead-scorer", arguments: { lead: "acme" }, workspaceKey: CALLER },
      deps(entry, async (input) => {
        seen = input.input;
        return { runId: "r", status: "done", outputs: {}, totalCostUsdc: 0 };
      }),
    );
    expect(seen).toEqual({ lead: "acme" });
  });

  it("refunds the caller when the run errors", async () => {
    const entry = await seedAgent(0.25);
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry, async () => ({
        runId: "r",
        status: "error",
        outputs: {},
        totalCostUsdc: 0,
      })),
    );
    expect(result.isError).toBe(true);
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(1, 6);
  });

  it("refunds the caller when the runner throws", async () => {
    const entry = await seedAgent(0.25);
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry, async () => {
        throw new Error("engine exploded");
      }),
    );
    expect(result.isError).toBe(true);
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(1, 6);
  });

  it("claws the creator's credit back too when a paid run fails", async () => {
    const entry = await seedAgent(0.25);
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry, async () => {
        throw new Error("engine exploded");
      }),
    );
    expect(await repo.getCreditBalance(CREATOR)).toBeCloseTo(0, 6);
  });

  it("does not leak the underlying error text to the caller", async () => {
    const entry = await seedAgent(0.25);
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry, async () => {
        throw new Error("postgres://user:pw@host down");
      }),
    );
    expect(JSON.stringify(result)).not.toContain("postgres");
  });

  it("refuses to bill a caller paying itself into its own agent for free", async () => {
    // The creator calling its own agent settles to itself; debiting and
    // crediting the same ledger nets to zero, so skip the round trip.
    const entry = await seedAgent(0.25);
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CREATOR },
      deps(entry),
    );
    expect(await repo.getCreditBalance(CREATOR)).toBeCloseTo(0, 6);
  });
});

describe("callAgentTool — governance exclusions", () => {
  it("refuses a relay-backed agent instead of running it without relay semantics", async () => {
    const entry = await seedAgent(0);
    await repo.upsertRelayEndpoint({
      agentId,
      url: "https://creator.example/run",
      secret: "s3cret",
    });
    const result = await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("relay");
  });

  it("never charges for an agent it refuses on eligibility", async () => {
    const entry = await seedAgent(0.25);
    await repo.createCredit({ ownerId: CALLER, deltaUsdc: 1, reason: "topup", tx: "0x9" });
    await repo.upsertRelayEndpoint({
      agentId,
      url: "https://creator.example/run",
      secret: "s3cret",
    });
    await callAgentTool(
      { name: "run_lead-scorer", arguments: {}, workspaceKey: CALLER },
      deps(entry),
    );
    expect(await repo.getCreditBalance(CALLER)).toBeCloseTo(1, 6);
  });
})
