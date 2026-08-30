import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";
import { buildCatalog } from "@/lib/catalog";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import { projectAp2Discovery } from "@/lib/discovery/agent-card";
import { publicAp2RuntimeStatus } from "@/lib/rails/ap2/config";
import { AP2_EXTENSION_URI } from "@/lib/rails/ap2/types";
import { PUBLIC_PAYMENT_PROJECTION } from "@/lib/public-payment-readiness";

export const runtime = "nodejs";

const AGENT_PARAMETER = {
  name: "agent",
  in: "path",
  required: true,
  description: "Published agent slug (preferred canonical identity) or legacy id.",
  schema: { type: "string", minLength: 1 },
} as const;

const TASK_PARAMETER = {
  name: "taskId",
  in: "path",
  required: true,
  description: "Opaque A2A task identifier.",
  schema: { type: "string", minLength: 1 },
} as const;

const A2A_VERSION_PARAMETER = {
  name: "A2A-Version",
  in: "header",
  required: true,
  description: "A2A protocol version. This interface supports 1.0.",
  schema: { type: "string", const: "1.0" },
} as const;

const AP2_EXTENSION_PARAMETER = {
  name: "A2A-Extensions",
  in: "header",
  required: false,
  description:
    "Negotiate the advertised experimental AP2 v0.2 merchant extension. In required mode this header and valid mandates are required for priced Live execution.",
  schema: { type: "string", const: AP2_EXTENSION_URI },
} as const;

const AP2_COMPATIBILITY_PARAMETER = {
  name: "X-A2A-Extensions",
  in: "header",
  required: false,
  deprecated: true,
  description:
    "Temporary sample-client compatibility spelling for A2A-Extensions.",
  schema: { type: "string", const: AP2_EXTENSION_URI },
} as const;

const A2A_ERROR_RESPONSE = {
  description: "A2A request failed.",
  content: {
    "application/a2a+json": {
      schema: { type: "object", additionalProperties: true },
    },
  },
} as const;

const ERROR_RESPONSE = {
  description: "Request failed.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
} as const;

