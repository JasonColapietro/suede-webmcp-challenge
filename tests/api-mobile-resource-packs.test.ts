import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "@/lib/catalog";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";

const state = vi.hoisted(() => ({
  entries: [] as CatalogEntry[],
  error: null as Error | null,
}));

vi.mock("@/lib/catalog", () => ({
  buildCatalog: vi.fn(async () => {
    if (state.error) throw state.error;
    return state.entries;
  }),
}));

import { GET } from "@/app/api/mobile/resource-packs/route";

const semanticHash = "b".repeat(64);

function entry(): CatalogEntry {
  return {
    id: "agent-mobile",
    slug: "mobile-pack",
    name: "Mobile Pack",
    summary: "A released pack.",
    description: null,
    priceUsdc: 0,
    calls: 0,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: 1,
    settlementLive: false,
    acceptsPayment: false,
    paymentState: "preview",
    previewAvailable: true,
    payTo: "0x0000000000000000000000000000000000000000",
    schedule: null,
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    publishedLive: true,
    urls: {
      public: "/a/mobile-pack",
      run: "/api/agents/mobile-pack/run",
      x402: "/api/agents/mobile-pack/.well-known/x402",
      agentCard: "/api/agents/mobile-pack/.well-known/agent-card.json",
      a2a: "/api/agents/mobile-pack/a2a",
    },
    extensions: {
      [RESOURCE_CONTRACT_EXTENSION_URI]: {
        extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
        resourceProductId: "resource-mobile",
        resourceVersion: "pack-mobile-v1",
        semanticHash,
        freshness: "fresh",
        evidencePolicy: "Citations required.",
        reviewBoundary: "Reviewed records.",
        access: { execution: "free", discovery: "public" },
        sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual_text"] },
        jobContract: {
          jobStatement: "Return one result.",
          buyerIntent: "Get one result.",
          inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
          outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
          unsupportedRequest: "Refuse unrelated work.",
          evidenceRequirement: "Citations required.",
          safeExample: {},
          reviewBoundary: "Reviewed records.",
          dataHandlingDisclosure: "No source bodies.",
        },
      },
    },
  };
}

describe("GET /api/mobile/resource-packs", () => {
  beforeEach(() => {
    state.entries = [entry()];
    state.error = null;
  });

  it("returns a cacheable compact released-pack envelope", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(body).toMatchObject({
      schemaVersion: "resource-packs.v1",
      service: "Suede Resource Foundry",
      site: "https://agents.suedeai.ai",
      count: 1,
      packs: [{ resourceProductId: "resource-mobile", packVersionId: "pack-mobile-v1" }],
    });
  });

  it("returns an opaque no-store error when catalog resolution fails", async () => {
    state.error = new Error("provider secret detail");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "internal error" });
    errorSpy.mockRestore();
  });
});
