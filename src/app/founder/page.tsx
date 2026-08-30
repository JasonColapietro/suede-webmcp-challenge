/**
 * Founder page — the entity anchor for "Jason Colapietro" + "Suede Labs AI".
 * Person/ProfilePage JSON-LD here shares @ids with the site-wide graph in
 * layout.tsx so search engines resolve one founder entity across every page.
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { SITE_URL } from "@/lib/site";
import { PRESS_MENTIONS } from "@/lib/press";
import "../chrome.css";
import "../site.css";

const PAGE_TITLE = "Jason Colapietro, Founder of Suede Labs AI";
const PAGE_DESCRIPTION =
  "Jason Colapietro, who creates under the declared alias Johnny Suede, is the founder and CEO of Suede Labs AI and the published author of the ownership trilogy.";

export const metadata: Metadata = {
  title: { absolute: `${PAGE_TITLE} | Suede Agent Studio` },
  description: PAGE_DESCRIPTION,
  keywords: [
    "Jason Colapietro",
    "Johnny Suede",
    "Jason Colapietro author",
    "Jason Colapietro books",
    "Suede Labs AI",
    "Suede AI founder",
    "AI agent",
    "AI agents that earn",
    "agent commerce",
    "creator software",
    "AI expert",
  ],
  alternates: { canonical: "/founder" },
  openGraph: {
    type: "profile",
    locale: "en_US",
    url: "/founder",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

const THESIS: { no: string; title: string; body: string; color: string }[] = [
  {
    no: "01",
    title: "Evidence is infrastructure",
    body: "Software earns trust by showing what ran, what it cost, and what changed. Suede Agent Studio makes that evidence part of every test, release, and paid call.",
    color: "var(--primary)",
  },
  {
    no: "02",
    title: "Agents are the new workforce",
    body: "The next small business is a flow of AI agents researching, deciding, acting, and selling around the clock. Suede Agent Studio is the canvas where that workforce gets wired and launched.",
    color: "var(--text-info)",
  },
  {
    no: "03",
    title: "Earning must be native",
    body: "A launched agent publishes its current call state, not a payment promise. An ordinary standalone service may offer a preview; a company or otherwise unready service may be unavailable. When eligible and separately payment-enabled, x402 v2 handles caller settlement in USDC on Base.",
    color: "var(--text-success)",
  },
];

/**
 * Jason's published books. The three Kindle titles mirror the canonical list
 * in suede-home `src/lib/seo-entity.ts` exactly (update there first); The
 * Signal Chain is sold direct on guitar.solutions, so it carries no ASIN.
 */
const BOOKS: {
  /** Matches the slug in suede-home seo-entity.ts — feeds the shared node @id. */
  slug: string;
  headline: string;
  subtitle: string;
  name: string;
  url: string;
  cta: string;
  asin?: string;
  datePublished?: string;
  /** Imprint for titles Suede publishes itself; never the company name. */
  publisher?: string;
}[] = [
  {
    slug: "human-authenticity-layer",
    headline: "Suede Labs: The Human Authenticity Layer",
    subtitle: "How Ownership, Origin, and AI Redraw the Creative Map",
    name: "Suede Labs: The Human Authenticity Layer: How Ownership, Origin, and AI Redraw the Creative Map",
    asin: "B0GD5FX6N6",
    url: "https://www.amazon.com/dp/B0GD5FX6N6",
    cta: "Amazon (Kindle) →",
  },
  {
    slug: "proof-as-infrastructure",
    headline: "Proof as Infrastructure",
    subtitle: "Designing Durable Systems Without Trust Assumptions",
    name: "Proof as Infrastructure: Designing Durable Systems Without Trust Assumptions",
    asin: "B0GMB2VLXQ",
    url: "https://www.amazon.com/dp/B0GMB2VLXQ",
    datePublished: "2026-02-08",
    cta: "Amazon (Kindle) →",
  },
  {
    slug: "stake-your-claim",
    headline: "Stake Your Claim",
    subtitle:
      "Speeches, Discussions & Hard Truths on Turning the AI Onslaught into a Real Asset, Autonomous Agents, and Building Generational Wealth",
    name: "Stake Your Claim: Speeches, Discussions & Hard Truths on Turning the AI Onslaught into a Real Asset, Autonomous Agents, and Building Generational Wealth",
    asin: "B0GRG8LGQQ",
    url: "https://www.amazon.com/dp/B0GRG8LGQQ",
    datePublished: "2026-03-06",
    cta: "Amazon (Kindle) →",
  },
  {
    slug: "the-screenshot",
    headline: "The Screenshot",
    subtitle: "Why AI Recommends Your Competitors, and How to Fix It",
    name: "The Screenshot: Why AI Recommends Your Competitors, and How to Fix It",
    url: "https://seo.suedeai.ai/book",
    datePublished: "2026-08-19",
    publisher: "Johnny Suede Press",
    cta: "Read it free →",
  },
  {
    slug: "the-signal-chain",
    headline: "The Signal Chain: A Life in Six Strings",
    subtitle: "Guitar Tone, Memoir & Method",
    name: "The Signal Chain: A Life in Six Strings - Guitar Tone, Memoir & Method",
    url: "https://guitar.solutions",
    cta: "guitar.solutions →",
  },
  {
    slug: "guitar-without-a-number",
    headline: "The Guitar Without a Number",
    subtitle:
      "Memoir-driven guitar instruction for the self-taught player. Theory, tone, artist songbooks, and a music IP rights chapter.",
    name: "The Guitar Without a Number",
    url: "https://guitar.solutions/catalog.html",
    cta: "Open the catalog →",
  },
];

