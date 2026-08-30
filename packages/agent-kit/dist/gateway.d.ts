/**
 * Suede gateway client — suede.llm({ system, prompt }) → { text }
 *
 * The server route ships in Phase 9. In v0 the client works offline via
 * SUEDE_GATEWAY_STUB=1 (echoes system + prompt, no HTTP).
 *
 * Environment variables (all optional at import time; read at call time):
 *   SUEDE_API_URL         — override platform URL (default: https://agents.suedeai.ai)
 *   SUEDE_WORKSPACE_KEY   — workspace bearer token (claim at /flows)
 *   SUEDE_GATEWAY_STUB    — set to "1" for offline local echo mode
 */
export declare class GatewayError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export interface LlmInput {
    system: string;
    prompt: string;
}
export interface LlmResult {
    text: string;
}
export interface RunResult {
    output: unknown;
}
/**
 * The suede namespace — entry point for all Suede platform calls in agent code.
 *
 * - `suede.llm({ system, prompt })` — metered LLM gateway call (Phase 9 server route)
 * - `suede.run(nodeType, config)` — execute a platform node step (emitted by codegen for each step)
 */
export declare const suede: {
    llm(input: LlmInput): Promise<LlmResult>;
    run(nodeType: string, config?: Record<string, unknown>): Promise<RunResult>;
};
//# sourceMappingURL=gateway.d.ts.map