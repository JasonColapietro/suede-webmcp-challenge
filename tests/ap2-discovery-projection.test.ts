import { readFile } from "node:fs/promises";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSuedeAgentCard } from "@/lib/discovery/agent-card";

const openApiRoute = await import("@/app/openapi.json/route");

const AP2_EXTENSION_URI = "https://github.com/google-agentic-commerce/ap2/v1";

const agent = {
  name: "PO Match Gate",
  slug: "po-match-gate-mkgu0",
  description: "Match a purchase order to an invoice.",
  priceUsdc: 0.1,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  tags: ["finance"],
  paymentState: "payment-enabled" as const,
  publishedLive: true,
  fulfillmentSupportsAp2: true,
} satisfies Parameters<typeof buildSuedeAgentCard>[0];

type Ap2Status = {
  readonly mode: "off" | "optional" | "required";
  readonly ready: boolean;
};

const buildWithAp2 = (
  input: Parameters<typeof buildSuedeAgentCard>[0],
  status?: Ap2Status,
) => buildSuedeAgentCard(input, status);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function enableReadyAp2(mode: "optional" | "required"): Promise<void> {
  const merchant = await generateKeyPair("ES256", { extractable: true });
  const trusted = await generateKeyPair("ES256", { extractable: true });
  vi.stubEnv("AP2_MODE", mode);
  vi.stubEnv("AP2_MERCHANT_ISSUER", "https://agents.suedeai.ai");
  vi.stubEnv("AP2_MERCHANT_SIGNING_JWK", JSON.stringify({
    ...(await exportJWK(merchant.privateKey)),
    alg: "ES256",
    kid: "merchant-test-key",
    use: "sig",
  }));
  vi.stubEnv("AP2_TRUSTED_ISSUERS_JSON", JSON.stringify({
    issuers: [{
      issuer: "https://wallet.example",
      algorithms: ["ES256"],
      keys: [{
        ...(await exportJWK(trusted.publicKey)),
        alg: "ES256",
        kid: "wallet-test-key",
        use: "sig",
      }],
    }],
  }));
  vi.stubEnv("AP2_REPLAY_STORE_READY", "1");
}

describe("experimental AP2 discovery projection", () => {
  it("does not advertise AP2 when it is off or readiness fails", () => {
    for (const status of [
      { mode: "off", ready: true },
      { mode: "optional", ready: false },
      { mode: "required", ready: false },
    ] as const) {
      const card = buildWithAp2(agent, status);
      expect(card.capabilities.extensions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ uri: AP2_EXTENSION_URI })]),
      );
      expect(card["x-suede"]).not.toHaveProperty("ap2");
    }
  });

  it("does not advertise AP2 for non-Live, non-settling, or fractional-cent services", () => {
    for (const ineligible of [
      { ...agent, paymentState: "preview" as const },
      { ...agent, publishedLive: false },
      { ...agent, priceUsdc: 0.001 },
    ]) {
      const card = buildWithAp2(ineligible, { mode: "optional", ready: true });
      expect(card.capabilities.extensions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ uri: AP2_EXTENSION_URI })]),
      );
      expect(card["x-suede"]).not.toHaveProperty("ap2");
    }
  });

  it("advertises only the experimental merchant role while x402 remains settlement", () => {
    const card = buildWithAp2(agent, { mode: "optional", ready: true });
    expect(card.capabilities.extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uri: AP2_EXTENSION_URI,
        required: false,
        params: expect.objectContaining({
          protocol: "AP2",
          version: "0.2",
          profile: "merchant",
          status: "experimental",
          settlementRail: "x402-v2",
          negotiationHeader: "A2A-Extensions",
          compatibilityHeader: "X-A2A-Extensions",
        }),
      }),
    ]));
    expect(card["x-suede"]).toMatchObject({
      pricing: { rail: "x402" },
      ap2: {
        version: "0.2",
        status: "experimental",
        profile: "merchant",
        mode: "optional",
        extensionUri: AP2_EXTENSION_URI,
        settlementRail: "x402-v2",
      },
    });
  });

  it("marks the AP2 extension required only in ready required mode", () => {
    const card = buildWithAp2(agent, { mode: "required", ready: true });
    const extension = card.capabilities.extensions.find(
      (candidate) => candidate.uri === AP2_EXTENSION_URI,
    );
    expect(extension).toMatchObject({ required: true });
    expect(card["x-suede"].ap2).toMatchObject({ mode: "required" });
  });

  it("projects a ready runtime status into the public OpenAPI contract", async () => {
    await enableReadyAp2("required");

    const openApiResponse = await openApiRoute.GET();
    const openApi = await openApiResponse.json() as {
      "x-suede-ap2"?: { mode: string; requiredForPricedLive: boolean };
      paths: Record<string, { post?: { description?: string; parameters?: Array<{ name: string }> } }>;
    };
    expect(openApi["x-suede-ap2"]).toMatchObject({
      mode: "required",
      requiredForPricedLive: true,
    });
    expect(
      openApi.paths["/api/agents/{agent}/a2a/message:send"]?.post?.parameters,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "A2A-Extensions" }),
      expect.objectContaining({ name: "X-A2A-Extensions" }),
    ]));
    expect(openApi.paths).toHaveProperty("/.well-known/ap2.json");
    expect(openApi.paths).toHaveProperty("/.well-known/ap2-jwks.json");
    expect(openApi.paths).toHaveProperty("/api/agents/{agent}/.well-known/ap2");
    expect(openApi.paths).toHaveProperty("/api/agents/{agent}/ap2/checkout");
    expect(openApi.paths["/api/agents/{agent}/run"]?.post?.description).toMatch(
      /AP2 v0\.2 merchant authorization/,
    );
  });

  it("documents the feature gate and avoids broader AP2 role or compliance claims", async () => {
    const [llms, ...docs] = await Promise.all([
      readFile(new URL("../public/llms.txt", import.meta.url), "utf8"),
      readFile(new URL("../src/app/docs/api/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/app/docs/payments/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/app/docs/launching/page.tsx", import.meta.url), "utf8"),
    ]);
    const copy = docs.join("\n");
    expect(llms).not.toMatch(/\bAP2\b/u);
    expect(llms).not.toContain(AP2_EXTENSION_URI);
    expect(copy).toMatch(/experimental AP2 v0\.2\s+merchant authorization/i);
    expect(copy).toContain(AP2_EXTENSION_URI);
    expect(copy).toContain("AP2_MODE");
    expect(copy).toMatch(/x402 remains the settlement rail/i);
    expect(copy).not.toMatch(/AP2(?:\+x402)? compliant/i);
    expect(copy).not.toMatch(/Suede (?:is|acts as) (?:a |the )?(?:CP|MPP|credentials provider|payment processor)/i);
  });
});
