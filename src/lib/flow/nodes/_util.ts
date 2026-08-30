/** Shared helpers for node executors. */

/** Replace {{key}} / {{a.b}} tokens in a template with values from inputs. */
export function interpolate(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const parts = path.split(".");
    let cur: unknown = inputs;
    for (const part of parts) {
      if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return "";
      }
    }
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
}

/** Read a file fixture from either a direct upstream string or Input-node object. */
export function upstreamFileBase64(inputs: Record<string, unknown>): string | undefined {
  const upstream = inputs.in;
  if (typeof upstream === "string") return upstream;
  if (upstream === null || typeof upstream !== "object" || Array.isArray(upstream)) return undefined;
  const value = (upstream as Record<string, unknown>).fileBase64;
  return typeof value === "string" ? value : undefined;
}

/** Recursively interpolate strings while preserving JSON escaping and structure. */
export function interpolateStructured(
  value: unknown,
  inputs: Record<string, unknown>,
  depth = 0,
): unknown {
  if (depth > 64) throw new Error("Interpolated value exceeds the nesting limit");
  if (typeof value === "string") return interpolate(value, inputs);
  if (Array.isArray(value)) {
    return value.map((item) => interpolateStructured(item, inputs, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    interpolateStructured(item, inputs, depth + 1),
  ]));
}

export function upstreamRecord(inputs: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const upstream = inputs.in;
  if (upstream === null || typeof upstream !== "object" || Array.isArray(upstream)) return {};
  const prototype = Object.getPrototypeOf(upstream);
  return prototype === Object.prototype || prototype === null
    ? upstream as Readonly<Record<string, unknown>>
    : {};
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
