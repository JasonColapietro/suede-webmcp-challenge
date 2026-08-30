import { z } from "zod";
import { SITE_URL } from "@/lib/site";
import { resolveAgent } from "@/lib/agents";
import { A2A_MEDIA_TYPE, A2A_PROTOCOL_VERSION } from "@/lib/discovery/a2a-contract";
import {
  publicAp2RuntimeStatus,
  type Ap2Readiness,
} from "@/lib/rails/ap2/config";

export { A2A_MEDIA_TYPE, A2A_PROTOCOL_VERSION } from "@/lib/discovery/a2a-contract";
const LEGACY_DEFAULT_VERSION = "0.3";
const MAX_A2A_BODY_BYTES = 256 * 1024;
const MAX_AP2_PRESENTATION_BYTES = 96 * 1024;
const AP2_EXTENSION_URI = "https://github.com/google-agentic-commerce/ap2/v1";
const AP2_CHECKOUT_MANDATE_KEY = "ap2.mandates.CheckoutMandateSdJwt";
const AP2_PAYMENT_MANDATE_KEY = "ap2.mandates.PaymentMandateSdJwt";
const AP2_CHECKOUT_RECEIPT_KEY = "ap2.CheckoutReceipt";

export interface A2AAgentRouteContext {
  params: Promise<{ agent: string }>;
}

export type PublishedAgentRunHandler = (
  request: Request,
  context: A2AAgentRouteContext,
) => Promise<Response>;

type PublicAp2RuntimeStatusResolver = () => Promise<Pick<Ap2Readiness, "advertise">>;

const sendMessageSchema = z.object({
  message: z.object({
    messageId: z.string().trim().min(1).max(256),
    contextId: z.string().trim().min(1).max(256).optional(),
    taskId: z.string().trim().min(1).max(256).optional(),
    role: z.literal("ROLE_USER"),
    parts: z.array(z.record(z.string(), z.unknown())).min(1).max(16),
  }).passthrough(),
  configuration: z.object({
    acceptedOutputModes: z.array(z.string().trim().min(1).max(128)).max(16).optional(),
    taskPushNotificationConfig: z.unknown().optional(),
  }).passthrough().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

interface A2AErrorOptions {
  status: number;
  statusName: string;
  reason: string;
  message: string;
  metadata?: Record<string, string>;
  violations?: readonly string[];
  retryAfter?: string;
  domain?: string;
}

function responseHeaders(contentType = A2A_MEDIA_TYPE): Headers {
  return new Headers({
    "A2A-Version": A2A_PROTOCOL_VERSION,
    "cache-control": "no-store",
    "content-type": contentType,
  });
}

export function a2aError(options: A2AErrorOptions): Response {
  const headers = responseHeaders();
  if (options.retryAfter) headers.set("Retry-After", options.retryAfter);
  return new Response(JSON.stringify({
    error: {
      code: options.status,
      status: options.statusName,
      message: options.message,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: options.reason,
          domain: options.domain ?? "a2a-protocol.org",
          ...(options.metadata ? { metadata: options.metadata } : {}),
        },
        ...(options.violations && options.violations.length > 0
          ? [{
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: options.violations.slice(0, 64).map((description) => ({
                field: "message.parts[0].data",
                description: description.slice(0, 512),
              })),
            }]
          : []),
      ],
    },
  }), {
    status: options.status,
    headers,
  });
}

export async function validateA2AAgent(
  context: A2AAgentRouteContext,
): Promise<Response | null> {
  const { agent } = await context.params;
  const record = await resolveAgent(agent);
  if (record?.status === "live") return null;
  return a2aError({
    status: 404,
    statusName: "NOT_FOUND",
    reason: "AGENT_NOT_FOUND",
    message: "The specified agent does not exist or is not accessible.",
    domain: "agents.suedeai.ai",
  });
}

