import type { ResourceRunReceipt } from "./repository";

export interface TrustCountFact {
  readonly count: number | null;
  readonly basis: "resource_run_receipts" | "not_recorded";
}

export interface TrustMoneyFact extends TrustCountFact {
  readonly amountUsdc: number | null;
}

export interface ResourceTrustAnalytics {
  readonly activity: { readonly calls: TrustCountFact };
  readonly facts: {
    readonly attempted: TrustCountFact;
    readonly free: TrustCountFact;
    readonly challenged: TrustCountFact;
    readonly executed: TrustCountFact;
    readonly credited: TrustMoneyFact;
    readonly settled: TrustMoneyFact;
    readonly refunded: TrustMoneyFact;
    readonly failed: TrustCountFact;
  };
  readonly quality: {
    readonly schemaValidExecutions: number;
    readonly evidenceBackedExecutions: number;
    readonly freshExecutions: number;
    readonly staleExecutions: number;
    readonly mixedExecutions: number;
    readonly unknownCount: number;
    readonly conflictCount: number;
  };
  readonly rates: {
    readonly schemaValidRate: number | null;
    readonly evidenceCoverageRate: number | null;
    readonly freshRate: number | null;
    readonly staleRate: number | null;
    readonly mixedRate: number | null;
    readonly unknownRate: number | null;
    readonly conflictRate: number | null;
  };
  readonly economics: {
    readonly price: {
      readonly executionCount: number;
      readonly totalUsdc: number;
      readonly averageUsdc: number | null;
      readonly basis: "resource_run_receipts";
    };
    readonly cost: { readonly status: "not_recorded"; readonly amountUsdc: null };
    readonly margin: { readonly status: "not_recorded"; readonly amountUsdc: null };
  };
  readonly demand: { readonly status: "not_measured"; readonly value: null };
  readonly revenue: { readonly status: "not_measured"; readonly amountUsdc: null };
}

const UNKNOWN_COUNT = Object.freeze({ count: null, basis: "not_recorded" as const });
const UNKNOWN_MONEY = Object.freeze({ count: null, amountUsdc: null, basis: "not_recorded" as const });
const EXECUTION_STATES = new Set<ResourceRunReceipt["paymentState"]>([
  "free", "credited", "settled", "refunded",
]);

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function usdc(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function countPaymentState(
  receipts: readonly ResourceRunReceipt[],
  state: ResourceRunReceipt["paymentState"],
): TrustCountFact {
  return Object.freeze({
    count: receipts.filter((receipt) => receipt.paymentState === state).length,
    basis: "resource_run_receipts" as const,
  });
}

function sumPaymentState(
  receipts: readonly ResourceRunReceipt[],
  state: ResourceRunReceipt["paymentState"],
): TrustMoneyFact {
  const matching = receipts.filter((receipt) => receipt.paymentState === state);
  return Object.freeze({
    count: matching.length,
    amountUsdc: Math.round(matching.reduce((sum, receipt) => sum + receipt.priceUsdc, 0) * 1_000_000) / 1_000_000,
    basis: "resource_run_receipts" as const,
  });
}

/**
 * Aggregate only durable receipt facts. A listing, a 402 challenge, or a
 * successful deterministic test is not demand, credit, settlement, or revenue.
 */
export function aggregateResourceTrust(receipts: readonly ResourceRunReceipt[]): ResourceTrustAnalytics {
  const executions = receipts.filter((receipt) => EXECUTION_STATES.has(receipt.paymentState));
  const schemaValidExecutions = executions.filter((receipt) => receipt.outputSchemaValid).length;
  const evidenceBackedExecutions = executions.filter((receipt) => receipt.evidence.length > 0).length;
  const freshExecutions = executions.filter((receipt) => receipt.freshness === "fresh").length;
  const staleExecutions = executions.filter((receipt) => receipt.freshness === "stale").length;
  const mixedExecutions = executions.filter((receipt) => receipt.freshness === "mixed").length;
  const unknownExecutions = executions.filter((receipt) => receipt.unknowns.length > 0).length;
  const conflictExecutions = executions.filter((receipt) => receipt.conflicts.length > 0).length;
  const totalPriceUsdc = usdc(executions.reduce((sum, receipt) => sum + receipt.priceUsdc, 0));
  return Object.freeze({
    activity: Object.freeze({
      calls: Object.freeze({ count: receipts.length, basis: "resource_run_receipts" as const }),
    }),
    facts: Object.freeze({
      attempted: UNKNOWN_COUNT,
      free: countPaymentState(receipts, "free"),
      challenged: UNKNOWN_COUNT,
      executed: Object.freeze({ count: executions.length, basis: "resource_run_receipts" as const }),
      credited: sumPaymentState(receipts, "credited"),
      settled: sumPaymentState(receipts, "settled"),
      refunded: UNKNOWN_MONEY,
      failed: UNKNOWN_COUNT,
    }),
    quality: Object.freeze({
      schemaValidExecutions,
      evidenceBackedExecutions,
      freshExecutions,
      staleExecutions,
      mixedExecutions,
      unknownCount: executions.reduce((sum, receipt) => sum + receipt.unknowns.length, 0),
      conflictCount: executions.reduce((sum, receipt) => sum + receipt.conflicts.length, 0),
    }),
    rates: Object.freeze({
      schemaValidRate: rate(schemaValidExecutions, executions.length),
      evidenceCoverageRate: rate(evidenceBackedExecutions, executions.length),
      freshRate: rate(freshExecutions, executions.length),
      staleRate: rate(staleExecutions, executions.length),
      mixedRate: rate(mixedExecutions, executions.length),
      unknownRate: rate(unknownExecutions, executions.length),
      conflictRate: rate(conflictExecutions, executions.length),
    }),
    economics: Object.freeze({
      price: Object.freeze({
        executionCount: executions.length,
        totalUsdc: totalPriceUsdc,
        averageUsdc: executions.length === 0 ? null : usdc(totalPriceUsdc / executions.length),
        basis: "resource_run_receipts" as const,
      }),
      cost: Object.freeze({ status: "not_recorded" as const, amountUsdc: null }),
      margin: Object.freeze({ status: "not_recorded" as const, amountUsdc: null }),
    }),
    demand: Object.freeze({ status: "not_measured" as const, value: null }),
    revenue: Object.freeze({ status: "not_measured" as const, amountUsdc: null }),
  });
}
