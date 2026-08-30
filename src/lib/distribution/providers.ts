/**
 * The single machine-readable registry of agent-commerce protocol providers.
 *
 * `venues.ts` answers WHERE a launched agent gets listed. This file answers
 * WHICH protocols the studio actually speaks, WHO stewards each one, and where
 * a partnership conversation with that steward starts. Every entry states what
 * is implemented today in the plain proof voice, with a dated receipt and the
 * live path that verifies it, so the /integrations page and /api/providers
 * feed can never drift from the code.
 *
 * Pure data. Client-safe: no server imports, no Node APIs. Public copy rule:
 * no em dashes in any string here (these strings render on public surfaces).
 */

/** Where a partnership conversation with the steward starts. */
export type ProviderChannelKind = "github" | "form" | "site";

export interface ProviderChannel {
  kind: ProviderChannelKind;
  url: string;
  /** Honest one-liner: what this channel is and who reads it. */
  note: string;
}

export interface ProviderReceipt {
  /** ISO date the integration shipped. */
  date: string;
  /** What shipped, named the way the repo names it (PR, decision, commit). */
  ref: string;
  /** Live path on this site, or the steward's spec URL, that verifies it. */
  verifyUrl: string;
}

export interface ProtocolProvider {
  id: string;
  /** Protocol or surface name as the ecosystem writes it. */
  protocol: string;
  /** Organization or community that stewards the protocol. */
  steward: string;
  stewardUrl: string;
  /** What Agent Studio implements today. Plain voice, no promises. */
  implemented: string;
  /** Repo modules that carry the implementation. */
  modules: readonly string[];
  /** Live, publicly reachable paths on this site that prove the integration. */
  endpoints: readonly string[];
  receipt: ProviderReceipt;
  /** The specific partnership ask, used verbatim in generated outreach. */
  partnerAsk: string;
  partnerChannel: ProviderChannel;
  /**
   * Present only where a partnership actually exists. Absent means the entry
   * is an implementation the studio built against an open protocol, which is
   * the case for every steward we have merely contacted. Never set this from
   * an outreach message that went unanswered.
   */
  partner?: ProviderPartnership;
}

export interface ProviderPartnership {
  /** Short public label. Rendered as a badge, so keep it to a few words. */
  label: string;
  /** One plain sentence a reader can check against what is shipped. */
  detail: string;
}