const PRODUCTS: { name: string; href: string; body: string }[] = [
  {
    name: "Suede Agent Studio",
    href: "/",
    body: "This site: a visual builder where agents publish preview, payment-enabled, or unavailable state. Eligible services can separately enable x402 v2.",
  },
  {
    name: "Suede Social",
    href: "https://social.suedeai.ai",
    body: "The network where musicians share work, collaborate, and build an audience.",
  },
  {
    name: "Strumly",
    href: "https://strumly.suedeai.ai",
    body: "A 24/7 conversational AI guitar coach with a full practice toolkit: tuner, chords, scales, ear training.",
  },
  {
    name: "Suede Muse",
    href: "https://muse.suedeai.ai",
    body: "The musician's AI companion: a bandmate in your pocket for lyrics, theory, and creative momentum.",
  },
  {
    name: "Suede Studio Music",
    href: "https://studio.suedeai.ai",
    body: "The inspiration and remix workspace: sketches, references, and directions become tracks you own, with stems on every render.",
  },
  {
    name: "Suede Labs AI",
    href: "https://suedeai.ai",
    body: "The company home: AI agent products and focused creator tools, including Suede Studio Guitar and Suede Studio Voice.",
  },
  {
    name: "Creative Rails (suedeai.org)",
    href: "https://suedeai.org",
    body: "Essays, the books, and the founder's profile: the writing behind the Suede thesis.",
  },
];

/** Canonical @ids — same nodes suedeai.ai publishes; see layout.tsx note. */
const JASON_PERSON_ID = "https://suedeai.ai/founder#person";
const SUEDE_ORG_ID = "https://suedeai.ai/#organization";

const profileJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "ProfilePage",
      "@id": `${SITE_URL}/founder#profile`,
      url: `${SITE_URL}/founder`,
      name: PAGE_TITLE,
      description: PAGE_DESCRIPTION,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      mainEntity: {
        "@type": "Person",
        "@id": JASON_PERSON_ID,
        name: "Jason Colapietro",
        givenName: "Jason",
        familyName: "Colapietro",
        alternateName: ["Johnny Suede"],
        url: "https://suedeai.ai/founder",
        jobTitle: "Founder and CEO of Suede Labs AI",
        description:
          "Founder and CEO of Suede Labs AI and published author focused on AI agent orchestration, creator software, and agent commerce.",
        worksFor: { "@id": SUEDE_ORG_ID },
        knowsAbout: [
          "AI agents",
          "agent orchestration",
          "x402 agent payments",
          "agent commerce",
          "creator software",
        ],
        sameAs: [
          "https://suedeai.ai/founder",
          "https://suedeai.org/jason-colapietro/",
          "https://x.com/johnnysuede",
          "https://github.com/JasonColapietro",
          "https://www.linkedin.com/in/jasoncolapietro",
          "https://jasoncolapietro.com/",
          "https://johnnysuede.com/",
          "https://jasoncolapietro.substack.com",
          "https://www.youtube.com/@aisuede",
          "https://www.crunchbase.com/person/jason-colapietro-d83e",
          "https://www.wikidata.org/wiki/Q140235755",
          `${SITE_URL}/founder`,
        ],
      },
    },
    // @id is the canonical node published by suedeai.ai/founder, not a local
    // one: this page cites the same Book, so it must not mint a second entity.
    ...BOOKS.map((book) => ({
      "@type": "Book",
      "@id": `https://suedeai.ai/founder#book-${book.slug}`,
      name: book.name,
      url: book.url,
      sameAs: book.url,
      bookFormat: "https://schema.org/EBook",
      inLanguage: "en",
      ...(book.datePublished ? { datePublished: book.datePublished } : {}),
      author: { "@id": JASON_PERSON_ID },
      ...(book.publisher
        ? { publisher: { "@type": "Organization", name: book.publisher } }
        : {}),
      ...(book.asin
        ? {
            publisher: { "@type": "Organization", name: "Suede Labs" },
            identifier: {
              "@type": "PropertyValue",
              propertyID: "ASIN",
              value: book.asin,
            },
          }
        : {}),
    })),
  ],
};

