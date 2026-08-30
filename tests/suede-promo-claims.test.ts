import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  promoClaimsNode,
  promoClaimsParamsSchema,
} from "@/lib/flow/nodes/suede/promoClaims";
import type { NodeContext } from "@/lib/flow/executor";

const EMPTY_PROVENANCE = Object.freeze({}) as never;

function ctx(overrides: Partial<NodeContext> = {}): NodeContext {
  return { dryRun: false, runId: "run-1", ...overrides } as unknown as NodeContext;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  process.env.PROMO_AGENT_KEY = "test-agent-key";
});

describe("promoClaims params", () => {
  it("defaults to the review-queue statuses and a 200 limit", () => {
    const parsed = promoClaimsParamsSchema.parse({});
    expect(parsed.statuses).toEqual(["inconclusive", "disputed"]);
    expect(parsed.limit).toBe(200);
    expect(parsed.campaignId).toBeUndefined();
  });

  it("rejects an unknown status", () => {
    expect(() => promoClaimsParamsSchema.parse({ statuses: ["settled"] })).toThrow();
  });

  it("rejects a limit above the server ceiling and an empty status list", () => {
    expect(() => promoClaimsParamsSchema.parse({ limit: 501 })).toThrow();
    expect(() => promoClaimsParamsSchema.parse({ statuses: [] })).toThrow();
  });

  it("rejects a non-uuid campaign id", () => {
    expect(() => promoClaimsParamsSchema.parse({ campaignId: "not-a-uuid" })).toThrow();
  });
});

describe("promoClaims dry run", () => {
  it("returns an empty ledger without touching the network", async () => {
    const result = await promoClaimsNode.executor(
      ctx({ dryRun: true } as Partial<NodeContext>),
      {},
      {},
      EMPTY_PROVENANCE,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outputs.claims).toEqual({ claims: [], total: 0, dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("promoClaims live read", () => {
  it("returns the upstream ledger and sends the agent key", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ claims: [{ claim_id: "c-1" }], total: 1 }), { status: 200 }),
    );

    const result = await promoClaimsNode.executor(ctx(), {}, {}, EMPTY_PROVENANCE);

    expect(result.ok).toBe(true);
    expect(result.ok && (result.outputs.claims as { total: number }).total).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("status=inconclusive%2Cdisputed");
    expect(String(url)).toContain("limit=200");
    expect(String(url)).not.toContain("campaignId");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-agent-key",
    });
  });

  it("includes campaignId only when configured", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ claims: [], total: 0 }), { status: 200 }),
    );
    const campaignId = "11111111-2222-3333-4444-555555555555";

    await promoClaimsNode.executor(ctx(), { campaignId }, {}, EMPTY_PROVENANCE);

    expect(String(fetchMock.mock.calls[0][0])).toContain(`campaignId=${campaignId}`);
  });

  it("fails with the upstream status rather than inventing an empty ledger", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    const result = await promoClaimsNode.executor(ctx(), {}, {}, EMPTY_PROVENANCE);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("500");
  });

  it("fails cleanly when the network throws", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const result = await promoClaimsNode.executor(ctx(), {}, {}, EMPTY_PROVENANCE);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("socket hang up");
  });
});
