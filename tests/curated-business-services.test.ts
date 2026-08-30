import { afterEach, describe, expect, it, vi } from "vitest";
import {
  curatedBusinessService,
  extractCuratedServiceResult,
  listCuratedBusinessServiceContracts,
} from "@/lib/curated-business-services";
import { triggerInputContractViolations } from "@/lib/run-service";
import { buildX402BazaarExtensions } from "@/lib/rails/x402-verify";
import { buildSuedeAgentCard } from "@/lib/discovery/agent-card";
import { SITE_URL } from "@/lib/site";

const catalogState = vi.hoisted(() => ({ entries: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/catalog", () => ({
  buildCatalog: vi.fn(async () => catalogState.entries),
}));

afterEach(() => {
  catalogState.entries = [];
});

describe("curated business service registry", () => {
  const contracts = listCuratedBusinessServiceContracts();

  it("contains the six exact platform-operated business services", () => {
    expect(contracts.map(({ slug }) => slug)).toEqual([
      "po-match-gate-mkgu0",
      "resume-vs-jd-screener-wp72w",
      "contract-red-flag-scan-chm9v",
      "vendor-risk-read-q0jjq",
      "expense-policy-check-l8o5i",
      "bank-rec-discrepancy-finder-bw0tt",
    ]);
    expect(new Set(contracts.map(({ templateId }) => templateId))).toHaveLength(6);
  });

  it("fails closed for customer copies and graph identity drift", () => {
    for (const contract of contracts) {
      expect(curatedBusinessService(contract.slug, { id: contract.templateId })).toBe(contract);
    }
    const first = contracts[0]!;
    expect(curatedBusinessService("customer-copy", { id: first.templateId })).toBeNull();
    expect(curatedBusinessService(first.slug, { id: "other-graph" })).toBeNull();
  });

  it("ships crawler examples that pass the exact pre-payment contracts", () => {
    for (const contract of contracts) {
      expect(triggerInputContractViolations(contract.inputSchema, contract.exampleInput)).toEqual([]);
      expect(Object.keys(contract.outputSchema.properties ?? {})).not.toHaveLength(0);
      expect(contract.reviewPolicy).toMatch(/human|counsel|controller|bookkeeper/iu);
    }
  });

  it("requires all curated inputs and enforces the PDF contract", () => {
    const po = contracts.find(({ key }) => key === "po-match")!;
    expect(triggerInputContractViolations(po.inputSchema, {})).toEqual([
      'missing required field "purchaseOrder"',
      'missing required field "invoice"',
    ]);
    const resume = contracts.find(({ key }) => key === "resume-jd-screen")!;
    expect(triggerInputContractViolations(resume.inputSchema, {})).toEqual([
      'missing required field "jobDescription"',
      'missing required field "resume"',
    ]);
    const contract = contracts.find(({ key }) => key === "contract-red-flag")!;
    expect(triggerInputContractViolations(contract.inputSchema, {
      filename: "terms.txt",
      fileBase64: "not-base64",
    })).toEqual(expect.arrayContaining([
      'field "filename" does not match the required pattern',
      'field "fileBase64" must be valid base64',
    ]));
  });

  it("puts the valid request body and typed result in Bazaar metadata", () => {
    const contract = contracts[0]!;
    const extensions = buildX402BazaarExtensions({
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      exampleInput: contract.exampleInput,
      exampleOutput: contract.exampleOutput,
    });
    expect(extensions.bazaar.info.input.body).toEqual({ input: contract.exampleInput });
    expect(extensions.bazaar.info.output.example.result).toEqual(contract.exampleOutput);
  });

  it("builds an AgentCard with the standard A2A binding and honest x402 extension", () => {
    const contract = contracts[0]!;
    const card = buildSuedeAgentCard({
      name: contract.name,
      slug: contract.slug,
      description: contract.description,
      priceUsdc: 0.1,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      tags: contract.tags,
      paymentState: "payment-enabled",
      publishedLive: true,
      fulfillmentSupportsAp2: true,
    });
    expect(card).toMatchObject({
      name: contract.name,
      version: "1.0.0",
      supportedInterfaces: [{ protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
      provider: { organization: "Suede Labs AI" },
      capabilities: { streaming: false },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
    });
    expect(card.skills[0]).toMatchObject({
      id: `run-${contract.slug}`,
      name: contract.name,
      tags: [...contract.tags],
    });
    expect(card["x-suede"]).toMatchObject({
      endpoint: `${SITE_URL}/api/agents/${contract.slug}/run`,
      a2aEndpoint: `${SITE_URL}/api/agents/${contract.slug}/a2a/message:send`,
      pricing: { rail: "x402", amountUsdc: 0.1 },
    });
  });

  it("projects unavailable services without a preview or x402 extension", () => {
    const contract = contracts[0]!;
    const card = buildSuedeAgentCard({
      name: contract.name,
      slug: contract.slug,
      description: contract.description,
      priceUsdc: 0.1,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      tags: contract.tags,
      paymentState: "unavailable",
      publishedLive: true,
      fulfillmentSupportsAp2: true,
    });
    expect(card["x-suede"].pricing).toEqual({
      state: "unavailable",
      acceptsPayment: false,
      amountUsdc: 0.1,
    });
    expect(card.capabilities.extensions).toEqual([]);
  });

  it("adds a normalized result without removing raw node outputs", () => {
    const contract = contracts[0]!;
    const outputs = {
      llm: { text: "noise" },
      out: { result: { result: JSON.stringify(contract.exampleOutput) } },
    };
    expect(extractCuratedServiceResult(
      contract,
      { nodes: [{ id: "out", type: "output" }] },
      outputs,
    )).toEqual(contract.exampleOutput);
    expect(outputs.out).toBeDefined();
  });

  it("does not label parseable but schema-invalid model output as a curated result", () => {
    const contract = contracts[0]!;
    expect(extractCuratedServiceResult(
      contract,
      { nodes: [{ id: "out", type: "output" }] },
      { out: { result: { text: '{"matched":"yes","status":"pass"}' } } },
    )).toBeNull();
  });

  it("versions service readiness and labels settlement only as historical evidence", async () => {
    const contract = contracts[0]!;
    catalogState.entries = [{
      id: "service-readiness-agent",
      slug: contract.slug,
      name: contract.name,
      curation: { collection: "business-operations" },
      paymentState: "unavailable",
      publishedLive: true,
      acceptsPayment: false,
      previewAvailable: false,
      settledCalls: 2,
      lastCallAt: 1_786_190_400_000,
      urls: {
        public: `/a/${contract.slug}`,
        run: `/api/agents/${contract.slug}/run`,
        x402: `/api/agents/${contract.slug}/.well-known/x402`,
        agentCard: `/api/agents/${contract.slug}/.well-known/agent-card`,
        a2a: `/api/agents/${contract.slug}/a2a`,
      },
    }];

    const { GET } = await import("@/app/api/services/route");
    const response = await GET();
    const body = await response.json();
    expect(body).toMatchObject({
      readinessProjectionVersion: 2,
      historicallySettledServiceCount: 1,
      services: [{
        readiness: {
          state: "unavailable",
          hasSettledCalls: true,
          settledCalls: 2,
        },
      }],
    });
    expect(body).not.toHaveProperty("settlementVerifiedCount");
    expect(body.services[0].readiness).not.toHaveProperty("settlementVerified");
  });

  it("documents the versioned historical-settlement projection in OpenAPI", async () => {
    const { GET } = await import("@/app/openapi.json/route");
    const body = await (await GET()).json();
    const schema = body.components.schemas.CuratedServiceCatalog;
    expect(schema.properties).toMatchObject({
      readinessProjectionVersion: { type: "integer", const: 2 },
      historicallySettledServiceCount: { type: "integer", minimum: 0 },
    });
    expect(schema.properties).not.toHaveProperty("settlementVerifiedCount");
    expect(schema.required).toEqual(expect.arrayContaining([
      "readinessProjectionVersion",
      "historicallySettledServiceCount",
    ]));
    expect(schema.required).not.toContain("settlementVerifiedCount");
    expect(schema.properties.services.items.properties.readiness).toEqual({
      $ref: "#/components/schemas/CuratedServiceReadiness",
    });
    const readinessSchema = body.components.schemas.CuratedServiceReadiness;
    expect(readinessSchema.properties.hasSettledCalls.description).toMatch(
      /historical evidence only/iu,
    );
    expect(readinessSchema.properties).not.toHaveProperty("settlementVerified");
  });

  it("projects payment-enabled services as concrete AgentCash-discoverable OpenAPI routes", async () => {
    const contract = contracts[0]!;
    catalogState.entries = [{
      id: "agentcash-paid-agent",
      slug: contract.slug,
      name: contract.name,
      summary: contract.description,
      description: contract.description,
      priceUsdc: 0.1,
      paymentState: "payment-enabled",
      acceptsPayment: true,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      exampleInput: contract.exampleInput,
      exampleOutput: contract.exampleOutput,
      urls: {
        public: `/a/${contract.slug}`,
        run: `/api/agents/${contract.slug}/run`,
        x402: `/api/agents/${contract.slug}/.well-known/x402`,
        agentCard: `/api/agents/${contract.slug}/.well-known/agent-card.json`,
        a2a: `/api/agents/${contract.slug}/a2a`,
      },
    }];

    const { GET } = await import("@/app/openapi.json/route");
    const body = await (await GET()).json();
    const paidPath = body.paths[`/api/agents/${contract.slug}/run`]?.post;

    expect(body.info["x-guidance"]).toMatch(/concrete paid service routes/iu);
    expect(paidPath).toMatchObject({
      operationId: `runPublishedAgent_${contract.slug.replaceAll("-", "_")}`,
      "x-payment-info": {
        protocols: [{ x402: {} }],
        price: { mode: "fixed", currency: "USD", amount: "0.100000" },
      },
      responses: {
        "200": expect.any(Object),
        "402": expect.any(Object),
      },
    });
    expect(
      paidPath.requestBody.content["application/json"].schema.properties.input,
    ).toEqual(contract.inputSchema);
    expect(body.paths["/api/agents/{agent}/run"].post).not.toHaveProperty(
      "x-payment-info",
    );
  });
});
