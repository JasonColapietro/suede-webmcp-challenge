import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authorization: "Bearer workspace-key",
  repo: { kind: "test-repo" },
  handleGatewayTopup: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ Authorization: state.authorization })),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: vi.fn(async () => state.repo),
}));

vi.mock("@/lib/gateway/topup-handler", () => ({
  handleGatewayTopup: (...args: unknown[]) => state.handleGatewayTopup(...args),
  TopupTierSchema: {
    safeParse: (value: unknown) =>
      value === 1 || value === undefined
        ? { success: true, data: value ?? 1 }
        : { success: false },
  },
}));

async function route() {
  return import("@/app/api/gateway/topup/route");
}

function request(headers?: Record<string, string>): Request {
  return new Request("https://agents.suedeai.ai/api/gateway/topup?tier=1", {
    method: "POST",
    headers,
  });
}

const challenge = {
  ok: false as const,
  status: 402 as const,
  x402Version: 2 as const,
  error: "payment required",
  resource: {
    url: "https://agents.suedeai.ai/api/gateway/topup?tier=1",
    description: "Suede gateway credit - $1 USDC",
    mimeType: "application/json",
    serviceName: "Suede Agent Studio",
    tags: ["suede", "gateway", "topup", "x402"],
  },
  accepts: [{
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000000",
    payTo: "0xb5a000000000000000000000000000000000032d",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  }],
  extensions: { bazaar: { info: {}, schema: {} } },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.authorization = "Bearer workspace-key";
  state.handleGatewayTopup.mockResolvedValue(challenge);
});

describe("POST /api/gateway/topup x402 v2 transport", () => {
  it("prefers PAYMENT-SIGNATURE and emits the encoded PAYMENT-REQUIRED challenge", async () => {
    const { POST } = await route();

    const response = await POST(request({
      "PAYMENT-SIGNATURE": "v2-payment",
      "X-PAYMENT": "legacy-payment",
    }));

    expect(state.handleGatewayTopup).toHaveBeenCalledWith(
      "workspace-key",
      1,
      "v2-payment",
      state.repo,
    );
    expect(response.status).toBe(402);
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "PAYMENT-REQUIRED,PAYMENT-RESPONSE,Link",
    );
    const encoded = response.headers.get("payment-required");
    expect(encoded).not.toBeNull();
    expect(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"))).toEqual({
      x402Version: challenge.x402Version,
      error: challenge.error,
      resource: challenge.resource,
      accepts: challenge.accepts,
      extensions: challenge.extensions,
    });
  });

  it("keeps legacy X-PAYMENT callers working during migration", async () => {
    const { POST } = await route();

    await POST(request({ "X-PAYMENT": "legacy-payment" }));

    expect(state.handleGatewayTopup).toHaveBeenCalledWith(
      "workspace-key",
      1,
      "legacy-payment",
      state.repo,
    );
  });
});
