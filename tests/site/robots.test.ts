import { describe, expect, it } from "vitest";
import { parseRobots } from "@/lib/site/robots";

describe("parseRobots", () => {
  it("treats an empty or ruleless file as unrestricted", () => {
    expect(parseRobots("").unrestricted).toBe(true);
    expect(parseRobots("# nothing here\nSitemap: https://a.example/sitemap.xml").unrestricted).toBe(true);
  });

  it("applies the wildcard group", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /admin\nDisallow: /cart");

    expect(policy.isAllowed("/")).toBe(true);
    expect(policy.isAllowed("/pricing")).toBe(true);
    expect(policy.isAllowed("/admin")).toBe(false);
    expect(policy.isAllowed("/admin/users")).toBe(false);
    expect(policy.isAllowed("/cart/checkout")).toBe(false);
  });

  it("blocks the whole site on Disallow: /", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /");

    expect(policy.isAllowed("/")).toBe(false);
    expect(policy.isAllowed("/anything")).toBe(false);
  });

  it("reads an empty Disallow as no restriction, not as a prefix", () => {
    const policy = parseRobots("User-agent: *\nDisallow:");

    expect(policy.unrestricted).toBe(true);
    expect(policy.isAllowed("/anything")).toBe(true);
  });

  it("lets the longest match win, with Allow beating Disallow at equal length", () => {
    const policy = parseRobots(
      "User-agent: *\nDisallow: /docs\nAllow: /docs/public\nDisallow: /docs/public/draft",
    );

    expect(policy.isAllowed("/docs/internal")).toBe(false);
    expect(policy.isAllowed("/docs/public")).toBe(true);
    expect(policy.isAllowed("/docs/public/draft")).toBe(false);
  });

  it("prefers a group naming this crawler over the wildcard group", () => {
    const policy = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: SuedeAgentStudio\nDisallow: /private",
    );

    expect(policy.isAllowed("/pricing")).toBe(true);
    expect(policy.isAllowed("/private")).toBe(false);
  });

  it("ignores groups for other crawlers", () => {
    const policy = parseRobots("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin");

    expect(policy.isAllowed("/pricing")).toBe(true);
    expect(policy.isAllowed("/admin")).toBe(false);
  });

  it("shares one rule block across consecutive User-agent lines", () => {
    const policy = parseRobots("User-agent: BadBot\nUser-agent: *\nDisallow: /admin");

    expect(policy.isAllowed("/admin")).toBe(false);
    expect(policy.isAllowed("/pricing")).toBe(true);
  });

  it("strips trailing wildcards and anchors, and ignores comments", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /search*  # no search pages\nDisallow: /tmp$");

    expect(policy.isAllowed("/search?q=x")).toBe(false);
    expect(policy.isAllowed("/tmp")).toBe(false);
    expect(policy.isAllowed("/pricing")).toBe(true);
  });

  it("ignores directives that appear before any User-agent line", () => {
    const policy = parseRobots("Disallow: /orphan\nUser-agent: *\nDisallow: /admin");

    expect(policy.isAllowed("/orphan")).toBe(true);
    expect(policy.isAllowed("/admin")).toBe(false);
  });
});
