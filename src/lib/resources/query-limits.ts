/** Shared browser-safe Resource query bounds. */
export const RESOURCE_QUERY_LIMIT = 100;
export const RESOURCE_QUERY_LIMITS = Object.freeze({
  idBytes: 128,
  filterFields: 64,
  filterBytes: 64 * 1024,
  filterValues: 2_000,
  depth: 16,
} as const);
