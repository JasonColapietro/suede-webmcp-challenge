import { createHash } from "node:crypto";

import {
  SignJWT,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AP2_CHECKOUT_MANDATE_DATA_KEY,
  AP2_CHECKOUT_RECEIPT_DATA_KEY,
  AP2_EXTENSION_URI,
  AP2_PAYMENT_MANDATE_DATA_KEY,
  AP2_SELLER_SUBPROFILE,
  Ap2ProtocolError,
  buildAp2RequestDigest,
  deriveMerchantJwks,
  finalMandateReference,
  finalMandateReplayIdentity,
  issueCheckoutReceipt,
  issueMerchantCheckoutJwt,
  loadAp2RuntimeConfig,
  parseSdJwtPresentation,
  parseTrustedIssuerRegistry,
  resolveAp2Mode,
  resolveAp2Readiness,
  rootSdJwtReference,
  sha256Base64Url,
  verifyAp2Authorization,
  verifyCheckoutReceipt,
  verifyMerchantCheckoutJwt,
  verifyMerchantCheckoutQuote,
  type Ap2ExpectedBinding,
  type Ap2MerchantSigningConfig,
  type Ap2TrustedIssuerRegistry,
} from "@/lib/rails/ap2";

const NOW = 1_787_000_000;
const MERCHANT_ISSUER = "https://agents.suedeai.ai";
const TRUSTED_ISSUER = "https://wallet.example";
const AUDIENCE = "https://agents.suedeai.ai/api/agents/agent_1/run";
const NONCE = "checkout_challenge_123";

interface SigningFixture {
  readonly privateKey: KeyLike;
  readonly publicJwk: JWK;
  readonly kid: string;
}

let merchantConfig: Ap2MerchantSigningConfig;
let merchantPublicJwk: JWK;
let merchantPrivateJwk: JWK;
let trustedSigner: SigningFixture;
let agentSigner: SigningFixture;
let registry: Ap2TrustedIssuerRegistry;

async function signingFixture(kid: string): Promise<SigningFixture> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      ...(await exportJWK(pair.publicKey)),
      alg: "ES256",
      kid,
      use: "sig",
    },
    kid,
  };
}

