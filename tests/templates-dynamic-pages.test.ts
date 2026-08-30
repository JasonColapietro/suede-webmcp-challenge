/**
 * Derived /templates/[slug] detail pages: every marketing-allowed template
 * gets an indexable page from the seed graph, the six hand-authored static
 * directories keep precedence (never doubled by the dynamic route), held
 * slugs 404, and the sitemap carries the derived URL list.
 */
import React from "react";
import { describe, expect, it } from "vitest";

// vitest transforms TSX with the classic JSX runtime, so invoking a server
// component needs React in scope the way Next's automatic runtime provides it.
(globalThis as { React?: typeof React }).React = React;
import { SEED_TEMPLATES } from "@/lib/templates";
import { FEATURED_TEMPLATE_PAGES } from "@/lib/featured-templates";
import { isPublicTemplateMarketingAllowed } from "@/lib/marketing-holds";
import { getTemplateDetail, listTemplateDetailPageSlugs } from "@/lib/template-summaries";
import { buildTemplateMetadataDescription } from "@/lib/metadata-copy";
import { SITE_URL } from "@/lib/site";
import sitemap from "@/app/sitemap";
import TemplateDetailPage, {
  generateMetadata,
  generateStaticParams,
} from "@/app/templates/[slug]/page";

const HELD_SLUG = "song-register-royalty";

function routeParams(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

describe("derived template detail pages", () => {
  it("generates a static page for every marketing-allowed template without a static dir", () => {
    const params = generateStaticParams();
    const slugs = params.map((p) => p.slug);
    const staticSegments = new Set(FEATURED_TEMPLATE_PAGES.map((p) => p.route));
    const expected = SEED_TEMPLATES.filter(
      (t) => isPublicTemplateMarketingAllowed(t.slug) && !staticSegments.has(t.slug),
    ).map((t) => t.slug);

    expect(slugs).toEqual(expected);
    // The dynamic route must never shadow or double a hand-authored page.
    for (const slug of slugs) {
      expect(staticSegments.has(slug), `${slug} collides with a static dir`).toBe(false);
    }
    // The catalog is bigger than the six featured pages by design.
    expect(slugs.length).toBeGreaterThan(70);
  });

  it("renders an allowed slug with derived facts and canonical metadata", async () => {
    const slug = listTemplateDetailPageSlugs()[0];
    expect(slug).toBeDefined();
    if (!slug) return;

    const element = await TemplateDetailPage(routeParams(slug));
    expect(element).toBeTruthy();

    const detail = getTemplateDetail(slug);
    expect(detail).not.toBeNull();

    const metadata = await generateMetadata(routeParams(slug));
    expect(metadata.alternates?.canonical).toBe(`/templates/${slug}`);
    expect(metadata.title).toEqual({
      absolute: `${detail?.name} Agent Template | Suede Agent Studio`,
    });
    expect(metadata.description).toBe(buildTemplateMetadataDescription(detail!));
  });

  // Hold lifted 2026-08-04: the Registry is live, so this slug has a real
  // detail page again instead of 404ing.
  it("renders the formerly held slug with real metadata", async () => {
    expect(isPublicTemplateMarketingAllowed(HELD_SLUG)).toBe(true);
    expect(listTemplateDetailPageSlugs()).toContain(HELD_SLUG);
    expect(getTemplateDetail(HELD_SLUG)).not.toBeNull();
    await expect(TemplateDetailPage(routeParams(HELD_SLUG))).resolves.toBeTruthy();
    expect(await generateMetadata(routeParams(HELD_SLUG))).not.toEqual({});
  });

  it("404s a slug that does not exist at all", async () => {
    await expect(
      TemplateDetailPage(routeParams("not-a-template")),
    ).rejects.toThrow();
  });

  it("lists every derived detail URL in the sitemap at priority 0.6", async () => {
    const entries = await sitemap();
    const urls = new Set(entries.map((e) => e.url));
    const slugs = listTemplateDetailPageSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      expect(urls.has(`${SITE_URL}/templates/${slug}`), `sitemap missing ${slug}`).toBe(true);
    }
    for (const entry of entries) {
      if (slugs.some((slug) => entry.url === `${SITE_URL}/templates/${slug}`)) {
        expect(entry.priority).toBe(0.6);
        expect(entry.lastModified).toBe("2026-08-03");
      }
    }
    expect(urls.has(`${SITE_URL}/templates/${HELD_SLUG}`)).toBe(true);
  });
});
