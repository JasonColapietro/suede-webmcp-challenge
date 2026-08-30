/**
 * MCP wire protocol — pure JSON-RPC and Streamable HTTP transport rules for
 * the modern (per-request `_meta`) revision. No database, no Next imports.
 *
 * This server speaks 2026-07-28 (which removed the `initialize` handshake,
 * protocol-level sessions, and the GET stream) and additionally serves the
 * previous revision through a stateless shim: `initialize` is answered with a
 * real InitializeResult, and requests carrying only the MCP-Protocol-Version
 * header (no `_meta`, no mirrored Mcp-* headers) dispatch through the same
 * stateless switch. Anything older is answered with an
 * UnsupportedProtocolVersionError naming what we do support.
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28
 */

/** The current protocol revision this server implements. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * The previous revision, accepted through a stateless compatibility shim:
 * it still opens with `initialize`, carries its version only in the
 * MCP-Protocol-Version header, and mirrors no Mcp-* headers. Dispatch is
 * shared with the modern path — the shim changes handshake and header
 * validation only, never tool behavior or billing.
 */
export const MCP_PREVIOUS_PROTOCOL_VERSION = "2025-11-25";

/** Every revision this server accepts, newest first. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
  MCP_PROTOCOL_VERSION,
  MCP_PREVIOUS_PROTOCOL_VERSION,
];

/** Revisions served through the legacy (initialize + header-version) shim. */
export const MCP_LEGACY_VERSIONS: readonly string[] = [
  MCP_PREVIOUS_PROTOCOL_VERSION,
];

/** `_meta` key carrying the per-request protocol version. */
export const MCP_META_PROTOCOL_VERSION =
  "io.modelcontextprotocol/protocolVersion";
/** `_meta` key carrying server identity on a DiscoverResult. */
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

// JSON-RPC 2.0 standard codes.
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

// MCP protocol-defined codes.
/** Headers disagree with the body, or a required header is missing/malformed. */
export const MCP_ERROR_HEADER_MISMATCH = -32020;
/** The requested protocol version is one this server does not implement. */
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Methods whose `params.name`/`params.uri` must be mirrored into `Mcp-Name`. */
const NAME_HEADER_METHODS: ReadonlySet<string> = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
]);

const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";

export type JsonRpcId = string | number;

export interface McpRequestEnvelope {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** An HTTP response the route layer can return verbatim. */
export interface McpHttpResponse {
  readonly status: number;
  /** `null` means "no body" (a 202 acknowledgement). */
  readonly body: unknown | null;
}

// ---------------------------------------------------------------------------
// Header value encoding
// ---------------------------------------------------------------------------

/**
 * Encode a value into the Base64 sentinel form clients use when a value
 * cannot ride in a plain ASCII header (`=?base64?<b64>?=`).
 */
export function encodeHeaderValue(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `${BASE64_SENTINEL_PREFIX}${encoded}${BASE64_SENTINEL_SUFFIX}`;
}

/**
 * Decode a header value that may be in the Base64 sentinel form. Plain values
 * pass through unchanged. Servers MUST decode before comparing to the body.
 *
 * Returns null when the sentinel wrapper is present but its payload is not
 * decodable, so a malformed value is rejected rather than compared raw.
 */
export function decodeHeaderValue(raw: string): string | null {
  if (
    !raw.startsWith(BASE64_SENTINEL_PREFIX) ||
    !raw.endsWith(BASE64_SENTINEL_SUFFIX)
  ) {
    return raw;
  }
  const payload = raw.slice(
    BASE64_SENTINEL_PREFIX.length,
    raw.length - BASE64_SENTINEL_SUFFIX.length,
  );
  try {
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    // Round-trip guard: Buffer.from is lenient about non-base64 input, so
    // re-encoding is what actually proves the payload was well-formed.
    if (Buffer.from(decoded, "utf8").toString("base64") !== payload) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    error: { code, message, ...(data ? { data } : {}) },
  };
}

/** A successful result, stamped with the `resultType` this revision requires. */
export function jsonRpcResult(
  id: JsonRpcId,
  result: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", ...result },
  };
}

/** The UnsupportedProtocolVersionError, which always names what we support. */
export function unsupportedVersionResponse(
  id: JsonRpcId | null,
  requested: string,
): McpHttpResponse {
  return {
    status: 400,
    body: jsonRpcError(
      id,
      MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
      `Unsupported protocol version. This server supports ${MCP_SUPPORTED_VERSIONS.join(", ")}.`,
      { supported: [...MCP_SUPPORTED_VERSIONS], requested },
    ),
  };
}

