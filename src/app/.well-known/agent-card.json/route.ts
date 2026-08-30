import { NextResponse } from "next/server";
import { buildCatalog } from "@/lib/catalog";
import { SITE_URL } from "@/lib/site";
import { PUBLIC_PAYMENT_PROJECTION } from "@/lib/public-payment-readiness";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    const entries = await buildCatalog();
    const absolute = (value: string): string => value.startsWith("http") ? value : `${SITE_URL}${value}`;
    return NextResponse.json(
      {
        name: "Suede Agent Studio",
        description:
          "Published visual agent flows. Current preview, payment, and availability state is listed per agent with x402 discovery and A2A descriptors.",
        supportedInterfaces: [
          {
            url: `${SITE_URL}/api/mcp`,
            protocolBinding: "MCP",
            protocolVersion: "2025-06-18",
          },
        ],
        provider: { organization: "Suede Labs AI", url: SITE_URL },
        version: "1.0.0",
        documentationUrl: `${SITE_URL}/docs`,
        capabilities: {
          streaming: false,
          pushNotifications: false,
          extendedAgentCard: false,
        },
        defaultInputModes: ["application/json"],
        defaultOutputModes: ["application/json"],
        skills: entries.map((entry) => ({
          id: `run-${entry.slug}`,
          name: entry.name,
          description: entry.description ?? entry.summary,
          tags: entry.tags ? [...entry.tags] : ["suede", "agent", "workflow"],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        })),
        "x-suede": {
          projection: PUBLIC_PAYMENT_PROJECTION,
          site: SITE_URL,
          catalog: `${SITE_URL}/api/catalog`,
          curatedServices: `${SITE_URL}/api/services`,
          x402: `${SITE_URL}/.well-known/x402`,
          openapi: `${SITE_URL}/openapi.json`,
          mcp: `${SITE_URL}/api/mcp`,
          funding: {
            topup: `${SITE_URL}/api/gateway/topup`,
            cardCheckout: `${SITE_URL}/api/gateway/topup/stripe`,
            rail: "x402",
            asset: "USDC",
            network: "eip155:8453",
          },
          count: entries.length,
          agents: entries.map((entry) => ({
            id: entry.id,
            slug: entry.slug,
            name: entry.name,
            description: entry.description ?? entry.summary,
            inputSchema: entry.inputSchema,
            ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
            ...(entry.exampleInput ? { exampleInput: entry.exampleInput } : {}),
            ...(entry.exampleOutput ? { exampleOutput: entry.exampleOutput } : {}),
            ...(entry.curation ? { curation: entry.curation } : {}),
            publicUrl: absolute(entry.urls.public),
            runUrl: absolute(entry.urls.run),
            agentCardUrl: absolute(entry.urls.agentCard),
            a2aUrl: absolute(entry.urls.a2a),
            a2aSendUrl: `${absolute(entry.urls.a2a)}/message:send`,
            payment: entry.paymentState === "payment-enabled"
              ? {
                  state: "payment-enabled",
                  acceptsPayment: true,
                  rail: "x402",
                  amountUsdc: entry.priceUsdc,
                  discoveryUrl: absolute(entry.urls.x402),
                }
              : {
                  state: entry.paymentState,
                  acceptsPayment: false,
                },
            ...(entry.extensions ? { extensions: entry.extensions } : {}),
            ...(entry.ap2 ? { ap2: entry.ap2 } : {}),
          })),
        },
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
