/** Decode the single URL-segment layer returned by Next's dynamic route hook. */
export function decodeRouteRowId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
