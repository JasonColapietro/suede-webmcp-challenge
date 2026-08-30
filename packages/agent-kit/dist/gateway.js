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
export class GatewayError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = "GatewayError";
        this.status = status;
    }
}
/**
 * Execute a named platform node (e.g. "input", "llm", "output") on the Suede
 * gateway. This is what the codegen emits for each manifest step: `suede.run(nodeType, config)`.
 *
 * In STUB mode (SUEDE_GATEWAY_STUB=1): returns { output: config } immediately.
 * In live mode: POSTs to /api/gateway/run — ships in Phase 9.
 */
async function callRun(nodeType, config) {
    const stub = process.env["SUEDE_GATEWAY_STUB"];
    if (stub === "1") {
        return { output: config };
    }
    const apiUrl = process.env["SUEDE_API_URL"] ?? "https://agents.suedeai.ai";
    const workspaceKey = process.env["SUEDE_WORKSPACE_KEY"] ?? "";
    const url = `${apiUrl}/api/gateway/run`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${workspaceKey}`,
            },
            body: JSON.stringify({ nodeType, config }),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GatewayError(0, `Network error calling gateway/run: ${message}`);
    }
    if (response.status === 401) {
        throw new GatewayError(401, "Gateway: invalid or missing workspace key — claim yours at /flows");
    }
    if (response.status === 429) {
        throw new GatewayError(429, "Gateway: rate limit exceeded");
    }
    if (response.status === 402) {
        // Surface topup instructions from machine-readable 402 body.
        let topupMsg = "Top up at /api/gateway/topup";
        try {
            const body = await response.json();
            if (body.topup?.topupEndpoint) {
                const tiers = body.topup.tiers?.join("|") ?? "1|5|20";
                topupMsg = `Top up at ${body.topup.topupEndpoint}?tier=${tiers.split("|")[0]} (x402, USDC on Base)`;
            }
        }
        catch { /* non-fatal */ }
        throw new GatewayError(402, `Gateway: gateway credit exhausted. ${topupMsg}`);
    }
    if (!response.ok) {
        throw new GatewayError(response.status, `Gateway: unexpected ${response.status}`);
    }
    const data = (await response.json());
    return { output: data.output };
}
async function callLlm(input) {
    const stub = process.env["SUEDE_GATEWAY_STUB"];
    if (stub === "1") {
        // Local echo mode — no HTTP, safe for offline development
        return { text: `${input.system}\n${input.prompt}` };
    }
    const apiUrl = process.env["SUEDE_API_URL"] ?? "https://agents.suedeai.ai";
    const workspaceKey = process.env["SUEDE_WORKSPACE_KEY"] ?? "";
    const url = `${apiUrl}/api/gateway/llm`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${workspaceKey}`,
            },
            body: JSON.stringify({ system: input.system, prompt: input.prompt }),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GatewayError(0, `Network error calling gateway: ${message}`);
    }
    if (response.status === 401) {
        throw new GatewayError(401, "Gateway: invalid or missing workspace key — claim yours at /flows");
    }
    if (response.status === 429) {
        throw new GatewayError(429, "Gateway: rate limit exceeded — slow down or upgrade your plan");
    }
    if (response.status === 402) {
        // Surface topup instructions from machine-readable 402 body.
        let topupMsg = "Top up at /api/gateway/topup";
        try {
            const body = await response.json();
            if (body.topup?.topupEndpoint) {
                const tiers = body.topup.tiers?.join("|") ?? "1|5|20";
                topupMsg = `Top up at ${body.topup.topupEndpoint}?tier=${tiers.split("|")[0]} (x402, USDC on Base)`;
            }
        }
        catch { /* non-fatal */ }
        throw new GatewayError(402, `Gateway: monthly token limit reached. ${topupMsg}`);
    }
    if (!response.ok) {
        throw new GatewayError(response.status, `Gateway: unexpected ${response.status}`);
    }
    const data = (await response.json());
    if (typeof data.text !== "string") {
        throw new GatewayError(0, "Gateway: response missing 'text' field");
    }
    return { text: data.text };
}
/**
 * The suede namespace — entry point for all Suede platform calls in agent code.
 *
 * - `suede.llm({ system, prompt })` — metered LLM gateway call (Phase 9 server route)
 * - `suede.run(nodeType, config)` — execute a platform node step (emitted by codegen for each step)
 */
export const suede = {
    llm: callLlm,
    run: (nodeType, config = {}) => callRun(nodeType, config),
};
//# sourceMappingURL=gateway.js.map