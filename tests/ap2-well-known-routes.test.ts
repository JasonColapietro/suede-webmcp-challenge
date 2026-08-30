import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildCatalog = vi.fn();
vi.mock("@/lib/catalog", () => ({ buildCatalog }));

const rootDiscovery = await import("@/app/.well-known/ap2.json/route");
const jwksDiscovery = await import("@/app/.well-known/ap2-jwks.json/route");
const agentDiscovery = await import("@/app/api/agents/[agent]/.well-known/ap2/route");

const ENTRY = {
  id: "agent-1",
  slug: "po-match-gate-mkgu0",
  priceUsdc: 0.1,
  payTo: "0x1111111111111111111111111111111111111111",
  acceptsPayment: true,
  publishedLive: true,
  ap2: { mode: "optional" },
  urls: {
    run: "/api/agents/po-match-gate-mkgu0/run",
    a2a: "/api/agents/po-match-gate-mkgu0/a2a/message:send",
  },
};

async function enableReadyAp2(): Promise<void> {
  const merchant = await generateKeyPair("ES256", { extractable: true });
  const trusted = await generateKeyPair("ES256", { extractable: true });
  vi.stubEnv("AP2_MODE", "optional");
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

beforeEach(() => {
  buildCatalog.mockResolvedValue([ENTRY]);
});

afterEach(() => {
  buildCatalog.mockReset();
  vi.unstubAllEnvs();
});

describe("AP2 discovery routes", () => {
  it("returns 404 everywhere while the fail-closed mode is off", async () => {
    vi.stubEnv("AP2_MODE", "off");

    expect((await rootDiscovery.GET()).status).toBe(404);
    expect((await jwksDiscovery.GET()).status).toBe(404);
    expect((await agentDiscovery.GET(new Request("https://agents.suedeai.ai"), {
      params: Promise.resolve({ agent: ENTRY.slug }),
    })).status).toBe(404);
    expect(buildCatalog).not.toHaveBeenCalled();
  });

  it("keeps historical receipt keys verifiable while acceptance is off", async () => {
    await enableReadyAp2();
    vi.stubEnv("AP2_MODE", "off");

    expect((await rootDiscovery.GET()).status).toBe(404);
    expect((await agentDiscovery.GET(new Request("https://agents.suedeai.ai"), {
      params: Promise.resolve({ agent: ENTRY.slug }),
    })).status).toBe(404);
    const jwksResponse = await jwksDiscovery.GET();
    const jwks = await jwksResponse.json() as { keys: Array<Record<string, unknown>> };
    expect(jwksResponse.status).toBe(200);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(buildCatalog).not.toHaveBeenCalled();
  });

  it("publishes only merchant-role metadata and a public key when ready", async () => {
    await enableReadyAp2();

    const rootResponse = await rootDiscovery.GET();
    const root = await rootResponse.json();
    expect(rootResponse.status).toBe(200);
    expect(root).toMatchObject({
      protocol: "AP2",
      version: "0.2",
      profile: "ap2-v0.2-experimental",
      role: "merchant",
      mode: "optional",
      settlementRail: "x402-v2",
      services: [expect.objectContaining({
        slug: ENTRY.slug,
        runUrl: "https://agents.suedeai.ai/api/agents/po-match-gate-mkgu0/run",
        a2aUrl: "https://agents.suedeai.ai/api/agents/po-match-gate-mkgu0/a2a/message:send",
      })],
    });

    const agentResponse = await agentDiscovery.GET(new Request("https://agents.suedeai.ai"), {
      params: Promise.resolve({ agent: ENTRY.id }),
    });
    const agent = await agentResponse.json();
    expect(agentResponse.status).toBe(200);
    expect(agent).toMatchObject({
      role: "merchant",
      runUrl: "https://agents.suedeai.ai/api/agents/po-match-gate-mkgu0/run",
      a2aUrl: "https://agents.suedeai.ai/api/agents/po-match-gate-mkgu0/a2a/message:send",
      settlement: {
        rail: "x402-v2",
        scheme: "exact",
        network: "eip155:8453",
      },
      receipts: {
        merchant: "signed Checkout Receipt",
        payment: "provided by the credential/payment processor, not Agent Studio",
      },
    });

    const jwksResponse = await jwksDiscovery.GET();
    const jwks = await jwksResponse.json() as { keys: Array<Record<string, unknown>> };
    expect(jwksResponse.status).toBe(200);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      kid: "merchant-test-key",
      use: "sig",
    });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});
