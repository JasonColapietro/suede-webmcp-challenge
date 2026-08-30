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
const FIELD_RANGES = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }, // day of week (7 == 0 == Sunday)
];
function expandField(token, min, max) {
    const out = new Set();
    for (const atom of token.split(",")) {
        const stepMatch = /^(.+?)\/(\d+)$/.exec(atom);
        const base = stepMatch ? stepMatch[1] : atom;
        const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
        if (!Number.isFinite(step) || step < 1)
            return null;
        let lo;
        let hi;
        if (base === "*") {
            lo = min;
            hi = max;
        }
        else {
            const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
            if (rangeMatch) {
                lo = Number.parseInt(rangeMatch[1], 10);
                hi = Number.parseInt(rangeMatch[2], 10);
            }
            else if (/^\d+$/.test(base)) {
                lo = Number.parseInt(base, 10);
                hi = lo;
            }
            else {
                return null;
            }
        }
        if (lo < min || hi > max || lo > hi)
            return null;
        for (let v = lo; v <= hi; v += step)
            out.add(v);
    }
    return out.size > 0 ? out : null;
}
/** Parse a five-field cron expression; null when invalid. */
export function parseCronVendored(expr) {
    const tokens = expr.trim().split(/\s+/);
    if (tokens.length !== 5)
        return null;
    const sets = [];
    for (let i = 0; i < 5; i += 1) {
        const set = expandField(tokens[i], FIELD_RANGES[i].min, FIELD_RANGES[i].max);
        if (set === null)
            return null;
        sets.push(set);
    }
    const dow = new Set();
    for (const v of sets[4])
        dow.add(v === 7 ? 0 : v);
    return {
        minute: sets[0],
        hour: sets[1],
        dom: sets[2],
        month: sets[3],
        dow,
        domRestricted: tokens[2] !== "*",
        dowRestricted: tokens[4] !== "*",
    };
}
/** Returns true if the given string is a valid five-field cron expression. */
export function isValidCron(expr) {
    return parseCronVendored(expr) !== null;
}
//# sourceMappingURL=cron-vendor.js.map