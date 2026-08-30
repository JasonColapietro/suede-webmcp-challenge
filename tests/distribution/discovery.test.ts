/**
 * Discovery layer: venue registry, generated payloads, the agent_listings repo
 * methods, and per-agent readiness.
 *
 * The load-bearing guarantees under test:
 * - The registry states each venue's real mechanism (no fake one-click).
 * - Payload builders refuse to emit a listing with a zero-address payTo.
 * - agent_listings upsert is idempotent per (agent, venue) and preserves the
 *   original submittedAt.
 * - Readiness reports facts (payout wallet, emitted x402 version) and gates on
 *   ownership.
 */
import { describe, it, expect } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { getRepo } from "@/lib/db/repo";
import { ZERO_ADDRESS } from "@/lib/payout";
import { DISCOVERY_VENUES, getVenue } from "@/lib/distribution/venues";
import {
  buildServiceDescriptor,
  buildSatringPayload,
  buildX402ScoutRegisterBody,
  NoPayoutWalletError,
} from "@/lib/distribution/payloads";
import {
  checkAgentDiscoveryReadiness,
  DiscoveryAgentNotFoundError,
} from "@/lib/distribution/readiness";
import type { CatalogEntry } from "@/lib/catalog";

const REAL_WALLET = "0x1111111111111111111111111111111111111111";

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return Object.assign({
    id: "agent-1",
    slug: "lead-qualifier-ab12c",
    name: "Lead Qualifier",
    summary: "Input › LLM › Output",
    description: null,
    priceUsdc: 0.25,
    calls: 0,
    settledCalls: 0,
    lastCallAt: null,
    createdAt: Date.now(),
    settlementLive: true,
    acceptsPayment: true,
    paymentState: "payment-enabled" as const,
    previewAvailable: true,
    publishedLive: true,
    payTo: REAL_WALLET,
    schedule: null,
    inputSchema: { type: "object" },
    urls: {
      public: "/a/lead-qualifier-ab12c",
      run: "/api/agents/agent-1/run",
      x402: "/api/agents/lead-qualifier-ab12c/.well-known/x402",
      agentCard: "/api/agents/lead-qualifier-ab12c/.well-known/agent-card",
      a2a: "/api/agents/lead-qualifier-ab12c/a2a",
    },
  }, overrides);
}

describe("discovery venue registry", () => {
  it("lists the nine venues with honest mechanisms", () => {
    expect(DISCOVERY_VENUES).toHaveLength(9);
    const byId = new Map(DISCOVERY_VENUES.map((v) => [v.id, v]));
    expect(byId.get("x402scout")?.mechanism).toBe("push-free");
    expect(byId.get("awesome-x402-xpaysh")?.mechanism).toBe("push-github");
    expect(byId.get("awesome-x402-index")?.mechanism).toBe("push-github");
    expect(byId.get("x402-index-discovery")?.github).toMatchObject({ kind: "issue" });
    expect(byId.get("bazaar")?.mechanism).toBe("auto");
    expect(byId.get("x402search")?.mechanism).toBe("auto");
    expect(byId.get("satring")?.mechanism).toBe("paid");
    expect(byId.get("satring")?.requiresPaymentV2).toBe(true);
    expect(byId.get("satring")?.costUsdc).toBe(0.5);
    expect(byId.get("paysh")?.mechanism).toBe("manual");
    expect(byId.get("agentic-market")?.mechanism).toBe("manual");
  });

  it("resolves a venue by id and returns null for unknown ids", () => {
    expect(getVenue("x402scout")?.name).toBeTruthy();
    expect(getVenue("nope")).toBeNull();
  });
});

describe("generated submission payloads", () => {
  it("builds the x402Scout register body from live entry data", () => {
    const body = buildX402ScoutRegisterBody(makeEntry());
    expect(body.name).toBe("Lead Qualifier");
    expect(body.price_usd).toBe(0.25);
    expect(body.url).toContain("/api/agents/lead-qualifier-ab12c/.well-known/x402");
  });

  it("refuses to build a listing with a zero-address payTo", () => {
    const noWallet = makeEntry({ payTo: ZERO_ADDRESS });
    expect(() => buildX402ScoutRegisterBody(noWallet)).toThrow(NoPayoutWalletError);
    expect(() => buildSatringPayload(noWallet)).toThrow(NoPayoutWalletError);
    try {
      buildX402ScoutRegisterBody(noWallet);
    } catch (error) {
      expect(error).toBeInstanceOf(NoPayoutWalletError);
      expect((error as NoPayoutWalletError).code).toBe("NO_PAYOUT_WALLET");
    }
  });

  it("prices the Satring payload from the agent's real price", () => {
    const payload = buildSatringPayload(makeEntry({ priceUsdc: 0.1 }));
    expect(payload.pricing.amount).toBe("0.10");
    expect(payload.protocols).toEqual(["x402"]);
  });

  it("emits a service descriptor at x402 version 2", () => {
    const service = buildServiceDescriptor();
    expect(service.x402Version).toBe(2);
    expect(service.name).toBe("Suede Agent Studio");
  });
});

