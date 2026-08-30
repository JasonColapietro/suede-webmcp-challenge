/**
 * Transport + JSON-RPC conformance for the MCP endpoint
 * (src/lib/mcp/protocol.ts, src/lib/mcp/server.ts).
 *
 * These are pure-function tests against the modern (2026-07-28) revision:
 * per-request `_meta` protocol version, mirrored transport headers, and
 * stateless dispatch. No HTTP layer, no database.
 */
import { describe, it, expect } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  MCP_PREVIOUS_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  JSONRPC_METHOD_NOT_FOUND,
  encodeHeaderValue,
} from "@/lib/mcp/protocol";
import { handleMcpHttpRequest, type McpServerDeps } from "@/lib/mcp/server";

const TOOL = {
  name: "run_lead_scorer",
  title: "Lead Scorer",
  description: "Scores an inbound lead. Costs 0.25 USDC per call.",
  inputSchema: { type: "object" as const, additionalProperties: false },
};

function deps(overrides: Partial<McpServerDeps> = {}): McpServerDeps {
  return {
    listTools: async () => [TOOL],
    callTool: async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
    }),
    ...overrides,
  };
}

/** A well-formed modern request body with the required `_meta`. */
function body(
  method: string,
  params: Record<string, unknown> = {},
  version: string = MCP_PROTOCOL_VERSION,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": { name: "Test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

/** The transport headers a conforming client mirrors from the body. */
function headers(
  method: string,
  extra: Record<string, string> = {},
  version: string = MCP_PROTOCOL_VERSION,
): Headers {
  return new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": version,
    "mcp-method": method,
    ...extra,
  });
}

function post(input: {
  body: unknown;
  headers: Headers;
  deps?: McpServerDeps;
}): ReturnType<typeof handleMcpHttpRequest> {
  return handleMcpHttpRequest({
    httpMethod: "POST",
    headers: input.headers,
    body: input.body,
    deps: input.deps ?? deps(),
  });
}

describe("MCP transport — HTTP method handling", () => {
  it("rejects GET with 405, since this revision removed the GET stream", async () => {
    const res = await handleMcpHttpRequest({
      httpMethod: "GET",
      headers: headers("tools/list"),
      body: null,
      deps: deps(),
    });
    expect(res.status).toBe(405);
  });

  it("rejects DELETE with 405, since this revision removed sessions", async () => {
    const res = await handleMcpHttpRequest({
      httpMethod: "DELETE",
      headers: headers("tools/list"),
      body: null,
      deps: deps(),
    });
    expect(res.status).toBe(405);
  });
});

describe("MCP transport — Origin validation", () => {
  it("allows a request with no Origin header, as non-browser clients send none", async () => {
    const res = await post({ body: body("tools/list"), headers: headers("tools/list") });
    expect(res.status).toBe(200);
  });

  it("rejects a foreign Origin with 403 to block DNS rebinding", async () => {
    const res = await post({
      body: body("tools/list"),
      headers: headers("tools/list", { origin: "https://evil.example" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("MCP transport — header/body validation", () => {
  it("rejects a missing MCP-Protocol-Version header with HeaderMismatch", async () => {
    const h = headers("tools/list");
    h.delete("mcp-protocol-version");
    const res = await post({ body: body("tools/list"), headers: h });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: MCP_ERROR_HEADER_MISMATCH },
    });
  });

  it("rejects a missing Mcp-Method header with HeaderMismatch", async () => {
    const h = headers("tools/list");
    h.delete("mcp-method");
    const res = await post({ body: body("tools/list"), headers: h });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: MCP_ERROR_HEADER_MISMATCH } });
  });

  it("rejects an Mcp-Method header that disagrees with the body method", async () => {
    const res = await post({
      body: body("tools/list"),
      headers: headers("tools/call"),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: MCP_ERROR_HEADER_MISMATCH } });
  });

  it("rejects a protocol-version header that disagrees with the body _meta", async () => {
    const res = await post({
      body: body("tools/list", {}, MCP_PROTOCOL_VERSION),
      headers: headers("tools/list", {}, "2025-11-25"),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: MCP_ERROR_HEADER_MISMATCH } });
  });

  it("requires Mcp-Name on tools/call and rejects it when absent", async () => {
    const res = await post({
      body: body("tools/call", { name: TOOL.name, arguments: {} }),
      headers: headers("tools/call"),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: MCP_ERROR_HEADER_MISMATCH } });
  });

  it("rejects an Mcp-Name header that disagrees with params.name", async () => {
    const res = await post({
      body: body("tools/call", { name: TOOL.name, arguments: {} }),
      headers: headers("tools/call", { "mcp-name": "run_something_else" }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: MCP_ERROR_HEADER_MISMATCH } });
  });

  it("decodes a base64-sentinel Mcp-Name before comparing it to the body", async () => {
    const res = await post({
      body: body("tools/call", { name: TOOL.name, arguments: {} }),
      headers: headers("tools/call", { "mcp-name": encodeHeaderValue(TOOL.name) }),
    });
    expect(res.status).toBe(200);
  });
});

