export const HIDDEN_AGENTS_STORAGE_KEY = "suede:hidden-agents:v1";
export const HIDDEN_AGENTS_EVENT = "suede:hidden-agents-changed";

export function parseHiddenAgentIds(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(
      (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 256,
    ).slice(0, 1_000));
  } catch {
    return new Set();
  }
}