function requestedA2AVersion(request: Request): string {
  const header = request.headers.get("a2a-version")?.trim();
  const url = new URL(request.url);
  const query = (url.searchParams.get("A2A-Version") ??
    url.searchParams.get("a2a-version"))?.trim();
  const requested = header || query || LEGACY_DEFAULT_VERSION;
  return requested.length <= 16 && /^\d+\.\d+$/.test(requested)
    ? requested
    : "invalid";
}

export function validateA2AVersion(request: Request): Response | null {
  const requested = requestedA2AVersion(request);
  if (requested === A2A_PROTOCOL_VERSION) return null;
  return a2aError({
    status: 400,
    statusName: "FAILED_PRECONDITION",
    reason: "VERSION_NOT_SUPPORTED",
    message: `A2A protocol version ${requested} is not supported by this interface.`,
    metadata: {
      requestedVersion: requested,
      supportedVersions: A2A_PROTOCOL_VERSION,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestContentTypeSupported(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (!contentType) return true;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === A2A_MEDIA_TYPE || mediaType === "application/json";
}

function contentTypeError(message: string): Response {
  return a2aError({
    status: 400,
    statusName: "INVALID_ARGUMENT",
    reason: "CONTENT_TYPE_NOT_SUPPORTED",
    message,
  });
}

function taskNotFound(taskId: string): Response {
  return a2aError({
    status: 404,
    statusName: "NOT_FOUND",
    reason: "TASK_NOT_FOUND",
    message: "The specified task ID does not exist or is not accessible.",
    metadata: { taskId: taskId.slice(0, 256) },
  });
}

async function readBoundedJson(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_A2A_BODY_BYTES) {
    return {
      ok: false,
      response: a2aError({
        status: 413,
        statusName: "RESOURCE_EXHAUSTED",
        reason: "REQUEST_TOO_LARGE",
        message: `A2A request bodies are limited to ${MAX_A2A_BODY_BYTES} bytes.`,
        domain: "agents.suedeai.ai",
      }),
    };
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_A2A_BODY_BYTES) {
    return {
      ok: false,
      response: a2aError({
        status: 413,
        statusName: "RESOURCE_EXHAUSTED",
        reason: "REQUEST_TOO_LARGE",
        message: `A2A request bodies are limited to ${MAX_A2A_BODY_BYTES} bytes.`,
        domain: "agents.suedeai.ai",
      }),
    };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: a2aError({
        status: 400,
        statusName: "INVALID_ARGUMENT",
        reason: "INVALID_REQUEST",
        message: "The request body must be valid JSON.",
      }),
    };
  }
}

function extractStructuredInput(
  value: unknown,
):
  | {
      ok: true;
      input: Record<string, unknown>;
      messageId: string;
      contextId?: string;
      ap2?: {
        authorizationMode: "direct" | "autonomous";
        checkoutMandateSdJwt: string;
        paymentMandateSdJwt: string;
      };
    }
  | { ok: false; response: Response } {
  const parsed = sendMessageSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      response: a2aError({
        status: 400,
        statusName: "INVALID_ARGUMENT",
        reason: "INVALID_REQUEST",
        message: "SendMessage requires a ROLE_USER message with a messageId and at least one part.",
      }),
    };
  }

  if (parsed.data.message.taskId) {
    return { ok: false, response: taskNotFound(parsed.data.message.taskId) };
  }
  if (parsed.data.configuration?.taskPushNotificationConfig !== undefined) {
    return {
      ok: false,
      response: a2aError({
        status: 400,
        statusName: "FAILED_PRECONDITION",
        reason: "PUSH_NOTIFICATION_NOT_SUPPORTED",
        message: "This synchronous A2A interface does not support push notifications.",
      }),
    };
  }

  const acceptedModes = parsed.data.configuration?.acceptedOutputModes;
  if (
    acceptedModes &&
    acceptedModes.length > 0 &&
    !acceptedModes.some((mode) => {
      const normalized = mode.toLowerCase();
      return normalized === "application/json" || normalized === A2A_MEDIA_TYPE || normalized === "*/*";
    })
  ) {
    return {
      ok: false,
      response: contentTypeError("This agent returns structured application/json output."),
    };
  }

  let dataPart: Record<string, unknown> | null = null;
  let checkoutMandateSdJwt: string | null = null;
  let paymentMandateSdJwt: string | null = null;
  for (const part of parsed.data.message.parts) {
    const contentFields = ["text", "raw", "url", "data"].filter((field) =>
      Object.prototype.hasOwnProperty.call(part, field));
    if (contentFields.length !== 1) {
      return {
        ok: false,
        response: a2aError({
          status: 400,
          statusName: "INVALID_ARGUMENT",
          reason: "INVALID_REQUEST",
          message: "Each A2A message part must contain exactly one of text, raw, url, or data.",
        }),
      };
    }
    if (contentFields[0] !== "data") {
      return {
        ok: false,
        response: contentTypeError(
          "This business service accepts one structured data part; text and file parts are not supported.",
        ),
      };
    }
    if (!isRecord(part.data)) {
      return {
        ok: false,
        response: a2aError({
          status: 400,
          statusName: "INVALID_ARGUMENT",
          reason: "INVALID_REQUEST",
          message: "Send one data part containing a JSON object.",
        }),
      };
    }
    const mediaType = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : null;
    if (mediaType && mediaType !== "application/json" && mediaType !== A2A_MEDIA_TYPE) {
      return {
        ok: false,
        response: contentTypeError("The structured data part must use application/json."),
      };
    }
    const keys = Object.keys(part.data);
    const isAp2Part = keys.length > 0 && keys.every((key) =>
      key === AP2_CHECKOUT_MANDATE_KEY || key === AP2_PAYMENT_MANDATE_KEY);
    if (isAp2Part) {
      const checkout = part.data[AP2_CHECKOUT_MANDATE_KEY];
      const payment = part.data[AP2_PAYMENT_MANDATE_KEY];
      if (
        (checkout !== undefined &&
          (typeof checkout !== "string" || checkout.length === 0 ||
            new TextEncoder().encode(checkout).byteLength > MAX_AP2_PRESENTATION_BYTES ||
            checkoutMandateSdJwt !== null)) ||
        (payment !== undefined &&
          (typeof payment !== "string" || payment.length === 0 ||
            new TextEncoder().encode(payment).byteLength > MAX_AP2_PRESENTATION_BYTES ||
            paymentMandateSdJwt !== null))
      ) {
        return {
          ok: false,
          response: a2aError({
            status: 400,
            statusName: "INVALID_ARGUMENT",
            reason: "INVALID_AP2_PRESENTATION",
            message: "AP2 mandate parts must be unique, non-empty, and within the presentation limit.",
            domain: "agents.suedeai.ai",
          }),
        };
      }
      if (typeof checkout === "string") checkoutMandateSdJwt = checkout;
      if (typeof payment === "string") paymentMandateSdJwt = payment;
      continue;
    }
    if (dataPart !== null) {
      return {
        ok: false,
        response: a2aError({
          status: 400,
          statusName: "INVALID_ARGUMENT",
          reason: "INVALID_REQUEST",
          message: "Send exactly one business-input data part plus optional AP2 mandate data parts.",
        }),
      };
    }
    dataPart = part.data;
  }

  if (dataPart === null) {
    return {
      ok: false,
      response: a2aError({
        status: 400,
        statusName: "INVALID_ARGUMENT",
        reason: "INVALID_REQUEST",
        message: "Send one data part containing a JSON object.",
      }),
    };
  }
  if ((paymentMandateSdJwt === null) !== (checkoutMandateSdJwt === null)) {
    return {
      ok: false,
      response: a2aError({
        status: 400,
        statusName: "INVALID_ARGUMENT",
        reason: "INVALID_AP2_PRESENTATION",
        message: "AP2 Checkout and Payment Mandates must be presented together.",
        domain: "agents.suedeai.ai",
      }),
    };
  }
  const checkoutChainLength = checkoutMandateSdJwt?.split("~~").length ?? 0;
  const paymentChainLength = paymentMandateSdJwt?.split("~~").length ?? 0;
  if (
    checkoutMandateSdJwt !== null
    && paymentMandateSdJwt !== null
    && !(
      checkoutChainLength === paymentChainLength
      && (checkoutChainLength === 1 || checkoutChainLength === 2)
    )
  ) {
    return {
      ok: false,
      response: a2aError({
        status: 400,
        statusName: "INVALID_ARGUMENT",
        reason: "INVALID_AP2_PRESENTATION",
        message: "AP2 mandate chains must both be direct or both contain one autonomous delegation hop.",
        domain: "agents.suedeai.ai",
      }),
    };
  }

  return {
    ok: true,
    input: dataPart,
    messageId: parsed.data.message.messageId,
    ...(parsed.data.message.contextId
      ? { contextId: parsed.data.message.contextId }
      : {}),
    ...(checkoutMandateSdJwt !== null && paymentMandateSdJwt !== null
      ? {
          ap2: {
            authorizationMode:
              checkoutChainLength === 2
                ? "autonomous" as const
                : "direct" as const,
            checkoutMandateSdJwt,
            paymentMandateSdJwt,
          },
        }
      : {}),
  };
}