function headerMismatch(id: JsonRpcId | null, message: string): McpHttpResponse {
  return {
    status: 400,
    body: jsonRpcError(id, MCP_ERROR_HEADER_MISMATCH, message),
  };
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

export type EnvelopeResult =
  | { ok: true; envelope: McpRequestEnvelope; isNotification: boolean }
  | { ok: false; response: McpHttpResponse };

function readId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

/** Parse and shape-check a JSON-RPC request or notification body. */
export function parseEnvelope(body: unknown): EnvelopeResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      response: {
        status: 400,
        body: jsonRpcError(null, JSONRPC_INVALID_REQUEST, "Body must be a JSON-RPC request object."),
      },
    };
  }
  const record = body as Record<string, unknown>;
  const id = readId(record.id);
  if (record.jsonrpc !== "2.0") {
    return {
      ok: false,
      response: {
        status: 400,
        body: jsonRpcError(id ?? null, JSONRPC_INVALID_REQUEST, 'Missing or invalid "jsonrpc": must be "2.0".'),
      },
    };
  }
  if (typeof record.method !== "string" || record.method === "") {
    return {
      ok: false,
      response: {
        status: 400,
        body: jsonRpcError(id ?? null, JSONRPC_INVALID_REQUEST, 'Missing or invalid "method".'),
      },
    };
  }
  const rawParams = record.params;
  const params =
    typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {};
  return {
    ok: true,
    envelope: {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method: record.method,
      params,
    },
    isNotification: id === undefined,
  };
}

/** The protocol version declared in the body's `params._meta`, if any. */
export function protocolVersionFromEnvelope(
  envelope: McpRequestEnvelope,
): string | null {
  const meta = envelope.params._meta;
  if (typeof meta !== "object" || meta === null) return null;
  const version = (meta as Record<string, unknown>)[MCP_META_PROTOCOL_VERSION];
  return typeof version === "string" ? version : null;
}

// ---------------------------------------------------------------------------
// Transport header validation
// ---------------------------------------------------------------------------

export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Enforce the mirrored-header contract: every required transport header is
 * present and agrees with the body. A load balancer routing on the header
 * while the server executes on the body is exactly the split-brain this
 * prevents.
 */
export function validateTransportHeaders(
  headers: HeaderReader,
  envelope: McpRequestEnvelope,
): McpHttpResponse | null {
  const id = envelope.id ?? null;

  const versionHeader = headers.get("mcp-protocol-version");
  if (versionHeader === null || versionHeader.trim() === "") {
    return headerMismatch(id, "Missing required MCP-Protocol-Version header.");
  }
  const bodyVersion = protocolVersionFromEnvelope(envelope);
  if (bodyVersion === null) {
    return headerMismatch(
      id,
      `Missing required "${MCP_META_PROTOCOL_VERSION}" in params._meta.`,
    );
  }
  if (versionHeader !== bodyVersion) {
    return headerMismatch(
      id,
      `Header mismatch: MCP-Protocol-Version header '${versionHeader}' does not match body value '${bodyVersion}'.`,
    );
  }

  const methodHeader = headers.get("mcp-method");
  if (methodHeader === null || methodHeader.trim() === "") {
    return headerMismatch(id, "Missing required Mcp-Method header.");
  }
  if (methodHeader !== envelope.method) {
    return headerMismatch(
      id,
      `Header mismatch: Mcp-Method header '${methodHeader}' does not match body value '${envelope.method}'.`,
    );
  }

  if (NAME_HEADER_METHODS.has(envelope.method)) {
    const bodyName = envelope.params.name ?? envelope.params.uri;
    const rawNameHeader = headers.get("mcp-name");
    if (rawNameHeader === null || rawNameHeader.trim() === "") {
      return headerMismatch(id, `Missing required Mcp-Name header for ${envelope.method}.`);
    }
    const nameHeader = decodeHeaderValue(rawNameHeader);
    if (nameHeader === null) {
      return headerMismatch(id, "Mcp-Name header is not a decodable base64 sentinel value.");
    }
    if (typeof bodyName !== "string" || nameHeader !== bodyName) {
      return headerMismatch(
        id,
        `Header mismatch: Mcp-Name header '${nameHeader}' does not match the request body.`,
      );
    }
  }

  return null;
}

/**
 * Is `origin` allowed to reach this endpoint?
 *
 * An absent Origin is allowed: MCP clients are overwhelmingly non-browser and
 * send none. A *present* foreign Origin is the DNS-rebinding case the spec
 * requires us to reject.
 */
export function isOriginAllowed(
  origin: string | null,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === null || origin === "" || origin === "null") return true;
  return allowedOrigins.includes(origin);
}
