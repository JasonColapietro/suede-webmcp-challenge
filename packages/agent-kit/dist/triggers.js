/**
 * Trigger constructors for the @suedeai/agents SDK.
 * Each constructor validates its arguments and returns a frozen trigger object.
 */
import { z } from "zod";
import { isValidCron } from "./cron-vendor.js";
const scheduleSchema = z.string().min(1).refine(isValidCron, {
    message: "Invalid five-field cron expression",
});
const paidCallSchema = z.number().nonnegative({
    message: "priceUsdc must be >= 0",
});
/** Create a schedule trigger. Validates the cron expression (five fields, UTC). */
export function schedule(cron) {
    const parsed = scheduleSchema.safeParse(cron);
    if (!parsed.success) {
        throw new Error(`schedule(): ${parsed.error.issues[0].message} — got ${JSON.stringify(cron)}`);
    }
    return Object.freeze({ kind: "schedule", cron: parsed.data });
}
/** Create a paidCall trigger. Price must be >= 0 (USDC). */
export function paidCall(priceUsdc) {
    const parsed = paidCallSchema.safeParse(priceUsdc);
    if (!parsed.success) {
        throw new Error(`paidCall(): ${parsed.error.issues[0].message}`);
    }
    return Object.freeze({ kind: "paidCall", priceUsdc: parsed.data });
}
/** Create a manual trigger (operator-invoked; no schedule, no payment). */
export function manual() {
    return Object.freeze({ kind: "manual" });
}
/** Create a webhook trigger (executes via relay — Phase 8). */
export function webhook() {
    return Object.freeze({ kind: "webhook" });
}
//# sourceMappingURL=triggers.js.map