function requestedA2AExtensions(request: Request): string[] {
  const values = [
    request.headers.get("a2a-extensions"),
    request.headers.get("x-a2a-extensions"),
  ].filter((value): value is string => value !== null);
  return [...new Set(values.flatMap((value) => value.split(","))
    .map((value) => value.trim()).filter(Boolean))];
}

function containsAp2MandateData(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.message) || !Array.isArray(value.message.parts)) {
    return false;
  }
  return value.message.parts.some((part) =>
    isRecord(part)
    && isRecord(part.data)
    && (
      Object.prototype.hasOwnProperty.call(part.data, AP2_CHECKOUT_MANDATE_KEY)
      || Object.prototype.hasOwnProperty.call(part.data, AP2_PAYMENT_MANDATE_KEY)
    ));
}

function runErrorStatusName(status: number): string {
  if (status === 400) return "INVALID_ARGUMENT";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "FAILED_PRECONDITION";
  if (status === 429) return "RESOURCE_EXHAUSTED";
  if (status === 503) return "UNAVAILABLE";
  return "INTERNAL";
}

function copyRunResponse(response: Response, activatedExtensions: readonly string[]): Response {
  const headers = new Headers(response.headers);
  headers.set("A2A-Version", A2A_PROTOCOL_VERSION);
  headers.set("cache-control", "no-store");
  if (activatedExtensions.length > 0) {
    headers.set("A2A-Extensions", activatedExtensions.join(", "));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function publicRunMetadata(payload: Record<string, unknown>, requestMessageId: string) {
  const metadata: Record<string, unknown> = { requestMessageId };
  for (const key of ["runId", "status", "totalCostUsdc", "settled", "mode", "relayed", "transaction"]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) metadata[key] = payload[key];
  }
  return { "x-suede": metadata };
}

/**
 * Implements A2A 1.0 SendMessage over the HTTP+JSON binding. The public run
 * handler remains the execution and x402 authority; this adapter only maps
 * A2A structured parts into that contract and maps successful output back to
 * a direct A2A Message response.
 */
export async function handleA2ASendMessage(
  request: Request,
  context: A2AAgentRouteContext,
  runPublishedAgent: PublishedAgentRunHandler,
  resolveAp2Status: PublicAp2RuntimeStatusResolver = publicAp2RuntimeStatus,
): Promise<Response> {
  const versionError = validateA2AVersion(request);
  if (versionError) return versionError;
  if (!requestContentTypeSupported(request)) {
    return contentTypeError(`Use ${A2A_MEDIA_TYPE} for A2A requests.`);
  }

  const body = await readBoundedJson(request);
  if (!body.ok) return body.response;
  const requestedExtensions = requestedA2AExtensions(request);
  const ap2MandateDataPresent = containsAp2MandateData(body.value);
  // A2A extension negotiation is additive: ignore unknown optional URIs and
  // activate/echo only extensions this endpoint supports. A client that needs
  // AP2 still has an explicit fail-closed check below when mandate data is sent.
  const ap2Requested = requestedExtensions.includes(AP2_EXTENSION_URI);
  let ap2Available = false;
  if (ap2Requested || ap2MandateDataPresent) {
    try {
      ap2Available = (await resolveAp2Status()).advertise;
    } catch {
      ap2Available = false;
    }
  }
  const activatedExtensions = ap2Available && ap2Requested
    ? [AP2_EXTENSION_URI]
    : [];
  if (ap2MandateDataPresent && !ap2Available) {
    return a2aError({
      status: 400,
      statusName: "FAILED_PRECONDITION",
      reason: "EXTENSION_NOT_AVAILABLE",
      message: "The AP2 extension is not available on this interface.",
      metadata: { extension: AP2_EXTENSION_URI },
      domain: "agents.suedeai.ai",
    });
  }

  const extracted = extractStructuredInput(body.value);
  if (!extracted.ok) return extracted.response;
  if (extracted.ap2 && !requestedExtensions.includes(AP2_EXTENSION_URI)) {
    return a2aError({
      status: 400,
      statusName: "FAILED_PRECONDITION",
      reason: "EXTENSION_NOT_ACTIVATED",
      message: "Activate the AP2 extension with the A2A-Extensions header before sending mandates.",
      metadata: { extension: AP2_EXTENSION_URI },
    });
  }

  const { agent } = await context.params;
  const sourceUrl = new URL(request.url);
  const runUrl = new URL(`/api/agents/${encodeURIComponent(agent)}/run`, SITE_URL);
  const dryRun = sourceUrl.searchParams.get("dryRun");
  if (dryRun !== null) runUrl.searchParams.set("dryRun", dryRun);

  const runHeaders = new Headers({ "content-type": "application/json" });
  for (const header of [
    "payment-signature",
    "x-payment",
    "x-suede-dry-run",
    "x-forwarded-for",
    "x-real-ip",
    "user-agent",
    "traceparent",
  ]) {
    const value = request.headers.get(header);
    if (value !== null) runHeaders.set(header, value);
  }
  if (activatedExtensions.length > 0) {
    runHeaders.set("A2A-Extensions", activatedExtensions.join(", "));
  }

  const runResponse = await runPublishedAgent(
    new Request(runUrl, {
      method: "POST",
      headers: runHeaders,
      body: JSON.stringify({
        input: extracted.input,
        ...(extracted.ap2 ? { ap2: extracted.ap2 } : {}),
      }),
    }),
    context,
  );

  // Payment challenges and durable pending states are already machine-readable
  // protocol responses. Preserve their status/body/Retry-After instead of
  // turning a 202 reconciliation state into a completed ROLE_AGENT message.
  if (runResponse.status === 402 || runResponse.status === 202) {
    return copyRunResponse(runResponse, activatedExtensions);
  }

  let payload: unknown;
  try {
    payload = await runResponse.json();
  } catch {
    return a2aError({
      status: 500,
      statusName: "INTERNAL",
      reason: "INVALID_AGENT_RESPONSE",
      message: "The agent returned an invalid response.",
    });
  }

  if (!runResponse.ok) {
    const errorPayload = isRecord(payload) ? payload : {};
    const ap2Payload = isRecord(errorPayload.ap2) ? errorPayload.ap2 : null;
    const checkoutReceipt = ap2Payload && typeof ap2Payload.checkoutReceipt === "string"
      ? ap2Payload.checkoutReceipt
      : null;
    const message = typeof errorPayload.message === "string"
      ? errorPayload.message
      : typeof errorPayload.error === "string"
        ? errorPayload.error
        : "The agent request failed.";
    return a2aError({
      status: runResponse.status,
      statusName: runErrorStatusName(runResponse.status),
      reason: "AGENT_RUN_FAILED",
      message,
      ...(checkoutReceipt
        ? { metadata: { [AP2_CHECKOUT_RECEIPT_KEY]: checkoutReceipt } }
        : {}),
      ...(Array.isArray(errorPayload.violations) &&
        errorPayload.violations.every((violation) => typeof violation === "string")
        ? { violations: errorPayload.violations as string[] }
        : {}),
      ...(runResponse.headers.get("retry-after")
        ? { retryAfter: runResponse.headers.get("retry-after")! }
        : {}),
      domain: "agents.suedeai.ai",
    });
  }
  if (!isRecord(payload)) {
    return a2aError({
      status: 500,
      statusName: "INTERNAL",
      reason: "INVALID_AGENT_RESPONSE",
      message: "The agent returned an invalid response.",
    });
  }

  const isResourceEnvelope = Object.prototype.hasOwnProperty.call(payload, "result") &&
    Object.prototype.hasOwnProperty.call(payload, "resourceReceipt") &&
    Object.prototype.hasOwnProperty.call(payload, "payment");
  const data = isResourceEnvelope
    ? payload
    : Object.prototype.hasOwnProperty.call(payload, "result")
    ? payload.result
    : Object.prototype.hasOwnProperty.call(payload, "outputs")
      ? payload.outputs
      : payload;
  const headers = new Headers(runResponse.headers);
  headers.set("A2A-Version", A2A_PROTOCOL_VERSION);
  headers.set("cache-control", "no-store");
  headers.set("content-type", A2A_MEDIA_TYPE);
  if (activatedExtensions.length > 0) {
    headers.set("A2A-Extensions", activatedExtensions.join(", "));
  }
  const responseParts: Array<{ data: unknown; mediaType: string }> = [
    { data, mediaType: "application/json" },
  ];
  const ap2 = isRecord(payload.ap2) ? payload.ap2 : null;
  if (ap2 && typeof ap2.checkoutReceipt === "string") {
    responseParts.push({
      data: { [AP2_CHECKOUT_RECEIPT_KEY]: ap2.checkoutReceipt },
      mediaType: "application/json",
    });
  }
  return new Response(JSON.stringify({
    message: {
      messageId: crypto.randomUUID(),
      contextId: extracted.contextId ?? crypto.randomUUID(),
      role: "ROLE_AGENT",
      parts: responseParts,
      metadata: publicRunMetadata(payload, extracted.messageId),
    },
  }), { status: 200, headers });
}

export function listDirectMessageTasks(request: Request): Response {
  const versionError = validateA2AVersion(request);
  if (versionError) return versionError;
  const requestedPageSize = new URL(request.url).searchParams.get("pageSize");
  const pageSize = requestedPageSize === null ? 50 : Number(requestedPageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return a2aError({
      status: 400,
      statusName: "INVALID_ARGUMENT",
      reason: "INVALID_REQUEST",
      message: "pageSize must be an integer between 1 and 100.",
    });
  }
  return new Response(JSON.stringify({
    tasks: [],
    totalSize: 0,
    pageSize,
    nextPageToken: "",
  }), { status: 200, headers: responseHeaders() });
}

export function directMessageTaskNotFound(request: Request, taskId: string): Response {
  const versionError = validateA2AVersion(request);
  return versionError ?? taskNotFound(taskId);
}

export function unsupportedA2AOperation(request: Request, operation: string): Response {
  const versionError = validateA2AVersion(request);
  if (versionError) return versionError;
  return a2aError({
    status: 400,
    statusName: "FAILED_PRECONDITION",
    reason: "UNSUPPORTED_OPERATION",
    message: `${operation} is not supported by this synchronous A2A interface.`,
  });
}
