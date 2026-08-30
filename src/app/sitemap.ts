import type { MetadataRoute } from "next";
import { buildCatalog } from "@/lib/catalog";
import { ARTICLES } from "@/lib/articles";
import { listTemplateDetailPageSlugs } from "@/lib/template-summaries";
import { SITE_URL, SITE_LAST_UPDATED } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: SITE_LAST_UPDATED, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/agents`, lastModified: "2026-07-20", changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE_URL}/launch`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/docs`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/docs/overview`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/building-flows`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/launching`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/payments`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/api`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/nodes`, lastModified: "2026-08-03", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/architecture`, lastModified: "2026-08-03", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/mcp`, lastModified: "2026-08-03", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/docs/reliability`, lastModified: "2026-08-03", changeFrequency: "monthly", priority: 0.65 },
    { url: `${SITE_URL}/docs/examples`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.65 },
    { url: `${SITE_URL}/docs/faq`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.65 },
    { url: `${SITE_URL}/docs/troubleshooting`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.65 },
    { url: `${SITE_URL}/articles`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.7 },
    ...ARTICLES.map((article) => ({
      url: `${SITE_URL}/articles/${article.slug}`,
      lastModified: article.dateModified,
      changeFrequency: "monthly" as const,
      priority: 0.65,
    })),
    { url: `${SITE_URL}/start`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/from-website`, lastModified: "2026-07-26", changeFrequency: "weekly", priority: 0.85 },
    { url: `${SITE_URL}/founder`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/about`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/contact`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/privacy`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/security`, lastModified: "2026-07-22", changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/status`, lastModified: "2026-08-03", changeFrequency: "daily", priority: 0.6 },
    { url: `${SITE_URL}/account-deletion`, lastModified: "2026-07-19", changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/pricing`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/grade`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_URL}/templates`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.75 },
    { url: `${SITE_URL}/templates/grade-rebuilder`, lastModified: "2026-06-22", changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_URL}/templates/lead-qualifier`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_URL}/templates/competitor-tracker`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_URL}/templates/review-responder`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_URL}/templates/invoice-chaser`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_URL}/templates/meeting-prep`, lastModified: "2026-07-20", changeFrequency: "weekly", priority: 0.7 },
    // Derived detail pages: every marketing-allowed template without a
    // hand-authored static directory above. The list is computed, never typed.
    ...listTemplateDetailPageSlugs().map((slug) => ({
      url: `${SITE_URL}/templates/${slug}`,
      lastModified: "2026-08-03",
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    { url: `${SITE_URL}/compare/gumloop-alternative`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/rankings/best-ai-agent-builders`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/no-code-ai-agent-platform`, lastModified: "2026-07-31", changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/firm`, lastModified: "2026-08-18", changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/ai-agent-marketplace-payments`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/x402-agent-builder`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/fit`, lastModified: "2026-07-20", changeFrequency: "monthly", priority: 0.6 },
  ];
  try {
    const entries = await buildCatalog();
    const agentPages: MetadataRoute.Sitemap = entries.map((e) => ({
      url: e.urls.public.startsWith("http") ? e.urls.public : `${SITE_URL}${e.urls.public}`,
      lastModified: new Date(e.createdAt),
      changeFrequency: "daily",
      priority: 0.7,
    }));
    return [...staticPages, ...agentPages];
  } catch {
    return staticPages;
  }
}
