import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  class UnauthenticatedOwnerError extends Error {
    status = 401;
  }
  return {
    authorization: null as string | null,
    resolvedOwner: "sb:verified-user",
    resolveOwnerId: vi.fn(),
    createStripeTopupSession: vi.fn(),
    readBoundedJsonRequest: vi.fn(),
    UnauthenticatedOwnerError,
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers(
    state.authorization === null
      ? undefined
      : { Authorization: state.authorization },
  )),
}));

vi.mock("@/lib/auth", () => ({
  resolveOwnerId: (...args: unknown[]) => state.resolveOwnerId(...args),
  SUEDE_OWNER_PREFIX: "sb:",
  UnauthenticatedOwnerError: state.UnauthenticatedOwnerError,
}));

vi.mock("@/lib/gateway/stripe-topup", () => ({
  createStripeTopupSession: (...args: unknown[]) =>
    state.createStripeTopupSession(...args),
  StripeTopupTierSchema: {
    safeParse: (value: unknown) =>
      value === 5
        ? { success: true, data: 5 }
        : { success: false },
  },
  STRIPE_TOPUP_TIERS: [1, 5, 20, 50, 100, 250],
}));

vi.mock("@/lib/projects/api-response", () => ({
  readBoundedJsonRequest: (...args: unknown[]) =>
    state.readBoundedJsonRequest(...args),
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {},
}));

async function route() {
  return import("@/app/api/gateway/topup/stripe/route");
}

function request(): Request {
  return new Request("https://agents.suedeai.ai/api/gateway/topup/stripe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier: 5 }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_local_route_only");
  state.authorization = null;
  state.resolveOwnerId.mockResolvedValue(state.resolvedOwner);
  state.readBoundedJsonRequest.mockResolvedValue({
    ok: true,
    data: { tier: 5 },
  });
  state.createStripeTopupSession.mockResolvedValue({
    ok: true,
    url: "https://checkout.stripe.test/session",
  });
});

describe("POST /api/gateway/topup/stripe auth", () => {
  it("uses verified session ownership when no bearer is present", async () => {
    const { POST } = await route();

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.resolveOwnerId).toHaveBeenCalledTimes(1);
    expect(state.createStripeTopupSession).toHaveBeenCalledWith(
      expect.anything(),
      "sb:verified-user",
      5,
    );
  });

  it("preserves anonymous workspace bearer compatibility", async () => {
    state.authorization = "Bearer anonymous-workspace-key";
    const { POST } = await route();

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect(state.createStripeTopupSession).toHaveBeenCalledWith(
      expect.anything(),
      "anonymous-workspace-key",
      5,
    );
  });

  it("rejects malformed and forged signed-in owner bearers", async () => {
    const { POST } = await route();

    state.authorization = "Basic not-a-workspace-key";
    const malformed = await POST(request());
    expect(malformed.status).toBe(401);

    state.authorization = "Bearer sb:public-user-id";
    const forged = await POST(request());
    expect(forged.status).toBe(401);

    expect(state.resolveOwnerId).not.toHaveBeenCalled();
    expect(state.createStripeTopupSession).not.toHaveBeenCalled();
  });
});
