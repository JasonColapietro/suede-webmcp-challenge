/**
 * Vendored cron parser — copied from src/lib/cron.ts (agentix repo) on 2026-06-11.
 * Provenance: /Users/jasoncolapietro/code/agentix/src/lib/cron.ts
 *
 * Do NOT import from that file across the workspace boundary.
 * Keep this in sync with the source if the parse logic ever changes.
 *
 * Minimal zero-dependency cron matcher. Standard five fields
 * (minute hour day-of-month month day-of-week), numeric atoms with
 * `*`, `a`, `a-b`, comma lists, and `/step`. All math is UTC at minute resolution.
 * Pure data in/out.
 */
interface CronSpec {
    minute: Set<number>;
    hour: Set<number>;
    dom: Set<number>;
    month: Set<number>;
    dow: Set<number>;
    domRestricted: boolean;
    dowRestricted: boolean;
}
/** Parse a five-field cron expression; null when invalid. */
export declare function parseCronVendored(expr: string): CronSpec | null;
/** Returns true if the given string is a valid five-field cron expression. */
export declare function isValidCron(expr: string): boolean;
export {};
//# sourceMappingURL=cron-vendor.d.ts.map