import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FlowRepo } from "@/lib/db/repo";

import {
  deriveMerchantJwks,
  loadAp2RuntimeConfig,
  verifyMerchantCheckoutQuote,
  type Ap2RuntimeConfig,
} from "@/lib/rails/ap2";
import {
  expectedAp2X402Nonce,
  ap2X402PaymentInstrumentId,
  hashAp2PaymentNonce,
  issueAp2Checkout,
  loadAp2RunConfig,
  type Ap2RunTerms,
} from "@/lib/rails/ap2-runtime";

let runtime: Ap2RuntimeConfig;
let readyEnv: Readonly<Record<string, string>>;

const terms: Ap2RunTerms = {
  agentId: "agent-1",
  agentSlug: "invoice-check",
  flowId: "flow-1",
  live: {
    ownerId: "owner-1",
    flowId: "flow-1",
    deploymentId: "deployment-1",
    environmentId: "environment-live",
    flowVersionId: "version-1",
    semanticHash: "a".repeat(64),
    fullHash: "b".repeat(64),
  },
  resource: "https://agents.suedeai.ai/api/agents/invoice-check/run",
  input: { invoiceId: "inv-1" },
  priceUsdc: 0.25,
  payTo: "0x1111111111111111111111111111111111111111",
  siteOrigin: "https://agents.suedeai.ai",
};

beforeAll(async () => {
  const merchant = await generateKeyPair("ES256", { extractable: true });
  const merchantJwk = {
    ...(await exportJWK(merchant.privateKey)),
    alg: "ES256",
    kid: "merchant-key",
    use: "sig",
  };
  const trusted = await generateKeyPair("ES256", { extractable: true });
  const trustedJwk = {
    ...(await exportJWK(trusted.publicKey)),
    alg: "ES256",
    kid: "wallet-key",
    use: "sig",
  };
  readyEnv = {
    AP2_MODE: "optional",
    AP2_MERCHANT_ISSUER: "https://agents.suedeai.ai",
    AP2_MERCHANT_SIGNING_JWK: JSON.stringify(merchantJwk),
    AP2_TRUSTED_ISSUERS_JSON: JSON.stringify({
      issuers: [{
        issuer: "https://wallet.example",
        algorithms: ["ES256"],
        keys: [trustedJwk],
      }],
    }),
  };
  runtime = await loadAp2RuntimeConfig({
    replayStoreReady: true,
    env: readyEnv,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AP2 run binding", () => {
  it("binds the generated server challenge into the verified merchant quote", async () => {
    const checkout = await issueAp2Checkout({
      runtime,
      terms,
      issuedAt: 1_787_000_000,
    });
    const quote = await verifyMerchantCheckoutQuote({
      checkoutJwt: checkout.checkoutJwt,
      publicJwks: await deriveMerchantJwks(runtime.signing!),
      issuer: runtime.signing!.issuer,
      now: 1_787_000_001,
    });

    expect(quote.checkoutHash).toBe(checkout.checkoutHash);
    expect(quote.binding).toMatchObject({
      nonce: checkout.challengeNonce,
      agentId: terms.agentId,
      deploymentId: terms.live.deploymentId,
      requestDigest: checkout.binding.requestDigest,
      amountAtomic: "250000",
      amountMinorUsd: 25,
    });
  });

  it("refuses a price that cannot be represented exactly in USD minor units", async () => {
    await expect(issueAp2Checkout({
      runtime,
      terms: { ...terms, priceUsdc: 0.001 },
    })).rejects.toMatchObject({ code: "invalid_mandate" });
  });

  it("requires the operator's durable-store readiness assertion on the run path", async () => {
    for (const [name, value] of Object.entries(readyEnv)) vi.stubEnv(name, value);
    const repo = {
      reserveAp2Authorization: vi.fn(),
      getAp2AuthorizationByMandateReference: vi.fn(),
      transitionAp2Authorization: vi.fn(),
      checkAp2ReplayStoreReady: vi.fn(async () => true),
    } as unknown as FlowRepo;

    vi.stubEnv("AP2_REPLAY_STORE_READY", "");
    await expect(loadAp2RunConfig(repo)).resolves.toMatchObject({
      readiness: { ready: false, reason: "replay_store_unavailable" },
    });

    vi.stubEnv("AP2_REPLAY_STORE_READY", "1");
    await expect(loadAp2RunConfig(repo)).resolves.toMatchObject({
      readiness: { ready: true, advertise: true },
    });
    expect(repo.checkAp2ReplayStoreReady).toHaveBeenCalledOnce();

    vi.mocked(repo.checkAp2ReplayStoreReady).mockResolvedValue(false);
    await expect(loadAp2RunConfig(repo)).resolves.toMatchObject({
      readiness: { ready: false, reason: "replay_store_unavailable" },
    });
  });

  it("domain-separates the x402 nonce and local replay identity", () => {
    const first = expectedAp2X402Nonce("payment-ref", "checkout-hash");
    expect(first).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(expectedAp2X402Nonce("payment-ref-2", "checkout-hash")).not.toBe(first);
    expect(hashAp2PaymentNonce({
      network: "eip155:8453",
      asset: "0xAsset",
      payer: "0xPayer",
      nonce: first,
    })).not.toBe(hashAp2PaymentNonce({
      network: "eip155:8453",
      asset: "0xAsset",
      payer: "0xPayer2",
      nonce: first,
    }));
    expect(ap2X402PaymentInstrumentId(
      "eip155:8453",
      "0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
    )).toBe("eip155:8453:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
