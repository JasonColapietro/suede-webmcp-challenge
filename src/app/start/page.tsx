import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import ModeSwitch from "@/components/mode-switch";
import { BUILD_SETTINGS_LEDE } from "@/lib/build-settings";
import GuidedClient from "./guided-client";
import { getTemplate } from "@/lib/templates";
import { describeCron } from "@/lib/cron";
import { resolveOwnerId } from "@/lib/auth";
import {
  EmptyGuidedFlowError,
  getGuidedFlowData,
  type GuidedFlowData,
} from "@/lib/guided/flow";
import "../chrome.css";
import "../site.css";

const PAGE_TITLE = "Build it by describing it. | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Describe what you want an agent to do. The studio asks a few plain questions, drafts the agent, and shows you exactly what it does before it goes live. No code, no canvas.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/start" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/start",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

export const dynamic = "force-dynamic";

// First-screen capabilities strip: the concrete things a visitor can do from
// this page. Same pattern on / and /launch; keep phrases 2-4 words.
const PAGE_CAPABILITIES = [
  "Describe the job",
  "Answer plain questions",
  "Review the draft",
  "Approve to go live",
  "Start from a template",
];

const GUIDED_QUICK_PICKS = [
  "lead-qualifier",
  "competitor-tracker",
  "invoice-chaser",
  "meeting-prep",
  "review-responder",
  "licensing-desk",
].flatMap((slug) => {
  const template = getTemplate(slug);
  return template ? [template] : [];
});

interface StartPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StartPage({ searchParams }: StartPageProps): Promise<React.JSX.Element> {
  const flowParam = (await searchParams).flow;
  let guidedFlow: GuidedFlowData | null = null;
  if (flowParam !== undefined) {
    if (typeof flowParam !== "string" || flowParam.length === 0) notFound();
    const ownerId = await resolveOwnerId();
    try {
      guidedFlow = await getGuidedFlowData(flowParam, ownerId);
    } catch (error) {
      if (error instanceof EmptyGuidedFlowError) redirect("/start");
      throw error;
    }
    if (guidedFlow === null) notFound();
  }

  return (
    <div className="lp">
      <SiteNav active="/start" />
      <main id="main-content" className="lp-shell lp-page">
        {/* Hero */}
        <header className="lp-page-head">
          <span className="lp-eyebrow">Guided</span>
          <h1>Build it by describing it.</h1>
          <p>
            One sentence about the job is enough. The studio asks a few plain
            questions, drafts the agent, and shows you exactly what it does,
            when it runs, and what it charges. Approve it and it goes live.
          </p>
          {/* Capabilities strip: within the first screen, say what this page
              is for and what a visitor can do here. Mirrored on / and
              /launch. */}
          <div className="lp-caps" style={{ marginTop: "0.9rem" }}>
            <span className="lp-eyebrow">What you can do here</span>
            <div className="lp-caps-pills">
              {PAGE_CAPABILITIES.map((cap) => (
                <span key={cap} className="lp-pill">
                  {cap}
                </span>
              ))}
            </div>
          </div>
        </header>

        {/* Setting switch — after the hero, so a first-time visitor reads what
            this page builds before being asked which of three ways to build
            it. Guided, Studio and Code carry their explanation in a title
            tooltip, which no touch user and no keyboard user ever sees. The
            nav's Build menu already renders this lede above the same three
            options; /start is the other place the choice gets made, so it
            says the same sentence rather than three bare labels. */}
        <div style={{ marginBottom: "1.5rem" }}>
          <ModeSwitch active="guided" flowId={guidedFlow?.flowId} />
          <p className="start-setting-lede">{BUILD_SETTINGS_LEDE}</p>
        </div>

        {/* Guided interview chat */}
        <GuidedClient initialFlow={guidedFlow ?? undefined} />

        {/* Quick-picks */}
        <section className="lp-block" style={{ marginTop: "2rem" }}>
          <h2 className="lp-eyebrow guided-quick-heading">Or start with a template</h2>
          <p className="lp-section-sub" style={{ margin: "0 0 0.85rem" }}>
            Each of these is a working agent with its steps wired, schedule
            set, and price loaded. Open one and it launches under your wallet,
            another seat filled on your org chart.
          </p>
          <div className="lp-rows">
            {GUIDED_QUICK_PICKS.map((t) => {
              const schedNode = t.graph.nodes.find((n) => n.type === "schedule");
              const cron =
                typeof schedNode?.params.cron === "string" ? schedNode.params.cron : null;
              const cadence = cron ? describeCron(cron) : null;
              const coreNodes = t.graph.nodes.every((n) => !n.type.startsWith("suede."));
              const monthly = schedNode
                ? null
                : Math.round(t.suggestedPriceUsdc * 50 * 30);
              return (
                <Link
                  key={t.slug}
                  href={`/build/new?template=${t.slug}`}
                  className="lp-row"
                >
                  <div className="grow">
                    <div className="name">{t.name}</div>
                    <div className="sub">{t.pitch}</div>
                  </div>
                  {/* Fact rail: fixed slots (state | how-it-runs | price) so
                      the chips align column-for-column down the list. The
                      est/sched pair is mutually exclusive by construction,
                      so both share the middle slot. */}
                  <span className="lp-factrail">
                    <span
                      className={`lp-tpl-tag lp-tpl-tag--${coreNodes ? "core" : "rails"} lp-fact--state`}
                      title={
                        coreNodes
                          ? "Runs on the built-in nodes; launches as-is."
                          : "Taps Suede's paid media and workflow endpoints."
                      }
                    >
                      {coreNodes ? "Core" : "Suede rails"}
                    </span>
                    {monthly !== null && (
                      <span
                        className="lp-tpl-est tabular lp-fact--how"
                        title="Illustrative: price × 50 calls/day × 30 days."
                      >
                        ~${monthly.toLocaleString()}/mo est.
                      </span>
                    )}
                    {cadence && (
                      <span className="lp-pill lp-pill--sched tabular lp-fact--how">
                        runs {cadence}
                      </span>
                    )}
                    <span className="lp-pill lp-pill--price tabular lp-fact--price">
                      ${t.suggestedPriceUsdc.toFixed(2)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        <div className="guided-template-actions">
          <Link href="/from-website" className="lp-btn lp-btn--ghost lp-btn--sm">
            Turn your website into an agent →
          </Link>
          <Link
            href="/templates"
            className="lp-btn lp-btn--ghost lp-btn--rank3 lp-btn--sm"
          >
            Browse all templates →
          </Link>
          <Link
            href="/build/new"
            className="lp-btn lp-btn--ghost lp-btn--rank3 lp-btn--sm"
          >
            Blank canvas →
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
