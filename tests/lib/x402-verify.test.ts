import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodePaymentHeader,
  x402AuthorizationIdentity,
  verifyX402AuthorizationSignature,
  verifyAndSettle,
  usdcToAtomic,
  buildX402Accept,
  buildX402PaymentRequired,
  buildX402ResourceInfo,
  X402_RUN_OUTPUT_SCHEMA,
  X402_DEFAULT_MAX_TIMEOUT_SECONDS,
  X402_JSON_MIME_TYPE,
  X402_USDC_EIP712_DOMAIN,
  X402_BAZAAR_EXTENSIONS,
  USDC_TOKEN_ADDRESS,
  X402_FACILITATOR_NETWORK,
  X402_PROTOCOL_VERSION,
  X402_SCHEME,
} from "@/lib/rails/x402-verify";

/** Legacy x402-v1 network literal — verifyAndSettle always sends this exact
 * string to the facilitator when settling a v1-shaped incoming payload,
 * independent of X402_FACILITATOR_NETWORK (which now advertises the v2
 * CAIP-2 form). */
const LEGACY_FACILITATOR_NETWORK = "base";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PaymentPayload and base64-encode it. A real x402-client
 * signs authorization.to = payTo and value = maxAmountRequired verbatim, so the
 * default fixture matches DEFAULT_INPUT (payTo 0xReceiver, 0.25 USDC = 250000).
 */