describe("agent_listings repo methods", () => {
  it("upserts idempotently per (agent, venue) and preserves submittedAt", async () => {
    const repo = new SqliteRepo(":memory:");
    const first = await repo.upsertAgentListing({
      agentId: "a1",
      venueId: "x402scout",
      status: "submitted",
      externalUrl: "https://x402-discovery-api.onrender.com",
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.upsertAgentListing({
      agentId: "a1",
      venueId: "x402scout",
      status: "listed",
      externalUrl: "https://x402-discovery-api.onrender.com",
    });
    expect(second.submittedAt).toBe(first.submittedAt); // original submission time kept
    expect(second.status).toBe("listed");

    const listings = await repo.listAgentListings("a1");
    expect(listings).toHaveLength(1); // one row per (agent, venue)
    expect(listings[0].status).toBe("listed");
  });

  it("keeps separate rows for different venues", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.upsertAgentListing({ agentId: "a2", venueId: "x402scout", status: "submitted" });
    await repo.upsertAgentListing({ agentId: "a2", venueId: "paysh", status: "pending" });
    const listings = await repo.listAgentListings("a2");
    expect(listings).toHaveLength(2);
    expect(new Set(listings.map((l) => l.venueId))).toEqual(new Set(["x402scout", "paysh"]));
  });
});

describe("per-agent discovery readiness", () => {
  it("reports facts for an owned live agent and gates on ownership", async () => {
    const repo = await getRepo();
    const owner = "readiness-owner-" + Math.random().toString(36).slice(2, 8);
    const flow = await repo.saveFlow({
      ownerId: owner,
      name: "Readiness Flow",
      graph: { id: "g-readiness", name: "Readiness Flow", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "readiness-agent-" + Math.random().toString(36).slice(2, 6),
      status: "live",
      priceUsdc: 0.2,
    });
    await repo.saveWallet({ ownerId: owner, address: REAL_WALLET });

    const report = await checkAgentDiscoveryReadiness(agent.slug, owner);
    expect(report.protocolVersion).toBe(2);
    expect(report.checks).toHaveLength(9);

    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get("payout_wallet")?.state).toBe("pass");
    // Fresh agents default settlement OFF, so this reports a fixable fail.
    expect(byId.get("settlement_ready")?.state).toBe("fail");
    expect(byId.get("settlement_ready")?.fix).toBeTruthy();
    expect(byId.get("protocol_version")?.state).toBe("info");
    expect(byId.get("crawlable")?.state).toBe("info");
  });

  it("fails readiness with a fixable payout-wallet check when no wallet is set", async () => {
    const prevPlatform = process.env.X402_SELLER_WALLET_ADDRESS;
    delete process.env.X402_SELLER_WALLET_ADDRESS;
    try {
      const repo = await getRepo();
      const owner = "readiness-nowallet-" + Math.random().toString(36).slice(2, 8);
      const flow = await repo.saveFlow({
        ownerId: owner,
        name: "No Wallet Flow",
        graph: { id: "g-nowallet", name: "No Wallet Flow", nodes: [], edges: [] },
      });
      const agent = await repo.createAgent({
        flowId: flow.id,
        slug: "nowallet-agent-" + Math.random().toString(36).slice(2, 6),
        status: "live",
        priceUsdc: 0.1,
      });
      const report = await checkAgentDiscoveryReadiness(agent.slug, owner);
      const payout = report.checks.find((c) => c.id === "payout_wallet");
      expect(payout?.state).toBe("fail");
      expect(payout?.fix).toContain("payout wallet");
    } finally {
      if (prevPlatform === undefined) delete process.env.X402_SELLER_WALLET_ADDRESS;
      else process.env.X402_SELLER_WALLET_ADDRESS = prevPlatform;
    }
  });

  it("throws not-found for a wrong owner and an unknown agent", async () => {
    const repo = await getRepo();
    const owner = "readiness-owner2-" + Math.random().toString(36).slice(2, 8);
    const flow = await repo.saveFlow({
      ownerId: owner,
      name: "Owned Flow",
      graph: { id: "g-owned", name: "Owned Flow", nodes: [], edges: [] },
    });
    const agent = await repo.createAgent({
      flowId: flow.id,
      slug: "owned-agent-" + Math.random().toString(36).slice(2, 6),
      status: "live",
      priceUsdc: 0.1,
    });
    await expect(checkAgentDiscoveryReadiness(agent.slug, "someone-else")).rejects.toBeInstanceOf(
      DiscoveryAgentNotFoundError,
    );
    await expect(checkAgentDiscoveryReadiness("no-such-agent", owner)).rejects.toBeInstanceOf(
      DiscoveryAgentNotFoundError,
    );
  });
});
