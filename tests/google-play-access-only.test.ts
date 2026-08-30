/**
 * Unit tests for the Google Play access-only gate.
 *
 * The property under test is not "some paths are blocked" — it is that the
 * gate is deny-by-default and activated by host identity alone. Both matter:
 * an allowlist that leaks turns a shippable app into a removable one, and a
 * non-host activation switch is a way for the restricted runtime to appear on
 * agents.suedeai.ai (or the reverse).
 */

import { describe, expect, it } from "vitest";
import {
  GOOGLE_PLAY_ANDROID_HOST,
  GOOGLE_PLAY_APP_ORIGIN,
  isGooglePlayAccessOnlyHost,
  isGooglePlayAllowedApiPath,
  isGooglePlayAllowedAppPath,
  isGooglePlayBlockedCommerceDiscoveryPath,
  isGooglePlayBlockedPaymentPath,
  sanitizeGooglePlayAppDestination,
  sanitizeGooglePlaySearchParams,
} from "@/lib/google-play-access-only";

describe("Google Play access-only host identity", () => {
  it("uses a dedicated host, not the canonical one", () => {
    expect(GOOGLE_PLAY_ANDROID_HOST).toBe("android-agents.suedeai.ai");
    expect(GOOGLE_PLAY_APP_ORIGIN).toBe("https://android-agents.suedeai.ai");
    expect(isGooglePlayAccessOnlyHost("agents.suedeai.ai")).toBe(false);
  });

  it("matches the exact host, case-insensitively, with an optional port", () => {
    expect(isGooglePlayAccessOnlyHost("android-agents.suedeai.ai")).toBe(true);
    expect(isGooglePlayAccessOnlyHost("ANDROID-AGENTS.SUEDEAI.AI")).toBe(true);
    expect(isGooglePlayAccessOnlyHost(" android-agents.suedeai.ai ")).toBe(true);
    expect(isGooglePlayAccessOnlyHost("android-agents.suedeai.ai:3000")).toBe(true);
  });

  it("rejects lookalike hosts, suffixes, and malformed ports", () => {
    for (const host of [
      "",
      null,
      undefined,
      "evil-android-agents.suedeai.ai",
      "android-agents.suedeai.ai.attacker.test",
      "android-agents.suedeai.aix",
      "sub.android-agents.suedeai.ai",
      "android-agents.suedeai.ai:0",
      "android-agents.suedeai.ai:99999",
      "android-agents.suedeai.ai:port",
    ]) {
      expect(isGooglePlayAccessOnlyHost(host)).toBe(false);
    }
  });
});

describe("blocked payment routes", () => {
  it("blocks the Stripe card checkout that caused the violation", () => {
    expect(isGooglePlayBlockedPaymentPath("/api/gateway/topup/stripe")).toBe(true);
  });

  it("blocks the x402/USDC path to the same balance and the Stripe webhook", () => {
    expect(isGooglePlayBlockedPaymentPath("/api/gateway/topup")).toBe(true);
    expect(isGooglePlayBlockedPaymentPath("/api/gateway/topup/stripe/webhook")).toBe(true);
  });

  it("leaves the metered gateway itself usable", () => {
    expect(isGooglePlayBlockedPaymentPath("/api/gateway/llm")).toBe(false);
    expect(isGooglePlayBlockedPaymentPath("/api/gateway/run")).toBe(false);
  });
});

