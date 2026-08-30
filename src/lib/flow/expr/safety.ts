/**
 * Shared property-access denylist. Applied both at parse time (static dot
 * access, object literal keys, identifiers, lambda parameter names) and at
 * eval time (computed bracket access, get()'s dynamic path segments) so
 * there is no path, static or data-driven, that can read a prototype-chain
 * property off any value the evaluator touches.
 */

export const DENIED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function assertSafeKey(key: string): void {
  if (DENIED_KEYS.has(key)) {
    throw new Error(`Access to "${key}" is not allowed.`);
  }
}
