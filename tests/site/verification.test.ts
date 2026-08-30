import { describe, expect, it } from "vitest";
import { siteAgentListingBlocked } from "@/lib/catalog";
import {
  checkSiteVerificationFile,
  normalizeVerificationHost,
  SITE_VERIFICATION_PATH,
  siteVerificationToken,
  type VerificationFetch,
} from "@/lib/site/verification";

const OWNER = "11111111-2222-3333-4444-555555555555";

describe("normalizeVerificationHost", () => {
  it.each([
    ["acme.example", "acme.example"],
    ["  ACME.Example  ", "acme.example"],
    ["https://acme.example/pricing?x=1", "acme.example"],
    ["http://acme.example#top", "acme.example"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeVerificationHost(raw)).toBe(expected);
  });
});

describe("siteVerificationToken", () => {
  it("is deterministic and shaped for a text file", () => {
    const token = siteVerificationToken(OWNER, "acme.example");

    expect(token).toBe(siteVerificationToken(OWNER, "ACME.example"));
    expect(token).toMatch(/^suede-verify-[0-9a-f]{40}$/);
  });

  it("differs per owner and per host, and never leaks the workspace key", () => {
    const token = siteVerificationToken(OWNER, "acme.example");

    expect(token).not.toBe(siteVerificationToken("other-owner", "acme.example"));
    expect(token).not.toBe(siteVerificationToken(OWNER, "other.example"));
    expect(token).not.toContain(OWNER);
  });
});

describe("checkSiteVerificationFile", () => {
  const token = siteVerificationToken(OWNER, "acme.example");

  function fetchReturning(body: string, status = 200): VerificationFetch {
    return async (url) => {
      expect(url).toBe(`https://acme.example${SITE_VERIFICATION_PATH}`);
      return new Response(body, { status, headers: { "content-type": "text/plain" } });
    };
  }

  it("passes when the file contains the token (trailing newline tolerated)", async () => {
    await expect(
      checkSiteVerificationFile("acme.example", token, fetchReturning(`${token}\n`)),
    ).resolves.toEqual({ ok: true });
  });

  it("fails when the file exists but holds a different token", async () => {
    const result = await checkSiteVerificationFile(
      "acme.example",
      token,
      fetchReturning("suede-verify-0000000000000000000000000000000000000000"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("doesn't contain your verification token");
  });

  it("fails with the status when the file is missing", async () => {
    const result = await checkSiteVerificationFile("acme.example", token, fetchReturning("nope", 404));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("404");
  });

  it("fails closed when the host is unreachable", async () => {
    const result = await checkSiteVerificationFile("acme.example", token, async () => {
      throw new Error("connect ECONNREFUSED");
    });

    expect(result.ok).toBe(false);
  });

  it("rejects non-domains before any fetch", async () => {
    let fetched = false;
    const result = await checkSiteVerificationFile("localhost", token, async () => {
      fetched = true;
      return new Response(token);
    });

    expect(result.ok).toBe(false);
    expect(fetched).toBe(false);
  });
});

describe("siteAgentListingBlocked", () => {
  const verified = {
    getSiteVerification: async () => ({ ownerId: OWNER, host: "acme.example", method: "file", verifiedAt: "" }),
  };
  const unverified = { getSiteVerification: async () => null };

  it("never blocks ordinary agents", async () => {
    await expect(siteAgentListingBlocked(undefined, OWNER, unverified)).resolves.toBe(false);
    await expect(
      siteAgentListingBlocked({ template: "lead-qualifier" }, OWNER, unverified),
    ).resolves.toBe(false);
  });

  it("blocks a site agent until the domain is verified", async () => {
    const meta = { template: "site-agent:concierge", siteHost: "acme.example" };

    await expect(siteAgentListingBlocked(meta, OWNER, unverified)).resolves.toBe(true);
    await expect(siteAgentListingBlocked(meta, OWNER, verified)).resolves.toBe(false);
  });

  it("fails closed when the host marker is missing or the repo can't answer", async () => {
    await expect(
      siteAgentListingBlocked({ template: "site-agent:concierge" }, OWNER, verified),
    ).resolves.toBe(true);
    await expect(
      siteAgentListingBlocked(
        { template: "site-agent:concierge", siteHost: "acme.example" },
        OWNER,
        {}, // repo without the verification table/methods
      ),
    ).resolves.toBe(true);
    await expect(
      siteAgentListingBlocked(
        { template: "site-agent:concierge", siteHost: "acme.example" },
        OWNER,
        { getSiteVerification: async () => { throw new Error("relation does not exist"); } },
      ),
    ).resolves.toBe(true);
  });
});