describe("blocked commerce discovery", () => {
  it("blocks every static agent-commerce manifest this studio publishes", () => {
    for (const pathname of [
      "/.well-known/x402",
      "/.well-known/x402.json",
      "/.well-known/agent-card.json",
      "/.well-known/ai-plugin.json",
      "/api/catalog",
      "/api/services",
      "/api/mcp",
      "/api/cli/agents",
      "/api/cli/agents/some-agent/relay",
      "/llms.txt",
      "/openapi.json",
      "/sitemap.xml",
    ]) {
      expect(isGooglePlayBlockedCommerceDiscoveryPath(pathname)).toBe(true);
    }
  });

  it("blocks the per-agent paid and discovery endpoints under a dynamic slug", () => {
    for (const pathname of [
      "/api/agents/lead-qualifier/.well-known/x402",
      "/api/agents/lead-qualifier/.well-known/agent-card",
      "/api/agents/lead-qualifier/run",
      "/api/agents/lead-qualifier/a2a",
      "/api/agents/lead-qualifier/discovery",
      "/api/agents/lead-qualifier/discovery/submit",
      "/api/agents/lead-qualifier/settlement",
    ]) {
      expect(isGooglePlayBlockedCommerceDiscoveryPath(pathname)).toBe(true);
    }
  });

  it("keeps the builder's own per-agent management routes usable", () => {
    expect(isGooglePlayAllowedApiPath("/api/agents/lead-qualifier/template")).toBe(true);
    expect(isGooglePlayAllowedApiPath("/api/agents/lead-qualifier/webhook")).toBe(true);
    expect(isGooglePlayAllowedApiPath("/api/agents/lead-qualifier/webhook/rotate")).toBe(true);
  });

  it("does not block a path that merely starts with a blocked prefix's characters", () => {
    expect(isGooglePlayBlockedCommerceDiscoveryPath("/api/catalogue")).toBe(false);
    expect(isGooglePlayBlockedCommerceDiscoveryPath("/api/mcpx")).toBe(false);
  });
});

describe("reachable app paths are deny-by-default", () => {
  it("allows the builder surfaces the Android app needs", () => {
    for (const pathname of [
      "/flows",
      "/build",
      "/build/flow-1",
      "/code/flow-1",
      "/runs",
      "/runs/run-1",
      "/connections",
      "/templates",
      "/templates/lead-qualifier",
      "/company",
      "/start",
    ]) {
      expect(isGooglePlayAllowedAppPath(pathname)).toBe(true);
    }
  });

  it("allows the pages the Play listing is required to link to", () => {
    expect(isGooglePlayAllowedAppPath("/privacy")).toBe(true);
    expect(isGooglePlayAllowedAppPath("/account-deletion")).toBe(true);
  });

  it("denies every purchase and purchase-instruction surface", () => {
    for (const pathname of [
      "/",
      "/pricing",
      "/a/lead-qualifier",
      "/docs/payments",
      "/x402-agent-builder",
      "/ai-agent-marketplace-payments",
      "/compare/gumloop-alternative",
      "/agents",
    ]) {
      expect(isGooglePlayAllowedAppPath(pathname)).toBe(false);
    }
  });

  it("denies an API route nobody has explicitly allowed", () => {
    expect(isGooglePlayAllowedApiPath("/api/cron/tick")).toBe(false);
    expect(isGooglePlayAllowedApiPath("/api/gateway/topup/stripe")).toBe(false);
    expect(isGooglePlayAllowedApiPath("/api/some/route/invented/later")).toBe(false);
  });

  it("allows the owner-scoped builder APIs", () => {
    for (const pathname of [
      "/api/me",
      "/api/flows",
      "/api/flows/flow-1/run",
      "/api/v2/projects",
      "/api/v3/runs/run-1",
      "/api/gateway/llm",
    ]) {
      expect(isGooglePlayAllowedApiPath(pathname)).toBe(true);
    }
  });
});

describe("query sanitization", () => {
  it("strips the legacy play_mode flag so it can never activate the mode", () => {
    const params = new URLSearchParams("play_mode=1&foo=bar");
    const result = sanitizeGooglePlaySearchParams(params);
    expect(result.changed).toBe(true);
    expect(params.has("play_mode")).toBe(false);
    expect(params.get("foo")).toBe("bar");
  });

  it("strips purchase intent", () => {
    const params = new URLSearchParams("tier=50&checkout=1");
    const result = sanitizeGooglePlaySearchParams(params);
    expect(result.removedPurchaseIntent).toBe(true);
    expect(params.toString()).toBe("");
  });

  it("drops a return destination that points off-origin or at a purchase page", () => {
    for (const destination of [
      "https://agents.suedeai.ai/flows",
      "https://attacker.test/flows",
      "/pricing",
      "/a/lead-qualifier",
      "\\\\attacker.test",
    ]) {
      expect(sanitizeGooglePlayAppDestination(destination)).toBeNull();
    }
  });

  it("keeps a return destination on the Play origin and an allowed route", () => {
    expect(sanitizeGooglePlayAppDestination("/flows")).toBe(
      "https://android-agents.suedeai.ai/flows",
    );
    expect(
      sanitizeGooglePlayAppDestination("https://android-agents.suedeai.ai/build/flow-1"),
    ).toBe("https://android-agents.suedeai.ai/build/flow-1");
  });
});
