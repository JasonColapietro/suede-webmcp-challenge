import { describe, expect, it } from "vitest";
import {
  buildRunScript,
  buildTemplatePaymentPolicyExpression,
} from "@/lib/template-payment-client";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

type Requirement = Readonly<{
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}>;

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: ASSET,
    amount: "50000",
    payTo: PAY_TO,
    ...overrides,
  };
}

function policy(): (version: number, requirements: Requirement[]) => Requirement[] {
  const source = buildTemplatePaymentPolicyExpression({
    amountAtomic: "50000",
    payTo: PAY_TO,
  });
  return Function(`"use strict"; return (${source});`)() as (
    version: number,
    requirements: Requirement[],
  ) => Requirement[];
}

describe("generated x402 buyer policy", () => {
  it("accepts only the exact advertised x402 v2 Base USDC requirement", () => {
    const expected = requirement();
    expect(policy()(2, [expected])).toEqual([expected]);
    expect(policy()(1, [expected])).toEqual([]);
  });

  it.each([
    ["scheme", { scheme: "upto" }],
    ["network", { network: "eip155:1" }],
    ["asset", { asset: "0x2222222222222222222222222222222222222222" }],
    ["amount", { amount: "50001" }],
    ["recipient", { payTo: "0x3333333333333333333333333333333333333333" }],
  ] as const)("rejects a changed %s before signing", (_label, changed) => {
    expect(policy()(2, [requirement(changed)])).toEqual([]);
  });

  it("pins the generated client to the canonical resource and one Base network", () => {
    const script = buildRunScript("agent-123", 0.05, "payment-enabled", PAY_TO);
    expect(script).toContain('networks: [EXPECTED_NETWORK]');
    expect(script).toContain('const EXPECTED_NETWORK = "eip155:8453"');
    expect(script).toContain('const RESOURCE = "https://agents.suedeai.ai/api/agents/agent-123/run"');
    expect(script).toContain('x402Version !== 2');
    expect(script).toContain('requirement.amount === "50000"');
    expect(script).not.toContain("SUEDE_BASE_URL");
    expect(script).not.toContain("base-mainnet");
  });
});
