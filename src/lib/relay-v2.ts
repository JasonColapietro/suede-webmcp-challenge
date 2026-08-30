/**
 * Suede relay protocol v2.
 *
 * Delivery uses the run ID as an idempotency key. Once an execute request may
 * have reached a relay, transport and response-shape failures are deliberately
 * reported as ambiguous so callers reconcile with a signed status request
 * instead of executing the paid work again.
 *
 * Server-only: request signing and SSRF-safe transport both use Node APIs.
 */
import { createHash } from "node:crypto";
import { safeFetch } from "@/lib/net/safe-url";
import { signRelayRequest, type RelayEndpoint } from "@/lib/relay";

export const RELAY_V2_PROTOCOL = "suede-relay/2" as const;

const RELAY_V2_TIMEOUT_MS = 15_000;
const RELAY_V2_MAX_RESPONSE_BYTES = 256 * 1024;
const RELAY_V2_STATES = new Set<RelayV2State>([
  "completed",
  "failed",
  "accepted",
  "running",
  "unknown",
]);

export type RelayV2State = "completed" | "failed" | "accepted" | "running" | "unknown";
export type RelayV2FailureReason = "timeout" | "network" | "malformed" | "oversize";

export interface RelayV2Delivery {
  kind: "delivery";
  protocol: typeof RELAY_V2_PROTOCOL;
  deliveryId: string;
  state: RelayV2State;
  httpStatus: number;
  output?: unknown;
  error?: unknown;
  retryAfterMs?: number;
}

export interface RelayV2Ambiguous {
  kind: "ambiguous";
  deliveryId: string;
  reason: RelayV2FailureReason;
  httpStatus?: number;
}

export interface RelayV2Unavailable {
  kind: "unavailable";
  deliveryId: string;
  reason: RelayV2FailureReason;
  httpStatus?: number;
}

export type RelayV2ExecuteResult = RelayV2Delivery | RelayV2Ambiguous;
export type RelayV2StatusResult = RelayV2Delivery | RelayV2Unavailable;

export interface RelayV2ExecuteParams {
  relay: RelayEndpoint;
  runId: string;
  agent: string;
  input: unknown;
  requestWindow?: RelayV2RequestWindow;
}

export interface RelayV2StatusParams {
  relay: RelayEndpoint;
  deliveryId: string;
  agent: string;
}

export interface RelayV2RequestWindow {
  issuedAt: string;
  notAfter: string;
}

export interface RelayV2EndpointBinding {
  url: string;
  createdAt: string;
  protocolVersion: string;
}

interface RelayV2RequestBase {
  protocol: typeof RELAY_V2_PROTOCOL;
  operation: "execute" | "status";
  deliveryId: string;
  agent: string;
  issuedAt: string;
  notAfter: string;
}

interface RelayV2ExecuteRequest extends RelayV2RequestBase {
  operation: "execute";
  input: unknown;
}

interface RelayV2StatusRequest extends RelayV2RequestBase {
  operation: "status";
}

class OversizeRelayV2Response extends Error {}
class MalformedRelayV2Request extends Error {}

/**
 * Bind stored endpoint identity to the exact registration inputs. A fixed-key
 * JSON encoding makes field boundaries unambiguous without normalizing the URL.
 */
export function relayV2EndpointBindingHash(binding: RelayV2EndpointBinding): string {
  const canonical = JSON.stringify({
    url: binding.url,
    createdAt: binding.createdAt,
    protocolVersion: binding.protocolVersion,
  });
  return `sha256=${createHash("sha256").update(canonical).digest("hex")}`;
}

export function relayV2RequestWindow(): RelayV2RequestWindow {
  const issuedAtMs = Date.now();
  return {
    issuedAt: new Date(issuedAtMs).toISOString(),
    notAfter: new Date(issuedAtMs + RELAY_V2_TIMEOUT_MS).toISOString(),
  };
}

function timeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const byteLength = Number(declaredLength);
    if (Number.isFinite(byteLength) && byteLength > RELAY_V2_MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new OversizeRelayV2Response();
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > RELAY_V2_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OversizeRelayV2Response();
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

function parseDelivery(raw: unknown, deliveryId: string, httpStatus: number): RelayV2Delivery | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.protocol !== RELAY_V2_PROTOCOL || value.deliveryId !== deliveryId) return null;
  if (typeof value.state !== "string" || !RELAY_V2_STATES.has(value.state as RelayV2State)) {
    return null;
  }

  const delivery: RelayV2Delivery = {
    kind: "delivery",
    protocol: RELAY_V2_PROTOCOL,
    deliveryId,
    state: value.state as RelayV2State,
    httpStatus,
  };
  if (Object.prototype.hasOwnProperty.call(value, "output")) delivery.output = value.output;
  if (Object.prototype.hasOwnProperty.call(value, "error")) delivery.error = value.error;
  if (
    typeof value.retryAfterMs === "number" &&
    Number.isFinite(value.retryAfterMs) &&
    value.retryAfterMs >= 0
  ) {
    delivery.retryAfterMs = value.retryAfterMs;
  }
  return delivery;
}

function signedHeaders(body: string, relay: RelayEndpoint, issuedAt: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-suede-signature": signRelayRequest(body, relay.secret),
    "x-suede-timestamp": issuedAt,
  };
}

async function postRelayV2(
  relay: RelayEndpoint,
  request: RelayV2ExecuteRequest | RelayV2StatusRequest,
  idempotencyKey?: string,
): Promise<Response> {
  let body: string;
  try {
    body = JSON.stringify(request);
  } catch {
    throw new MalformedRelayV2Request();
  }
  const headers = signedHeaders(body, relay, request.issuedAt);
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  return safeFetch(
    relay.url,
    {
      method: "POST",
      headers,
      body,
    },
    { timeoutMs: RELAY_V2_TIMEOUT_MS, maxRedirects: 0 },
  );
}

async function parseRelayV2Response(
  response: Response,
  deliveryId: string,
): Promise<RelayV2Delivery | RelayV2FailureReason> {
  let body: string;
  try {
    body = await readBoundedBody(response);
  } catch (error) {
    if (error instanceof OversizeRelayV2Response) return "oversize";
    return timeoutFailure(error) ? "timeout" : "network";
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    return parseDelivery(parsed, deliveryId, response.status) ?? "malformed";
  } catch {
    return "malformed";
  }
}

/** Send a v2 execute delivery. Every post-send uncertainty is nonthrowing. */
export async function executeRelayV2(params: RelayV2ExecuteParams): Promise<RelayV2ExecuteResult> {
  const window = params.requestWindow ?? relayV2RequestWindow();
  const request: RelayV2ExecuteRequest = {
    protocol: RELAY_V2_PROTOCOL,
    operation: "execute",
    deliveryId: params.runId,
    agent: params.agent,
    input: params.input,
    ...window,
  };

  let response: Response;
  try {
    response = await postRelayV2(params.relay, request, params.runId);
  } catch (error) {
    return {
      kind: "ambiguous",
      deliveryId: params.runId,
      reason:
        error instanceof MalformedRelayV2Request
          ? "malformed"
          : timeoutFailure(error)
            ? "timeout"
            : "network",
    };
  }

  const parsed = await parseRelayV2Response(response, params.runId);
  if (typeof parsed !== "string") return parsed;
  return {
    kind: "ambiguous",
    deliveryId: params.runId,
    reason: parsed,
    httpStatus: response.status,
  };
}

/** Query a v2 delivery. Transport and response failures are nonthrowing. */
export async function queryRelayV2Status(params: RelayV2StatusParams): Promise<RelayV2StatusResult> {
  const request: RelayV2StatusRequest = {
    protocol: RELAY_V2_PROTOCOL,
    operation: "status",
    deliveryId: params.deliveryId,
    agent: params.agent,
    ...relayV2RequestWindow(),
  };

  let response: Response;
  try {
    response = await postRelayV2(params.relay, request);
  } catch (error) {
    return {
      kind: "unavailable",
      deliveryId: params.deliveryId,
      reason:
        error instanceof MalformedRelayV2Request
          ? "malformed"
          : timeoutFailure(error)
            ? "timeout"
            : "network",
    };
  }

  const parsed = await parseRelayV2Response(response, params.deliveryId);
  if (typeof parsed !== "string") return parsed;
  return {
    kind: "unavailable",
    deliveryId: params.deliveryId,
    reason: parsed,
    httpStatus: response.status,
  };
}
