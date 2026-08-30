/**
 * Creator money surfaces: the Workspace, Studio, Guided and from-website
 * clients must tell the truth about whether an agent is collecting payment,
 * and give the creator a control on every surface.
 *
 * This repo has no React testing-library, so these are source-shape
 * assertions in the same dialect as tests/google-play-flows-ui-gate.test.ts.
 * They pin three contracts:
 *  1. The Workspace never frames revenue served with Settle off as "pending".
 *  2. Every launch surface exposes a settlement opt-in that POSTs the
 *     existing /api/agents/[agent]/settlement route with { live: true } —
 *     settlement DEFAULTS stay off; these are opt-in controls only.
 *  3. The client-side TOPUP_TIERS mirror cannot drift from the server list.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOPUP_TIERS } from "@/lib/gateway/topup-handler";

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const flowsPage = read("src/app/flows/dashboard.tsx");
const buildPage = read("src/app/build/[flowId]/builder.tsx");
const guidedClient = read("src/app/start/guided-client.tsx");
const siteAgentClient = read("src/app/from-website/site-agent-client.tsx");
const agentDetail = read("src/components/portfolio/StudioAgentDetail.tsx");
const reviewLib = read("src/lib/guided/review.ts");

describe("Workspace money panel (/flows)", () => {
  it("mirrors the server TOPUP_TIERS exactly, since the handler is server-only", () => {
    // The page cannot import src/lib/gateway/topup-handler (it pulls the x402
    // verify stack into the client bundle), so it carries a mirror constant.
    // This tripwire fails the moment the server list changes.
    expect(flowsPage).toContain(
      `const TOPUP_TIERS = [${TOPUP_TIERS.join(", ")}] as const;`,
    );
  });

  it("renders every one-time tier as a card button", () => {
    expect(flowsPage).toContain("TOPUP_TIERS.map((tier) => (");
    expect(flowsPage).toContain("Add $${tier} by card");
  });

  it("frames the settle-off gap as served free, never pending", () => {
    expect(flowsPage).toContain("served free");
    expect(flowsPage).toContain("pending settlement");
    // The per-row copy must branch on the agent's settlement switch.
    expect(flowsPage).toContain("agent.settlementLive");
    // And the panel splits the two sums instead of blending them.
    expect(flowsPage).toContain("pendingCollectingUsdc");
    expect(flowsPage).toContain("servedFreeUsdc");
  });

  it("flags live priced non-collecting agents and counts collectors in the fleet line", () => {
    expect(flowsPage).toContain("not collecting");
    expect(flowsPage).toContain(
      'a.status === "live" && a.priceUsdc > 0 && !a.settlementLive',
    );
    expect(flowsPage).toContain("collectingCount");
    expect(flowsPage).toContain("collecting\n");
  });

  it("offers a bulk turn-on-Settle action that hits the settlement route", () => {
    expect(flowsPage).toContain("Turn on Settle to start collecting");
    expect(flowsPage).toContain("handleEnableCollecting");
    // Opt-in only: the bulk action may send live: true, never a default flip.
    expect(flowsPage).toContain("JSON.stringify({ live: true })");
  });

  it("links the Earnings figure to /portfolio and saves a wallet inline", () => {
    expect(flowsPage).toContain('href="/portfolio"');
    expect(flowsPage).toContain("handleWalletSave");
    expect(flowsPage).toContain("EVM_ADDRESS_RE");
    // The wallet write rides a relaunch of an agent that is ALREADY live.
    expect(flowsPage).toContain('data.agents.find((a) => a.status === "live")');
    expect(flowsPage).toContain("JSON.stringify({ payoutAddress: address })");
  });
});

describe("Studio publish popover and launch panel", () => {
  it("defaults the price field to blank and forces an explicit choice at launch", () => {
    expect(buildPage).toContain('useState<string>("")');
    expect(buildPage).toContain(
      "Set a price per call before launching. Enter 0 to serve calls free.",
    );
    expect(buildPage).toContain('if (trimmedPrice === "") {');
  });

  it("offers the collect-on-launch opt-in and posts settlement AFTER a successful launch", () => {
    expect(buildPage).toContain("Start collecting payment on launch");
    expect(buildPage).toContain("collectOnLaunch");
    // The settlement POST lives inside the slug-success branch of the launch
    // handler, so a failed launch can never flip settlement.
    const launchStart = buildPage.indexOf("const handleLaunch");
    const slugGate = buildPage.indexOf("if (slug) {", launchStart);
    const settlePost = buildPage.indexOf("/settlement", slugGate);
    expect(slugGate).toBeGreaterThan(launchStart);
    expect(settlePost).toBeGreaterThan(slugGate);
    expect(buildPage).toContain("JSON.stringify({ live: true })");
  });

  it("consumes the launch response money fields defensively", () => {
    expect(buildPage).toContain('typeof d.settlementLive === "boolean"');
    expect(buildPage).toContain('typeof d.payoutWarning === "string"');
    expect(buildPage).toContain('typeof d.floorUsdc === "number"');
    expect(buildPage).toContain('typeof d.suggestedUsdc === "number"');
  });

  it("tells the truth about settlement state in the launch panel", () => {
    expect(buildPage).toContain("Calls are free previews until you turn on settlement.");
    expect(buildPage).toContain("Start collecting payment");
    // Unknown must not be asserted as a state.
    expect(buildPage).toContain("info.settlementLive === true");
    expect(buildPage).toContain("info.settlementLive === false");
  });
});

describe("Guided and from-website launch clients", () => {
  it("Guided asks for a wallet only when the manifest prices calls", () => {
    expect(guidedClient).toContain("manifestPricesCalls");
    expect(guidedClient).toContain(
      't.kind === "paidCall" && t.priceUsdc > 0',
    );
    expect(guidedClient).toContain('id="guided-wallet"');
  });

  it("both clients pass the payout wallet in the launch body", () => {
    for (const source of [guidedClient, siteAgentClient]) {
      expect(source).toContain("payoutAddress: trimmedWallet");
    }
  });

  it("both clients show settlement state and a one-click opt-in post-launch", () => {
    for (const source of [guidedClient, siteAgentClient]) {
      expect(source).toContain("Calls are free previews until you turn on settlement.");
      expect(source).toContain("Start collecting payment");
      expect(source).toContain("handleEnableSettlement");
      expect(source).toContain("JSON.stringify({ live: true })");
      // Defensive launch-response reads: the new fields are optional.
      expect(source).toContain("launchData.settlementLive === true");
      expect(source).toContain('typeof launchData.payoutWarning === "string"');
    }
  });

  it("renders the payoutWarning from the launch response when present", () => {
    expect(guidedClient).toContain("currentPhase.payoutWarning");
    expect(siteAgentClient).toContain("phase.payoutWarning");
  });

  it("keeps Launch it on the legacy flow route and offers a secondary draft-only Foundry import", () => {
    expect(siteAgentClient).toContain('fetch("/api/flows"');
    expect(siteAgentClient).toContain("`/api/flows/${flowId}/launch`");
    expect(siteAgentClient).toContain("Continue in Resource Foundry");
    expect(siteAgentClient).toContain('fetch("/api/v2/resources/import/site-agent"');
    expect(siteAgentClient).toContain("router.push(data.redirectTo)");
  });
});

describe("Studio agent detail (portfolio)", () => {
  it("reads settlement from /api/me and never guesses when unknown", () => {
    expect(agentDetail).toContain("readSettlementLive");
    expect(agentDetail).toContain('fetch("/api/me")');
    expect(agentDetail).toContain("settlementLive !== null");
  });

  it("exposes the go-live toggle against the settlement route", () => {
    expect(agentDetail).toContain("Go live: accept payment");
    expect(agentDetail).toContain("Stop collecting payment");
    expect(agentDetail).toContain("/settlement");
    expect(agentDetail).toContain("JSON.stringify({ live: !settlementLive })");
  });
});

describe("Guided review copy", () => {
  it("never promises a workspace wallet that does not exist", () => {
    // The old fallback string must be gone; comments may still reference the
    // phrase to explain why it was wrong.
    expect(reviewLib).not.toContain('"Payouts go to your workspace wallet."');
    expect(reviewLib).toContain("No payout wallet yet");
  });
});