function makeHeader(
  opts: { network?: string; to?: string; value?: string } = {},
): string {
  const payload = {
    scheme: "exact",
    network: opts.network ?? "base-mainnet",
    payload: {
      authorization: {
        from: "0xAAA",
        to: opts.to ?? "0xReceiver",
        value: opts.value ?? "250000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0xdeadbeef",
      },
      signature: "0xsig",
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

const VALID_HEADER = makeHeader();

const DEFAULT_INPUT = {
  paymentHeader: VALID_HEADER,
  payTo: "0xReceiver",
  amountUsdc: 0.25,
  resource: "https://api.suedeai.xyz/agents/my-agent/run",
};

// ---------------------------------------------------------------------------
// decodePaymentHeader
// ---------------------------------------------------------------------------

describe("decodePaymentHeader", () => {
  it("decodes a well-formed base64-JSON header", () => {
    const result = decodePaymentHeader(VALID_HEADER);
    expect(result).not.toBeNull();
    expect(result?.scheme).toBe("exact");
    expect(result?.network).toBe("base-mainnet");
    expect(result?.payload.authorization.from).toBe("0xAAA");
  });

  it("returns null for plain garbage strings", () => {
    expect(decodePaymentHeader("not-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 that is not JSON", () => {
    const notJson = Buffer.from("hello world", "utf-8").toString("base64");
    expect(decodePaymentHeader(notJson)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const bad = Buffer.from(JSON.stringify({ scheme: "exact" }), "utf-8").toString("base64");
    expect(decodePaymentHeader(bad)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(decodePaymentHeader("")).toBeNull();
  });

  it("accepts 'base' network string in addition to 'base-mainnet'", () => {
    const header = makeHeader({ network: "base" });
    const result = decodePaymentHeader(header);
    expect(result).not.toBeNull();
    expect(result?.network).toBe("base");
  });

  it("projects a sanitized authorization identity without the payment signature", () => {
    expect(x402AuthorizationIdentity(VALID_HEADER)).toEqual({
      x402Version: 1,
      payer: "0xAAA",
      payTo: "0xReceiver",
      amountAtomic: "250000",
      nonce: "0xdeadbeef",
      validAfter: "0",
      validBefore: "9999999999",
      network: "base-mainnet",
      asset: null,
      scheme: "exact",
    });
    expect(JSON.stringify(x402AuthorizationIdentity(VALID_HEADER))).not.toContain("0xsig");
    expect(x402AuthorizationIdentity("garbage")).toBeNull();
  });
});

describe("local EIP-3009 signature authentication", () => {
  it("accepts only the canonical Base USDC signer and signed authorization fields", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const authorization = {
      from: account.address,
      to: "0x1111111111111111111111111111111111111111" as `0x${string}`,
      value: "250000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"ab".repeat(32)}` as `0x${string}`,
    };
    const signature = await account.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: USDC_TOKEN_ADDRESS,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        ...authorization,
        value: 250000n,
        validAfter: 0n,
        validBefore: 9999999999n,
      },
    });
    const encode = (from: string, value = authorization.value) => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: DEFAULT_INPUT.resource },
      accepted: {
        scheme: "exact",
        network: X402_FACILITATOR_NETWORK,
        amount: authorization.value,
        asset: USDC_TOKEN_ADDRESS,
        payTo: authorization.to,
        maxTimeoutSeconds: 60,
      },
      payload: {
        authorization: { ...authorization, from, value },
        signature,
      },
    }), "utf8").toString("base64");

    await expect(verifyX402AuthorizationSignature(encode(account.address))).resolves.toBe(true);
    await expect(verifyX402AuthorizationSignature(encode(
      "0x2222222222222222222222222222222222222222",
    ))).resolves.toBe(false);
    await expect(verifyX402AuthorizationSignature(encode(account.address, "250001")))
      .resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildX402Accept — spec-conformance for every advertised accepts[] entry
// (KD-1: atomic units, KD-2: canonical network, KD-3: absolute resource,
// KD-6: mimeType/outputSchema/maxTimeoutSeconds quality fields)
// ---------------------------------------------------------------------------

describe("buildX402Accept", () => {
  const BASE_INPUT = {
    priceUsdc: 0.1,
    payTo: "0xb5a05466712fd5bcdf2883f43cC6B1799428032d",
    resource: "https://agents.suedeai.ai/api/agents/abc/run",
    description: "Suede agent run",
  };

  it("advertises amount as an atomic integer string, not a decimal (KD-1)", () => {
    const accept = buildX402Accept(BASE_INPUT);
    expect(accept.amount).toBe("100000");
    expect(accept.amount).toMatch(/^[0-9]+$/);
    expect("maxAmountRequired" in accept).toBe(false);
  });

  it("matches usdcToAtomic for a range of prices", () => {
    for (const price of [0.01, 0.1, 0.25, 0.99, 1, 5.5]) {
      expect(buildX402Accept({ ...BASE_INPUT, priceUsdc: price }).amount).toBe(
        usdcToAtomic(price),
      );
    }
  });

  it("advertises the canonical x402-v2 CAIP network string, not 'base-mainnet' (KD-2)", () => {
    expect(buildX402Accept(BASE_INPUT).network).toBe("eip155:8453");
    expect(buildX402Accept(BASE_INPUT).network).toBe(X402_FACILITATOR_NETWORK);
  });

  it("builds an absolute https resource descriptor (KD-3)", () => {
    expect(buildX402ResourceInfo(BASE_INPUT).url).toMatch(/^https:\/\//);
  });

  it("throws if given a relative resource path, so KD-3 cannot silently regress", () => {
    expect(() =>
      buildX402Accept({ ...BASE_INPUT, resource: "/api/agents/abc/run" }),
    ).toThrow(/absolute https URL/);
  });

  it("builds a v2 payment-required document with Bazaar metadata (KD-6)", () => {
    const paymentRequired = buildX402PaymentRequired({
      ...BASE_INPUT,
      outputSchema: X402_RUN_OUTPUT_SCHEMA,
    });
    const accept = paymentRequired.accepts[0];
    expect(paymentRequired.x402Version).toBe(X402_PROTOCOL_VERSION);
    expect(paymentRequired.resource.url).toBe(BASE_INPUT.resource);
    expect(paymentRequired.resource.mimeType).toBe(X402_JSON_MIME_TYPE);
    expect(accept.maxTimeoutSeconds).toBe(X402_DEFAULT_MAX_TIMEOUT_SECONDS);
    expect(accept.extra).toEqual(X402_USDC_EIP712_DOMAIN);
    expect(paymentRequired.extensions).toEqual(X402_BAZAAR_EXTENSIONS);
  });

  it("declares Bazaar metadata for POST discovery", () => {
    const paymentRequired = buildX402PaymentRequired(BASE_INPUT);
    expect(paymentRequired.extensions.bazaar.info.input).toMatchObject({
      type: "http",
      method: "POST",
      bodyType: "json",
    });
    expect(paymentRequired.extensions.bazaar.info.input.body.input.prompt).toBe(
      "Complete the task described by this published workflow.",
    );
    expect(paymentRequired.extensions.bazaar.info.input.body.input.prompt).not.toMatch(
      /lyric|song|music/iu,
    );
  });

  it("scheme is always 'exact' and asset is the Base USDC contract", () => {
    const accept = buildX402Accept(BASE_INPUT);
    expect(accept.scheme).toBe(X402_SCHEME);
    expect(accept.asset).toBe(USDC_TOKEN_ADDRESS);
  });

  it("echoes payTo verbatim", () => {
    expect(buildX402Accept(BASE_INPUT).payTo).toBe(BASE_INPUT.payTo);
  });
});

// ---------------------------------------------------------------------------
// verifyAndSettle — fetch mocking
// ---------------------------------------------------------------------------

describe("verifyAndSettle", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns ok:true with tx + payer on successful verify + settle", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ isValid: true, payer: "0xPayer" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          payer: "0xPayer",
          transaction: "0xTxHash",
          network: "base",
        }),
      });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: true, transaction: "0xTxHash", payer: "0xPayer" });

    // Verify POST /verify was called first
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [verifyCall, settleCall] = fetchSpy.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(verifyCall[0]).toMatch(/\/verify$/);
    expect(settleCall[0]).toMatch(/\/settle$/);
  });

  it("sends the same body to both /verify and /settle", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, transaction: "0xTx" }),
      });

    await verifyAndSettle(DEFAULT_INPUT);

    const [verifyCall, settleCall] = fetchSpy.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(verifyCall[1].body).toBe(settleCall[1].body);

    const body = JSON.parse(verifyCall[1].body as string) as {
      x402Version: number;
      paymentRequirements: {
        network: string;
        maxAmountRequired: string;
        asset: string;
        scheme: string;
      };
    };
    expect(body.x402Version).toBe(1);
    // A legacy v1 incoming payload always settles with the legacy "base"
    // network literal, not the v2 CAIP-2 X402_FACILITATOR_NETWORK value.
    expect(body.paymentRequirements.network).toBe(LEGACY_FACILITATOR_NETWORK);
    expect(body.paymentRequirements.asset).toBe(USDC_TOKEN_ADDRESS);
    expect(body.paymentRequirements.scheme).toBe(X402_SCHEME);
  });

  it("falls back to payer from /verify when /settle omits it", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ isValid: true, payer: "0xPayerFromVerify" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, transaction: "0xTx" }),
      });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({
      ok: true,
      transaction: "0xTx",
      payer: "0xPayerFromVerify",
    });
  });

  it("returns null transaction + null payer when facilitator omits them", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: true, transaction: null, payer: null });
  });

  // -------------------------------------------------------------------------
  // Amount conversion correctness
  // -------------------------------------------------------------------------

  it("converts $0.25 USDC to 250000 atomic units", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    await verifyAndSettle({ ...DEFAULT_INPUT, amountUsdc: 0.25 });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { paymentRequirements: { maxAmountRequired: string } };
    expect(body.paymentRequirements.maxAmountRequired).toBe("250000");
  });

  it("converts $1.00 USDC to 1000000 atomic units", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    await verifyAndSettle({
      ...DEFAULT_INPUT,
      amountUsdc: 1.0,
      paymentHeader: makeHeader({ value: "1000000" }),
    });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { paymentRequirements: { maxAmountRequired: string } };
    expect(body.paymentRequirements.maxAmountRequired).toBe("1000000");
  });

  it("converts $0.99 USDC to 990000 atomic units", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    await verifyAndSettle({
      ...DEFAULT_INPUT,
      amountUsdc: 0.99,
      paymentHeader: makeHeader({ value: "990000" }),
    });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { paymentRequirements: { maxAmountRequired: string } };
    expect(body.paymentRequirements.maxAmountRequired).toBe("990000");
  });

  // -------------------------------------------------------------------------
  // Facilitator rejects at /verify
  // -------------------------------------------------------------------------

  it("returns ok:false when facilitator /verify returns isValid:false", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ isValid: false, invalidReason: "bad_signature" }),
    });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
    // /settle must NOT be called
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses fallback reason 'verify_invalid' when invalidReason is absent", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ isValid: false }),
    });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "verify_invalid" });
  });

  it("returns ok:false when /verify returns HTTP 4xx", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 400 });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "facilitator_verify_http_400" });
  });

  // -------------------------------------------------------------------------
  // Facilitator rejects at /settle
  // -------------------------------------------------------------------------

  it("returns ok:false when /settle returns success:false", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, errorReason: "insufficient_funds" }),
      });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "insufficient_funds" });
  });

  it("returns ok:false when /settle returns HTTP 5xx", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "facilitator_settle_http_503" });
  });

  // -------------------------------------------------------------------------
  // Garbage header
  // -------------------------------------------------------------------------

  it("returns ok:false for a garbage X-PAYMENT header without calling fetch", async () => {
    const result = await verifyAndSettle({ ...DEFAULT_INPUT, paymentHeader: "!!!garbage!!!" });
    expect(result).toEqual({ ok: false, reason: "x_payment_header_invalid_base64_json" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns ok:false for a header with missing fields without calling fetch", async () => {
    const bad = Buffer.from(JSON.stringify({ scheme: "exact" }), "utf-8").toString("base64");
    const result = await verifyAndSettle({ ...DEFAULT_INPUT, paymentHeader: bad });
    expect(result).toEqual({ ok: false, reason: "x_payment_header_invalid_base64_json" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Network error (fetch throws)
  // -------------------------------------------------------------------------

  it("returns ok:false when /verify network request throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("connection refused"));

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/facilitator_verify_network_error/);
    }
  });

  it("returns ok:false when /settle network request throws", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/facilitator_settle_network_error/);
    }
  });

  // -------------------------------------------------------------------------
  // Network normalisation
  // -------------------------------------------------------------------------

  it("accepts 'base-mainnet' in header and sends 'base' to facilitator", async () => {
    const header = makeHeader({ network: "base-mainnet" });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const result = await verifyAndSettle({ ...DEFAULT_INPUT, paymentHeader: header });
    expect(result.ok).toBe(true);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { paymentRequirements: { network: string } };
    expect(body.paymentRequirements.network).toBe("base");
  });

  it("rejects headers with an unsupported network", async () => {
    const header = makeHeader({ network: "polygon" });
    const result = await verifyAndSettle({ ...DEFAULT_INPUT, paymentHeader: header });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unsupported_network/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Local defense-in-depth guards — never reach the facilitator
  // -------------------------------------------------------------------------

  it("rejects a payment whose authorization.to != payTo without calling fetch", async () => {
    const header = makeHeader({ to: "0xAttackerRecipient" });
    const result = await verifyAndSettle({ ...DEFAULT_INPUT, paymentHeader: header });
    expect(result).toEqual({ ok: false, reason: "payment_recipient_mismatch" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches payTo case-insensitively (checksum vs lowercase addresses)", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, transaction: "0xT" }) });
    const header = makeHeader({ to: "0xABC" });
    const result = await verifyAndSettle({ ...DEFAULT_INPUT, paymentHeader: header, payTo: "0xabc" });
    expect(result.ok).toBe(true);
  });

  it("rejects an underpaying authorization.value without calling fetch", async () => {
    // Header pays 250000 (0.25) but the endpoint charges 1.00 (1000000).
    const result = await verifyAndSettle({ ...DEFAULT_INPUT, amountUsdc: 1.0 });
    expect(result).toEqual({ ok: false, reason: "payment_amount_insufficient" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts an overpaying authorization.value", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, transaction: "0xT" }) });
    const header = makeHeader({ value: "500000" }); // pays 0.50 for a 0.25 charge
    const result = await verifyAndSettle({ ...DEFAULT_INPUT, paymentHeader: header });
    expect(result.ok).toBe(true);
  });

  it("rejects overpayment before facilitator access when AP2 requires the exact amount", async () => {
    const header = makeHeader({ value: "500000" });
    const result = await verifyAndSettle({
      ...DEFAULT_INPUT,
      paymentHeader: header,
      requireExactAmount: true,
    });
    expect(result).toEqual({ ok: false, reason: "payment_amount_mismatch" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric authorization.value without calling fetch", async () => {
    const result = await verifyAndSettle({
      ...DEFAULT_INPUT,
      paymentHeader: makeHeader({ value: "not-a-number" }),
    });
    expect(result).toEqual({ ok: false, reason: "payment_amount_unparseable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// verifyAndSettle — x402-v2 payloads (amount field, CAIP-2 network,
// resource descriptor, Bazaar extensions echoed through to the facilitator)
// ---------------------------------------------------------------------------

const V2_RESOURCE_URL = "https://api.suedeai.xyz/agents/my-agent/run";

function makeV2Header(opts: { to?: string; value?: string } = {}): string {
  const payload = {
    x402Version: 2,
    resource: {
      url: V2_RESOURCE_URL,
      description: "Run test agent",
      mimeType: X402_JSON_MIME_TYPE,
      serviceName: "Suede Agent Studio",
    },
    accepted: {
      scheme: "exact",
      network: X402_FACILITATOR_NETWORK,
      amount: "250000",
      asset: USDC_TOKEN_ADDRESS,
      payTo: "0xReceiver",
      maxTimeoutSeconds: X402_DEFAULT_MAX_TIMEOUT_SECONDS,
      extra: X402_USDC_EIP712_DOMAIN,
    },
    extensions: X402_BAZAAR_EXTENSIONS,
    payload: {
      authorization: {
        from: "0xAAA",
        to: opts.to ?? "0xReceiver",
        value: opts.value ?? "250000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0xdeadbeef",
      },
      signature: "0xsig",
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

describe("decodePaymentHeader — x402-v2", () => {
  it("decodes a well-formed v2 header", () => {
    const result = decodePaymentHeader(makeV2Header());
    expect(result).not.toBeNull();
    expect(result?.x402Version).toBe(2);
    if (result?.x402Version !== 2) throw new Error("expected v2 payload");
    expect(result.accepted.network).toBe(X402_FACILITATOR_NETWORK);
    expect(result.accepted.amount).toBe("250000");
    expect(result.payload.authorization.from).toBe("0xAAA");
  });
});

describe("verifyAndSettle — x402-v2 payloads", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("settles a v2 payload and sends the v2 CAIP-2 network + amount to the facilitator", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true, payer: "0xPayer" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, transaction: "0xTx", payer: "0xPayer" }),
      });

    const result = await verifyAndSettle({
      paymentHeader: makeV2Header(),
      payTo: "0xReceiver",
      amountUsdc: 0.25,
      resource: V2_RESOURCE_URL,
    });
    expect(result).toEqual({ ok: true, transaction: "0xTx", payer: "0xPayer" });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      x402Version: number;
      paymentPayload: { resource: { url: string }; accepted: { amount: string } };
      paymentRequirements: { network: string; amount: string };
    };
    expect(body.x402Version).toBe(X402_PROTOCOL_VERSION);
    expect(body.paymentPayload.resource.url).toBe(V2_RESOURCE_URL);
    expect(body.paymentPayload.accepted.amount).toBe("250000");
    expect(body.paymentRequirements.network).toBe(X402_FACILITATOR_NETWORK);
    expect(body.paymentRequirements.amount).toBe("250000");
  });

  it("still rejects a v2 recipient mismatch locally, without calling fetch", async () => {
    const result = await verifyAndSettle({
      paymentHeader: makeV2Header({ to: "0xAttackerRecipient" }),
      payTo: "0xReceiver",
      amountUsdc: 0.25,
      resource: V2_RESOURCE_URL,
    });
    expect(result).toEqual({ ok: false, reason: "payment_recipient_mismatch" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still rejects a v2 underpayment locally, without calling fetch", async () => {
    const result = await verifyAndSettle({
      paymentHeader: makeV2Header(),
      payTo: "0xReceiver",
      amountUsdc: 1.0,
      resource: V2_RESOURCE_URL,
    });
    expect(result).toEqual({ ok: false, reason: "payment_amount_insufficient" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// usdcToAtomic — edge cases (never silently coerce a bad amount)
// ---------------------------------------------------------------------------

describe("usdcToAtomic edge cases", () => {
  it("throws on a negative amount instead of dropping the sign", () => {
    expect(() => usdcToAtomic(-0.25)).toThrow(/non-negative/);
    expect(() => usdcToAtomic(-1)).toThrow(/non-negative/);
  });

  it("throws on NaN and Infinity", () => {
    expect(() => usdcToAtomic(NaN)).toThrow(/finite/);
    expect(() => usdcToAtomic(Infinity)).toThrow(/finite/);
    expect(() => usdcToAtomic(-Infinity)).toThrow(/finite/);
  });

  it("still converts zero and large values correctly", () => {
    expect(usdcToAtomic(0)).toBe("0");
    expect(usdcToAtomic(1000)).toBe("1000000000");
  });
});

// ---------------------------------------------------------------------------
// verifyAndSettle — facilitator fallback (CDP primary, PayAI secondary)
// ---------------------------------------------------------------------------

describe("verifyAndSettle — facilitator fallback", () => {
  const CDP = "https://api.cdp.coinbase.com/platform/v2/x402";
  const PAYAI = "https://facilitator.payai.network";

  let fetchSpy: ReturnType<typeof vi.fn>;
  let savedPrimary: string | undefined;
  let savedSecondary: string | undefined;

  beforeEach(() => {
    savedPrimary = process.env.X402_FACILITATOR_URL;
    savedSecondary = process.env.X402_FACILITATOR_URL_SECONDARY;
    process.env.X402_FACILITATOR_URL = CDP;
    process.env.X402_FACILITATOR_URL_SECONDARY = PAYAI;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    if (savedPrimary === undefined) delete process.env.X402_FACILITATOR_URL;
    else process.env.X402_FACILITATOR_URL = savedPrimary;
    if (savedSecondary === undefined) delete process.env.X402_FACILITATOR_URL_SECONDARY;
    else process.env.X402_FACILITATOR_URL_SECONDARY = savedSecondary;
    vi.unstubAllGlobals();
  });

  it("falls back to the secondary facilitator when the primary returns an HTTP error", async () => {
    fetchSpy
      // CDP /verify → 401 (e.g. missing/expired creds) — retryable
      .mockResolvedValueOnce({ ok: false, status: 401 })
      // PayAI /verify → ok
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true, payer: "0xP" }) })
      // PayAI /settle → ok
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, transaction: "0xTx", payer: "0xP" }),
      });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: true, transaction: "0xTx", payer: "0xP" });

    const urls = fetchSpy.mock.calls.map((c) => (c as [string, RequestInit])[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(urls[0]).toContain("api.cdp.coinbase.com");
    expect(urls[1]).toContain("facilitator.payai.network");
    expect(urls[2]).toContain("facilitator.payai.network");
  });

  it("falls back to the secondary when the primary throws a network error", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, transaction: "0xTx2" }) });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transaction).toBe("0xTx2");
  });

  it("does NOT fall back when the primary returns a definitive invalid verdict", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ isValid: false, invalidReason: "bad_signature" }),
    });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
    // Only the primary /verify was called — a rejected payment must never be
    // re-attempted against the fallback.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back when settle returns a definitive failure", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, errorReason: "insufficient_funds" }),
      });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "insufficient_funds" });
    expect(fetchSpy).toHaveBeenCalledTimes(2); // CDP verify + CDP settle, no fallback
  });

  it("does NOT re-settle on the secondary when the primary settle HTTP-errors", async () => {
    // verify passes on CDP, then CDP /settle 5xx's — the transfer may already
    // have broadcast on-chain, so re-settling the SAME signed authorization on
    // PayAI is an unsafe double-broadcast. Must be terminal, not a fallback.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) }) // CDP verify
      .mockResolvedValueOnce({ ok: false, status: 503 }); // CDP settle

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "facilitator_settle_http_503" });
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no PayAI attempt
  });

  it("does NOT re-settle on the secondary when the primary settle times out", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ isValid: true }) }) // CDP verify
      .mockRejectedValueOnce(new Error("timeout")); // CDP settle network error

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/facilitator_settle_network_error/);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no PayAI attempt
  });

  it("returns the last facilitator's reason when every facilitator fails", async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 500 }) // CDP verify
      .mockResolvedValueOnce({ ok: false, status: 500 }); // PayAI verify

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "facilitator_verify_http_500" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses only the primary when no secondary is configured", async () => {
    delete process.env.X402_FACILITATOR_URL_SECONDARY;
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await verifyAndSettle(DEFAULT_INPUT);
    expect(result).toEqual({ ok: false, reason: "facilitator_verify_http_401" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
