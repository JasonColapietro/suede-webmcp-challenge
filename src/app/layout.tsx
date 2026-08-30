import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { OG_IMAGE, SITE_URL } from "@/lib/site";
import PostHogProvider from "@/components/PostHogProvider";
import "./globals.css";

/* Brand display face, self-hosted from repo-local woff2 (zero egress at build
   and runtime — no Google Fonts, no remote fetch). */
const instrumentSerif = localFont({
  src: [
    { path: "./fonts/instrument-serif-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/instrument-serif-latin-400-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-instrument-serif",
  display: "swap",
  // localFont defaults the metric-adjusted fallback face to local(Arial),
  // which put a size-adjusted SANS behind the display serif h1 during the
  // swap window. Times New Roman keeps the metric adjustment (CLS stays 0)
  // with serif letterforms, so the pre-swap frame reads as the same face.
  adjustFontFallback: "Times New Roman",
  fallback: ["Iowan Old Style", "Palatino Linotype", "Georgia", "serif"],
});

/* Geist Sans/Mono, subset to the Latin range this site actually renders.
   The `geist` package ships the full variable faces (69,652 B + 71,368 B) with
   Cyrillic, Greek, Vietnamese, and 172 box-drawing glyphs we never draw — and
   both faces are preloaded above the fold (nav, wordmark, hero stats, buttons),
   so that weight lands on every cold visit. `scripts/subset-geist-fonts.mjs`
   regenerates these from the package's own woff2; re-run it when `geist` is
   upgraded. The subsets keep the wght 100..900 axis, the tnum/lnum features
   `.tabular` relies on, and identical vertical metrics, so next/font's
   metric-adjusted fallback face is unchanged. */
const geistSans = localFont({
  src: "./fonts/geist-sans-latin-variable.woff2",
  variable: "--font-geist-sans",
  display: "swap",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin-variable.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
  // Not preloaded: mono renders only small microcopy above the fold (stat
  // labels, pills, band CTAs), and its 28 KB was competing with the CSS and
  // the two faces that actually gate the hero paint (sans lede = the LCP
  // element, serif h1) inside the pre-LCP bandwidth window on slow
  // connections. It still loads with display:swap over the metric-neutral
  // system-mono stack below, so the late swap is visually subtle.
  preload: false,
  // Matches the upstream `geist/font/mono` config: no metric-adjusted fallback
  // face, just the system monospace stack behind it.
  adjustFontFallback: false,
  fallback: [
    "ui-monospace",
    "SFMono-Regular",
    "Roboto Mono",
    "Menlo",
    "Monaco",
    "Liberation Mono",
    "DejaVu Sans Mono",
    "Courier New",
    "monospace",
  ],
});

const SITE_NAME = "Suede Agent Studio";
const DEFAULT_TITLE = "Suede Agent Studio: build and publish AI agents";
const DEFAULT_DESCRIPTION =
  "Build AI agents and publish explicit preview, payment-enabled, or unavailable state. Settled x402 calls route to your wallet.";
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  keywords: [
    "AI agents",
    "agent orchestration",
    "agents that earn",
    "agent monetization",
    "visual flow builder",
    "pay-per-call API",
    "on-chain AI",
    "Suede Agent Studio",
    "Suede Labs AI",
    "Suede AI",
    "Jason Colapietro",
    "Johnny Suede",
    "autonomous agents",
    "agent commerce",
    "AI agent marketplace",
  ],
  authors: [{ name: "Jason Colapietro", url: "https://suedeai.ai/founder" }],
  creator: "Jason Colapietro",
  publisher: "Suede Labs AI",
  alternates: { canonical: SITE_URL },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: DEFAULT_TITLE,
    description:
      "Conduct a workforce of agents with explicit call state. Ordinary services may preview; eligible services separately enable x402 payments.",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "Suede Agent Studio: wire AI agents and publish their current call state",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    title: DEFAULT_TITLE,
    description:
      "Conduct a workforce of agents with explicit call state. Ordinary services may preview; eligible services separately enable x402 payments.",
    images: [OG_IMAGE],
  },
};

/* Single light value, not a prefers-color-scheme pair: the theme now follows
   the stored toggle rather than the OS, and a media query cannot see
   localStorage. An OS-dark visitor gets the light page on first paint, so
   pairing dark browser chrome with it would mismatch. */
export const viewport: Viewport = {
  themeColor: "#ffffff",
};

/**
 * Site-wide entity graph: the app, the company, the founder, the website.
 * The Person and Organization @ids MIRROR the canonical nodes published on
 * suedeai.ai (suede-home `src/lib/seo-entity.ts`) — `/founder#person` and
 * `/#organization` on the suedeai.ai domain — so search engines merge this
 * site's claims into the same Jason Colapietro / Suede Labs AI entities.
 * Don't mint new @ids here; change suede-home first if the canon moves.
 */
const SUEDE_ORG_ID = "https://suedeai.ai/#organization";
const JASON_PERSON_ID = "https://suedeai.ai/founder#person";

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: SITE_NAME,
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      // Previously priceCurrency + description with no price at all, so a consumer
      // could extract "this costs USD" and nothing more. The Studio itself is free
      // — the page and /pricing both say building and launch cost nothing, while
      // preview-ready ordinary services may also dry-run free. Model credit and
      // per-call rates are usage costs set elsewhere, which is
      // what the description carries rather than a single misleading number.
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        url: `${SITE_URL}/pricing`,
        description:
          "Building and launching are free. Preview-ready ordinary services can dry-run free; company or otherwise unready services may be unavailable. Payment-enabled services quote x402 terms, and settled calls route USDC on Base.",
      },
      author: { "@id": JASON_PERSON_ID },
      publisher: { "@id": SUEDE_ORG_ID },
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      publisher: { "@id": SUEDE_ORG_ID },
    },
    {
      "@type": "Organization",
      "@id": SUEDE_ORG_ID,
      name: "Suede Labs AI",
      alternateName: ["Suede", "Suede AI", "Suede Labs"],
      url: "https://suedeai.ai",
      foundingDate: "2024",
      description:
        "AI agent orchestration and creator software for building, launching, and monetizing useful workflows.",
      founder: { "@id": JASON_PERSON_ID },
      sameAs: [
        "https://suedeai.org/",
        "https://app.suedeai.ai",
        "https://launch.suedeai.ai",
        "https://suede.social/",
        "https://guitarchords.info/",
        "https://guitarhub.org/",
        "https://suedelabsai.com/",
        "https://x.com/AISUEDE",
        "https://github.com/Suede-AI",
        "https://www.youtube.com/@aisuede",
        "https://www.instagram.com/suedeai/",
        "https://www.facebook.com/people/Suede-Labs-AI/61584534847516",
        "https://t.me/SUEDEAI",
        "https://discord.gg/YECSFQX2g",
        "https://linktr.ee/suedelabsai",
        "https://www.crunchbase.com/organization/suede-labs-ai",
        "https://www.linkedin.com/company/suede-labs-ai",
      ],
    },
    {
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
  ],
};

/* Sets data-theme before first paint so there's no light-mode flash for
   visitors who have chosen dark. Light is the product default: dark applies
   only when the SiteNav toggle has stored that choice, so the OS
   prefers-color-scheme is deliberately ignored — an OS-dark visitor still
   lands on the bright system unless they opt in. Kept inline (not a module
   import) so it runs synchronously in <head>, ahead of body paint. */
const THEME_INIT_SCRIPT = `(function(){try{if(localStorage.getItem('suede-theme')==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${instrumentSerif.variable} ${geistSans.variable} ${geistMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <PostHogProvider>{children}</PostHogProvider>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}
