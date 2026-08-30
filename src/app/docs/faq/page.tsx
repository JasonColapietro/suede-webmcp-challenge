/**
 * Docs / FAQ — direct answers to the questions builders and callers actually
 * ask, with FAQPage JSON-LD. Facts mirror billing constants, the run route,
 * and the launch route; keep in sync when those change.
 */
import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import { PLATFORM_TAKE_RATE } from "@/lib/billing";
import { SITE_URL } from "@/lib/site";

const PAGE_TITLE = "FAQ | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Direct answers: what it costs, whether you need a wallet or crypto knowledge, how dry-run works, how payouts reach your wallet, where flows are stored, and what happens when things fail.";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/faq" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/faq",
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
});

interface FaqEntry {
  q: string;
  a: string;
}

const platformTakePct = Math.round(PLATFORM_TAKE_RATE * 100);

const FAQ: FaqEntry[] = [
  {
    q: "Do I need a crypto wallet to use Agent Studio?",
    a: "Not to build, test, publish, or call a service that advertises a dry-run preview. You need a wallet address to receive money after your service is payment-enabled (an EVM payout address), or to call another payment-enabled service with a signed USDC payment on Base.",
  },
  {
    q: "What does it cost to build and launch an agent?",
    a: "Nothing. There is no subscription and no listing fee. Your running costs are metered: the LLM node's first 100k gateway tokens per month are free per workspace, then tokens are billed per million, and specialized Suede endpoint nodes carry a fixed per-call price shown on the node card. Logic nodes (HTTP, Transform, Branch, Loop) are free.",
  },
  {
    q: "What is dry-run mode exactly?",
    a: "A dry run executes the real graph but stubs exactly the nodes that cost money or touch external systems: LLM returns without calling the model, HTTP returns a fixed placeholder without making a request, and paid nodes never settle. Branch, Transform, Loop, and the other logic nodes run for real. Ordinary published agents advertise this as preview mode; a company service whose paid-call gates are not ready advertises unavailable instead. Nothing settles unless the service is separately payment-enabled and all settlement checks pass.",
  },
  {
    q: "What does the platform take when my agent gets paid?",
    a: `The current platform take is ${platformTakePct}%. For a payment-enabled service, the remaining settled amount routes to the configured payout address. There is no listing fee, monthly minimum, or payout threshold; deployment, payout, platform, and service readiness checks still have to pass before payment can be enabled.`,
  },
  {
    q: "Can people call my agent before I turn on real payments?",
    a: "For an ordinary service that advertises preview, yes: it answers free in dry-run mode so integrators can verify the output shape before money moves. Company services do not expose public dry-runs and advertise unavailable until their paid-call gates pass. After deployment, payout, platform, and service checks pass and you enable payment, the same URL starts issuing 402 challenges.",
  },
  {
    q: "Do callers need a Suede account or API key?",
    a: "No. A service that advertises preview accepts its dry-run call without an account or key, while a payment-enabled call authenticates with the payment itself; the caller's wallet signature is the identity. A service that advertises unavailable has no public call path. Suede never issues API keys to callers.",
  },
  {
    q: "Where are my flows stored, and who can see them?",
    a: "Flows are private to their owner; the directory only ever lists agents you have explicitly launched. Launching publishes the agent's name, description, intended price, run endpoint, and current preview, payment-enabled, or unavailable state, not the flow graph itself.",
  },
  {
    q: "What stops a buggy flow from spending all my money?",
    a: "Every run shares one in-run cost ceiling, checked before each cost-bearing node executes: the minimum of a per-run cap ($5 by default) and the agent's remaining daily budget. A loop that would exceed the ceiling aborts with an explicit error naming how many iterations completed. Loops are additionally capped at 200 iterations with concurrency at most 4.",
  },
  {
    q: "Can I run my agent on my own server and still sell it through Suede?",
    a: "Yes: that is the relay setting in the @suedeai/agents SDK. An ordinary relay service remains callable only when it advertises preview; a company or otherwise unavailable relay service has no public dry-run path. When one is payment-enabled, the platform verifies its x402 payment, forwards the call to your server with an HMAC signature, and routes settled USDC to your payout address. Your code runs on your machine.",
  },
  {
    q: "What happens if a paid call fails mid-run?",
    a: "Payment settles before execution starts, so a run that fails after settlement is a settled call with status \"error\" in the response. x402 has no chargeback mechanism, and the platform does not claw back settled payments. Internal dry-run testing before going live matters; prospective callers can also test free only when the service advertises preview.",
  },
  {
    q: "Is this only for music and IP workflows?",
    a: "No. The template catalog and node palette are mostly general business workflows: lead scoring, invoice chasing, contract review, support triage, dev-ops. Music and IP (song generation, IP registration, royalty splits) is one built-in vertical among the priced endpoint nodes, not the frame for the product.",
  },
  {
    q: "What is x402 in one sentence?",
    a: "An open protocol that uses HTTP status 402 to charge for a single API call: the server quotes machine-readable payment terms, the caller retries with a signed x402 v2 payload in a PAYMENT-SIGNATURE header, and settlement happens on Base before the response.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": `${SITE_URL}/docs/faq#faq`,
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export default function DocsFaqPage(): React.JSX.Element {
  return (
    <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · FAQ</span>
          <h1>Frequently asked questions</h1>
          <p>
            Short answers, no hedging. If a question isn&apos;t here, the{" "}
            <Link href="/contact" style={{ color: "var(--primary)" }}>
              contact page
            </Link>{" "}
            reaches a person.
          </p>
        </header>

        <section className="lp-doc lp-block" style={{ marginTop: 0 }}>
          <span className="lp-eyebrow">All questions</span>
          <h2>Questions</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem", marginTop: "1rem" }}>
            {FAQ.map((item) => (
              <div key={item.q}>
                <h3 style={{ marginBottom: "0.4rem" }}>{item.q}</h3>
                <p style={{ margin: 0 }}>{item.a}</p>
              </div>
            ))}
          </div>
        </section>
    </>
  );
}
