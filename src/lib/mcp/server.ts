/**
 * MCP request dispatch — turns a validated HTTP POST into a JSON-RPC result.
 *
 * Stateless by construction: this revision removed protocol-level sessions, so
 * every request carries its own version, identity, and (for paid tools) its own
 * bearer workspace key. Nothing is remembered between calls.
 *
 * Transport concerns live in protocol.ts; the tool surface is injected as
 * `deps` so this module stays free of the database and the flow engine.
 */
import { SITE_URL } from "@/lib/site";
import {
  isOriginAllowed,
  jsonRpcError,
  jsonRpcResult,
  MCP_META_SERVER_INFO,
  MCP_LEGACY_VERSIONS,
  MCP_PREVIOUS_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  parseEnvelope,
  protocolVersionFromEnvelope,
  unsupportedVersionResponse,
  validateTransportHeaders,
  type HeaderReader,
  type McpHttpResponse,
} from "./protocol";

export const MCP_SERVER_NAME = "Suede Agent Studio";
export const MCP_SERVER_VERSION = "1.0.0";

/**
 * Guidance handed to the calling model. It names the money rule up front,
 * because a model that discovers pricing only via a failed call wastes a
 * round trip and confuses the user.
 */
export const MCP_INSTRUCTIONS =
  "Each tool is a published Suede agent that runs a real workflow. Priced tools " +
  "are billed to the workspace credit of the bearer key on the request; the price " +
  "in USDC is stated in every tool description. Calls without a workspace key can " +
  "only use free tools.";

export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError: boolean;
  readonly structuredContent?: unknown;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface McpCallToolInput {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** Bearer workspace key, or null when the caller sent none. */
  readonly workspaceKey: string | null;
  /**
   * Hard ceiling on what this call may charge, in USDC.
   *
   * Optional, and unset by the JSON-RPC transport — an MCP client agrees to a
   * price by reading the tool descriptor, and re-reads it on every tools/list.
   * The browser storefront is different: it quotes a price to a buying agent,
   * then charges on a LATER catalog read, so without a ceiling the two can
   * disagree across a cache expiry. Set it there.
   */
  readonly maxPriceUsdc?: number;
}

export interface McpServerDeps {
  listTools(): Promise<readonly McpToolDescriptor[]>;
  callTool(input: McpCallToolInput): Promise<McpToolResult>;
}

export interface McpHttpRequest {
  readonly httpMethod: string;
  readonly headers: HeaderReader;
  readonly body: unknown;
  readonly deps: McpServerDeps;
  /** Overrides the site origin allow-list; defaults to this deployment. */
  readonly allowedOrigins?: readonly string[];
}

function defaultAllowedOrigins(): readonly string[] {
  const origins = new Set<string>();
  try {
    origins.add(new URL(SITE_URL).origin);
  } catch {
    // A malformed SITE_URL must not open the endpoint up; skip it.
  }
  if (process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:3210");
    origins.add("http://127.0.0.1:3210");
  }
  return [...origins];
}

/**
 * Verified-identity owner prefix, duplicated from src/lib/auth.ts
 * (SUEDE_OWNER_PREFIX) so this pure module never imports next/headers.
 * An `sb:`-prefixed owner id is a Supabase identity — derived from a verified
 * token, never a secret — so it must NEVER be honored as a bearer credential:
 * accepting one would let anyone who learns a user id spend that user's
 * workspace credit.
 */
const VERIFIED_OWNER_PREFIX = "sb:";

/** The only bearer shape /api/me/claim issues: a UUID workspace key. */
const WORKSPACE_KEY_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type BearerKeyResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "key"; readonly key: string };

function bearerWorkspaceKey(headers: HeaderReader): BearerKeyResult {
  const raw = headers.get("authorization");
  if (raw === null) return { kind: "absent" };
  if (!/^Bearer /i.test(raw)) return { kind: "absent" };
  const key = raw.slice(7).trim();
  if (key === "") return { kind: "absent" };
  if (key.toLowerCase().startsWith(VERIFIED_OWNER_PREFIX)) return { kind: "invalid" };
  if (!WORKSPACE_KEY_SHAPE.test(key)) return { kind: "invalid" };
  return { kind: "key", key };
}

/**
 * Handle one POST to the MCP endpoint.
 *
 * Check order is deliberate. HTTP method, then Origin (a rebinding attempt
 * should never reach parsing), then envelope shape, then the legacy
 * `initialize` probe (legacy clients send none of the modern headers, so this
 * must precede header validation or they get a misleading error), then header
 * agreement, then version support, then dispatch.
 */
