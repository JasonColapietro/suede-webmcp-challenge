import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getRepo } from "@/lib/db/repo";
import { SITE_URL } from "@/lib/site";
import type { AgentRecord, FlowRecord } from "@/lib/db/repo";
import type { FlowGraph } from "@/lib/flow/types";
import { getProjectRepo } from "@/lib/projects/provider";
import { promoteFlowToLive } from "@/lib/launch/promote-live";

const { GET: rootX402 } = await import("@/app/.well-known/x402/route");
const { GET: rootAgentCard } = await import("@/app/.well-known/agent-card.json/route");
const { GET: agentX402 } = await import("@/app/api/agents/[agent]/.well-known/x402/route");
const { GET: agentCard } = await import("@/app/api/agents/[agent]/.well-known/agent-card/route");
const { GET: agentA2A } = await import("@/app/api/agents/[agent]/a2a/route");
const { GET: agentTemplate } = await import("@/app/api/agents/[agent]/template/route");
const { GET: catalog } = await import("@/app/api/catalog/route");

interface AcceptContract {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  asset: string;
}

const request = new Request(`${SITE_URL}/compat-discovery`);
const GENERIC_RUN_DESCRIPTION =
  "Run a Suede Agent Studio workflow over x402.";
const params = (agent: string): { params: Promise<{ agent: string }> } => ({
  params: Promise.resolve({ agent }),
});

let flow: FlowRecord;
let agent: AgentRecord;

