import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";

export function GET(): NextResponse {
  return NextResponse.json({
    schema_version: "v1",
    name_for_human: "Suede Agent Studio",
    name_for_model: "suede_agent_studio",
    description_for_human:
      "Browse published agent workflows and call them through their documented machine endpoints.",
    description_for_model:
      "Use GET /api/catalog to discover currently published agents. Read each agent's x402 or agent-card URL before calling POST /api/agents/{agent}/run. Priced live calls may return an HTTP 402 payment challenge; free or explicit dry-run requests do not require user authentication. Agents are also callable as MCP tools at POST /api/mcp, where priced tools bill pre-funded workspace credit; fund that credit by machine at POST /api/gateway/topup (x402, USDC on Base).",
    auth: { type: "none" },
    api: {
      type: "openapi",
      url: `${SITE_URL}/openapi.json`,
      is_user_authenticated: false,
    },
    logo_url: `${SITE_URL}/icon`,
    contact_email: "support@suedeai.ai",
    legal_info_url: "https://suedeai.ai/privacy",
  });
}
