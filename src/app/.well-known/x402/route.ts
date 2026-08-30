/**
 * Root x402 discovery index — one document a caller can crawl to find every
 * published endpoint and distinguish payment-enabled, preview, and unavailable
 * services.
 * GET /.well-known/x402
 */
import { NextResponse } from "next/server";
import { buildCatalog } from "@/lib/catalog";
import { SITE_URL } from "@/lib/site";
import {
  facilitatorChain,
  buildX402BazaarExtensions,
  buildX402Accept,
  buildX402ResourceInfo,
  X402_PROTOCOL_VERSION,
} from "@/lib/rails/x402-verify";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";

export const runtime = "nodejs";

export async function buildX402DiscoveryIndex() {
  const entries = await buildCatalog();
  const absolute = (value: string): string => value.startsWith("http") ? value : `${SITE_URL}${value}`;
  return {
    x402Version: X402_PROTOCOL_VERSION,
    service: "Suede Agent Studio",
    description:
      "Published agent flows with current public-call readiness per endpoint. Payment-enabled entries accept x402 USDC on Base; preview entries accept dry-runs; unavailable entries advertise neither.",
    site: SITE_URL,
    catalog: `${SITE_URL}/api/catalog`,
    facilitators: facilitatorChain(),
    endpoints: entries.map((e) => {
      const resourceUrl = absolute(e.urls.run);
      const description = e.description ?? e.summary;
      const outputSchema = e.outputSchema ?? {
        type: "object",
        additionalProperties: true,
      };
      const tags = e.tags
        ? [...e.tags]
        : ["suede", "agent", e.paymentState === "payment-enabled" ? "x402" : e.paymentState];
      const contractExtensions = e.extensions ?? {};
      const payment = e.paymentState === "payment-enabled"
        ? {
            paymentState: "payment-enabled" as const,
            accepts: [
              buildX402Accept({
                priceUsdc: e.priceUsdc,
                payTo: e.payTo,
                resource: resourceUrl,
                description,
                outputSchema,
              }),
            ],
            extensions: {
              ...buildX402BazaarExtensions({
                ...(Object.hasOwn(contractExtensions, RESOURCE_CONTRACT_EXTENSION_URI)
                  ? { mode: "resource" as const }
                  : {}),
                inputSchema: e.inputSchema,
                outputSchema,
                exampleInput: e.exampleInput ?? {},
                exampleOutput: e.exampleOutput ?? { ok: true },
              }),
              ...contractExtensions,
            },
          }
        : {
            paymentState: e.paymentState,
            ...(e.extensions ? { extensions: contractExtensions } : {}),
          };
      return {
        name: e.name,
        summary: e.summary,
        // Honesty flags, not filters: a crawler must be able to tell a
        // deployed, settling endpoint from a dry-run-only listing without
        // paying to find out. publishedLive means an exact immutable Live
        // execution resolves; acceptsPayment means every current paid gate is ready.
        publishedLive: e.publishedLive,
        acceptsPayment: e.acceptsPayment,
        previewAvailable: e.previewAvailable,
        ...payment,
        resource: resourceUrl,
        resourceInfo: buildX402ResourceInfo({
          resource: resourceUrl,
          description,
          serviceName: "Suede Agent Studio",
          tags,
        }),
        inputSchema: e.inputSchema,
        outputSchema,
        ...(e.exampleInput ? { exampleInput: e.exampleInput } : {}),
        ...(e.exampleOutput ? { exampleOutput: e.exampleOutput } : {}),
        discovery: absolute(e.urls.x402),
        agentCard: absolute(e.urls.agentCard),
      };
    }),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await buildX402DiscoveryIndex(), {
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
