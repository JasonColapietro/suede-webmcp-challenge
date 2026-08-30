import { SITE_URL } from "@/lib/site";
import { A2A_PROTOCOL_VERSION } from "@/lib/discovery/a2a-contract";
import type { Ap2Readiness } from "@/lib/rails/ap2/config";
import { isAp2ServiceEligible } from "@/lib/rails/ap2-eligibility";
import {
  AP2_CHECKOUT_MANDATE_DATA_KEY,
  AP2_CHECKOUT_RECEIPT_DATA_KEY,
  AP2_EXTENSION_URI,
  AP2_PAYMENT_MANDATE_DATA_KEY,
  AP2_SELLER_SUBPROFILE,
} from "@/lib/rails/ap2/types";
import {
  PUBLIC_PAYMENT_PROJECTION,
  type PublicPaymentState,
} from "@/lib/public-payment-readiness";

export interface SuedeAgentCardInput {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly priceUsdc: number;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly paymentState: PublicPaymentState;
  readonly publishedLive: boolean;
  /** Local execution and relay-v2 are AP2-safe; legacy relays are not. */
  readonly fulfillmentSupportsAp2: boolean;
  readonly exampleInput?: Readonly<Record<string, unknown>>;
  readonly exampleOutput?: Readonly<Record<string, unknown>>;
  readonly reviewPolicy?: string;
  readonly dataHandling?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type Ap2DiscoveryStatus = Pick<Ap2Readiness, "mode" | "ready">;

export function projectAp2Discovery(status?: Ap2DiscoveryStatus) {
  if (!status?.ready || status.mode === "off") return null;
  return {
    protocol: "AP2",
    version: "0.2",
    profile: "merchant",
    status: "experimental",
    mode: status.mode,
    extensionUri: AP2_EXTENSION_URI,
    settlementRail: "x402-v2",
    negotiationHeader: "A2A-Extensions",
    compatibilityHeader: "X-A2A-Extensions",
    mandateDataKeys: [
      AP2_CHECKOUT_MANDATE_DATA_KEY,
      AP2_PAYMENT_MANDATE_DATA_KEY,
    ],
    merchantReceiptDataKey: AP2_CHECKOUT_RECEIPT_DATA_KEY,
    sellerSubprofile: AP2_SELLER_SUBPROFILE,
  } as const;
}

/**
 * A2A 1.0 AgentCard for the native HTTP+JSON interface. x402 remains the
 * payment rail and direct-run compatibility surface under the typed Suede
 * extension; it is not misrepresented as an A2A protocol binding.
 */
export function buildSuedeAgentCard(
  input: SuedeAgentCardInput,
  ap2Status?: Ap2DiscoveryStatus,
) {
  const acceptsPayment = input.paymentState === "payment-enabled";
  const ap2 = isAp2ServiceEligible({
    priceUsdc: input.priceUsdc,
    acceptsPayment,
    publishedLive: input.publishedLive,
    fulfillmentSupportsAp2: input.fulfillmentSupportsAp2,
  }) ? projectAp2Discovery(ap2Status) : null;
  const runUrl = `${SITE_URL}/api/agents/${input.slug}/run`;
  const a2aUrl = `${SITE_URL}/api/agents/${input.slug}/a2a`;
  const pricing = acceptsPayment
    ? {
        state: "payment-enabled" as const,
        acceptsPayment: true as const,
        amountUsdc: input.priceUsdc,
        rail: "x402" as const,
        network: "eip155:8453" as const,
      }
    : {
        state: input.paymentState,
        acceptsPayment: false as const,
        amountUsdc: input.priceUsdc,
      };
  return {
    name: input.name,
    description: input.description,
    supportedInterfaces: [
      {
        url: a2aUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: "Suede Labs AI",
      url: SITE_URL,
    },
    version: "1.0.0",
    documentationUrl: `${SITE_URL}/a/${input.slug}`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        ...(acceptsPayment
          ? [{
              uri: `${SITE_URL}/docs/payments#caller-pays`,
              description: "This payment-enabled service uses an x402 v2 payment challenge and PAYMENT-SIGNATURE retry.",
              required: false,
              params: {
                version: 2,
                rail: "x402",
                network: "eip155:8453",
                amountUsdc: input.priceUsdc,
                paymentHeader: "PAYMENT-SIGNATURE",
                discoveryUrl: `${SITE_URL}/api/agents/${input.slug}/.well-known/x402`,
              },
            }]
          : []),
        ...Object.entries(input.extensions ?? {}).map(([uri, params]) => ({
          uri,
          description: "Suede Resource Product contract for this exact immutable release.",
          required: false,
          params,
        })),
        ...(ap2
          ? [{
              uri: AP2_EXTENSION_URI,
              description:
                "Experimental AP2 v0.2 merchant authorization before x402 v2 settlement.",
              required: ap2.mode === "required",
              params: {
                protocol: ap2.protocol,
                version: ap2.version,
                profile: ap2.profile,
                status: ap2.status,
                settlementRail: ap2.settlementRail,
                negotiationHeader: ap2.negotiationHeader,
                compatibilityHeader: ap2.compatibilityHeader,
                mandateDataKeys: ap2.mandateDataKeys,
                merchantReceiptDataKey: ap2.merchantReceiptDataKey,
                sellerSubprofile: ap2.sellerSubprofile,
                documentationUrl: SITE_URL + "/docs/payments#ap2",
              },
            }]
           : []),
      ],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: `run-${input.slug}`,
        name: input.name,
        description: input.description,
        tags: [...input.tags],
        ...(input.exampleInput
          ? { examples: [JSON.stringify(input.exampleInput)] }
          : {}),
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    "x-suede": {
      projection: PUBLIC_PAYMENT_PROJECTION,
      slug: input.slug,
      a2aEndpoint: `${a2aUrl}/message:send`,
      endpoint: runUrl,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      ...(input.exampleInput ? { exampleInput: input.exampleInput } : {}),
      ...(input.exampleOutput ? { exampleOutput: input.exampleOutput } : {}),
      pricing,
      ...(ap2 ? { ap2 } : {}),
      ...(input.reviewPolicy ? { reviewPolicy: input.reviewPolicy } : {}),
      ...(input.dataHandling ? { dataHandling: input.dataHandling } : {}),
      ...(input.extensions ? { extensions: input.extensions } : {}),
    },
  };
}
