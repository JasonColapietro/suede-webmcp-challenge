import { describe, expect, it } from "vitest";
import {
  buildPublicAgentMetadataCopy,
  buildTemplateMetadataDescription,
} from "@/lib/metadata-copy";
import { getTemplateDetail, listTemplateDetailPageSlugs } from "@/lib/template-summaries";

describe("public metadata copy", () => {
  it("expands every derived template description into a useful search snippet", () => {
    for (const slug of listTemplateDetailPageSlugs()) {
      const detail = getTemplateDetail(slug);
      expect(detail).not.toBeNull();
      if (!detail) continue;
      const description = buildTemplateMetadataDescription(detail);
      expect(description.length, `${slug} description is too short`).toBeGreaterThanOrEqual(50);
      expect(description.length, `${slug} description is too long`).toBeLessThanOrEqual(165);
      expect(description.isWellFormed(), `${slug} description splits Unicode`).toBe(true);
    }
  });

  it.each(["price-watcher", "faq-concierge"])(
    "expands the thin %s template pitch with its buyer context",
    (slug) => {
      const detail = getTemplateDetail(slug);
      expect(detail).not.toBeNull();
      if (!detail) return;
      const description = buildTemplateMetadataDescription(detail);
      expect(description).toContain(detail.pitchProse);
      expect(description).toContain(detail.whoPays);
    },
  );

  it("keeps same-name public agents distinct across document and social metadata", () => {
    const first = buildPublicAgentMetadataCopy({
      name: "Site Audit",
      slug: "site-audit-1fow4",
      description: "Site Audit: a published service that is currently unavailable for public calls.",
    });
    const second = buildPublicAgentMetadataCopy({
      name: "Site Audit",
      slug: "site-audit-0wyt2",
      description: "Site Audit: a published service that is currently unavailable for public calls.",
    });

    expect(first.title).not.toBe(second.title);
    expect(first.description).not.toBe(second.description);
    expect(first.title).toContain("site-audit-1fow4");
    expect(second.title).toContain("site-audit-0wyt2");
    expect(first.description).toContain("/a/site-audit-1fow4");
    expect(second.description).toContain("/a/site-audit-0wyt2");
    for (const metadata of [first, second]) {
      expect(metadata.title.length).toBeLessThanOrEqual(70);
      expect(metadata.description.length).toBeGreaterThanOrEqual(50);
      expect(metadata.description.length).toBeLessThanOrEqual(165);
      expect(metadata.title.isWellFormed()).toBe(true);
      expect(metadata.description.isWellFormed()).toBe(true);
    }
  });

  it("keeps Unicode well-formed when long public copy is truncated", () => {
    const metadata = buildPublicAgentMetadataCopy({
      name: `${"a".repeat(45)}😀x`,
      slug: "unicode-agent-abc12",
      description: `${"b".repeat(150)}😀x`,
    });
    expect(metadata.title.isWellFormed()).toBe(true);
    expect(metadata.description.isWellFormed()).toBe(true);
  });

  it("bounds descriptions for the maximum supported public resource slug", () => {
    const slug = `${"a".repeat(141)}uniqueidentity12345`;
    const metadata = buildPublicAgentMetadataCopy({
      name: "Maximum Slug Agent",
      slug,
      description: "A useful public service with enough factual context for a search result.",
    });

    expect(slug).toHaveLength(160);
    expect(metadata.description.length).toBeLessThanOrEqual(165);
    expect(metadata.description).toContain("Public listing: /a/…");
    expect(metadata.description).toContain("uniqueidentity12345");
    expect(metadata.description.isWellFormed()).toBe(true);
  });
});
