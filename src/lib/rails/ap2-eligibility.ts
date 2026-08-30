export interface Ap2ServiceEligibilityInput {
  readonly priceUsdc: number;
  readonly acceptsPayment: boolean;
  readonly publishedLive: boolean;
  /** False for legacy relay-v1 delivery, which cannot guarantee one fulfillment. */
  readonly fulfillmentSupportsAp2: boolean;
}

/** One fail-closed predicate shared by runtime and every discovery projection. */
export function isAp2ServiceEligible(input: Ap2ServiceEligibilityInput): boolean {
  if (!input.acceptsPayment || !input.publishedLive
    || !input.fulfillmentSupportsAp2
    || !Number.isFinite(input.priceUsdc) || input.priceUsdc <= 0) return false;
  try {
    const [whole = "0", fraction = ""] = input.priceUsdc.toFixed(6).split(".");
    const atomic = BigInt(whole) * 1_000_000n
      + BigInt((fraction + "000000").slice(0, 6));
    return atomic > 0n && atomic % 10_000n === 0n;
  } catch {
    return false;
  }
}
