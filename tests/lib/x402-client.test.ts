/**
 * Regression: the outbound x402 client (used by flow nodes to pay OTHER
 * priced endpoints) must read the atomic-unit amount from the field the
 * server actually sends (`maxAmountRequired`) and sign it verbatim — no
 * second conversion. Before this fix the client's PaymentRequirement type
 * declared a field named `amount` that no real x402 challenge ever sends,
 * so `BigInt(requirement.amount)` was always `BigInt(undefined)`, which
 * throws. This test exercises the full live-mode signing path against a
 * challenge shaped exactly like a real server response.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { X402Client } from "@/lib/rails/x402-client";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xb5a05466712fd5bcdf2883f43cC6B1799428032d";

describe("X402Client — live settlement reads maxAmountRequired (KD-1 client coupling)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs requirement.maxAmountRequired verbatim and echoes the server's network", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });

    const challengeBody = {
      x402Version: 1,
      error: "payment required",
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "100000",
          asset: USDC,
          payTo: PAY_TO,
          resource: "https://api.suedeai.xyz/api/agents/abc/run",
        },
      ],
    };

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ status: 402, json: async () => challengeBody })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ runId: "run_1" }) });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.call("/api/agents/abc/run", { input: {} }, { priceUsdc: 0.1 });
    expect(result.settled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [, paidInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const paymentHeader = (paidInit.headers as Record<string, string>)["X-PAYMENT"];
    expect(paymentHeader).toBeTruthy();

    const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8")) as {
      network: string;
      payload: { authorization: { value: string } };
    };
    // Signed value must equal the advertised atomic amount exactly — no
    // second usdcToAtomic pass, which would turn "100000" into 100 trillion.
    expect(decoded.payload.authorization.value).toBe("100000");
    expect(decoded.network).toBe("base");
  });

  it("throws a clear error for an unrecognized network rather than signing blind", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });

    const challengeBody = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "polygon",
          maxAmountRequired: "100000",
          asset: USDC,
          payTo: PAY_TO,
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce({ status: 402, json: async () => challengeBody });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.call("/x", {}, { priceUsdc: 0.1 })).rejects.toThrow(/network/i);
  });

  it("refuses a challenge whose atomic amount exceeds the caller's USDC ceiling", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });
    const challengeBody = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "100001",
          asset: USDC,
          payTo: PAY_TO,
          resource: "https://api.suedeai.xyz/x",
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce({ status: 402, json: async () => challengeBody });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.call("/x", {}, { priceUsdc: 0.1 })).rejects.toThrow(
      /amount.*exceeds.*ceiling/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never rounds a sub-atomic caller ceiling upward when authorizing payment", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });
    const challengeBody = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "2",
          asset: USDC,
          payTo: PAY_TO,
          resource: "https://api.suedeai.xyz/x",
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce({ status: 402, json: async () => challengeBody });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.call("/x", {}, { priceUsdc: 0.0000015 })).rejects.toThrow(
      /precision|ceiling/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a challenge that redirects payment to a different recipient", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });
    const challengeBody = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "100000",
          asset: USDC,
          payTo: "0x1111111111111111111111111111111111111111",
          resource: "https://api.suedeai.xyz/x",
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce({ status: 402, json: async () => challengeBody });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.call("/x", {}, { priceUsdc: 0.1 })).rejects.toThrow(/payTo/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["scheme", { scheme: "upto" }, /scheme/i],
    ["network", { network: "base-sepolia" }, /network/i],
    ["asset", { asset: "0x2222222222222222222222222222222222222222" }, /asset/i],
    ["resource", { resource: "https://attacker.example/x" }, /resource/i],
  ])("refuses a challenge with a mismatched %s", async (_field, patch, error) => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });
    const challengeBody = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "100000",
          asset: USDC,
          payTo: PAY_TO,
          resource: "https://api.suedeai.xyz/x",
          ...patch,
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce({ status: 402, json: async () => challengeBody });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.call("/x", {}, { priceUsdc: 0.1 })).rejects.toThrow(error);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsupported x402 challenge version", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });
    const challengeBody = {
      x402Version: 3,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "100000",
          asset: USDC,
          payTo: PAY_TO,
          resource: "https://api.suedeai.xyz/x",
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValueOnce({ status: 402, json: async () => challengeBody });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(client.call("/x", {}, { priceUsdc: 0.1 })).rejects.toThrow(/version/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("X402Client — live settlement reads x402-v2 challenges (amount, PAYMENT-SIGNATURE)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs requirement.amount verbatim and pays with PAYMENT-SIGNATURE", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });

    const resourceUrl = "https://api.suedeai.xyz/api/agents/abc/run";
    const challengeBody = {
      x402Version: 2,
      error: "payment required",
      resource: {
        url: resourceUrl,
        description: "Run test agent",
        mimeType: "application/json",
        serviceName: "Suede Agent Studio",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "100000",
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
      extensions: {
        bazaar: {
          info: {
            input: { type: "http", method: "POST", bodyType: "json" },
            output: { type: "json", format: "application/json" },
          },
        },
      },
    };

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ status: 402, json: async () => challengeBody })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ runId: "run_1" }) });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.call("/api/agents/abc/run", { input: {} }, { priceUsdc: 0.1 });
    expect(result.settled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [, paidInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const paymentHeader = (paidInit.headers as Record<string, string>)["PAYMENT-SIGNATURE"];
    expect(paymentHeader).toBeTruthy();

    const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8")) as {
      x402Version: number;
      resource: { url: string };
      accepted: { network: string; amount: string };
      payload: { authorization: { value: string } };
    };
    // Signed value must equal the advertised atomic amount exactly — no
    // second usdcToAtomic pass, which would turn "100000" into 100 trillion.
    expect(decoded.payload.authorization.value).toBe("100000");
    expect(decoded.accepted.amount).toBe("100000");
    expect(decoded.accepted.network).toBe("eip155:8453");
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe(resourceUrl);
  });

  it("reads the challenge from the PAYMENT-REQUIRED header when the 402 body is unavailable", async () => {
    const privateKey = generatePrivateKey();
    const client = new X402Client({
      dryRun: false,
      privateKey,
      network: "base-mainnet",
      expectedPayTo: PAY_TO,
    });
    const resourceUrl = "https://api.suedeai.xyz/api/agents/abc/run";
    const challengeBody = {
      x402Version: 2,
      resource: { url: resourceUrl },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "100000",
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
      ],
    };
    const encodedHeader = Buffer.from(JSON.stringify(challengeBody), "utf-8").toString("base64");

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        status: 402,
        headers: new Headers({ "PAYMENT-REQUIRED": encodedHeader }),
        json: async () => {
          throw new Error("body should not be needed when PAYMENT-REQUIRED is present");
        },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ runId: "run_1" }) });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.call("/api/agents/abc/run", { input: {} }, { priceUsdc: 0.1 });
    expect(result.settled).toBe(true);
  });
});