describe("MCP transport — protocol version negotiation", () => {
  it("rejects an unsupported version with -32022 and lists what it supports", async () => {
    const res = await post({
      body: body("tools/list", {}, "1900-01-01"),
      headers: headers("tools/list", {}, "1900-01-01"),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: {
        code: MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
        data: {
          supported: [...MCP_SUPPORTED_VERSIONS],
          requested: "1900-01-01",
        },
      },
    });
  });

  it("answers a legacy initialize request with a real InitializeResult", async () => {
    // DELIBERATE pin rewrite (2026-08-09, prior-revision shim): this pin used
    // to assert that ANY initialize was refused with
    // UnsupportedProtocolVersionError, which locked every pre-2026-07-28
    // client out of the endpoint entirely. The server now serves the previous
    // revision (2025-11-25) through a stateless shim, so initialize completes
    // with a proper InitializeResult instead of an error. Clients older than
    // the previous revision still get a version we support named back, per
    // the spec's negotiation rule.
    const res = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PREVIOUS_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "Legacy", version: "0.1.0" },
        },
      },
      deps: deps(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PREVIOUS_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: expect.any(String), version: expect.any(String) },
        instructions: expect.any(String),
      },
    });
  });

  it("names a supported version back when initialize requests one it cannot serve", async () => {
    const res = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Old" } },
      },
      deps: deps(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      result: { protocolVersion: MCP_PREVIOUS_PROTOCOL_VERSION },
    });
  });
});