function trustedRegistryJson(signer: SigningFixture = trustedSigner): string {
  return JSON.stringify({
    issuers: [{
      issuer: TRUSTED_ISSUER,
      algorithms: ["ES256"],
      keys: [signer.publicJwk],
    }],
  });
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function disclosureDigest(disclosure: string): string {
  return createHash("sha256").update(disclosure, "ascii").digest("base64url");
}

async function signSdJwt(input: {
  readonly signer: SigningFixture;
  readonly issuer?: string;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly typ?: string;
  readonly disclosures?: readonly string[];
  readonly protectedHeader?: Readonly<Record<string, unknown>>;
  readonly includeKid?: boolean;
}): Promise<string> {
  let builder = new SignJWT({ ...input.claims })
    .setProtectedHeader({
      alg: "ES256",
      ...(input.includeKid === false ? {} : { kid: input.signer.kid }),
      ...(input.typ ? { typ: input.typ } : {}),
      ...input.protectedHeader,
    });
  if (input.issuer) builder = builder.setIssuer(input.issuer);
  const jwt = await builder.sign(input.signer.privateKey);
  return `${jwt}~${input.disclosures?.join("~") ?? ""}~`.replace(/~~$/u, "~");
}

function asChain(root: string, closed: string): string {
  return `${root.replace(/~$/u, "")}~~${closed}`;
}

function chainBinding(root: string): string {
  const canonical = root.endsWith("~") ? root : `${root}~`;
  return sha256Base64Url(canonical);
}

function baseBinding(checkoutJwt: string, checkoutHash: string): Ap2ExpectedBinding {
  return {
    audience: AUDIENCE,
    nonce: NONCE,
    checkoutJwt,
    checkoutHash,
    agentId: "agent_1",
    agentSlug: "invoice-chaser",
    flowId: "flow_1",
    deploymentId: "deployment_1",
    flowVersionId: "flow_version_1",
    fullHash: "a".repeat(64),
    resource: AUDIENCE,
    method: "POST",
    requestDigest: buildAp2RequestDigest({
      method: "POST",
      resource: AUDIENCE,
      body: { input: { invoiceId: "inv_1", urgency: "high" } },
    }),
    priceUsdc: 0.25,
    amountAtomic: "250000",
    amountMinorUsd: 25,
    payee: {
      id: "suede-agent-studio",
      name: "Suede Agent Studio",
      website: "https://agents.suedeai.ai",
    },
    payTo: "0xb5a05466712fd5bcdf2883f43cC6B1799428032d",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    scheme: "exact",
  };
}

function closedCheckoutMandate(binding: Ap2ExpectedBinding): Record<string, unknown> {
  return {
    vct: "mandate.checkout.1",
    checkout_jwt: binding.checkoutJwt,
    checkout_hash: binding.checkoutHash,
    iat: NOW,
    exp: NOW + 300,
  };
}

function closedPaymentMandate(binding: Ap2ExpectedBinding): Record<string, unknown> {
  return {
    vct: "mandate.payment.1",
    transaction_id: binding.checkoutHash,
    payee: binding.payee,
    payment_amount: { amount: binding.amountMinorUsd, currency: "USD" },
    payment_instrument: {
      id: "wallet_base_usdc_1",
      type: "x402",
      description: "Base USDC wallet",
    },
    iat: NOW,
    exp: NOW + 300,
  };
}

async function directPresentation(
  mandate: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return signSdJwt({
    signer: trustedSigner,
    issuer: TRUSTED_ISSUER,
    claims: {
      ...mandate,
      aud: AUDIENCE,
      nonce: NONCE,
      iat: NOW,
      exp: NOW + 300,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  const merchantPair = await generateKeyPair("ES256", { extractable: true });
  merchantPublicJwk = {
    ...(await exportJWK(merchantPair.publicKey)),
    alg: "ES256",
    kid: "merchant-2026-08",
    use: "sig",
  };
  merchantPrivateJwk = {
    ...(await exportJWK(merchantPair.privateKey)),
    alg: "ES256",
    kid: "merchant-2026-08",
    use: "sig",
  };
  merchantConfig = {
    issuer: MERCHANT_ISSUER,
    keyId: "merchant-2026-08",
    privateKeyPem: await exportPKCS8(merchantPair.privateKey),
  };
  trustedSigner = await signingFixture("wallet-key-1");
  agentSigner = await signingFixture("agent-key-1");
  registry = parseTrustedIssuerRegistry(trustedRegistryJson());
});

describe("AP2 configuration and constants", () => {
  it("exports the accepted extension and canonical sample data keys", () => {
    expect(AP2_EXTENSION_URI).toBe("https://github.com/google-agentic-commerce/ap2/v1");
    expect(AP2_CHECKOUT_MANDATE_DATA_KEY).toBe("ap2.mandates.CheckoutMandateSdJwt");
    expect(AP2_PAYMENT_MANDATE_DATA_KEY).toBe("ap2.mandates.PaymentMandateSdJwt");
    expect(AP2_CHECKOUT_RECEIPT_DATA_KEY).toBe("ap2.CheckoutReceipt");
  });

  it("publishes the exact bounded compatibility profile enforced by the verifier", () => {
    expect(AP2_SELLER_SUBPROFILE).toMatchObject({
      rootTrustResolution: "pinned-exact-or-unique-compatible-key",
      acceptedSdAlgorithms: ["sha-256"],
      delegatedKey: {
        kty: "EC",
        crv: "P-256",
        alg: "ES256",
        kidMember: "optional",
        algMember: "optional",
      },
      autonomousRootRequiredClaims: ["iat", "exp"],
      openPaymentPresetClaims: [
        "payee",
        "payment_amount",
        "payment_instrument",
        "pisp",
        "execution_date",
        "risk_data",
      ],
      openPaymentPresetRule: "exact-match-closed",
      unknownConstraints: "rejected",
      receiptReferenceRule: "sd-hash-final-sd-jwt",
    });
  });

  it("accepts only exact off, optional, and required mode values", () => {
    expect(resolveAp2Mode("off")).toBe("off");
    expect(resolveAp2Mode("optional")).toBe("optional");
    expect(resolveAp2Mode("required")).toBe("required");
    for (const value of [undefined, "", "OPTIONAL", " optional", "required\n", "on"]) {
      expect(resolveAp2Mode(value)).toBe("off");
    }
  });

  it("advertises optional or required mode only with signing, trust, and replay readiness", async () => {
    const ready = await resolveAp2Readiness({
      modeValue: "required",
      merchantSigning: merchantConfig,
      trustedIssuersJson: trustedRegistryJson(),
      replayStoreReady: true,
    });
    expect(ready).toMatchObject({
      mode: "required",
      ready: true,
      advertise: true,
      requireAuthorization: true,
      reasons: [],
    });

    const notReady = await resolveAp2Readiness({
      modeValue: "optional",
      merchantSigning: merchantConfig,
      trustedIssuersJson: trustedRegistryJson(),
      replayStoreReady: false,
    });
    expect(notReady.ready).toBe(false);
    expect(notReady.advertise).toBe(false);
    expect(notReady.reasons).toContain("replay_store_unavailable");
  });

  it("rejects registry entries that are symmetric, URL-resolved, or duplicate", () => {
    const symmetric = JSON.stringify({
      issuers: [{
        issuer: TRUSTED_ISSUER,
        algorithms: ["HS256"],
        keys: [{ kty: "oct", k: "c2VjcmV0", kid: "bad", alg: "HS256" }],
      }],
    });
    expect(() => parseTrustedIssuerRegistry(symmetric)).toThrow(Ap2ProtocolError);

    const remote = JSON.stringify({
      issuers: [{
        issuer: TRUSTED_ISSUER,
        algorithms: ["ES256"],
        jwksUrl: "https://attacker.example/jwks.json",
        keys: [trustedSigner.publicJwk],
      }],
    });
    expect(() => parseTrustedIssuerRegistry(remote)).toThrow(Ap2ProtocolError);

    const duplicate = JSON.stringify({
      issuers: [
        JSON.parse(trustedRegistryJson()).issuers[0],
        JSON.parse(trustedRegistryJson()).issuers[0],
      ],
    });
    expect(() => parseTrustedIssuerRegistry(duplicate)).toThrow(Ap2ProtocolError);
  });

  it("loads usable runtime trust while keeping the signing key out of serialization", async () => {
    const runtime = await loadAp2RuntimeConfig({
      replayStoreReady: true,
      env: {
        AP2_MODE: "optional",
        AP2_MERCHANT_ISSUER: MERCHANT_ISSUER,
        AP2_MERCHANT_SIGNING_JWK: JSON.stringify(merchantPrivateJwk),
        AP2_TRUSTED_ISSUERS_JSON: trustedRegistryJson(),
      },
    });
    expect(runtime.readiness).toMatchObject({ ready: true, advertise: true });
    expect(runtime.signing).toMatchObject({
      issuer: MERCHANT_ISSUER,
      keyId: "merchant-2026-08",
    });
    expect(runtime.trustedIssuers?.byIssuer.has(TRUSTED_ISSUER)).toBe(true);
    expect(JSON.stringify(runtime)).not.toContain(String(merchantPrivateJwk.d));
    expect(Object.keys(runtime)).not.toContain("signing");
  });

  it("fails closed for unsafe or unbounded retired merchant key rings", async () => {
    const retiredBase = {
      ...merchantPublicJwk,
      kid: "retired-key-1",
    };
    const cases: readonly unknown[] = [
      { keys: [{ ...retiredBase, d: String(merchantPrivateJwk.d) }] },
      { keys: [{ ...retiredBase, kid: merchantConfig.keyId }] },
      { keys: [retiredBase, { ...retiredBase }] },
      { keys: [{ ...retiredBase, alg: "RS256" }] },
      { keys: [{ ...retiredBase, x5u: "https://attacker.example/key.pem" }] },
      {
        keys: Array.from({ length: 9 }, (_, index) => ({
          ...retiredBase,
          kid: `retired-key-${index}`,
        })),
      },
    ];

    for (const retiredRing of cases) {
      const runtime = await loadAp2RuntimeConfig({
        replayStoreReady: true,
        env: {
          AP2_MODE: "optional",
          AP2_MERCHANT_ISSUER: MERCHANT_ISSUER,
          AP2_MERCHANT_SIGNING_JWK: JSON.stringify(merchantPrivateJwk),
          AP2_MERCHANT_RETIRED_JWKS_JSON: JSON.stringify(retiredRing),
          AP2_TRUSTED_ISSUERS_JSON: trustedRegistryJson(),
        },
      });
      expect(runtime.readiness).toMatchObject({ ready: false, advertise: false });
      expect(runtime.signing).toBeUndefined();
    }
  });
});

describe("merchant checkout JWT", () => {
  it("issues a short-lived ES256 checkout JWT and derives a public-only JWKS", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const verified = await verifyMerchantCheckoutJwt({
      checkoutJwt: issued.checkoutJwt,
      publicJwks: await deriveMerchantJwks(merchantConfig),
      expected,
      issuer: MERCHANT_ISSUER,
      now: NOW + 1,
    });
    const quote = await verifyMerchantCheckoutQuote({
      checkoutJwt: issued.checkoutJwt,
      publicJwks: await deriveMerchantJwks(merchantConfig),
      issuer: MERCHANT_ISSUER,
      now: NOW + 1,
    });

    expect(issued.checkoutHash).toBe(sha256Base64Url(issued.checkoutJwt));
    expect(issued.expiresAt).toBe(NOW + 300);
    expect(verified.binding).toEqual(expect.objectContaining({
      nonce: NONCE,
      agentId: "agent_1",
      deploymentId: "deployment_1",
      requestDigest: unsigned.requestDigest,
      amountAtomic: "250000",
    }));
    expect(quote).toMatchObject({
      audience: AUDIENCE,
      checkoutHash: issued.checkoutHash,
      expiresAt: NOW + 300,
      binding: { nonce: NONCE, resource: AUDIENCE },
    });
    const jwks = await deriveMerchantJwks(merchantConfig);
    expect(jwks.keys).toEqual([expect.objectContaining({
      alg: "ES256",
      crv: "P-256",
      kid: "merchant-2026-08",
      kty: "EC",
      use: "sig",
    })]);
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("rejects a valid merchant signature when any expected service binding changes", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = {
      ...baseBinding(issued.checkoutJwt, issued.checkoutHash),
      amountAtomic: "250001",
    };
    await expect(verifyMerchantCheckoutJwt({
      checkoutJwt: issued.checkoutJwt,
      publicJwks: { keys: [merchantPublicJwk] },
      expected,
      issuer: MERCHANT_ISSUER,
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid_mandate" });
    await expect(verifyMerchantCheckoutJwt({
      checkoutJwt: issued.checkoutJwt,
      publicJwks: { keys: [merchantPublicJwk] },
      expected: {
        ...baseBinding(issued.checkoutJwt, issued.checkoutHash),
        nonce: "attacker-selected-nonce",
      },
      issuer: MERCHANT_ISSUER,
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid_mandate" });
  });
});

describe("bounded SD-JWT parsing", () => {
  it("resolves a disclosed mandate field only when its digest is signed", async () => {
    const disclosure = b64url(["0123456789abcdef", "vct", "mandate.checkout.1"]);
    const token = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      disclosures: [disclosure],
      claims: {
        _sd_alg: "sha-256",
        _sd: [disclosureDigest(disclosure)],
        checkout_jwt: "merchant.jwt.value",
        checkout_hash: "checkout-hash",
        aud: AUDIENCE,
        nonce: NONCE,
        iat: NOW,
        exp: NOW + 300,
      },
    });
    const parsed = parseSdJwtPresentation(token);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.effectivePayload.vct).toBe("mandate.checkout.1");
  });

  it("rejects unreferenced disclosures, excessive chains, and oversized input", async () => {
    const disclosure = b64url(["0123456789abcdef", "vct", "mandate.checkout.1"]);
    const unreferenced = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      disclosures: [disclosure],
      claims: { _sd_alg: "sha-256", _sd: [], iat: NOW, exp: NOW + 300 },
    });
    expect(() => parseSdJwtPresentation(unreferenced)).toThrow(Ap2ProtocolError);
    expect(() => parseSdJwtPresentation("a~~b~~c")).toThrow(Ap2ProtocolError);
    expect(() => parseSdJwtPresentation("x".repeat(65_537))).toThrow(Ap2ProtocolError);
  });

  it("keeps undisclosed object claims and array elements hidden", async () => {
    const revealed = b64url(["0123456789abcdef", "vct", "mandate.checkout.1"]);
    const hiddenObject = b64url(["fedcba9876543210", "private_note", "do not reveal"]);
    const hiddenArray = b64url(["0011223344556677", { id: "hidden-item" }]);
    const token = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      disclosures: [revealed],
      claims: {
        _sd_alg: "sha-256",
        _sd: [disclosureDigest(revealed), disclosureDigest(hiddenObject)],
        items: [{ "...": disclosureDigest(hiddenArray) }],
        iat: NOW,
        exp: NOW + 300,
      },
    });

    const payload = parseSdJwtPresentation(token).segments[0]?.effectivePayload;
    expect(payload).toMatchObject({ vct: "mandate.checkout.1", items: [] });
    expect(payload).not.toHaveProperty("private_note");
  });

  it("restores the canonical trailing separator for a disclosed autonomous root", async () => {
    const disclosure = b64url(["0123456789abcdef", "purpose", "purchase"]);
    const root = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      disclosures: [disclosure],
      claims: {
        _sd_alg: "sha-256",
        _sd: [disclosureDigest(disclosure)],
        iat: NOW,
        exp: NOW + 300,
      },
    });
    const closed = await directPresentation(closedCheckoutMandate(baseBinding("jwt", "hash")));
    const parsed = parseSdJwtPresentation(asChain(root, closed));

    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]?.canonicalSdJwt).toBe(root);
    expect(parsed.segments[0]?.effectivePayload.purpose).toBe("purchase");
  });

  it("uses the root SD-JWT algorithm for the canonical open-mandate reference", async () => {
    const root = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      claims: { _sd_alg: "sha-384", iat: NOW, exp: NOW + 300 },
    });

    expect(rootSdJwtReference(root)).toBe(
      createHash("sha384").update(root, "ascii").digest("base64url"),
    );
  });

  it("can hash an open Checkout with the containing Payment root algorithm", async () => {
    const root = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      claims: { _sd_alg: "sha-256", iat: NOW, exp: NOW + 300 },
    });

    expect(rootSdJwtReference(root, "sha-384")).toBe(
      createHash("sha384").update(root, "ascii").digest("base64url"),
    );
  });

  it("hashes the final SD-JWT including disclosures with its _sd_alg", async () => {
    const disclosure = b64url(["0123456789abcdef", "purpose", "purchase"]);
    const closed = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      disclosures: [disclosure],
      claims: {
        _sd_alg: "sha-384",
        _sd: [createHash("sha384").update(disclosure, "ascii").digest("base64url")],
        iat: NOW,
        exp: NOW + 300,
      },
    });

    expect(finalMandateReference(closed)).toBe(
      createHash("sha384").update(closed, "ascii").digest("base64url"),
    );
  });

  it("keeps issuer-JWT replay identity stable across disclosure presentations", async () => {
    const disclosure = b64url(["0123456789abcdef", "purpose", "purchase"]);
    const disclosed = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      disclosures: [disclosure],
      claims: {
        _sd_alg: "sha-256",
        _sd: [disclosureDigest(disclosure)],
        iat: NOW,
        exp: NOW + 300,
      },
    });
    const issuerJwt = disclosed.split("~", 1)[0] ?? "";
    const hidden = `${issuerJwt}~`;
    expect(finalMandateReplayIdentity(disclosed)).toBe(sha256Base64Url(issuerJwt));
    expect(finalMandateReplayIdentity(hidden)).toBe(finalMandateReplayIdentity(disclosed));
    expect(finalMandateReference(hidden)).not.toBe(finalMandateReference(disclosed));
  });
});

