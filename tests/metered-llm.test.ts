/**
 * Metered flow-run inference (src/lib/run-context.ts's createMeteredLlm).
 *
 * Every real flow run's model call must be covered by the flow OWNER's
 * entitlement (gateway/model-spend.ts — the same allowance, credit, and
 * ledger as /api/gateway/llm) and booked after it happens. The contract:
 *
 *  - entitled owner: real inference, usage rows land in the shared "llm"
 *    ledger, credit is debited only once the free allowance is spent;
 *  - not entitled (never paid, allowance spent with no credit, missing
 *    owner, or a failed payment-adjacent read): DEGRADE to a stub — the run
 *    still completes (degrade-never-paywall), but no unmetered platform
 *    inference ever happens;
 *  - metering happens immediately after the model call and before any
 *    caller-side validation: garbage output still bills, a throw bills
 *    nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { createMeteredLlm, FLOW_RUN_MODEL_SPEND_REASON } from "@/lib/run-context";
import { MODEL_SPEND_USAGE_KIND } from "@/lib/gateway/model-spend";
import { FREE_MONTHLY_GATEWAY_TOKENS, gatewayCostUsdc } from "@/lib/billing";
import type { LlmClient } from "@/lib/llm";

const OWNER = "owner-workspace-0000-0000-000000000001";

let repo: SqliteRepo;

beforeEach(() => {
  repo = new SqliteRepo(":memory:");
});

function baseClient(totalTokens: number, text = "real-provider-output"): {
  client: LlmClient;
  generateWithUsage: ReturnType<typeof vi.fn>;
} {
  const generateWithUsage = vi.fn(async () => ({ text, usage: { totalTokens } }));
  const client: LlmClient = {
    generate: vi.fn(async () => text),
    generateWithUsage,
  };
  return { client, generateWithUsage };
}

async function payOwner(): Promise<void> {
  await repo.createCredit({ ownerId: OWNER, deltaUsdc: 1, reason: "topup", tx: "0x1" });
}

function metered(base: LlmClient, ownerId: string | null = OWNER): LlmClient {
  return createMeteredLlm({ base, ownerId, resolveRepo: async () => repo });
}

describe("createMeteredLlm — entitled owner", () => {
  it("returns real output and books the tokens in the shared llm usage ledger", async () => {
    await payOwner();
    const { client, generateWithUsage } = baseClient(1_200);

    const text = await metered(client).generate("score this lead");

    expect(text).toBe("real-provider-output");
    expect(generateWithUsage).toHaveBeenCalledTimes(1);
    expect(await repo.sumMonthlyUsage(OWNER, MODEL_SPEND_USAGE_KIND)).toBe(1_200);
  });

  it("books every call, not just the first", async () => {
    await payOwner();
    const { client } = baseClient(500);
    const llm = metered(client);

    await llm.generate("one");
    await llm.generate("two");

    expect(await repo.sumMonthlyUsage(OWNER, MODEL_SPEND_USAGE_KIND)).toBe(1_000);
  });

  it("does not debit credit while inside the free allowance", async () => {
    await payOwner();
    const { client } = baseClient(1_200);

    await metered(client).generate("prompt");

    expect(await repo.getCreditBalance(OWNER)).toBeCloseTo(1, 6);
  });

  it("debits credit at gatewayCostUsdc once the monthly allowance is spent", async () => {
    await payOwner();
    await repo.createUsage({
      ownerId: OWNER,
      kind: MODEL_SPEND_USAGE_KIND,
      units: FREE_MONTHLY_GATEWAY_TOKENS,
      costUsdc: 0,
    });
    const { client } = baseClient(10_000);

    await metered(client).generate("prompt");

    expect(await repo.getCreditBalance(OWNER)).toBeCloseTo(1 - gatewayCostUsdc(10_000), 6);
  });

  it("bills the reported usage even when the output is garbage (meter before validate)", async () => {
    await payOwner();
    const { client } = baseClient(900, "%%% totally unusable output %%%");

    const text = await metered(client).generate("prompt");

    // The caller has not validated anything yet, and the spend is already booked.
    expect(text).toContain("unusable");
    expect(await repo.sumMonthlyUsage(OWNER, MODEL_SPEND_USAGE_KIND)).toBe(900);
  });

  it("bills nothing when the provider throws", async () => {
    await payOwner();
    const generateWithUsage = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    const client: LlmClient = { generate: vi.fn(async () => "x"), generateWithUsage };

    await expect(metered(client).generate("prompt")).rejects.toThrow("provider exploded");
    expect(await repo.sumMonthlyUsage(OWNER, MODEL_SPEND_USAGE_KIND)).toBe(0);
  });

  it("estimates tokens when the base client cannot report usage, so inference is never free", async () => {
    await payOwner();
    const client: LlmClient = { generate: vi.fn(async () => "some real output text") };

    await metered(client).generate("a reasonably sized prompt");

    expect(await repo.sumMonthlyUsage(OWNER, MODEL_SPEND_USAGE_KIND)).toBeGreaterThan(0);
  });

  it("pins the ledger reason label for flow-run model spend", () => {
    // The reason string is what makes the credits ledger readable per
    // feature ("gateway:llm", "site-agent:refine", ...); keep it stable.
    expect(FLOW_RUN_MODEL_SPEND_REASON).toBe("flow-run");
  });
});

describe("createMeteredLlm — degrade, never paywall, never unmetered", () => {
  it("degrades an owner that has never paid to the stub, and never calls the provider", async () => {
    const { client, generateWithUsage } = baseClient(1_200);

    const text = await metered(client).generate("prompt");

    expect(generateWithUsage).not.toHaveBeenCalled();
    expect(text).toContain("[degraded]");
    expect(await repo.sumMonthlyUsage(OWNER, MODEL_SPEND_USAGE_KIND)).toBe(0);
    expect(await repo.getCreditBalance(OWNER)).toBe(0);
  });

  it("degrades when the run has no owner to bill (fail closed)", async () => {
    const { client, generateWithUsage } = baseClient(1_200);

    const text = await metered(client, null).generate("prompt");

    expect(generateWithUsage).not.toHaveBeenCalled();
    expect(text).toContain("[degraded]");
  });

  it("degrades when the entitlement read fails (fail CLOSED on payment-adjacent reads)", async () => {
    const { client, generateWithUsage } = baseClient(1_200);
    const llm = createMeteredLlm({
      base: client,
      ownerId: OWNER,
      resolveRepo: async () => {
        throw new Error("db unavailable");
      },
    });

    const text = await llm.generate("prompt");

    expect(generateWithUsage).not.toHaveBeenCalled();
    expect(text).toContain("[degraded]");
  });

  it("degrades when the allowance is spent and there is no credit, instead of paywalling", async () => {
    await payOwner();
    // Spend the paid credit back to zero, then exhaust the monthly allowance.
    await repo.createCredit({ ownerId: OWNER, deltaUsdc: -1, reason: "gateway:llm", tx: null });
    await repo.createUsage({
      ownerId: OWNER,
      kind: MODEL_SPEND_USAGE_KIND,
      units: FREE_MONTHLY_GATEWAY_TOKENS,
      costUsdc: 0,
    });
    const { client, generateWithUsage } = baseClient(1_200);

    const text = await metered(client).generate("prompt");

    // The call still resolves with output — the run completes — but no real
    // inference happened and nothing was billed.
    expect(generateWithUsage).not.toHaveBeenCalled();
    expect(text).toContain("[degraded]");
    expect(await repo.sumMonthlyUsage(OWNER, MODEL_SPEND_USAGE_KIND)).toBe(
      FREE_MONTHLY_GATEWAY_TOKENS,
    );
  });
});