describe("MCP transport — prior-revision (legacy) request flow", () => {
  /** Legacy-style headers: version rides only on MCP-Protocol-Version. */
  function legacyHeaders(extra: Record<string, string> = {}): Headers {
    return new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PREVIOUS_PROTOCOL_VERSION,
      ...extra,
    });
  }

  /** Legacy body: no `_meta` protocol version. */
  function legacyBody(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
    return { jsonrpc: "2.0", id: 2, method, params };
  }

  it("completes tools/list without _meta or mirrored Mcp-* headers", async () => {
    const res = await post({
      body: legacyBody("tools/list"),
      headers: legacyHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: { tools: [TOOL] } });
  });

  it("completes tools/call without an Mcp-Name header", async () => {
    let seen: unknown = null;
    const res = await post({
      body: legacyBody("tools/call", { name: TOOL.name, arguments: { lead: "acme" } }),
      headers: legacyHeaders(),
      deps: deps({
        callTool: async (input) => {
          seen = input;
          return { content: [{ type: "text", text: "scored" }], isError: false };
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ name: TOOL.name, arguments: { lead: "acme" } });
  });

  it("acknowledges the legacy notifications/initialized with 202", async () => {
    const res = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: legacyHeaders(),
      body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      deps: deps(),
    });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it("still applies the bearer workspace-key gate on the legacy path", async () => {
    let called = false;
    const res = await post({
      body: legacyBody("tools/call", { name: TOOL.name, arguments: {} }),
      headers: legacyHeaders({
        authorization: "Bearer sb:11111111-2222-3333-4444-555555555555",
      }),
      deps: deps({
        callTool: async () => {
          called = true;
          return { content: [], isError: false };
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it("holds a request that declares a _meta version to the modern header contract", async () => {
    // A body `_meta` version means the client claims the modern revision, so
    // a legacy-version header alongside it is a split-brain, not a shim case.
    const res = await post({
      body: body("tools/list"),
      headers: legacyHeaders(),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: MCP_ERROR_HEADER_MISMATCH } });
  });

  it("rejects a header-only version this server does not support", async () => {
    const res = await post({
      body: legacyBody("tools/list"),
      headers: new Headers({
        "content-type": "application/json",
        "mcp-protocol-version": "2024-11-05",
        "mcp-method": "tools/list",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("MCP dispatch", () => {
  it("returns 404 with -32601 for a method it does not implement", async () => {
    const res = await post({
      body: body("resources/read", { uri: "file:///x" }),
      headers: headers("resources/read", { "mcp-name": "file:///x" }),
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: JSONRPC_METHOD_NOT_FOUND } });
  });

  it("acknowledges a notification (no id) with 202 and no body", async () => {
    const res = await handleMcpHttpRequest({
      httpMethod: "POST",
      headers: headers("notifications/progress"),
      body: {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          },
        },
      },
      deps: deps(),
    });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it("answers server/discover with supported versions, capabilities and identity", async () => {
    const res = await post({
      body: body("server/discover"),
      headers: headers("server/discover"),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
      },
    });
    const result = (res.body as { result: Record<string, unknown> }).result;
    expect(result._meta).toMatchObject({
      "io.modelcontextprotocol/serverInfo": { name: expect.any(String) },
    });
  });

  it("answers tools/list with the deps' tools and a complete resultType", async () => {
    const res = await post({
      body: body("tools/list"),
      headers: headers("tools/list"),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      result: { resultType: "complete", tools: [TOOL] },
    });
  });

  it("passes the tool name and arguments through to callTool", async () => {
    let seen: unknown = null;
    const res = await post({
      body: body("tools/call", { name: TOOL.name, arguments: { lead: "acme" } }),
      headers: headers("tools/call", { "mcp-name": TOOL.name }),
      deps: deps({
        callTool: async (input) => {
          seen = input;
          return { content: [{ type: "text", text: "scored" }], isError: false };
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({
      name: TOOL.name,
      arguments: { lead: "acme" },
    });
    expect(res.body).toMatchObject({
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "scored" }],
        isError: false,
      },
    });
  });

  it('refuses a bearer "sb:<uuid>" before the tool call can reach any credit read', async () => {
    // SECURITY PIN (2026-08-09): `sb:`-prefixed owner ids are Supabase
    // identities — derived from a verified token in src/lib/auth.ts, never
    // secrets. /api/me/claim only ever issues UUID workspace keys. If the MCP
    // bearer accepted an sb: value, anyone who learned a Supabase user id
    // could present it and spend that user's workspace credit. The refusal
    // must happen in dispatch, before callTool (and therefore before any
    // balance read or debit) runs.
    let called = false;
    const res = await post({
      body: body("tools/call", { name: TOOL.name, arguments: {} }),
      headers: headers("tools/call", {
        "mcp-name": TOOL.name,
        authorization: "Bearer sb:11111111-2222-3333-4444-555555555555",
      }),
      deps: deps({
        callTool: async () => {
          called = true;
          return { content: [], isError: false };
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(called).toBe(false);
    expect(JSON.stringify(res.body)).toContain("workspace key");
  });

  it("refuses a bearer that is not UUID-shaped without dispatching the call", async () => {
    let called = false;
    const res = await post({
      body: body("tools/call", { name: TOOL.name, arguments: {} }),
      headers: headers("tools/call", {
        "mcp-name": TOOL.name,
        authorization: "Bearer not-a-workspace-key",
      }),
      deps: deps({
        callTool: async () => {
          called = true;
          return { content: [], isError: false };
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it("still treats a missing Authorization header as an anonymous call", async () => {
    let seen: { workspaceKey?: string | null } = { workspaceKey: "unset" };
    const res = await post({
      body: body("tools/call", { name: TOOL.name, arguments: {} }),
      headers: headers("tools/call", { "mcp-name": TOOL.name }),
      deps: deps({
        callTool: async (input) => {
          seen = input;
          return { content: [], isError: false };
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(seen.workspaceKey).toBeNull();
  });

  it("hands the bearer workspace key to callTool so it can bill the caller", async () => {
    let seen: { workspaceKey?: string | null } = {};
    await post({
      body: body("tools/call", { name: TOOL.name, arguments: {} }),
      headers: headers("tools/call", {
        "mcp-name": TOOL.name,
        authorization: "Bearer 11111111-2222-3333-4444-555555555555",
      }),
      deps: deps({
        callTool: async (input) => {
          seen = input;
          return { content: [], isError: false };
        },
      }),
    });
    expect(seen.workspaceKey).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("rejects a body that is not a JSON-RPC 2.0 request", async () => {
    const res = await post({
      body: { id: 1, method: "tools/list" },
      headers: headers("tools/list"),
    });
    expect(res.status).toBe(400);
  });
});
