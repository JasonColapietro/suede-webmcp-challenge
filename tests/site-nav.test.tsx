import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/site/SiteNav.tsx", "utf8");

describe("SiteNav Resources context", () => {
  it("names the Resource Foundry in the wordmark context without adding a seventh public link", () => {
    expect(source).toContain('"/resources": "Resources"');
    const linksStart = source.indexOf("= [", source.indexOf("const LINKS"));
    const publicLinks = source.slice(linksStart, source.indexOf("];", linksStart));
    // Build is a disclosure after #342, so the top-level nav is five direct
    // links plus one Build menu rather than six entries in LINKS.
    expect(publicLinks.match(/\{ href:/g)).toHaveLength(5);
    expect(source.match(/<BuildMenu active=\{active\} \/>/g)).toHaveLength(1);
    expect(publicLinks).not.toContain('href: "/resources"');
  });
});