export async function handleMcpHttpRequest(
  request: McpHttpRequest,
): Promise<McpHttpResponse> {
  const { httpMethod, headers, body, deps } = request;

  if (httpMethod !== "POST") {
    return {
      status: 405,
      body: jsonRpcError(
        null,
        JSONRPC_INVALID_PARAMS,
        "This MCP endpoint accepts POST only. Sessions and the GET stream were removed in 2026-07-28.",
      ),
    };
  }

  const allowedOrigins = request.allowedOrigins ?? defaultAllowedOrigins();
  if (!isOriginAllowed(headers.get("origin"), allowedOrigins)) {
    return {
      status: 403,
      body: jsonRpcError(null, JSONRPC_INVALID_PARAMS, "Origin not allowed."),
    };
  }

  const parsed = parseEnvelope(body);
  if (!parsed.ok) return parsed.response;
  const { envelope, isNotification } = parsed;

  // Legacy handshake shim: the previous revision opens with `initialize`, so
  // answer with a real InitializeResult instead of an error. Dispatch stays
  // stateless — nothing about this handshake is remembered — and if the
  // requested version is one we cannot serve, we name the newest legacy
  // revision we do, which the spec lets the client accept or disconnect from.
  if (envelope.method === "initialize") {
    if (isNotification) {
      return {
        status: 400,
        body: jsonRpcError(
          null,
          JSONRPC_INVALID_REQUEST,
          "initialize must be a request with an id, not a notification.",
        ),
      };
    }
    const requested = envelope.params.protocolVersion;
    const negotiated =
      typeof requested === "string" && MCP_LEGACY_VERSIONS.includes(requested)
        ? requested
        : MCP_PREVIOUS_PROTOCOL_VERSION;
    return {
      status: 200,
      body: jsonRpcResult(envelope.id as string | number, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: MCP_INSTRUCTIONS,
      }),
    };
  }

  // Notifications are acknowledged and dropped. This revision defines no
  // client-to-server notifications over Streamable HTTP, and it does not
  // define header requirements for them either, so they skip validation.
  if (isNotification) {
    return { status: 202, body: null };
  }

  // Legacy transport shim: the previous revision carries its version only in
  // the MCP-Protocol-Version header and mirrors no Mcp-* headers, so requests
  // in that shape skip the modern mirrored-header validation. Any request
  // that DOES declare a `_meta` version is held to the modern contract.
  const bodyVersion = protocolVersionFromEnvelope(envelope);
  const headerVersion = headers.get("mcp-protocol-version")?.trim() ?? "";
  const isLegacyTransport =
    bodyVersion === null && MCP_LEGACY_VERSIONS.includes(headerVersion);
  if (!isLegacyTransport) {
    const headerError = validateTransportHeaders(headers, envelope);
    if (headerError) return headerError;
  }

  const version = isLegacyTransport ? headerVersion : bodyVersion;
  if (version === null || !MCP_SUPPORTED_VERSIONS.includes(version)) {
    return unsupportedVersionResponse(envelope.id ?? null, version ?? "unknown");
  }

  const id = envelope.id as string | number;

  try {
    switch (envelope.method) {
      case "server/discover":
        return {
          status: 200,
          body: jsonRpcResult(id, {
            supportedVersions: [...MCP_SUPPORTED_VERSIONS],
            capabilities: { tools: {} },
            instructions: MCP_INSTRUCTIONS,
            _meta: {
              [MCP_META_SERVER_INFO]: {
                name: MCP_SERVER_NAME,
                version: MCP_SERVER_VERSION,
              },
            },
          }),
        };

      case "tools/list": {
        const tools = await deps.listTools();
        return { status: 200, body: jsonRpcResult(id, { tools: [...tools] }) };
      }

      case "tools/call": {
        const name = envelope.params.name;
        if (typeof name !== "string" || name === "") {
          return {
            status: 400,
            body: jsonRpcError(id, JSONRPC_INVALID_PARAMS, "params.name is required."),
          };
        }
        const rawArgs = envelope.params.arguments;
        const args =
          typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};
        // The bearer is validated BEFORE dispatch so a malformed or
        // identity-shaped credential can never reach a credit read.
        const bearer = bearerWorkspaceKey(headers);
        if (bearer.kind === "invalid") {
          return {
            status: 401,
            body: jsonRpcError(
              id,
              JSONRPC_INVALID_PARAMS,
              "The Authorization bearer is not a workspace key. Workspace keys are the " +
                "UUIDs your workspace shows at /api/me; identity values are never accepted. " +
                "No credit was read and nothing was charged.",
            ),
          };
        }
        const result = await deps.callTool({
          name,
          arguments: args,
          workspaceKey: bearer.kind === "key" ? bearer.key : null,
        });
        return {
          status: 200,
          body: jsonRpcResult(id, {
            content: [...result.content],
            isError: result.isError,
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
          }),
        };
      }

      default:
        return {
          status: 404,
          body: jsonRpcError(
            id,
            JSONRPC_METHOD_NOT_FOUND,
            `Method not found: ${envelope.method}`,
          ),
        };
    }
  } catch (error: unknown) {
    // Opaque on the money path, matching /api/agents/[agent]/run: a raw
    // message can leak facilitator, database, or relay internals.
    console.error("mcp request failed", error);
    return {
      status: 200,
      body: jsonRpcError(id, JSONRPC_INTERNAL_ERROR, "Internal error."),
    };
  }
}