describe("canonical request binding", () => {
  it("is stable across object key order and changes when the request body changes", () => {
    const first = buildAp2RequestDigest({
      method: "POST",
      resource: AUDIENCE,
      body: { z: 1, nested: { b: true, a: "same" } },
    });
    const reordered = buildAp2RequestDigest({
      method: "POST",
      resource: AUDIENCE,
      body: { nested: { a: "same", b: true }, z: 1 },
    });
    const changed = buildAp2RequestDigest({
      method: "POST",
      resource: AUDIENCE,
      body: { nested: { a: "changed", b: true }, z: 1 },
    });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe("direct AP2 authorization", () => {
  it("verifies exact checkout and payment bindings and returns only sanitized identities", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const checkoutPresentation = await directPresentation(closedCheckoutMandate(expected));
    const paymentPresentation = await directPresentation(closedPaymentMandate(expected));

    const result = await verifyAp2Authorization({
      authorizationMode: "direct",
      checkoutPresentation,
      paymentPresentation,
      expected,
      trustedIssuers: registry,
      now: NOW + 1,
    });

    expect(result).toEqual({
      mode: "direct",
      checkoutReference: sha256Base64Url(checkoutPresentation),
      paymentReference: sha256Base64Url(paymentPresentation),
      paymentReplayIdentity: sha256Base64Url(paymentPresentation.split("~", 1)[0] ?? ""),
      issuer: TRUSTED_ISSUER,
      paymentInstrumentId: "wallet_base_usdc_1",
    });
    expect(JSON.stringify(result)).not.toContain(checkoutPresentation);
    expect(JSON.stringify(result)).not.toContain(paymentPresentation);
  });

  it("rejects non-SHA-256 mandate algorithms under the advertised seller profile", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const checkoutPresentation = await directPresentation(
      closedCheckoutMandate(expected),
      { _sd_alg: "sha-384" },
    );
    const paymentPresentation = await directPresentation(closedPaymentMandate(expected));

    await expect(verifyAp2Authorization({
      authorizationMode: "direct",
      checkoutPresentation,
      paymentPresentation,
      expected,
      trustedIssuers: registry,
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid_credential" });
  });

  it("resolves official-form roots without iss or kid from one pinned compatible key", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const rootClaims = {
      aud: AUDIENCE,
      nonce: NONCE,
      iat: NOW,
      exp: NOW + 300,
    };
    const checkoutPresentation = await signSdJwt({
      signer: trustedSigner,
      includeKid: false,
      claims: { ...closedCheckoutMandate(expected), ...rootClaims },
    });
    const paymentPresentation = await signSdJwt({
      signer: trustedSigner,
      includeKid: false,
      claims: { ...closedPaymentMandate(expected), ...rootClaims },
    });

    await expect(verifyAp2Authorization({
      authorizationMode: "direct",
      checkoutPresentation,
      paymentPresentation,
      expected,
      trustedIssuers: registry,
      now: NOW,
    })).resolves.toMatchObject({ issuer: TRUSTED_ISSUER });
  });

  it("rejects a root without iss or kid when pinned trust resolution is ambiguous", async () => {
    const secondSigner = await signingFixture("wallet-key-2");
    const ambiguousRegistry = parseTrustedIssuerRegistry(JSON.stringify({
      issuers: [{
        issuer: TRUSTED_ISSUER,
        algorithms: ["ES256"],
        keys: [trustedSigner.publicJwk],
      }, {
        issuer: "https://second-wallet.example",
        algorithms: ["ES256"],
        keys: [secondSigner.publicJwk],
      }],
    }));
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const rootClaims = { aud: AUDIENCE, nonce: NONCE, iat: NOW, exp: NOW + 300 };
    const checkoutPresentation = await signSdJwt({
      signer: trustedSigner,
      includeKid: false,
      claims: { ...closedCheckoutMandate(expected), ...rootClaims },
    });
    const paymentPresentation = await signSdJwt({
      signer: trustedSigner,
      includeKid: false,
      claims: { ...closedPaymentMandate(expected), ...rootClaims },
    });

    await expect(verifyAp2Authorization({
      authorizationMode: "direct",
      checkoutPresentation,
      paymentPresentation,
      expected,
      trustedIssuers: ambiguousRegistry,
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid_credential" });
  });

  it("fails closed for wrong nonce, time, checkout, and attacker-controlled key URLs", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const validPayment = await directPresentation(closedPaymentMandate(expected));
    const cases = [
      await directPresentation(closedCheckoutMandate(expected), { nonce: "wrong" }),
      await directPresentation(closedCheckoutMandate(expected), { exp: NOW - 1 }),
      await directPresentation({ ...closedCheckoutMandate(expected), checkout_hash: "wrong" }),
      await signSdJwt({
        signer: trustedSigner,
        issuer: TRUSTED_ISSUER,
        claims: {
          ...closedCheckoutMandate(expected),
          aud: AUDIENCE,
          nonce: NONCE,
          iat: NOW,
          exp: NOW + 300,
        },
        protectedHeader: { jku: "https://attacker.example/jwks.json" },
      }),
    ];
    for (const checkoutPresentation of cases) {
      await expect(verifyAp2Authorization({
        authorizationMode: "direct",
        checkoutPresentation,
        paymentPresentation: validPayment,
        expected,
        trustedIssuers: registry,
        now: NOW + 1,
        clockSkewSeconds: 0,
      })).rejects.toBeInstanceOf(Ap2ProtocolError);
    }
  });
});

describe("one-hop autonomous AP2 authorization", () => {
  async function autonomousPresentations(
    expected: Ap2ExpectedBinding,
    paymentConstraints?: readonly Record<string, unknown>[],
    options: {
      readonly officialCnf?: boolean;
      readonly delegatedJwkMetadata?: Readonly<Record<string, unknown>>;
      readonly openPaymentPreset?: Readonly<Record<string, unknown>>;
      readonly closedPaymentOverrides?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<{ checkoutPresentation: string; paymentPresentation: string }> {
    const delegatedJwk: JWK = options.officialCnf
      ? {
          kty: agentSigner.publicJwk.kty,
          crv: agentSigner.publicJwk.crv,
          x: agentSigner.publicJwk.x,
          y: agentSigner.publicJwk.y,
          ...options.delegatedJwkMetadata,
        }
      : agentSigner.publicJwk;
    const openCheckout = {
      vct: "mandate.checkout.open.1",
      cnf: { jwk: delegatedJwk },
      constraints: [{
        type: "checkout.allowed_merchants",
        allowed: [expected.payee],
      }, {
        type: "checkout.line_items",
        items: [{
          id: "service-choice",
          acceptable_items: [{ id: expected.agentId, title: expected.agentSlug }],
          quantity: 1,
        }],
      }],
      iat: NOW - 60,
      exp: NOW + 600,
    };
    const openCheckoutRoot = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      claims: { delegate_payload: [openCheckout], _sd_alg: "sha-256" },
    });
    const openCheckoutReference = chainBinding(openCheckoutRoot);
    const closedCheckout = await signSdJwt({
      signer: agentSigner,
      issuer: "agent:agent_1",
      typ: "kb+sd-jwt",
      includeKid: !options.officialCnf,
      claims: {
        delegate_payload: [closedCheckoutMandate(expected)],
        aud: AUDIENCE,
        nonce: NONCE,
        iat: NOW,
        exp: NOW + 300,
        sd_hash: chainBinding(openCheckoutRoot),
      },
    });

    const openPayment = {
      vct: "mandate.payment.open.1",
      cnf: { jwk: delegatedJwk },
      constraints: paymentConstraints ?? [{
        type: "payment.allowed_payees",
        allowed: [expected.payee],
      }, {
        type: "payment.allowed_payment_instruments",
        allowed: [{ id: "wallet_base_usdc_1", type: "x402" }],
      }, {
        type: "payment.amount_range",
        min: expected.amountMinorUsd,
        max: expected.amountMinorUsd,
        currency: "USD",
      }, {
        type: "payment.reference",
        conditional_transaction_id: openCheckoutReference,
      }],
      iat: NOW - 60,
      exp: NOW + 600,
      ...options.openPaymentPreset,
    };
    const openPaymentRoot = await signSdJwt({
      signer: trustedSigner,
      issuer: TRUSTED_ISSUER,
      claims: { delegate_payload: [openPayment], _sd_alg: "sha-256" },
    });
    const closedPayment = await signSdJwt({
      signer: agentSigner,
      issuer: "agent:agent_1",
      typ: "kb+sd-jwt",
      includeKid: !options.officialCnf,
      claims: {
        delegate_payload: [{
          ...closedPaymentMandate(expected),
          ...options.closedPaymentOverrides,
        }],
        aud: AUDIENCE,
        nonce: NONCE,
        iat: NOW,
        exp: NOW + 300,
        issuer_jwt_hash: sha256Base64Url(openPaymentRoot.split("~", 1)[0] ?? ""),
      },
    });
    return {
      checkoutPresentation: asChain(openCheckoutRoot, closedCheckout),
      paymentPresentation: asChain(openPaymentRoot, closedPayment),
    };
  }

  it("verifies exactly one trusted open to agent-bound closed hop", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const presentations = await autonomousPresentations(expected);
    const result = await verifyAp2Authorization({
      authorizationMode: "autonomous",
      ...presentations,
      expected,
      trustedIssuers: registry,
      now: NOW,
    });
    expect(result).toMatchObject({
      mode: "autonomous",
      issuer: TRUSTED_ISSUER,
      paymentInstrumentId: "wallet_base_usdc_1",
    });
  });

  it("accepts the official P-256 cnf JWK form without kid or alg", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const presentations = await autonomousPresentations(expected, undefined, {
      officialCnf: true,
    });

    await expect(verifyAp2Authorization({
      authorizationMode: "autonomous",
      ...presentations,
      expected,
      trustedIssuers: registry,
      now: NOW,
    })).resolves.toMatchObject({ mode: "autonomous", issuer: TRUSTED_ISSUER });
  });

  it("accepts bounded verification-only metadata on the official P-256 cnf JWK", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const presentations = await autonomousPresentations(expected, undefined, {
      officialCnf: true,
      delegatedJwkMetadata: {
        use: "sig",
        key_ops: ["verify"],
        x5t: "Y2Fub25pY2FsLXRodW1icHJpbnQ",
        "x5t#S256": "Y2Fub25pY2FsLXNoYTI1Ni10aHVtYnByaW50",
      },
    });

    await expect(verifyAp2Authorization({
      authorizationMode: "autonomous",
      ...presentations,
      expected,
      trustedIssuers: registry,
      now: NOW,
    })).resolves.toMatchObject({ mode: "autonomous", issuer: TRUSTED_ISSUER });
  });

  it("accepts canonical preset fields on an open Payment Mandate", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const preset = {
      payee: expected.payee,
      payment_amount: { amount: expected.amountMinorUsd, currency: "USD" },
      payment_instrument: {
        id: "wallet_base_usdc_1",
        type: "x402",
        description: "Base USDC wallet",
      },
      pisp: {
        legal_name: "Example Payments LLC",
        brand_name: "Example Pay",
        domain_name: "pay.example",
      },
      execution_date: "2026-08-14T12:00:00Z",
      risk_data: { trusted_surface: "wallet.example", score: 7 },
    };
    const presentations = await autonomousPresentations(expected, undefined, {
      openPaymentPreset: preset,
      closedPaymentOverrides: preset,
    });

    await expect(verifyAp2Authorization({
      authorizationMode: "autonomous",
      ...presentations,
      expected,
      trustedIssuers: registry,
      now: NOW,
    })).resolves.toMatchObject({ mode: "autonomous", issuer: TRUSTED_ISSUER });
  });

  it("rejects every preset open Payment field that differs from the closed mandate", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    const closedPreset = {
      payee: expected.payee,
      payment_amount: { amount: expected.amountMinorUsd, currency: "USD" },
      payment_instrument: {
        id: "wallet_base_usdc_1",
        type: "x402",
        description: "Base USDC wallet",
      },
      pisp: {
        legal_name: "Example Payments LLC",
        brand_name: "Example Pay",
        domain_name: "pay.example",
      },
      execution_date: "2026-08-14T12:00:00Z",
      risk_data: { trusted_surface: "wallet.example", score: 7 },
    };
    const mismatches = [{
      payee: { ...expected.payee, name: "Different Merchant" },
    }, {
      payment_amount: { amount: expected.amountMinorUsd + 1, currency: "USD" },
    }, {
      payment_instrument: { ...closedPreset.payment_instrument, id: "different-wallet" },
    }, {
      pisp: { ...closedPreset.pisp, brand_name: "Different PISP" },
    }, {
      execution_date: "2026-08-15T12:00:00Z",
    }, {
      risk_data: { trusted_surface: "wallet.example", score: 8 },
    }];

    for (const mismatch of mismatches) {
      const presentations = await autonomousPresentations(expected, undefined, {
        openPaymentPreset: { ...closedPreset, ...mismatch },
        closedPaymentOverrides: closedPreset,
      });
      await expect(verifyAp2Authorization({
        authorizationMode: "autonomous",
        ...presentations,
        expected,
        trustedIssuers: registry,
        now: NOW,
      })).rejects.toMatchObject({ code: "invalid_mandate" });
    }
  });

  it("rejects stateful and unknown constraints as unresolved", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    for (const constraint of [
      { type: "payment.budget", max: 100, currency: "USD" },
      { type: "payment.agent_recurrence", frequency: "DAILY" },
      { type: "example.attacker.constraint", allow: true },
    ]) {
      const presentations = await autonomousPresentations(expected, [
        constraint,
        {
          type: "payment.reference",
          conditional_transaction_id: "placeholder",
        },
      ]);
      await expect(verifyAp2Authorization({
        authorizationMode: "autonomous",
        ...presentations,
        expected,
        trustedIssuers: registry,
        now: NOW,
      })).rejects.toMatchObject({ code: "unresolved_constraint" });
    }
  });

  it("rejects malformed and reversed payment execution windows", async () => {
    const unsigned = baseBinding("pending", "pending");
    const issued = await issueMerchantCheckoutJwt({
      signing: merchantConfig,
      binding: unsigned,
      issuedAt: NOW,
      expiresInSeconds: 300,
    });
    const expected = baseBinding(issued.checkoutJwt, issued.checkoutHash);
    for (const window of [
      { not_before: "not-a-date" },
      { not_after: "not-a-date" },
      { not_before: "2026-08-14T00:00:00Z", not_after: "2026-08-13T00:00:00Z" },
    ]) {
      const presentations = await autonomousPresentations(expected, [{
        type: "payment.execution_date",
        ...window,
      }, {
        type: "payment.reference",
        conditional_transaction_id: "placeholder",
      }]);
      await expect(verifyAp2Authorization({
        authorizationMode: "autonomous",
        ...presentations,
        expected,
        trustedIssuers: registry,
        now: NOW,
      })).rejects.toMatchObject({ code: "invalid_mandate" });
    }
  });
});

