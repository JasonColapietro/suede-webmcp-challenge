/**
 * serve() — minimal node:http server for self-hosted agents.
 *
 * Endpoints:
 *   POST /run      — execute the agent's run() function
 *   GET  /manifest — returns the agent definition minus run()
 *
 * No framework. Plain node:http.
 *
 * Relay signature verification:
 *   When SUEDE_RELAY_SECRET is set, POST /run requires a valid
 *   x-suede-signature header (HMAC-SHA256 of the raw body).
 *   Requests without a valid signature are rejected with 401.
 *
 *   Note: the HMAC helper is duplicated here (no cross-workspace import).
 */

import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createLocalMemory } from "./memory.js";
import type { AgentDefinition, AgentContext } from "./types.js";

// ── Vendored HMAC helpers (provenance: packages/agent-kit/src/serve.ts) ────
// Duplicated from src/lib/relay.ts to avoid a cross-workspace import.

function signBody(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

function verifySignature(body: string, secret: string, sig: string): boolean {
  if (!sig.startsWith("sha256=")) return false;
  const expected = signBody(body, secret);
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedHex = sig.slice(7);
  const expectedHex = expected.slice(7);
  if (providedHex.length !== expectedHex.length) {
    // Constant-time dummy compare — always false, no early-exit on length.
    try { timingSafeEqual(expectedBuf, expectedBuf); } catch { /* ignore */ }
    return false;
  }
  const providedBuf = Buffer.from(`sha256=${providedHex}`, "utf-8");
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

export interface ServeOptions {
  /** TCP port to listen on. Use 0 for a random free port (tests). */
  port: number;
}

export interface ServeHandle {
  /** Shutdown the server. */
  close(): void;
  /** Exposed for testing — the underlying node:http Server instance. */
  _server: http.Server;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Start an HTTP server exposing the agent's run() and manifest.
 *
 * @param agent - a frozen AgentDefinition from defineAgent()
 * @param options - port to listen on
 * @returns ServeHandle with close()
 */
export function serve(agent: AgentDefinition, options: ServeOptions): ServeHandle {
  const memory = createLocalMemory(process.cwd());

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/manifest") {
      // Return definition minus run()
      const manifest = {
        name: agent.name,
        description: agent.description,
        triggers: agent.triggers,
      };
      return json(res, 200, manifest);
    }

    if (method === "POST" && url === "/run") {
      let rawBody = "";
      req.on("data", (chunk: Buffer) => {
        rawBody += chunk.toString();
      });
      req.on("end", () => {
        // Relay signature verification — only when SUEDE_RELAY_SECRET is set.
        const relaySecret = process.env.SUEDE_RELAY_SECRET;
        if (relaySecret) {
          const sig = req.headers["x-suede-signature"];
          if (typeof sig !== "string" || !verifySignature(rawBody, relaySecret, sig)) {
            return json(res, 401, { error: "Invalid or missing relay signature" });
          }
        }

        let parsed: { input?: unknown; trigger?: string };
        try {
          parsed = JSON.parse(rawBody) as { input?: unknown; trigger?: string };
        } catch {
          return json(res, 400, { error: "Invalid JSON body" });
        }

        const triggerKind = (parsed.trigger ?? "manual") as AgentContext["trigger"];
        const ctx: AgentContext = {
          input: parsed.input ?? null,
          trigger: triggerKind,
          memory,
        };

        void agent
          .run(ctx)
          .then((output) => {
            json(res, 200, { output });
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            json(res, 500, { error: message });
          });
      });
      return;
    }

    json(res, 404, { error: `Not found: ${method} ${url}` });
  });

  server.listen(options.port, "127.0.0.1", () => {
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : options.port;
    process.stdout.write(`[suede] Agent "${agent.name}" serving on http://127.0.0.1:${port}\n`);
  });

  return {
    _server: server,
    close(): void {
      server.close();
    },
  };
}
