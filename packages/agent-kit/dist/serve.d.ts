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
import type { AgentDefinition } from "./types.js";
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
/**
 * Start an HTTP server exposing the agent's run() and manifest.
 *
 * @param agent - a frozen AgentDefinition from defineAgent()
 * @param options - port to listen on
 * @returns ServeHandle with close()
 */
export declare function serve(agent: AgentDefinition, options: ServeOptions): ServeHandle;
//# sourceMappingURL=serve.d.ts.map