describe("signed Checkout Receipts", () => {
  it("issues independently verifiable success and error receipts bound to the mandate", async () => {
    const success = await issueCheckoutReceipt({
      signing: merchantConfig,
      reference: "closed-mandate-reference",
      status: "Success",
      orderId: "run_123",
      issuedAt: NOW,
    });
    const failure = await issueCheckoutReceipt({
      signing: merchantConfig,
      reference: "closed-mandate-reference",
      status: "Error",
      error: "invalid_mandate",
      errorDescription: "Authorization did not match the checkout.",
      issuedAt: NOW,
    });
    const jwks = await deriveMerchantJwks(merchantConfig);
    await expect(verifyCheckoutReceipt({
      receiptJwt: success,
      publicJwks: jwks,
      issuer: MERCHANT_ISSUER,
    })).resolves.toMatchObject({
      status: "Success",
      reference: "closed-mandate-reference",
      order_id: "run_123",
    });
    await expect(verifyCheckoutReceipt({
      receiptJwt: failure,
      publicJwks: jwks,
      issuer: MERCHANT_ISSUER,
    })).resolves.toMatchObject({
      status: "Error",
      error: "invalid_mandate",
    });
  });

  it("verifies historical receipts after rotating to a new active signing key", async () => {
    const historicalReceipt = await issueCheckoutReceipt({
      signing: merchantConfig,
      reference: "historical-mandate-reference",
      status: "Success",
      orderId: "run_historical",
      issuedAt: NOW,
    });
    const nextPair = await generateKeyPair("ES256", { extractable: true });
    const nextPrivateJwk = {
      ...(await exportJWK(nextPair.privateKey)),
      alg: "ES256",
      kid: "merchant-2026-09",
      use: "sig",
    };
    const runtime = await loadAp2RuntimeConfig({
      replayStoreReady: true,
      env: {
        AP2_MODE: "optional",
        AP2_MERCHANT_ISSUER: MERCHANT_ISSUER,
        AP2_MERCHANT_SIGNING_JWK: JSON.stringify(nextPrivateJwk),
        AP2_MERCHANT_RETIRED_JWKS_JSON: JSON.stringify({
          keys: [merchantPublicJwk],
        }),
        AP2_TRUSTED_ISSUERS_JSON: trustedRegistryJson(),
      },
    });
    expect(runtime.readiness.ready).toBe(true);
    const jwks = await deriveMerchantJwks(runtime.signing!);
    expect(jwks.keys.map((key) => key.kid)).toEqual([
      "merchant-2026-09",
      "merchant-2026-08",
    ]);
    expect(jwks.keys.every((key) => !("d" in key))).toBe(true);

    await expect(verifyCheckoutReceipt({
      receiptJwt: historicalReceipt,
      publicJwks: jwks,
      issuer: MERCHANT_ISSUER,
    })).resolves.toMatchObject({ order_id: "run_historical" });

    const currentReceipt = await issueCheckoutReceipt({
      signing: runtime.signing!,
      reference: "current-mandate-reference",
      status: "Success",
      orderId: "run_current",
      issuedAt: NOW + 1,
    });
    expect(decodeProtectedHeader(currentReceipt).kid).toBe("merchant-2026-09");
  });
});
