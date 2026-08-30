import { z } from "zod";

export const WEBMCP_BUY_PATH = "/api/webmcp/buy";
export const WEBMCP_BUY_METHOD = "POST" as const;
export const WEBMCP_BUY_TOOL_NAME = "buy_service";

/** Exact body accepted by the cookie-authenticated WebMCP spend route. */
export const webMcpBuyBodySchema = z.object({
  slug: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()).default({}),
  confirmedPriceUsdc: z.number().finite().min(0),
}).strict();

/**
 * Buyability is forwarded from the server catalog and shared by every WebMCP
 * consumer. Neither browser tools nor mobile projections may infer it.
 */
export function isWebMcpBuyable(entry: Readonly<{
  acceptsPayment: boolean;
  publishedLive: boolean;
}>): boolean {
  return entry.acceptsPayment && entry.publishedLive;
}
