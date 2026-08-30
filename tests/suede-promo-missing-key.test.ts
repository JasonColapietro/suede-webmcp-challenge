import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promoNode } from "@/lib/flow/nodes/suede/promo";
import { promoClaimsNode } from "@/lib/flow/nodes/suede/promoClaims";
import type { NodeContext } from "@/lib/flow/executor";

/**
 * Without a PROMO_AGENT_KEY guard these nodes send `Bearer ` (empty), Promo
 * answers 401, and the operator sees a bare "Promo API error: 401" that reads
 * like a Promo outage rather than missing local config — after the caller has
 * already paid for the run. Both nodes must fail *before* the network call.
 */

const EMPTY_PROVENANCE = Object.freeze({}) as never;

/**
 * NodeResult is a discriminated union — `error` only exists on the failure
 * variant, and `expect(result.ok).toBe(false)` does not narrow it for
 * TypeScript. This asserts and narrows in one step.
 */
function expectFailure(
  result: Awaited<ReturnType<typeof promoNode.executor>>,
): { error: string } {
  if (result.ok) throw new Error("expected the node to fail, but it succeeded");
  return result as { error: string };
}

function ctx(overrides: Partial<NodeContext> = {}): NodeContext {
  return { dryRun: false, runId: "run-1", ...overrides } as unknown as NodeContext;
}

const VALID_PROMO_PARAMS = {
  name: "Launch push",
  brief: "Post about the drop with the required hashtags.",
  rewardUsdc: 5,
  slotCap: 25,
  hashtags: ["#suede"],
};

let fetchMock: ReturnType<typeof vi.fn>;
const originalKey = process.env.PROMO_AGENT_KEY;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.PROMO_AGENT_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.PROMO_AGENT_KEY;
  else process.env.PROMO_AGENT_KEY = originalKey;
});

describe("suede.promo — missing PROMO_AGENT_KEY", () => {
  it("fails with a config message and never calls fetch", async () => {
    const result = await promoNode.executor(ctx(), VALID_PROMO_PARAMS, EMPTY_PROVENANCE);

    expect(expectFailure(result).error).toBe(
      "Promo is not configured: PROMO_AGENT_KEY is not set on this deployment.",
    );
    expect(result.costUsdc).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty-string key as unconfigured", async () => {
    process.env.PROMO_AGENT_KEY = "";
    const result = await promoNode.executor(ctx(), VALID_PROMO_PARAMS, EMPTY_PROVENANCE);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not surface a bare upstream 401 as the error", async () => {
    const result = await promoNode.executor(ctx(), VALID_PROMO_PARAMS, EMPTY_PROVENANCE);
    expect(expectFailure(result).error).not.toMatch(/401/);
  });

  it("still proceeds to fetch once a key is present", async () => {
    process.env.PROMO_AGENT_KEY = "test-agent-key";
    fetchMock.mockResolvedValue({
      status: 201,
      json: async () => ({
        campaignId: "abc",
        campaignUrl: "https://promo.suedeai.ai/c/abc",
      }),
    });

    const result = await promoNode.executor(ctx(), VALID_PROMO_PARAMS, EMPTY_PROVENANCE);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-agent-key",
    );
  });

  it("does not fire on a dry run — the stub answers first", async () => {
    const result = await promoNode.executor(
      ctx({ dryRun: true } as Partial<NodeContext>),
      VALID_PROMO_PARAMS,
      EMPTY_PROVENANCE,
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("suede.promoClaims — missing PROMO_AGENT_KEY", () => {
  it("fails with a config message and never calls fetch", async () => {
    const result = await promoClaimsNode.executor(ctx(), {}, EMPTY_PROVENANCE);

    expect(expectFailure(result).error).toBe(
      "Promo is not configured: PROMO_AGENT_KEY is not set on this deployment.",
    );
    expect(result.costUsdc).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty-string key as unconfigured", async () => {
    process.env.PROMO_AGENT_KEY = "";
    const result = await promoClaimsNode.executor(ctx(), {}, EMPTY_PROVENANCE);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire on a dry run", async () => {
    const result = await promoClaimsNode.executor(
      ctx({ dryRun: true } as Partial<NodeContext>),
      {},
      EMPTY_PROVENANCE,
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
