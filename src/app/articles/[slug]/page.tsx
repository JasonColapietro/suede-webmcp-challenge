/**
 * Article page — renders a typed-block article from src/lib/articles.ts
 * with per-page metadata and Article JSON-LD. Statically generated for
 * every entry in ARTICLES. The shell owns typography only; article content
 * itself lives in the data module and is not rewritten here.
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { ARTICLES, getArticle, readingTimeLabel, type ArticleBlock } from "@/lib/articles";
import { SITE_URL } from "@/lib/site";
import "../../chrome.css";
import "../../site.css";
import "../articles.css";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return ARTICLES.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) return {};
  const title = `${article.title} | Suede Agent Studio`;
  // Visible blurb and search snippet are different jobs; see Article.metaDescription.
  const snippet = article.metaDescription ?? article.description;
  return withDefaultSocialImages({
    title: { absolute: title },
    description: snippet,
    alternates: { canonical: `/articles/${article.slug}` },
    openGraph: {
      type: "article",
      locale: "en_US",
      url: `/articles/${article.slug}`,
      siteName: "Suede Agent Studio",
      title,
      description: snippet,
      publishedTime: article.datePublished,
      modifiedTime: article.dateModified,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: snippet,
      site: "@AISUEDE",
      creator: "@johnnysuede",
    },
  });
}

function Block({ block }: { block: ArticleBlock }): React.JSX.Element {
  switch (block.kind) {
    case "h2":
      return <h2>{block.text}</h2>;
    case "h3":
      return <h3>{block.text}</h3>;
    case "code":
      return <pre className="lp-code">{block.code}</pre>;
    case "ul":
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "p":
      return <p>{block.text}</p>;
  }
}

export default async function ArticlePage({ params }: RouteParams): Promise<React.JSX.Element> {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${SITE_URL}/articles/${article.slug}#article`,
    headline: article.title,
    description: article.description,
    datePublished: `${article.datePublished}T00:00:00Z`,
    dateModified: `${article.dateModified}T00:00:00Z`,
    url: `${SITE_URL}/articles/${article.slug}`,
    author: {
      "@type": "Person",
      "@id": "https://suedeai.ai/founder#person",
      name: "Jason Colapietro",
      url: `${SITE_URL}/founder`,
    },
    publisher: {
      "@type": "Organization",
      "@id": "https://suedeai.ai/#organization",
      name: "Suede Labs AI",
      url: "https://suedeai.ai",
    },
    mainEntityOfPage: `${SITE_URL}/articles/${article.slug}`,
  };

  return (
    <div className="lp">
      <SiteNav active="/articles" />
      <main id="main-content" className="lp-shell lp-page" style={{ maxWidth: 760 }}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <header className="lp-page-head">
          <span className="lp-eyebrow">
            {article.eyebrow} · {readingTimeLabel(article)} ·{" "}
            <time dateTime={article.datePublished}>{article.datePublished}</time>
          </span>
          <h1>{article.title}</h1>
          <p>{article.description}</p>
        </header>

        <article className="lp-block ar-body" style={{ marginTop: 0 }}>
          {article.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </article>

        <section className="lp-block ar-panel">
          <span className="lp-eyebrow">Keep reading</span>
          <ul className="ar-related">
            {article.related.map((link) => (
              <li key={link.href}>
                <Link href={link.href}>{link.label}</Link>
              </li>
            ))}
            <li>
              <Link href="/articles">All articles</Link>
            </li>
          </ul>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
