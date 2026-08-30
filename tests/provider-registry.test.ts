import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_PROVIDERS,
  getProtocolProvider,
  type ProtocolProvider,
} from "@/lib/distribution/providers";
import { DISCOVERY_VENUES } from "@/lib/distribution/venues";
import { buildProviderPartnerOutreach } from "@/lib/distribution/provider-outreach";
import { buildServiceDescriptor } from "@/lib/distribution/payloads";
import { SITE_URL } from "@/lib/site";

const providersRoute = await import("@/app/api/providers/route");

const EM_DASH = "—";

function providerStrings(provider: ProtocolProvider): string[] {
  return [
    provider.protocol,
    provider.steward,
    provider.stewardUrl,
    provider.implemented,
    ...provider.modules,
    ...provider.endpoints,
    provider.receipt.date,
    provider.receipt.ref,
    provider.receipt.verifyUrl,
    provider.partnerAsk,
    provider.partnerChannel.url,
    provider.partnerChannel.note,
  ];
}

describe("protocol provider registry", () => {
  it("contains the six implemented protocol integrations, uniquely keyed", () => {
    expect(PROTOCOL_PROVIDERS.map(({ id }) => id)).toEqual([
      "x402",
      "ap2",
      "a2a",
      "mcp",
      "webmcp",
      "agentcash",
    ]);
    expect(new Set(PROTOCOL_PROVIDERS.map(({ id }) => id)).size).toBe(
      PROTOCOL_PROVIDERS.length,
    );
  });

  it("keeps every entry honest and renderable: dated receipts, verifiable paths, https channels", () => {
    for (const provider of PROTOCOL_PROVIDERS) {
      expect(provider.receipt.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(provider.stewardUrl).toMatch(/^https:\/\//u);
      expect(provider.partnerChannel.url).toMatch(/^https:\/\//u);
      expect(
        provider.receipt.verifyUrl.startsWith("/") ||
          provider.receipt.verifyUrl.startsWith("https://"),
      ).toBe(true);
      for (const endpoint of provider.endpoints) {
        expect(endpoint.startsWith("/")).toBe(true);
      }
      expect(provider.modules.length).toBeGreaterThan(0);
    }
  });

  it("carries no em dashes anywhere in public registry copy", () => {
    for (const provider of PROTOCOL_PROVIDERS) {
      for (const value of providerStrings(provider)) {
        expect(value).not.toContain(EM_DASH);
      }
    }
    // The /integrations page and /api/providers also render every venue's
    // name and status, so the venue registry is public copy too.
    for (const venue of DISCOVERY_VENUES) {
      expect(venue.name).not.toContain(EM_DASH);
      expect(venue.status).not.toContain(EM_DASH);
    }
  });

  it("names only modules and endpoints that actually exist in this tree", () => {
    for (const provider of PROTOCOL_PROVIDERS) {
      for (const module of provider.modules) {
        expect(existsSync(module), `${provider.id} module ${module}`).toBe(true);
      }
      for (const endpoint of provider.endpoints) {
        const candidates = [
          `src/app${endpoint}/route.ts`,
          `src/app${endpoint}/page.tsx`,
        ];
        expect(
          candidates.some((candidate) => existsSync(candidate)),
          `${provider.id} endpoint ${endpoint} has no route or page`,
        ).toBe(true);
      }
    }
  });

  it("claims a partnership only where one exists, and only AgentCash today", () => {
    const partners = PROTOCOL_PROVIDERS.filter((provider) => provider.partner);
    expect(partners.map(({ id }) => id)).toEqual(["agentcash"]);
    const partner = getProtocolProvider("agentcash")!.partner!;
    expect(partner.label).toBe("Partner");
    expect(partner.detail).toContain("partners");
    expect(partner.detail).not.toContain(EM_DASH);
  });

  it("looks up providers by id and fails closed on unknown ids", () => {
    expect(getProtocolProvider("x402")?.protocol).toBe("x402 v2");
    expect(getProtocolProvider("unknown")).toBeNull();
  });
});

describe("provider partnership outreach", () => {
  const service = buildServiceDescriptor();

  it("builds a plain-text message per provider from live values only", () => {
    for (const provider of PROTOCOL_PROVIDERS) {
      const outreach = buildProviderPartnerOutreach(provider, service, {
        liveAgents: 4,
        paymentEnabled: 2,
      });
      expect(outreach.providerId).toBe(provider.id);
      expect(outreach.channelUrl).toBe(provider.partnerChannel.url);
      expect(outreach.subject).toContain(provider.protocol);
      expect(outreach.body).toContain(provider.implemented);
      expect(outreach.body).toContain(provider.partnerAsk);
      expect(outreach.body).toContain(`${service.site}/api/providers`);
      expect(outreach.body).toContain("4 published agents");
      expect(outreach.body).toContain("2 of which accept x402 payment");
      expect(outreach.body).not.toContain(EM_DASH);
      for (const endpoint of provider.endpoints) {
        expect(outreach.body).toContain(`${service.site}${endpoint}`);
      }
    }
  });

  it("never manufactures counts when the catalog is empty", () => {
    const provider = PROTOCOL_PROVIDERS[0]!;
    const outreach = buildProviderPartnerOutreach(provider, service, {
      liveAgents: 0,
      paymentEnabled: 0,
    });
    expect(outreach.body).not.toContain("0 published agents");
    expect(outreach.body).toContain("listings vary as creators publish");
  });

  it("points endpoint-free integrations at the catalog instead of a fake path", () => {
    const webmcp = getProtocolProvider("webmcp")!;
    const outreach = buildProviderPartnerOutreach(webmcp, service, {
      liveAgents: 1,
      paymentEnabled: 1,
    });
    expect(outreach.body).toContain("browser session");
    expect(outreach.body).toContain(service.catalogUrl);
  });
});

describe("GET /api/providers", () => {
  it("serves the registry with absolute URLs plus the venue list", async () => {
    const response = await providersRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const payload = (await response.json()) as {
      site: string;
      catalog: string;
      providers: Array<{
        id: string;
        endpoints: string[];
        receipt: { verifyUrl: string };
      }>;
      venues: Array<{ id: string }>;
    };
    expect(payload.site).toBe(SITE_URL);
    expect(payload.catalog).toBe(`${SITE_URL}/api/catalog`);
    expect(payload.providers.map(({ id }) => id)).toEqual(
      PROTOCOL_PROVIDERS.map(({ id }) => id),
    );
    for (const provider of payload.providers) {
      for (const endpoint of provider.endpoints) {
        expect(endpoint.startsWith(`${SITE_URL}/`)).toBe(true);
      }
      expect(provider.receipt.verifyUrl).toMatch(/^https:\/\//u);
    }
    expect(payload.venues.map(({ id }) => id)).toEqual(
      DISCOVERY_VENUES.map(({ id }) => id),
    );
  });
});
