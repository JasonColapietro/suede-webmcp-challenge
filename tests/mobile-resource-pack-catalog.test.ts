import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "@/lib/catalog";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import {
  MOBILE_RESOURCE_PACK_CATALOG_VERSION,
  projectMobileResourcePackCatalog,
} from "@/lib/resources/mobile-catalog";
import {
  WEBMCP_BUY_METHOD,
  WEBMCP_BUY_PATH,
  webMcpBuyBodySchema,
} from "@/lib/webmcp/buy-contract";

const semanticHash = "a".repeat(64);

function resourceEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "agent-pack-1",
    slug: "pricing-signals",
    name: "Pricing Signals",
    summary: "Answers reviewed pricing questions.",
    description: "Answers one bounded pricing question from reviewed records.",
    priceUsdc: 0.05,
    calls: 0,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: 1,
    settlementLive: true,
    acceptsPayment: true,
    paymentState: "payment-enabled",
    previewAvailable: true,
    payTo: "0x1111111111111111111111111111111111111111",
    schedule: null,
    inputSchema: {
      type: "object", properties: { question: { type: "string" } },
      required: ["question"], additionalProperties: false,
    },
    outputSchema: {
      type: "object", properties: { answer: { type: "string" } },
      required: ["answer"], additionalProperties: false,
    },
    publishedLive: true,
    urls: {
      public: "https://agents.suedeai.ai/a/pricing-signals",
      run: "https://agents.suedeai.ai/api/agents/pricing-signals/run",
      x402: "https://agents.suedeai.ai/api/agents/pricing-signals/.well-known/x402",
      agentCard: "https://agents.suedeai.ai/api/agents/pricing-signals/.well-known/agent-card.json",
      a2a: "https://agents.suedeai.ai/api/agents/pricing-signals/a2a",
    },
    extensions: {
      [RESOURCE_CONTRACT_EXTENSION_URI]: {
        extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
        resourceProductId: "resource-product-1",
        resourceVersion: "pack-version-7",
        semanticHash,
        freshness: "fresh",
        evidencePolicy: "Every answer cites this exact pack.",
        reviewBoundary: "Owner-reviewed records only.",
        access: { execution: "paid", discovery: "public" },
        sourceDisclosure: { sourceCount: 2, sourceKinds: ["manual_text"] },
        jobContract: {
          jobStatement: "Answer one pricing question.",
          buyerIntent: "Get a reviewed pricing answer.",
          inputSchema: {
            type: "object", properties: { question: { type: "string" } },
            required: ["question"], additionalProperties: false,
          },
          outputSchema: {
            type: "object", properties: { answer: { type: "string" } },
            required: ["answer"], additionalProperties: false,
          },
          unsupportedRequest: "Refuse unrelated requests.",
          evidenceRequirement: "Every answer cites this exact pack.",
          safeExample: { answer: "The team tier fits the stated requirements." },
          reviewBoundary: "Owner-reviewed records only.",
          dataHandlingDisclosure: "Private source bodies are not returned.",
        },
      },
    },
    ...overrides,
  };
}

describe("mobile Resource Pack catalog", () => {
  it("projects only released Resource Foundry entries with immutable pack identity", () => {
    const ordinary = { ...resourceEntry({ id: "ordinary", slug: "ordinary" }), extensions: undefined };
    const catalog = projectMobileResourcePackCatalog([ordinary, resourceEntry()]);

    expect(catalog.schemaVersion).toBe(MOBILE_RESOURCE_PACK_CATALOG_VERSION);
    expect(catalog.count).toBe(1);
    expect(catalog.packs[0]).toMatchObject({
      resourceProductId: "resource-product-1",
      packVersionId: "pack-version-7",
      semanticHash,
      slug: "pricing-signals",
      priceUsdc: 0.05,
      freshness: "fresh",
      availability: {
        publishedLive: true,
        acceptsPayment: true,
        previewAvailable: true,
        paymentState: "payment-enabled",
      },
    });
    expect(catalog.packs[0]).not.toHaveProperty("records");
    expect(catalog.packs[0]).not.toHaveProperty("sources");
    expect(catalog.packs[0]?.urls).toEqual(resourceEntry().urls);
  });

  it("hands a buyable pack to the existing external WebMCP checkout without executing it", () => {
    const [pack] = projectMobileResourcePackCatalog([resourceEntry()]).packs;

    expect(pack?.purchaseHandoff).toEqual({
      kind: "external_webmcp_agent",
      url: "https://agents.suedeai.ai/a/pricing-signals",
      requiresWebMcpAgentBrowser: true,
      requiresAuthenticatedBrowserSession: true,
      requiresUserInitiatedNavigation: true,
      catalogExecutesPurchase: false,
      webMcp: {
        tool: "buy_service",
      },
    });
    expect(pack?.purchaseHandoff?.webMcp).not.toHaveProperty("endpoint");
    expect(pack?.purchaseHandoff?.webMcp).not.toHaveProperty("requestBody");
    expect(WEBMCP_BUY_PATH).toBe("/api/webmcp/buy");
    expect(WEBMCP_BUY_METHOD).toBe("POST");
    expect(webMcpBuyBodySchema.safeParse({
      slug: "pricing-signals",
      input: { question: "Which tier fits a ten-person team?" },
      confirmedPriceUsdc: 0.05,
    }).success).toBe(true);
  });

  it("fails closed to no purchase handoff when server buyability is false", () => {
    const [pack] = projectMobileResourcePackCatalog([
      resourceEntry({ acceptsPayment: false }),
    ]).packs;
    expect(pack?.purchaseHandoff).toBeNull();
  });

  it("omits an entry that is not backed by a current Live publication", () => {
    expect(projectMobileResourcePackCatalog([
      resourceEntry({ publishedLive: false }),
    ]).packs).toEqual([]);
  });

  it("drops a malformed Resource extension instead of guessing immutable identity", () => {
    const malformed = resourceEntry({
      extensions: {
        [RESOURCE_CONTRACT_EXTENSION_URI]: {
          resourceProductId: "resource-product-1",
          resourceVersion: "pack-version-7",
          semanticHash: "not-a-hash",
        },
      },
    });

    expect(projectMobileResourcePackCatalog([malformed]).packs).toEqual([]);
  });
});
