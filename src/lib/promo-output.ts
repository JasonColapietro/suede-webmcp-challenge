/**
 * Parses the stored `run_steps.output` of a `suede.promo` step into the promo
 * campaign summary the agent page renders.
 *
 * Why this exists: the flow engine persists a node's outputs keyed by PORT, so a
 * `suede.promo` step is stored as `{ "campaign": { campaignId, campaignUrl,
 * name } }` (see `promoNode` -> `outputs.campaign` and `run-service.ts`'s
 * `output: event.outputs`). Both repo implementations previously read
 * `output.campaignUrl` off the top level, which is always `undefined` — so
 * `getLastPromoOutput` returned null and the "View Campaign" card on
 * `/a/[slug]` never rendered.
 *
 * Both shapes are accepted: the port-keyed shape that is actually written, and a
 * flat shape, so any older or hand-written rows still resolve.
 */

export type PromoOutput = {
  campaignId: string;
  campaignUrl: string;
  name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the campaign summary, or null when this step output does not carry a
 * usable campaign URL.
 */
export function parsePromoOutput(rawOutput: unknown): PromoOutput | null {
  let output: unknown = rawOutput;

  // Rows may hold either a JSON string or an already-parsed object.
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return null;
    }
  }
  if (!isRecord(output)) return null;

  // Port-keyed shape first (what the engine actually writes), then flat.
  const candidate = isRecord(output.campaign) ? output.campaign : output;

  const campaignUrl = candidate.campaignUrl;
  if (typeof campaignUrl !== "string" || campaignUrl.length === 0) return null;

  return {
    campaignId: String(candidate.campaignId ?? ""),
    campaignUrl,
    name: String(candidate.name ?? "Promo Campaign"),
  };
}
