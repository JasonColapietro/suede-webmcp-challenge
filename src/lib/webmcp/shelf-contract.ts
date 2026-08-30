/**
 * The zod boundary between the browser storefront and the public shelf feed.
 *
 * A fetch response is an external boundary, so nothing reaches the WebMCP tool
 * layer without passing through here first.
 *
 * The shelf is read from `/api/services` and NEVER from `/api/catalog`.
 * `/api/services` is the explicit Suede-operated shelf: its curation claim is
 * awarded by exact-slug matching in buildCatalog(), so a customer copy of the
 * same template cannot inherit it. `/api/catalog` is every eligible published
 * agent, which is a different and much weaker claim to put in front of a
 * spending agent.
 *
 * Buyability is FORWARDED, never recomputed. The server owns whether a call
 * can happen; this module only transports that verdict. Anything missing or
 * unparseable fails closed to not-buyable — a shelf entry we cannot read is
 * never presented as payable.
 */
import { z } from "zod";

/** Readiness exactly as `/api/services` projects it. */
const readinessSchema = z.object({
  state: z.string(),
  publishedLive: z.boolean(),
  acceptsPayment: z.boolean(),
  previewAvailable: z.boolean(),
  hasSettledCalls: z.boolean(),
  settledCalls: z.number(),
  lastCallAt: z.number().nullable(),
});

const curationSchema = z.object({
  key: z.string(),
  collection: z.string(),
  operator: z.string(),
  buyerIntent: z.string(),
  reviewPolicy: z.string(),
  dataHandling: z.string(),
});

const urlsSchema = z.object({
  public: z.string(),
  run: z.string(),
  x402: z.string(),
  agentCard: z.string(),
  a2a: z.string(),
});

/**
 * One shelf entry. Unknown keys are allowed through zod's default stripping so
 * a server-side field added later cannot break the storefront; the fields the
 * tools actually read are all required here.
 */
const shelfEntrySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string().nullable().optional(),
  priceUsdc: z.number(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  exampleInput: z.record(z.string(), z.unknown()).optional(),
  exampleOutput: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  curation: curationSchema.optional(),
  readiness: readinessSchema,
  urls: urlsSchema,
});

const shelfEnvelopeSchema = z.object({
  service: z.string(),
  operator: z.string(),
  collection: z.string(),
  count: z.number(),
  services: z.array(shelfEntrySchema),
});

export type ShelfEntry = z.infer<typeof shelfEntrySchema>;
export type ShelfEnvelope = z.infer<typeof shelfEnvelopeSchema>;

export type ShelfParseResult =
  | { readonly ok: true; readonly shelf: ShelfEnvelope }
  | { readonly ok: false; readonly reason: string };

/** Parse a `/api/services` response body. Never throws. */
export function parseShelf(body: unknown): ShelfParseResult {
  const parsed = shelfEnvelopeSchema.safeParse(body);
  if (parsed.success) return { ok: true, shelf: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path.join(".") ?? "";
  return {
    ok: false,
    reason: path ? `shelf feed rejected at ${path}` : "shelf feed rejected",
  };
}

/**
 * Whether a paid call may be offered for this entry.
 *
 * Every clause is the server's own verdict read back. This function must never
 * grow a condition the server does not already enforce — the storefront's whole
 * safety argument is that it adds no authority of its own.
 */
export function isBuyable(entry: ShelfEntry): boolean {
  return entry.readiness.acceptsPayment && entry.readiness.publishedLive;
}

/** Whether a free dry-run may be offered for this entry. */
export function isPreviewable(entry: ShelfEntry): boolean {
  return entry.readiness.previewAvailable;
}
