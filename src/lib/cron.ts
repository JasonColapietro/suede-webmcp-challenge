/**
 * Minimal zero-dependency cron matcher. Standard five fields
 * (minute hour day-of-month month day-of-week), numeric atoms with
 * `*`, `a`, `a-b`, comma lists, and `/step`. All math is UTC at minute
 * resolution — the platform tick is hourly, so sub-hourly schedules
 * effectively round up to the tick. Pure data in/out: safe to import
 * from client components.
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MINUTE_MS = 60_000;
/** How far occurrence searches walk before giving up (covers yearly crons). */
const SEARCH_LIMIT_MINUTES = 370 * 24 * 60;

const FIELD_RANGES: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (7 == 0 == Sunday)
];

function expandField(token: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const atom of token.split(",")) {
    const stepMatch = /^(.+?)\/(\d+)$/.exec(atom);
    const base = stepMatch ? stepMatch[1] : atom;
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
    if (!Number.isFinite(step) || step < 1) return null;

    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
      if (rangeMatch) {
        lo = Number.parseInt(rangeMatch[1], 10);
        hi = Number.parseInt(rangeMatch[2], 10);
      } else if (/^\d+$/.test(base)) {
        lo = Number.parseInt(base, 10);
        hi = lo;
      } else {
        return null;
      }
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** Parse a five-field cron expression; null when invalid. */
export function parseCron(expr: string): CronSpec | null {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i += 1) {
    const set = expandField(tokens[i], FIELD_RANGES[i].min, FIELD_RANGES[i].max);
    if (set === null) return null;
    sets.push(set);
  }
  const dow = new Set<number>();
  for (const v of sets[4]) dow.add(v === 7 ? 0 : v);
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

function matchesAt(spec: CronSpec, t: number): boolean {
  const d = new Date(t);
  if (!spec.minute.has(d.getUTCMinutes())) return false;
  if (!spec.hour.has(d.getUTCHours())) return false;
  if (!spec.month.has(d.getUTCMonth() + 1)) return false;
  const domMatch = spec.dom.has(d.getUTCDate());
  const dowMatch = spec.dow.has(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  if (spec.domRestricted) return domMatch;
  if (spec.dowRestricted) return dowMatch;
  return true;
}

/** Latest occurrence at or before `now` (ms), or null. */
export function mostRecentOccurrence(expr: string, now: number): number | null {
  const spec = parseCron(expr);
  if (spec === null) return null;
  let t = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i += 1) {
    if (matchesAt(spec, t)) return t;
    t -= MINUTE_MS;
  }
  return null;
}

/** Earliest occurrence strictly after `now` (ms), or null. */
export function nextOccurrence(expr: string, now: number): number | null {
  const spec = parseCron(expr);
  if (spec === null) return null;
  let t = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS;
  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i += 1) {
    if (matchesAt(spec, t)) return t;
    t += MINUTE_MS;
  }
  return null;
}

/**
 * A schedule is due when an occurrence has passed that it hasn't run for:
 * never ran, or lastRunAt precedes the most recent occurrence <= now.
 * Invalid expressions never fire.
 */
export function isDue(expr: string, lastRunAt: number | null, now: number): boolean {
  const occurrence = mostRecentOccurrence(expr, now);
  if (occurrence === null) return false;
  return lastRunAt === null || lastRunAt < occurrence;
}

/** Shared due-filter used by every FlowRepo implementation. */
export function filterDue<T extends { cron: string; enabled: boolean; lastRunAt: number | null }>(
  rows: T[],
  now: number,
): T[] {
  return rows.filter((row) => row.enabled && isDue(row.cron, row.lastRunAt, now));
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Human description of the common shapes; raw `cron(...)` otherwise. */
export function describeCron(expr: string): string {
  const fallback = `cron(${expr})`;
  if (parseCron(expr) === null) return fallback;
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const num = (s: string): boolean => /^\d+$/.test(s);

  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "every minute";
  }
  const stepMatch = /^\*\/(\d+)$/.exec(m);
  if (stepMatch && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `every ${stepMatch[1]} minutes`;
  }
  if (num(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    const minute = Number.parseInt(m, 10);
    return minute === 0 ? "hourly" : `hourly at :${pad2(minute)}`;
  }
  if (num(m) && num(h) && dom === "*" && mon === "*" && dow === "*") {
    return `daily at ${pad2(Number.parseInt(h, 10))}:${pad2(Number.parseInt(m, 10))} UTC`;
  }
  if (num(m) && num(h) && dom === "*" && mon === "*" && num(dow)) {
    const day = DAY_NAMES[Number.parseInt(dow, 10) % 7];
    return `weekly on ${day} at ${pad2(Number.parseInt(h, 10))}:${pad2(Number.parseInt(m, 10))} UTC`;
  }
  if (num(m) && num(h) && num(dom) && mon === "*" && dow === "*") {
    return `monthly on day ${Number.parseInt(dom, 10)} at ${pad2(Number.parseInt(h, 10))}:${pad2(Number.parseInt(m, 10))} UTC`;
  }
  return fallback;
}
