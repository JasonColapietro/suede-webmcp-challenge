/**
 * Trigger constructors for the @suedeai/agents SDK.
 * Each constructor validates its arguments and returns a frozen trigger object.
 */
import type { Trigger } from "./types.js";
/** Create a schedule trigger. Validates the cron expression (five fields, UTC). */
export declare function schedule(cron: string): Extract<Trigger, {
    kind: "schedule";
}>;
/** Create a paidCall trigger. Price must be >= 0 (USDC). */
export declare function paidCall(priceUsdc: number): Extract<Trigger, {
    kind: "paidCall";
}>;
/** Create a manual trigger (operator-invoked; no schedule, no payment). */
export declare function manual(): Extract<Trigger, {
    kind: "manual";
}>;
/** Create a webhook trigger (executes via relay — Phase 8). */
export declare function webhook(): Extract<Trigger, {
    kind: "webhook";
}>;
//# sourceMappingURL=triggers.d.ts.map