const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Suede Agent Studio public agent API",
    version: "0.3.0",
    description:
      "Public catalog, A2A 1.0 HTTP+JSON execution, discovery documents, portable templates, and machine-run endpoints for agents published from Suede Agent Studio. Priced live runs use x402; explicit dry-runs and free agents can run without payment.",
    contact: {
      name: "Suede Agent Studio support",
      email: "support@suedeai.ai",
      url: `${SITE_URL}/contact`,
    },
  },
  servers: [{ url: SITE_URL }],
  paths: {
    "/api/mcp": {
      post: {
        operationId: "callMcpEndpoint",
        summary: "Call the MCP endpoint (JSON-RPC over HTTP)",
        description:
          "Model Context Protocol endpoint exposing the currently eligible published agents returned by tools/list. Company employees, relay-backed services, and agents without an immutable Live deployment are excluded. Priced tools bill pre-funded workspace credit via an Authorization: Bearer workspace-key header (a UUID). Free eligible tools need no key.",
        parameters: [
          {
            name: "Authorization",
            in: "header",
            required: false,
            description: "Bearer workspace key (UUID) for priced tool calls.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true },
            },
          },
        },
        responses: {
          "200": { description: "JSON-RPC result or tool error." },
          "202": { description: "Notification acknowledged." },
          "400": ERROR_RESPONSE,
          "401": { description: "Bearer is not a valid workspace key." },
          "403": ERROR_RESPONSE,
          "429": ERROR_RESPONSE,
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/api/gateway/topup": {
      post: {
        operationId: "topUpWorkspaceCredit",
        summary: "Fund workspace credit over x402 (USDC on Base)",
        description:
          "Machine-payable credit topup. Authenticate with Authorization: Bearer workspace-key. Without an X-PAYMENT header the route answers HTTP 402 with x402 payment instructions; pay and retry with the X-PAYMENT header to credit the workspace.",
        parameters: [
          {
            name: "tier",
            in: "query",
            required: false,
            description: "USDC topup amount: 1, 5, or 20 (default 1).",
            schema: { type: "integer", enum: [1, 5, 20] },
          },
          {
            name: "X-PAYMENT",
            in: "header",
            required: false,
            description: "x402 payment payload settling the selected tier.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Credit added: { creditsAdded, transaction, payer }." },
          "400": ERROR_RESPONSE,
          "401": ERROR_RESPONSE,
          "402": { description: "Payment required; body carries x402 accepts." },
          "500": ERROR_RESPONSE,
          "503": ERROR_RESPONSE,
        },
      },
    },
    "/api/catalog": {
      get: {
        operationId: "listPublishedAgents",
        summary: "List currently published agents",
        responses: {
          "200": {
            description: "Current public catalog.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Catalog" },
              },
            },
          },
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/api/services": {
      get: {
        operationId: "listCuratedBusinessServices",
        summary: "List Suede-curated business services",
        description:
          "A deliberately small shelf of business decision services with typed input and output schemas, safe examples, pricing facts, and explicit human-review boundaries.",
        responses: {
          "200": {
            description: "Current curated business service feed.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CuratedServiceCatalog" },
              },
            },
          },
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/.well-known/x402": {
      get: {
        operationId: "getX402Index",
        summary: "Read current x402 payment discovery",
        responses: {
          "200": { description: "x402 discovery index for published agents." },
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/.well-known/agent-card.json": {
      get: {
        operationId: "getStudioAgentCard",
        summary: "Read the root agent and capability card",
        responses: {
          "200": { description: "Current published-agent capability card." },
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/.well-known/agent-card.json": {
      get: {
        operationId: "getPublishedAgentCard",
        summary: "Read one published agent's capability card",
        parameters: [AGENT_PARAMETER],
        responses: {
          "200": { description: "Capability, provider, and pricing details." },
          "404": ERROR_RESPONSE,
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/.well-known/x402": {
      get: {
        operationId: "getPublishedAgentX402",
        summary: "Read one published agent's x402 terms",
        parameters: [AGENT_PARAMETER],
        responses: {
          "200": { description: "Current x402 payment requirements." },
          "404": ERROR_RESPONSE,
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/a2a": {
      get: {
        operationId: "getPublishedAgentA2a",
        summary: "Read one published agent's A2A 1.0 AgentCard",
        parameters: [AGENT_PARAMETER],
        responses: {
          "200": { description: "A2A AgentCard advertising an HTTP+JSON 1.0 interface." },
          "404": ERROR_RESPONSE,
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/a2a/message:send": {
      post: {
        operationId: "sendPublishedAgentA2aMessage",
        summary: "Execute one published agent via A2A SendMessage",
        description:
          "A2A 1.0 HTTP+JSON SendMessage. Send exactly one structured data part containing the agent input object. Returns a direct ROLE_AGENT message. Priced live calls preserve the same x402 HTTP 402 challenge and PAYMENT-SIGNATURE retry as the direct run endpoint.",
        parameters: [
          AGENT_PARAMETER,
          A2A_VERSION_PARAMETER,
          {
            name: "PAYMENT-SIGNATURE",
            in: "header",
            required: false,
            description: "Base64-encoded x402 v2 payment payload for a priced live call.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/a2a+json": {
              schema: { $ref: "#/components/schemas/A2ASendMessageRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Direct synchronous A2A message response.",
            content: {
              "application/a2a+json": {
                schema: { $ref: "#/components/schemas/A2ASendMessageResponse" },
              },
            },
          },
          "400": A2A_ERROR_RESPONSE,
          "402": { description: "x402 payment required for a priced live call." },
          "404": A2A_ERROR_RESPONSE,
          "409": A2A_ERROR_RESPONSE,
          "429": A2A_ERROR_RESPONSE,
          "500": A2A_ERROR_RESPONSE,
          "503": A2A_ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/a2a/message:stream": {
      post: {
        operationId: "streamPublishedAgentA2aMessage",
        summary: "A2A streaming capability probe",
        description: "Returns UnsupportedOperation because these synchronous services advertise streaming: false.",
        parameters: [AGENT_PARAMETER, A2A_VERSION_PARAMETER],
        responses: { "400": A2A_ERROR_RESPONSE },
      },
    },
    "/api/agents/{agent}/a2a/tasks": {
      get: {
        operationId: "listPublishedAgentA2aTasks",
        summary: "List A2A tasks",
        description: "These services return direct messages and retain no A2A tasks, so the list is empty.",
        parameters: [AGENT_PARAMETER, A2A_VERSION_PARAMETER],
        responses: {
          "200": {
            description: "Empty direct-message task collection.",
            content: {
              "application/a2a+json": {
                schema: { $ref: "#/components/schemas/A2AListTasksResponse" },
              },
            },
          },
          "400": A2A_ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/a2a/tasks/{taskId}": {
      get: {
        operationId: "getPublishedAgentA2aTask",
        summary: "Get an A2A task",
        description: "Direct-message services do not create tasks and return TaskNotFound.",
        parameters: [AGENT_PARAMETER, TASK_PARAMETER, A2A_VERSION_PARAMETER],
        responses: {
          "400": A2A_ERROR_RESPONSE,
          "404": A2A_ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/a2a/tasks/{taskId}:cancel": {
      post: {
        operationId: "cancelPublishedAgentA2aTask",
        summary: "Cancel an A2A task",
        description: "Direct-message services do not create tasks and return TaskNotFound.",
        parameters: [AGENT_PARAMETER, TASK_PARAMETER, A2A_VERSION_PARAMETER],
        responses: {
          "400": A2A_ERROR_RESPONSE,
          "404": A2A_ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/template": {
      get: {
        operationId: "downloadPublishedAgentTemplate",
        summary: "Download one published agent's portable template",
        parameters: [AGENT_PARAMETER],
        responses: {
          "200": {
            description: "Portable flow, run client, and README bundle.",
            headers: {
              "Content-Disposition": {
                schema: { type: "string" },
                description: "Attachment filename for the JSON bundle.",
              },
            },
          },
          "404": ERROR_RESPONSE,
          "500": ERROR_RESPONSE,
        },
      },
    },
    "/api/agents/{agent}/run": {
      post: {
        operationId: "runPublishedAgent",
        summary: "Run one published agent",
        description:
          "Send an input object. Set dryRun true for the explicit non-settling preview path. A priced live run without a valid PAYMENT-SIGNATURE header responds with HTTP 402 and current x402 v2 payment requirements. Legacy X-PAYMENT remains accepted during migration.",
        parameters: [
          AGENT_PARAMETER,
          {
            name: "PAYMENT-SIGNATURE",
            in: "header",
            required: false,
            description: "Base64-encoded x402 v2 payment payload for a priced live run.",
            schema: { type: "string" },
          },
          {
            name: "X-PAYMENT",
            in: "header",
            required: false,
            deprecated: true,
            description: "Legacy x402 v1 payment payload accepted during migration.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Run completed.",
            content: {
              "application/json": {
                schema: { oneOf: [
                  { $ref: "#/components/schemas/RunResult" },
                  { $ref: "#/components/schemas/ResourceRunEnvelope" },
                ] },
              },
            },
          },
          "400": ERROR_RESPONSE,
          "402": {
            description: "Payment required for a priced live run.",
          },
          "404": ERROR_RESPONSE,
          "409": ERROR_RESPONSE,
          "429": ERROR_RESPONSE,
          "500": ERROR_RESPONSE,
          "503": ERROR_RESPONSE,
        },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          message: { type: "string" },
        },
        required: ["error"],
        additionalProperties: true,
      },
      Catalog: {
        type: "object",
        properties: {
          service: { type: "string" },
          description: { type: "string" },
          site: { type: "string", format: "uri" },
          count: { type: "integer", minimum: 0 },
          agents: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["service", "site", "count", "agents"],
      },
      CuratedServiceCatalog: {
        type: "object",
        properties: {
          service: { type: "string" },
          operator: { type: "string" },
          description: { type: "string" },
          collection: { type: "string", const: "business-operations" },
          site: { type: "string", format: "uri" },
          readinessProjectionVersion: {
            type: "integer",
            const: PUBLIC_PAYMENT_PROJECTION.version,
          },
          count: { type: "integer", minimum: 0 },
          historicallySettledServiceCount: { type: "integer", minimum: 0 },
          services: {
            type: "array",
            items: {
              type: "object",
              properties: {
                readiness: { $ref: "#/components/schemas/CuratedServiceReadiness" },
              },
              required: ["readiness"],
              additionalProperties: true,
            },
          },
        },
        required: [
          "service",
          "operator",
          "collection",
          "site",
          "readinessProjectionVersion",
          "count",
          "historicallySettledServiceCount",
          "services",
        ],
        additionalProperties: false,
      },
      CuratedServiceReadiness: {
        type: "object",
        properties: {
          state: { type: "string", enum: [...PUBLIC_PAYMENT_PROJECTION.states] },
          publishedLive: { type: "boolean" },
          acceptsPayment: { type: "boolean" },
          previewAvailable: { type: "boolean" },
          hasSettledCalls: {
            type: "boolean",
            description:
              "Historical evidence only: true when this service has at least one recorded settled call. It does not assert current payment readiness.",
          },
          settledCalls: { type: "integer", minimum: 0 },
          lastCallAt: { type: ["integer", "null"], minimum: 0 },
        },
        required: [
          "state",
          "publishedLive",
          "acceptsPayment",
          "previewAvailable",
          "hasSettledCalls",
          "settledCalls",
          "lastCallAt",
        ],
        additionalProperties: false,
      },
      RunRequest: {
        type: "object",
        properties: {
          input: { type: "object", additionalProperties: true },
          runVariables: { type: "object", additionalProperties: true },
          dryRun: { type: "boolean" },
        },
        additionalProperties: true,
      },
      A2ASendMessageRequest: {
        type: "object",
        properties: {
          message: {
            type: "object",
            properties: {
              messageId: { type: "string", minLength: 1 },
              contextId: { type: "string", minLength: 1 },
              role: { type: "string", const: "ROLE_USER" },
              parts: {
                type: "array",
                minItems: 1,
                maxItems: 1,
                items: {
                  type: "object",
                  properties: {
                    data: { type: "object", additionalProperties: true },
                    mediaType: { type: "string", const: "application/json" },
                  },
                  required: ["data"],
                  additionalProperties: true,
                },
              },
            },
            required: ["messageId", "role", "parts"],
            additionalProperties: true,
          },
        },
        required: ["message"],
        additionalProperties: true,
      },
      A2ASendMessageResponse: {
        type: "object",
        properties: {
          message: {
            type: "object",
            properties: {
              messageId: { type: "string" },
              contextId: { type: "string" },
              role: { type: "string", const: "ROLE_AGENT" },
              parts: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } },
              metadata: { type: "object", additionalProperties: true },
            },
            required: ["messageId", "contextId", "role", "parts"],
            additionalProperties: true,
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      A2AListTasksResponse: {
        type: "object",
        properties: {
          tasks: { type: "array", items: { type: "object", additionalProperties: true } },
          totalSize: { type: "integer", const: 0 },
          pageSize: { type: "integer", minimum: 1, maximum: 100 },
          nextPageToken: { type: "string", const: "" },
        },
        required: ["tasks", "totalSize", "pageSize", "nextPageToken"],
        additionalProperties: false,
      },
      RunResult: {
        type: "object",
        properties: {
          runId: { type: "string" },
          status: { type: "string", enum: ["done", "error"] },
          totalCostUsdc: { type: "number" },
          outputs: { type: "object", additionalProperties: true },
          result: {
            type: "object",
            additionalProperties: true,
            description: "Best-effort normalized result for a curated service; raw outputs remain available.",
          },
          settled: { type: "boolean" },
          relayed: { type: "boolean" },
          transaction: { type: "string" },
          payer: { type: "string" },
        },
        required: ["runId", "status", "totalCostUsdc", "outputs", "settled"],
        additionalProperties: false,
      },
      ResourceRunEnvelope: {
        type: "object",
        properties: {
          result: {},
          resourceReceipt: {
            type: "object",
            properties: {
              resourceProductId: { type: "string" },
              resourceVersion: { type: "string" },
              semanticHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
              freshness: { type: "string", enum: ["fresh", "stale", "mixed"] },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    sourceSnapshotId: { type: "string" },
                    locator: { type: "string" },
                    observedAt: { type: "string", format: "date-time" },
                    fieldHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    conflict: { type: "string" },
                  },
                  required: ["id", "sourceSnapshotId", "locator", "observedAt"],
                  additionalProperties: false,
                },
              },
              unknowns: { type: "array", items: { type: "string" } },
              conflicts: { type: "array", items: { type: "string" } },
              outputSchemaValid: { type: "boolean", const: true },
            },
            required: ["resourceProductId", "resourceVersion", "semanticHash", "freshness", "evidence", "unknowns", "conflicts", "outputSchemaValid"],
            additionalProperties: false,
          },
          payment: {
            type: "object",
            properties: {
              priceUsdc: { type: "number", minimum: 0 },
              state: { type: "string", enum: ["free", "challenged", "credited", "settled", "refunded", "failed"] },
              receiptId: { type: ["string", "null"] },
            },
            required: ["priceUsdc", "state", "receiptId"],
            additionalProperties: false,
          },
        },
        required: ["result", "resourceReceipt", "payment"],
        additionalProperties: false,
      },
    },
  },
} as const;

function publicOpenApiDocument(
  ap2: NonNullable<ReturnType<typeof projectAp2Discovery>> | null,
  base = OPENAPI_DOCUMENT,
) {
  if (!ap2) return base;
  const a2aPath = base.paths["/api/agents/{agent}/a2a/message:send"];
  const runPath = base.paths["/api/agents/{agent}/run"];
  const ap2AuthorizationSchema = {
    type: "object",
    properties: {
      authorizationMode: { type: "string", enum: ["direct", "autonomous"] },
      checkoutMandateSdJwt: { type: "string", minLength: 1 },
      paymentMandateSdJwt: { type: "string", minLength: 1 },
    },
    required: ["authorizationMode", "checkoutMandateSdJwt", "paymentMandateSdJwt"],
    additionalProperties: false,
  } as const;
  return {
    ...base,
    "x-suede-ap2": {
      ...ap2,
      requiredForPricedLive: ap2.mode === "required",
      documentationUrl: SITE_URL + "/docs/payments#ap2",
    },
    paths: {
      ...base.paths,
      "/.well-known/ap2.json": {
        get: {
          operationId: "getAp2MerchantIndex",
          summary: "Read the experimental AP2 merchant discovery index",
          responses: {
            "200": { description: "Current AP2 merchant profile and eligible published services." },
            "404": ERROR_RESPONSE,
          },
        },
      },
      "/.well-known/ap2-jwks.json": {
        get: {
          operationId: "getAp2MerchantJwks",
          summary: "Read AP2 merchant receipt verification keys",
          responses: {
            "200": { description: "Public ES256 keys for verifying merchant checkout quotes and receipts." },
            "404": ERROR_RESPONSE,
          },
        },
      },
      "/api/agents/{agent}/.well-known/ap2": {
        get: {
          operationId: "getPublishedAgentAp2",
          summary: "Read one published service's experimental AP2 terms",
          parameters: [AGENT_PARAMETER],
          responses: {
            "200": { description: "Merchant authorization, checkout, receipt, and x402 binding metadata." },
            "404": ERROR_RESPONSE,
            "500": ERROR_RESPONSE,
          },
        },
      },
      "/api/agents/{agent}/ap2/checkout": {
        post: {
          operationId: "issuePublishedAgentAp2Checkout",
          summary: "Request a merchant-signed AP2 checkout quote",
          description:
            "Runs the same company, input, payout, and immutable Live-deployment preflight as execution, then returns a short-lived signed checkout JWT without settling or running the service.",
          parameters: [AGENT_PARAMETER],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    input: { type: "object", additionalProperties: true },
                    runVariables: { type: "object", additionalProperties: true },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": { description: "Merchant-signed AP2 checkout quote and exact x402 payment terms." },
            "400": ERROR_RESPONSE,
            "404": ERROR_RESPONSE,
            "409": ERROR_RESPONSE,
            "429": ERROR_RESPONSE,
            "503": ERROR_RESPONSE,
          },
        },
      },
      "/api/agents/{agent}/a2a/message:send": {
        ...a2aPath,
        post: {
          ...a2aPath.post,
          description:
            a2aPath.post.description
            + " When advertised, experimental AP2 v0.2 merchant authorization is negotiated with A2A-Extensions; x402 v2 remains the settlement rail.",
          parameters: [
            ...a2aPath.post.parameters,
            AP2_EXTENSION_PARAMETER,
            AP2_COMPATIBILITY_PARAMETER,
          ],
        },
      },
      "/api/agents/{agent}/run": {
        ...runPath,
        post: {
          ...runPath.post,
          description:
            runPath.post.description
            + " When advertised, the ap2 body member presents experimental AP2 v0.2 merchant authorization before x402 settlement.",
        },
      },
    },
    components: {
      ...base.components,
      schemas: {
        ...base.components.schemas,
        RunRequest: {
          ...base.components.schemas.RunRequest,
          properties: {
            ...base.components.schemas.RunRequest.properties,
            ap2: ap2AuthorizationSchema,
          },
        },
        A2ASendMessageRequest: {
          ...base.components.schemas.A2ASendMessageRequest,
          description:
            "When AP2 is negotiated, include one business-input data part plus Checkout and Payment Mandate SD-JWT data parts using the advertised AP2 keys.",
        },
        RunResult: {
          ...base.components.schemas.RunResult,
          properties: {
            ...base.components.schemas.RunResult.properties,
            ap2: {
              type: "object",
              properties: {
                profile: { type: "string", const: "ap2-v0.2-experimental" },
                authorizationMode: { type: ["string", "null"], enum: ["direct", "autonomous", null] },
                checkoutReceipt: { type: "string" },
              },
              required: ["profile", "authorizationMode", "checkoutReceipt"],
              additionalProperties: false,
            },
          },
        },
      },
    },
  };
}

export async function GET(): Promise<NextResponse> {
  const [ap2Status, entries] = await Promise.all([
    publicAp2RuntimeStatus(),
    buildCatalog().catch(() => []),
  ]);
  const resourceContracts = entries.flatMap((entry) => {
    const contract = entry.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI];
    return contract === undefined ? [] : [{ slug: entry.slug, urls: entry.urls, contract }];
  });
  const document = {
    ...OPENAPI_DOCUMENT,
    "x-suede-resource-contracts": {
      extensionUri: RESOURCE_CONTRACT_EXTENSION_URI,
      contracts: resourceContracts,
    },
  };
  return NextResponse.json(publicOpenApiDocument(projectAp2Discovery(ap2Status), document), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
