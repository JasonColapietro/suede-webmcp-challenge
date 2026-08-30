import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  discoverGooglePlaces,
  ProspectAdapterUnavailableError,
  runOptimizeOperatorAudit,
} from "@/lib/company/prospect-engine/adapters";

const originalPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
const originalAuditUrl = process.env.OPTIMIZE_OPERATOR_AUDIT_URL;
const originalAuditToken = process.env.OPTIMIZE_OPERATOR_AUDIT_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = originalPlacesKey;
  if (originalAuditUrl === undefined) delete process.env.OPTIMIZE_OPERATOR_AUDIT_URL; else process.env.OPTIMIZE_OPERATOR_AUDIT_URL = originalAuditUrl;
  if (originalAuditToken === undefined) delete process.env.OPTIMIZE_OPERATOR_AUDIT_TOKEN; else process.env.OPTIMIZE_OPERATOR_AUDIT_TOKEN = originalAuditToken;
});

describe("Prospect Engine adapters", () => {
  it("keeps Places optional and returns only ephemeral bounded candidates", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    await expect(discoverGooglePlaces("roofers")).rejects.toBeInstanceOf(ProspectAdapterUnavailableError);

    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ places: [{
      id: "places/abc",
      displayName: { text: "Fixture Roofing" },
      websiteUri: "https://fixture.example.com/",
      googleMapsUri: "https://maps.google.com/?cid=1",
      formattedAddress: "must not persist",
      phoneNumber: "must not persist",
    }] }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const results = await discoverGooglePlaces("roofers", fetcher);
    expect(results).toEqual([{
      placeId: "places/abc",
      displayName: "Fixture Roofing",
      websiteUrl: "https://fixture.example.com/",
      mapsUri: "https://maps.google.com/?cid=1",
      sourceAttribution: "Google Maps",
    }]);
    expect(JSON.stringify(results)).not.toContain("phone");
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("places:searchText"), expect.objectContaining({ cache: "no-store" }));
  });

  it("fails closed without the authenticated Optimize endpoint and token", async () => {
    delete process.env.OPTIMIZE_OPERATOR_AUDIT_URL;
    delete process.env.OPTIMIZE_OPERATOR_AUDIT_TOKEN;
    await expect(runOptimizeOperatorAudit("https://fixture.example.com/")).rejects.toBeInstanceOf(ProspectAdapterUnavailableError);
  });

  it("posts the Scan contract and accepts its strict prepared-repair envelope", async () => {
    process.env.OPTIMIZE_OPERATOR_AUDIT_URL = "https://scan.suedeai.ai/api/operator-audit";
    process.env.OPTIMIZE_OPERATOR_AUDIT_TOKEN = "fixture-token";
    const responseBody = { handoff: {
      kind: "suede.audit.prospect",
      version: 1,
      source: "suede-audit",
      domain: "fixture.example.com",
      auditedUrl: "https://fixture.example.com/",
      observedAt: "2026-08-04T11:55:00.000Z",
      totalFindings: 1,
      omittedCount: 0,
      findings: [{
        id: "broken-link-about",
        kind: "site-integrity",
        lane: "Links",
        title: "Broken About link",
        priority: "high",
        observed: "The About link returns HTTP 404.",
        action: "Replace the broken destination.",
        evidence: {
          subtype: "redirect-link",
          sourceUrl: "https://fixture.example.com/services",
          targetUrl: "https://fixture.example.com/about-old",
          finalUrl: "https://fixture.example.com/about",
          status: 200,
          anchorText: "About",
          redirectChain: [{
            status: 301,
            from: "https://fixture.example.com/about-old",
            to: "https://fixture.example.com/about",
          }],
        },
        preparedRepair: {
          kind: "replace-link-target",
          ready: true,
          before: "https://fixture.example.com/about-old",
          after: "https://fixture.example.com/about",
          instruction: "Replace the old About link target with the verified public page.",
          verification: ["Open the About link.", "Confirm the destination returns HTTP 200."],
        },
      }],
    } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const timeout = vi.spyOn(AbortSignal, "timeout");

    const audit = await runOptimizeOperatorAudit("https://fixture.example.com/", fetcher);

    expect(audit.findings[0]?.preparedRepair?.after).toBe("https://fixture.example.com/about");
    expect(audit.findings[0]?.kind).toBe("site-integrity");
    expect(audit.findings[0]?.evidence?.subtype).toBe("redirect-link");
    expect(audit.findings[0]?.evidence?.redirectChain).toHaveLength(1);
    expect(timeout).toHaveBeenCalledWith(55_000);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://scan.suedeai.ai/api/operator-audit"),
      expect.objectContaining({
        body: JSON.stringify({ url: "https://fixture.example.com/" }),
        cache: "no-store",
        redirect: "error",
      }),
    );
  });
});
