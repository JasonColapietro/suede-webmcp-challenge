import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "src/app/account-deletion/page.tsx"), "utf8");
const flowsPage = readFileSync(join(process.cwd(), "src/app/flows/dashboard.tsx"), "utf8");
const privacyPage = readFileSync(join(process.cwd(), "src/app/privacy/page.tsx"), "utf8");
const sitemap = readFileSync(join(process.cwd(), "src/app/sitemap.ts"), "utf8");

describe("account and data deletion discovery", () => {
  it("publishes the site social card in Open Graph and Twitter metadata", () => {
    expect(page).toMatch(
      /openGraph:[\s\S]*?images:\s*\[[\s\S]*?url:\s*OG_IMAGE/,
    );
    expect(page).toMatch(
      /twitter:[\s\S]*?images:\s*\[OG_IMAGE\]/,
    );
  });

  it("publishes separate shared-account and Agent Studio workspace paths", () => {
    expect(page).toContain("Request workspace deletion");
    expect(page).toContain("https://app.suedeai.ai/profile");
    expect(page).toContain("separate operational database");
    expect(page).toContain("Public blockchain transactions");
  });

  it("links the request path from signed-in workspace settings and privacy", () => {
    expect(flowsPage).toContain('href="/account-deletion"');
    expect(flowsPage).toContain("Account settings");
    expect(privacyPage).toContain('<Link href="/account-deletion">');
    expect(sitemap).toContain("`${SITE_URL}/account-deletion`");
  });
});