export const PROTOCOL_PROVIDERS: readonly ProtocolProvider[] = [
  {
    id: "x402",
    protocol: "x402 v2",
    steward: "Coinbase and the open x402 community",
    stewardUrl: "https://www.x402.org",
    implemented:
      "Priced Live calls answer HTTP 402 with an exact USDC quote on Base and run only after the signed payment authorization verifies. Settlement is off by default and opt-in per agent, and every settled call routes to the creator's payout wallet.",
    modules: [
      "src/lib/rails/x402-verify.ts",
      "src/lib/rails/x402-client.ts",
      "src/lib/rails/x402-reconcile.ts",
    ],
    endpoints: ["/.well-known/x402", "/api/catalog"],
    receipt: {
      date: "2026-08-09",
      ref: "Paid-call rail end to end, PR #291",
      verifyUrl: "/.well-known/x402",
    },
    partnerAsk:
      "list Suede Agent Studio as a production x402 implementation and keep our discovery surfaces aligned as the protocol evolves",
    partnerChannel: {
      kind: "form",
      url: "https://x402.org/contact/",
      note: "The x402 team's own contact form.",
    },
  },
  {
    id: "ap2",
    protocol: "AP2 v0.2",
    steward: "Google and the Agent Payments Protocol contributors",
    stewardUrl: "https://github.com/google-agentic-commerce/AP2",
    implemented:
      "Merchant authorization for AP2 v0.2, live in optional mode: an ES256-signed merchant JWKS, a durable authorization ledger with replay-nonce reservation, and AP2 mandate negotiation forwarded over A2A. Settlement still runs on the x402 v2 rail, and the discovery document returns 404 whenever merchant keys or the replay ledger are not ready.",
    modules: ["src/lib/rails/ap2", "src/lib/rails/ap2-runtime.ts"],
    endpoints: ["/.well-known/ap2.json", "/.well-known/ap2-jwks.json"],
    receipt: {
      date: "2026-08-29",
      ref: "AP2 merchant keys and replay ledger activated in production",
      verifyUrl: "/.well-known/ap2.json",
    },
    partnerAsk:
      "review our AP2 v0.2 merchant authorization flow and consider Suede Agent Studio as a merchant-side reference deployment",
    partnerChannel: {
      kind: "github",
      url: "https://github.com/google-agentic-commerce/AP2",
      note: "The open AP2 protocol repository.",
    },
  },
  {
    id: "a2a",
    protocol: "A2A",
    steward: "The A2A Project under the Linux Foundation",
    stewardUrl: "https://github.com/a2aproject/A2A",
    implemented:
      "A studio agent card at the well-known path plus a per-agent card and an A2A HTTP JSON endpoint for every published agent, so other agents can discover, read the contract, and invoke without a human.",
    modules: [
      "src/lib/discovery/a2a-http-json.ts",
      "src/lib/discovery/agent-card.ts",
      "src/lib/discovery/a2a-contract.ts",
    ],
    endpoints: ["/.well-known/agent-card.json"],
    receipt: {
      date: "2026-08-13",
      ref: "Suede agent card and A2A HTTP JSON contract",
      verifyUrl: "/.well-known/agent-card.json",
    },
    partnerAsk:
      "reference Suede Agent Studio's agent cards as a live A2A deployment and tell us where our card projection should track the spec more closely",
    partnerChannel: {
      kind: "github",
      url: "https://github.com/a2aproject/A2A",
      note: "The A2A protocol repository and discussions.",
    },
  },
  {
    id: "mcp",
    protocol: "Model Context Protocol",
    steward: "Anthropic and the MCP community",
    stewardUrl: "https://github.com/modelcontextprotocol",
    implemented:
      "Every published agent is exposed as a callable MCP tool over HTTP, with real input schemas derived from the published graph and metered runs charged against pre-funded credit.",
    modules: ["src/lib/mcp"],
    endpoints: ["/api/mcp", "/docs/mcp"],
    receipt: {
      date: "2026-08-05",
      ref: "Published agents as MCP tools, PR #279",
      verifyUrl: "/docs/mcp",
    },
    partnerAsk:
      "include the Suede Agent Studio MCP surface in community server listings and flag anything in our tool projection that should track the spec more closely",
    partnerChannel: {
      kind: "github",
      url: "https://github.com/modelcontextprotocol",
      note: "The MCP specification organization on GitHub.",
    },
  },
  {
    id: "webmcp",
    protocol: "WebMCP",
    steward: "The W3C Web Machine Learning Community Group",
    stewardUrl: "https://github.com/webmachinelearning/webmcp",
    implemented:
      "A browser-session storefront: an agent arriving inside a visitor's logged-in browser can list what the studio sells, read the exact contract, preview for free, and buy, without an API key ever being minted. The transport is the page itself, not an HTTP endpoint.",
    modules: ["src/lib/webmcp"],
    endpoints: [],
    receipt: {
      date: "2026-08-27",
      ref: "Sell to AI agents from the browser session, PR #361",
      verifyUrl: "https://github.com/webmachinelearning/webmcp",
    },
    partnerAsk:
      "take our origin-trial feedback and count Suede Agent Studio as an early WebMCP commerce deployment",
    partnerChannel: {
      kind: "github",
      url: "https://github.com/webmachinelearning/webmcp",
      note: "The WebMCP proposal repository and issue tracker.",
    },
  },
  {
    id: "agentcash",
    protocol: "AgentCash discovery",
    steward: "AgentCash",
    stewardUrl: "https://agentcash.dev",
    implemented:
      "The OpenAPI document projects every payment-enabled agent as a concrete paid route with the x-payment-info extension AgentCash discovery reads, so a funded agent can find a service, follow the 402 challenge, and pay per call.",
    modules: ["src/app/openapi.json/route.ts"],
    endpoints: ["/openapi.json"],
    receipt: {
      date: "2026-08-27",
      ref: "AgentCash payment discovery metadata, PR #362",
      verifyUrl: "/openapi.json",
    },
    partnerAsk:
      "index our OpenAPI x-payment-info routes in AgentCash discovery and tell us what would make the studio's services first-class for AgentCash-funded agents",
    partnerChannel: {
      kind: "site",
      url: "https://agentcash.dev/merchant",
      note: "The AgentCash merchant onboarding surface.",
    },
    partner: {
      label: "Partner",
      detail:
        "Suede and AgentCash are partners. AgentCash opened the conversation, and the discovery metadata their agents read is live on our OpenAPI document.",
    },
  },
] as const;

/** Look up a protocol provider by id, or null when the id is unknown. */
export function getProtocolProvider(id: string): ProtocolProvider | null {
  return PROTOCOL_PROVIDERS.find((provider) => provider.id === id) ?? null;
}