export default function FounderPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/founder" />

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section id="main-content" className="lp-hero">
        <div className="lp-shell">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: "clamp(2rem, 5vw, 4rem)",
              alignItems: "center",
              position: "relative",
              zIndex: 1,
            }}
          >
            <div>
              {/* One line, always: the kicker is ~200px and fits every
                  viewport, so a mid-phrase wrap is never the better outcome. */}
              <span className="lp-eyebrow" style={{ whiteSpace: "nowrap" }}>
                Founder · Suede Labs AI
              </span>
              <h1
                className="lp-h1"
                style={{ marginTop: "0.6rem", maxWidth: "20ch" }}
              >
                Jason Colapietro builds <em>AI agents that can earn</em>.
              </h1>
              <p className="lp-lede">
                Jason Colapietro is the founder and CEO of <b>Suede Labs AI</b>,
                an AI agent and creator-software company, and a <b>published
                author</b> of the ownership
                trilogy and a guitar tone memoir. He creates under the declared
                alias <b>Johnny Suede</b>. He has built and scaled
                multiple multimillion-dollar businesses and took the $SUEDE
                token to a peak fully diluted valuation of roughly $28 million.
                Suede Agent Studio is the thesis running live: wire an AI agent
                on a canvas and publish its current call state. An ordinary
                standalone service may offer a preview; company or otherwise
                unready services may be unavailable. Eligible services can then
                enable payments through x402 v2 USDC on Base. Stripe handles
                builder funding, and A2A provides the agent interface.
              </p>
              <div className="lp-hero-actions">
                <a
                  href="https://github.com/JasonColapietro"
                  className="lp-btn lp-btn--primary"
                >
                  GitHub · JasonColapietro →
                </a>
                <a href="https://suedeai.ai" className="lp-btn lp-btn--ghost">
                  Suede Labs AI
                </a>
                <a
                  href="https://www.linkedin.com/in/jasoncolapietro"
                  className="lp-btn lp-btn--ghost"
                >
                  LinkedIn
                </a>
                <a
                  href="https://jasoncolapietro.substack.com"
                  className="lp-btn lp-btn--ghost"
                >
                  Substack
                </a>
                <a href="https://x.com/johnnysuede" className="lp-btn lp-btn--ghost">
                  X
                </a>
                <a
                  href="https://www.youtube.com/@aisuede"
                  className="lp-btn lp-btn--ghost"
                >
                  YouTube
                </a>
                <a
                  href="https://www.crunchbase.com/person/jason-colapietro-d83e"
                  className="lp-btn lp-btn--ghost"
                >
                  Crunchbase
                </a>
                <a
                  href="https://www.wikidata.org/wiki/Q140235755"
                  className="lp-btn lp-btn--ghost"
                >
                  Wikidata
                </a>
              </div>
              <div className="lp-hero-meta">
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                  }}
                >
                  Founder &amp; CEO · Published author
                </span>
              </div>
            </div>

            {/* Founder photo */}
            <div
              style={{
                flexShrink: 0,
                alignSelf: "center",
              }}
            >
              <Image
                src="/jason-colapietro.png"
                alt="Jason Colapietro, founder of Suede Labs AI"
                width={260}
                height={260}
                priority
                style={{
                  borderRadius: "50%",
                  objectFit: "cover",
                  border: "2px solid var(--hairline)",
                  boxShadow: "0 0 0 6px color-mix(in srgb, var(--primary) 12%, transparent)",
                  display: "block",
                  width: "clamp(160px, 20vw, 260px)",
                  height: "clamp(160px, 20vw, 260px)",
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="lp-shell lp-page" style={{ paddingTop: 0 }}>
        {/* ── The thesis ─────────────────────────────────────────────────── */}
        <section
          className="lp-section"
          style={{ paddingTop: "clamp(2rem,5vw,4rem)" }}
        >
          <span className="lp-eyebrow">The thesis</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              letterSpacing: "-0.015em",
              margin: "0.35em 0 2rem",
              maxWidth: "24ch",
            }}
          >
            Three bets, one company.
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "1rem",
            }}
          >
            {THESIS.map((item) => (
              <div key={item.no} className="lp-feature">
                <div className="lp-feature-no" style={{ color: item.color }}>
                  {item.no} · {item.title}
                </div>
                <p style={{ marginTop: "0.45rem" }}>{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── The books ──────────────────────────────────────────────────── */}
        <section className="lp-section">
          <span className="lp-eyebrow">Published author</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              letterSpacing: "-0.015em",
              margin: "0.35em 0 0.5rem",
              maxWidth: "24ch",
            }}
          >
            Books by Jason Colapietro.
          </h2>
          <p
            style={{
              color: "var(--text-muted)",
              maxWidth: "60ch",
              margin: "0 0 2rem",
              lineHeight: 1.6,
            }}
          >
            The ownership trilogy: three Kindle titles on the argument this
            studio ships (ownership, proof, and AI agents as real economic
            assets), plus <em>The Screenshot</em>, a free book on AI search
            visibility, and a guitar tone memoir &amp; method sold direct at
            guitar.solutions.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "1rem",
            }}
          >
            {BOOKS.map((book) => (
              <a
                key={book.url}
                href={book.url}
                className="lp-feature"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div
                  className="lp-feature-no"
                  style={{ color: "var(--primary)" }}
                >
                  {book.headline}
                </div>
                <p style={{ marginTop: "0.45rem" }}>{book.subtitle}.</p>
                <span
                  style={{
                    display: "inline-block",
                    marginTop: "0.75rem",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                  }}
                >
                  {book.cta}
                </span>
              </a>
            ))}
          </div>
          <p
            style={{
              color: "var(--text-muted)",
              margin: "1.25rem 0 0",
              lineHeight: 1.6,
            }}
          >
            Start with the free condensed preview:{" "}
            <a href="https://suedeai.org/book/">
              read the Stake Your Claim preview on suedeai.org
            </a>
            .
          </p>
        </section>

        {/* ── The constellation ──────────────────────────────────────────── */}
        <section className="lp-section">
          <span className="lp-eyebrow">Built at Suede Labs AI</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              letterSpacing: "-0.015em",
              margin: "0.35em 0 0.5rem",
              maxWidth: "24ch",
            }}
          >
            One stack, shipped product by product.
          </h2>
          <p
            style={{
              color: "var(--text-muted)",
              maxWidth: "60ch",
              margin: "0 0 2rem",
              lineHeight: 1.6,
            }}
          >
            Every Suede product is a working piece of the same ownership stack
            (registry, network, agent canvas, coach, companion), built and shipped
            by one founder.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "1rem",
            }}
          >
            {PRODUCTS.map((p) =>
              p.href.startsWith("/") ? (
                <Link
                  key={p.name}
                  href={p.href}
                  className="lp-feature"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div
                    className="lp-feature-no"
                    style={{ color: "var(--primary)" }}
                  >
                    {p.name}
                  </div>
                  <p style={{ marginTop: "0.45rem" }}>{p.body}</p>
                </Link>
              ) : (
                <a
                  key={p.name}
                  href={p.href}
                  className="lp-feature"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div
                    className="lp-feature-no"
                    style={{ color: "var(--primary)" }}
                  >
                    {p.name}
                  </div>
                  <p style={{ marginTop: "0.45rem" }}>{p.body}</p>
                </a>
              ),
            )}
          </div>
        </section>

        {/* ── Press ──────────────────────────────────────────────────────── */}
        <section className="lp-section">
          <span className="lp-eyebrow">In the press</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              letterSpacing: "-0.015em",
              margin: "0.35em 0 1.5rem",
              maxWidth: "24ch",
            }}
          >
            Coverage.
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "1rem",
            }}
          >
            {PRESS_MENTIONS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener"
                className="lp-feature"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div className="lp-feature-no" style={{ color: "var(--primary)" }}>
                  {item.outlet} ·{" "}
                  <time dateTime={item.published}>{item.publishedLabel}</time>
                </div>
                <p style={{ marginTop: "0.45rem" }}>{item.headline}</p>
              </a>
            ))}
          </div>
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: "var(--text-sm)",
              marginTop: "1.5rem",
            }}
          >
            Infrastructure and ecosystem references:{" "}
            <a href="https://cloud.google.com" style={{ color: "var(--primary)" }}>
              Google Cloud
            </a>
            ,{" "}
            <a href="https://layerzero.network" style={{ color: "var(--primary)" }}>
              LayerZero
            </a>
            , and{" "}
            <a href="https://chain.link" style={{ color: "var(--primary)" }}>
              Chainlink
            </a>
            . Agent Studio caller settlement uses x402 v2 in USDC on Base.
          </p>
        </section>

        {/* ── CTA ────────────────────────────────────────────────────────── */}
        <section className="lp-cta-band">
          <span className="lp-eyebrow" style={{ color: "var(--primary)" }}>
            See the thesis run
          </span>
          <h2>Launch an agent. Enable payments when ready.</h2>
          <Link href="/start" className="lp-btn lp-btn--primary">
            Start building →
          </Link>
        </section>
      </div>

      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(profileJsonLd) }}
      />
    </div>
  );
}
