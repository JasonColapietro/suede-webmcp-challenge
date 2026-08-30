/**
 * Run-mode resolution for POST /api/agents/[agent]/run.
 *
 * The Suede Agents iOS app's in-app "Run Agent" is a FREE dry-run preview — the
 * person tapping it has no wallet and pays nothing. The caller signals that
 * intent with `?dryRun=1`, a `{ "dryRun": true }` body field, or the
 * `x-suede-dry-run: 1` header. An explicit dry-run ALWAYS wins, so the human
 * preview never hits the x402 paywall (the cause of the App Store 2.1
 * rejection). Machine-to-machine callers that omit the signal still settle via
 * x402 for live, priced agents — the revenue path is untouched. This helper
 * selects a non-settling mode; protocol-specific callers may still refuse a
 * preview when the published contract does not expose one.
 */

/** Whether the caller explicitly asked for a free dry-run preview. */
export function isDryRunRequested(
  url: URL,
  headers: Headers,
  body: { dryRun?: unknown },
): boolean {
  const query = url.searchParams.get("dryRun");
  return (
    body.dryRun === true ||
    query === "1" ||
    query === "true" ||
    headers.get("x-suede-dry-run") === "1"
  );
}

export interface RunModeInput {
  /** Caller explicitly requested a free dry-run preview. */
  requestedDryRun: boolean;
  /** Platform-level live settlement (`X402_SKIP_SETTLEMENT === "false"`). */
  globalLive: boolean;
  /** Per-agent settlement opt-in (`settlement_live`). */
  agentSettlementLive: boolean;
}

/**
 * Resolve whether this run is a dry-run. An explicit dry-run request wins mode
 * selection; otherwise a run settles only when BOTH the platform and the agent
 * are live. Callers enforce service-specific preview eligibility separately.
 */
export function resolveRunMode(input: RunModeInput): { dryRun: boolean } {
  const dryRun =
    input.requestedDryRun || !(input.globalLive && input.agentSettlementLive);
  return { dryRun };
}