function discoveryGraph(): FlowGraph {
  return {
    id: `graph-discovery-${Math.random().toString(36).slice(2)}`,
    name: `Compatibility Service ${Date.now()}`,
    nodes: [
      { id: "input", type: "input", params: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", params: {}, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: "input-output", source: "input", target: "output" }],
  };
}

beforeAll(async () => {
  const repo = await getRepo();
  flow = await repo.saveFlow({
    ownerId: `compat-discovery-owner-${Date.now()}`,
    name: `Compatibility Service ${Date.now()}`,
    graph: discoveryGraph(),
  });
  const promotion = await promoteFlowToLive({
    flowId: flow.id,
    ownerId: flow.ownerId,
    projectRepo: await getProjectRepo(),
  });
  if (promotion.status !== "promoted") {
    throw new Error(`Compatibility fixture promotion failed at ${promotion.stage}`);
  }
  agent = await repo.createAgent({
    flowId: flow.id,
    slug: `compatibility-service-${Date.now()}`,
    status: "live",
    priceUsdc: 0.05,
  });
});

afterAll(async () => {
  const repo = await getRepo();
  await repo.deleteFlow(flow.id, flow.ownerId);
});

describe("discovery v0 compatibility", () => {
  // 2026-07-22: deliberately re-baselined from x402-v1 to x402-v2 (amount
  // field, CAIP-2 network, structured resource descriptor, Bazaar discovery
  // extensions) — a commissioned protocol migration, not accidental drift.
  // Legacy v1 PAYMENT payloads are still decoded and settled by
  // src/lib/rails/x402-verify.ts for backward compatibility; only the
  // advertised discovery-document SHAPE moves to v2 here.
  it("keeps root and per-agent x402 v2 payment-state projections compatible", async () => {
    const rootResponse = await rootX402();
    expect(rootResponse.status).toBe(200);
    const root = (await rootResponse.json()) as {
      x402Version: number;
      endpoints: Array<{
        resource: string;
        summary: string;
        publishedLive: boolean;
        acceptsPayment: boolean;
        paymentState: "payment-enabled" | "preview" | "unavailable";
        resourceInfo: { description?: string };
        accepts?: AcceptContract[];
        extensions?: Record<string, unknown>;
      }>;
    };
    const resource = `${SITE_URL}/api/agents/${agent.slug}/run`;
    const rootEntry = root.endpoints.find((entry) => entry.resource === resource);
    expect(root.x402Version).toBe(2);
    expect(rootEntry).toBeDefined();

    // Honesty flags (2026-08-09): every index entry must let a crawler tell a
    // deployed, settling endpoint from a dry-run-only listing WITHOUT paying.
    // The fixture promotes the exact immutable graph before publication while
    // settlement defaults off, so discovery is Live without claiming payment.
    expect(rootEntry?.publishedLive).toBe(true);
    expect(rootEntry?.acceptsPayment).toBe(false);
    expect(rootEntry?.paymentState).toBe("preview");
    expect(rootEntry?.accepts).toBeUndefined();
    expect(rootEntry?.extensions).toBeUndefined();

    const perResponse = await agentX402(request, params(agent.slug));
    const per = (await perResponse.json()) as {
      x402Version: number;
      name: string;
      resource: { url: string; description?: string };
      inputSchema: Record<string, unknown>;
      acceptsPayment: boolean;
      paymentState: "payment-enabled" | "preview" | "unavailable";
      accepts?: AcceptContract[];
      extensions?: Record<string, unknown>;
      payoutSource?: string;
    };
    expect(per.x402Version).toBe(2);
    expect(per.resource.url).toBe(resource);
    expect(per.resource.url.startsWith("https://")).toBe(true);
    expect(rootEntry?.summary).toBeTruthy();
    expect(rootEntry?.summary).not.toBe(GENERIC_RUN_DESCRIPTION);
    expect(rootEntry?.resourceInfo.description).toBe("Input › Output");
    expect(rootEntry?.resourceInfo.description).not.toContain(agent.slug);
    // DELIBERATE pin update (2026-08-09, per-agent identity): the per-agent
    // manifest's RESOURCE identity now reads "<flow name>: <description>" so
    // two agents' documents are distinguishable; the pinned generic CDP
    // string stays on the accepts/402-challenge side (see
    // tests/x402-generic-cdp-metadata.test.ts) and on the root index above.
    expect(per.name).toBe(flow.name);
    expect(per.resource.description).toBe(`${flow.name}: Input › Output`);
    expect(per.resource.description).not.toBe(GENERIC_RUN_DESCRIPTION);
    // Top-level input schema, derived from the public graph. The fixture's
    // input node authors no fields, so the honest open-object fallback wins.
    expect(per.inputSchema).toEqual({ type: "object" });
    expect(per.acceptsPayment).toBe(false);
    expect(per.paymentState).toBe("preview");
    expect(per.accepts).toBeUndefined();
    expect(per.extensions).toBeUndefined();
    expect(per.payoutSource).toBeUndefined();
  });

  it("serves the same required AgentCard fields from both per-agent discovery aliases", async () => {
    // DELIBERATE pin update (2026-08-09, per-agent identity): the card used to
    // advertise the slug as its name, one boilerplate description shared by
    // every agent, and a relative url. It now carries the flow's human name
    // (slug moves to its own field), the creator's description or node-chain
    // summary, an absolute SITE_URL url, and the derived input schema —
    // provider, capabilities, and pricing keep their legacy shape.
    const cardResponse = await agentCard(request, params(agent.slug));
    const card = (await cardResponse.json()) as Record<string, unknown>;
    expect(card).toMatchObject({
      name: flow.name,
      description: "Input › Output",
      supportedInterfaces: [{
        url: `${SITE_URL}/api/agents/${agent.slug}/a2a`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      }],
      provider: { organization: "Suede Labs AI", url: SITE_URL },
      version: "1.0.0",
      capabilities: { streaming: false, extensions: [] },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [{ name: flow.name, description: "Input › Output" }],
      "x-suede": {
        projection: {
          version: 2,
          states: ["preview", "payment-enabled", "unavailable"],
          migration:
            "Version 2 omits x402 terms unless state is payment-enabled; unavailable does not imply a public dry-run.",
        },
        slug: agent.slug,
        a2aEndpoint: `${SITE_URL}/api/agents/${agent.slug}/a2a/message:send`,
        endpoint: `${SITE_URL}/api/agents/${agent.slug}/run`,
        inputSchema: { type: "object" },
        pricing: {
          amountUsdc: 0.05,
          acceptsPayment: false,
          state: "preview",
        },
      },
    });

    const a2aResponse = await agentA2A(request, params(agent.slug));
    expect(await a2aResponse.json()).toEqual(card);
  });

  it("keeps preview agents crawlable from the root AgentCard without projecting payment", async () => {
    const response = await rootAgentCard();
    const body = (await response.json()) as {
      "x-suede": {
        projection: {
          version: number;
          states: string[];
          migration: string;
        };
        agents: Array<{
          id: string;
          payment: Record<string, unknown>;
        }>;
      };
    };
    const entry = body["x-suede"].agents.find((candidate) => candidate.id === agent.id);
    expect(body["x-suede"].projection).toEqual({
      version: 2,
      states: ["preview", "payment-enabled", "unavailable"],
      migration:
        "Version 2 omits x402 terms unless state is payment-enabled; unavailable does not imply a public dry-run.",
    });
    expect(entry).toBeDefined();
    expect(entry?.payment).toEqual({
      state: "preview",
      acceptsPayment: false,
    });
  });

  it("keeps catalog URLs absolute and linked across every discovery surface", async () => {
    const response = await catalog();
    const body = (await response.json()) as {
      description: string;
      service: string;
      site: string;
      count: number;
      agents: Array<{ id: string; urls: Record<string, string> }>;
    };
    const entry = body.agents.find((candidate) => candidate.id === agent.id);
    expect(body.service).toBe("Suede Agent Studio");
    expect(body.description).toContain("current payment availability");
    expect(body.description).not.toContain("published as pay-per-call");
    expect(body.site).toBe(SITE_URL);
    expect(body.count).toBe(body.agents.length);
    expect(response.headers.get("server-timing")).toMatch(
      /catalog_source_fresh;dur=\d+\.\d/,
    );
    expect(response.headers.get("server-timing")).toMatch(
      /catalog_total;dur=\d+\.\d/,
    );
    expect(response.headers.get("x-catalog-profile")).toBe(
      response.headers.get("server-timing"),
    );
    expect(entry?.urls).toEqual({
      public: `${SITE_URL}/a/${agent.slug}`,
      run: `${SITE_URL}/api/agents/${agent.slug}/run`,
      x402: `${SITE_URL}/api/agents/${agent.slug}/.well-known/x402`,
      agentCard: `${SITE_URL}/api/agents/${agent.slug}/.well-known/agent-card.json`,
      a2a: `${SITE_URL}/api/agents/${agent.slug}/a2a`,
    });
  });

  it("exports only implemented interfaces and settlement rails", async () => {
    const response = await agentTemplate(request, params(agent.slug));
    const body = (await response.json()) as {
      name: string;
      flow: FlowGraph;
      files: Record<string, string>;
      schemaVersion: number;
      interfaces: string[];
      settlementRails: string[];
      payment: Record<string, unknown>;
    };
    expect(body.schemaVersion).toBe(2);
    expect(body.name).toBe(agent.slug);
    expect(body.flow).toEqual(flow.graph);
    expect(Object.keys(body.files).sort()).toEqual(["README.md", "flow.json", "run.ts"]);
    expect(body.interfaces).toEqual(["a2a"]);
    expect(body.settlementRails).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/\bacp\b/i);
    expect(body.payment).toEqual({ state: "preview", acceptsPayment: false });
    expect(body.files["run.ts"]).toContain("dryRun: true");
    expect(body.files["run.ts"]).toContain("https://agents.suedeai.ai");
    expect(body.files["run.ts"]).not.toContain("https://studio.suedeai.ai");
    expect(body.files["run.ts"]).not.toContain("@x402/fetch");
    expect(body.files["run.ts"]).not.toContain("WALLET_PRIVATE_KEY");
    expect(body.files["README.md"]).toContain("Preview mode");
    expect(body.files["README.md"]).not.toContain("callable per-call in USDC");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${agent.slug}.suede-template.json"`,
    );
  });

  it("does not project payment when flags are on but no Live deployment backs the service", async () => {
    const repo = await getRepo();
    await repo.updateAgent(agent.id, { settlementLive: true });
    vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
    try {
      const perResponse = await agentX402(request, params(agent.slug));
      const per = (await perResponse.json()) as {
        acceptsPayment: boolean;
        paymentState: string;
        accepts?: AcceptContract[];
        extensions?: Record<string, unknown>;
      };
      expect(per.acceptsPayment).toBe(false);
      expect(per.paymentState).toBe("preview");
      expect(per.accepts).toBeUndefined();
      expect(per.extensions).toBeUndefined();

      const templateResponse = await agentTemplate(request, params(agent.slug));
      const template = (await templateResponse.json()) as {
        files: Record<string, string>;
        interfaces: string[];
        settlementRails: string[];
        payment: Record<string, unknown>;
      };
      expect(template.interfaces).toEqual(["a2a"]);
      expect(template.settlementRails).toEqual([]);
      expect(template.payment).toEqual({ state: "preview", acceptsPayment: false });
      expect(template.files["run.ts"]).toContain("dryRun: true");
      expect(template.files["run.ts"]).not.toContain("@x402/fetch");
      expect(template.files["run.ts"]).toContain("https://agents.suedeai.ai");
      expect(template.files["run.ts"]).not.toContain("studio.suedeai.ai");
      expect(template.files["run.ts"]).not.toContain("WALLET_PRIVATE_KEY");
      expect(template.files["run.ts"]).not.toContain("base-mainnet");
      expect(template.files["README.md"]).toContain("Preview mode");
    } finally {
      vi.unstubAllEnvs();
      await repo.updateAgent(agent.id, { settlementLive: false });
    }
  });

  it("returns the same 404 error for unknown discovery agents", async () => {
    const unknown = `unknown-${Date.now()}`;
    for (const handler of [agentX402, agentCard, agentA2A, agentTemplate]) {
      const response = await handler(request, params(unknown));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "agent not found" });
    }
  });

  it("adds the standard per-agent AgentCard JSON alias while retaining the bare compatibility route", () => {
    // Root x402.json IS now present — an intentional 2026-07-22 addition for
    // crawlers/clients that look for the .json suffix instead of the bare
    // /.well-known/x402 path. Per-agent aliases remain deliberately absent.
    expect(existsSync("src/app/.well-known/x402.json/route.ts")).toBe(true);
    expect(existsSync("src/app/.well-known/agent-card.json/route.ts")).toBe(true);
    expect(existsSync("src/app/.well-known/ai-plugin.json/route.ts")).toBe(true);
    expect(existsSync("src/app/openapi.json/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agents/[agent]/.well-known/x402.json/route.ts")).toBe(false);
    expect(existsSync("src/app/api/agents/[agent]/.well-known/agent-card.json/route.ts")).toBe(true);
  });
});
