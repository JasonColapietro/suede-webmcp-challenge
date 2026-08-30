import { readFile } from "node:fs/promises";
import type { Metadata } from "next";
import { describe, expect, it } from "vitest";
import { OG_IMAGE } from "@/lib/site";
import { withDefaultSocialImages } from "@/lib/social-metadata";

const AFFECTED_PUBLIC_METADATA_FILES = [
  "src/app/about/page.tsx",
  "src/app/ai-agent-marketplace-payments/page.tsx",
  "src/app/articles/page.tsx",
  "src/app/articles/[slug]/page.tsx",
  "src/app/contact/page.tsx",
  "src/app/docs/api/page.tsx",
  "src/app/docs/architecture/page.tsx",
  "src/app/docs/building-flows/page.tsx",
  "src/app/docs/examples/page.tsx",
  "src/app/docs/faq/page.tsx",
  "src/app/docs/launching/page.tsx",
  "src/app/docs/mcp/page.tsx",
  "src/app/docs/nodes/page.tsx",
  "src/app/docs/overview/page.tsx",
  "src/app/docs/payments/page.tsx",
  "src/app/docs/reliability/page.tsx",
  "src/app/docs/troubleshooting/page.tsx",
  "src/app/fit/page.tsx",
  "src/app/founder/page.tsx",
  "src/app/integrations/page.tsx",
  "src/app/launch/page.tsx",
  "src/app/privacy/page.tsx",
  "src/app/security/page.tsx",
  "src/app/status/page.tsx",
  "src/app/templates/competitor-tracker/page.tsx",
  "src/app/templates/grade-rebuilder/page.tsx",
  "src/app/templates/invoice-chaser/page.tsx",
  "src/app/templates/lead-qualifier/page.tsx",
  "src/app/templates/meeting-prep/page.tsx",
  "src/app/templates/review-responder/page.tsx",
  "src/app/x402-agent-builder/page.tsx",
] as const;

describe("public child social metadata", () => {
  it("fills missing Open Graph and Twitter images without changing robots", () => {
    const input: Metadata = {
      title: "Public page",
      robots: { index: false, follow: true },
      openGraph: { title: "Public page" },
      twitter: { card: "summary_large_image", title: "Public page" },
    };

    const result = withDefaultSocialImages(input);

    expect(result.openGraph?.images).toEqual([
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "Suede Agent Studio",
      },
    ]);
    expect(result.twitter?.images).toEqual([OG_IMAGE]);
    expect(result.robots).toEqual({ index: false, follow: true });
  });

  it("preserves explicit social images", () => {
    const result = withDefaultSocialImages({
      openGraph: { images: ["https://example.com/custom-og.png"] },
      twitter: { images: ["https://example.com/custom-twitter.png"] },
    });

    expect(result.openGraph?.images).toEqual(["https://example.com/custom-og.png"]);
    expect(result.twitter?.images).toEqual(["https://example.com/custom-twitter.png"]);
  });

  it("routes every crawled missing-image metadata object through the shared fallback", async () => {
    for (const relativePath of AFFECTED_PUBLIC_METADATA_FILES) {
      const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
      expect(source, relativePath).toContain("withDefaultSocialImages");
    }
  });
});
