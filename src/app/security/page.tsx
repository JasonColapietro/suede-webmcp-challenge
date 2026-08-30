/**
 * Security & Trust — the canonical public home for Suede Agent Studio's actual
 * security practices. Every claim below is grounded in shipped code, with the
 * source of truth noted inline so it can be re-verified if the codebase moves:
 *   - HTTPS + HttpOnly/Secure/SameSite owner cookie      src/middleware.ts
 *   - workspace isolation, fail-closed owner resolution  src/lib/auth.ts
 *   - RLS + server-only request secret + no DELETE       docs/migrations/PENDING.md
 *   - AES-256-GCM Connection secrets w/ AAD binding       src/lib/connections/crypto.ts
 *   - webhook HMAC-SHA256, constant-time, replay window   src/lib/webhook-auth.ts
 *   - outbound relay HMAC-SHA256                          src/lib/relay.ts
 *   - x402 local recipient/amount/network guards, dry-run src/lib/rails/x402-verify.ts
 *   - rate limit / per-IP budget / per-run spend ceiling  src/lib/rate-limit.ts, engine.ts
 *   - settled calls route straight to the creator wallet src/lib/billing.ts
 * The certification statement matches the existing guardrail in src/app/fit/page.tsx.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./security.css";

const PAGE_TITLE = "Security & Trust";
const PAGE_DESCRIPTION =
  "The security practices behind Suede Agent Studio: how data moves and is stored, how payments and webhooks are verified, and exactly where we stand on formal certifications.";
const PAGE_URL = `${SITE_URL}/security`;
const LAST_UPDATED = "2026-08-03";
const SECURITY_EMAIL = "security@suedeai.ai";

export const metadata: Metadata = {
  title: { absolute: `${PAGE_TITLE} | Suede Agent Studio` },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/security" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/security",
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

const securityPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "@id": `${PAGE_URL}#webpage`,
  url: PAGE_URL,
  name: `${PAGE_TITLE} | Suede Agent Studio`,
  description: PAGE_DESCRIPTION,
  dateModified: `${LAST_UPDATED}T00:00:00Z`,
  isPartOf: { "@id": `${SITE_URL}/#website` },
};

interface SecuritySection {
  title: string;
  body: React.JSX.Element;
}

const SECTIONS: SecuritySection[] = [
  {
    title: "How your data moves",
    body: (
      <p>
        Traffic to agents.suedeai.ai is served over HTTPS. The first-party
        cookie that identifies your workspace is set HttpOnly and Secure in
        production, so it is never exposed to page scripts and never sent
        over plain HTTP. Agent runs that call third-party model providers do
        so over the provider&apos;s own encrypted APIs.
      </p>
    ),
  },
  {
    title: "How your data is stored and separated",
    body: (
      <>
        <p>
          Every request is scoped to a workspace owner before it touches
          storage. Ecosystem-authenticated identities are only ever derived
          from a verified session; they are explicitly rejected when presented
          as a raw header or cookie value, so no one can claim another
          signed-in user&apos;s workspace by guessing an id. If a request ever
          arrives without a resolvable owner in production, the request fails
          closed rather than pooling into a shared account.
        </p>
        <p>
          Workspace data lives in Supabase (managed Postgres) behind row-level
          security. The application reaches it through a server-only request
          secret; direct browser traffic cannot read or write those tables,
          and the runtime role has no DELETE privilege on them.
        </p>
      </>
    ),
  },
  {
    title: "Secrets and credentials",
    body: (
      <p>
        Platform secrets (model keys, the payment signer, the connection
        encryption key) live in the deployment environment and are never
        committed to source. When you store a third-party credential as a
        Connection, it is encrypted with AES-256-GCM before it is written,
        cryptographically bound to your workspace and that specific
        connection so a ciphertext cannot be replayed under a different
        identity, and the plaintext is wiped from memory immediately after
        use. When you launch a webhook-triggered agent, its signing secret
        is generated from a cryptographically secure random source, stored
        only as a hash, and shown to you exactly once.
      </p>
    ),
  },
  {
    title: "How payments are verified",
    body: (
      <p>
        Paid calls use the x402 standard: a caller&apos;s wallet signs a
        USDC payment on Base, and the endpoint verifies it before doing any
        work. Before a payment is ever forwarded for settlement, Suede
        independently checks that the signed authorization pays the correct
        wallet, for at least the required amount, on the supported network.
        A definitively invalid payment is rejected locally, not passed
        through. Settlement defaults to dry-run: a newly launched agent does
        not move real money until its creator explicitly switches it live.
        Payouts route straight to the creator&apos;s own wallet; Suede never
        custodies creator funds. Settlement happens on a public blockchain,
        so payment amounts and wallet addresses are visible on-chain by the
        design of the network.
      </p>
    ),
  },
  {
    title: "Abuse and spend controls",
    body: (
      <p>
        Inbound webhook calls must carry a valid HMAC-SHA256 signature and a
        recent timestamp; signatures are compared in constant time and
        stale or replayed requests are rejected. Rate limiting and per-IP
        token budgets throttle abusive traffic, the free tier is gated so a
        freshly minted key cannot farm funded model capacity, and every run
        enforces a hard per-run spend ceiling so a single flow cannot run up
        an unbounded bill. Outbound calls Suede makes to a creator&apos;s own
        server are themselves HMAC-signed so the creator can verify they
        genuinely came from Suede.
      </p>
    ),
  },
  {
    title: "You are not locked in",
    body: (
      <p>
        Any flow exports to TypeScript with the Suede SDK, so your engineers
        can read, own, and self-host the exact logic. Creator payouts go to a
        wallet you control. Reported agents can be taken down, and you can
        request deletion of a workspace and its data at any time from the{" "}
        <Link href="/account-deletion">account and data deletion page</Link>.
      </p>
    ),
  },
  {
    title: "Reporting a vulnerability",
    body: (
      <p>
        Found a security issue? Email{" "}
        <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>. Our
        machine-readable disclosure policy lives at{" "}
        <a href="/.well-known/security.txt">/.well-known/security.txt</a>. We
        read these directly and typically reply within one business day.
        Please do not publicly disclose an unpatched issue before we have had
        a chance to respond.
      </p>
    ),
  },
  {
    title: "What we're working toward",
    body: (
      <>
        <p>
          The following are on our roadmap and are <strong>not</strong> in
          place today. We list them so you know the direction, not so you
          count them as shipped:
        </p>
        <ul>
          <li>
            A formal third-party security audit (the path toward SOC 2 Type
            II).
          </li>
          <li>
            Globally-coordinated rate limiting (today&apos;s limits are
            effective but enforced per running instance).
          </li>
          <li>
            A dedicated key-management service (KMS/HSM) backing secret
            storage, and rotatable, regenerable webhook secrets.
          </li>
          <li>
            SSO/SAML, exportable audit logs, and a signed Data Processing
            Addendum for enterprise buyers.
          </li>
        </ul>
        <p>
          Enterprise buyers who need a DPA, a completed security questionnaire,
          or a deeper architecture review can reach us at{" "}
          <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a> and we
          will work through it with you.
        </p>
      </>
    ),
  },
];

export default function SecurityPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/security" />

      <div id="main-content" className="lp-shell lp-page">
        <div className="lp-page-head">
          <span className="lp-eyebrow">Security</span>
          <h1>Security and trust.</h1>
          <p>
            This page describes the security practices that are actually in
            place in Suede Agent Studio today, no more and no less. Where a
            formal certification is not yet in place, we say so plainly on
            this page rather than leaving you to guess.
          </p>
        </div>

        <section className="lp-section" style={{ paddingTop: 0 }} aria-label="Certification stance">
          <div className="sec-stance">
            <span className="k">Where we stand on certifications</span>
            <h2>No certification theater.</h2>
            <p>
              Suede Agent Studio is not SOC 2, HIPAA, or ISO 27001 certified.
              Those require a third-party audit engagement, and we will claim
              them the day they are real and not before. If your procurement
              process requires a certification we do not yet hold, tell us; we
              would rather have that conversation directly than have you find
              out later. Everything below is a current, factual description of
              how the product handles your data and money.
            </p>
          </div>
        </section>

        <div className="sec-list">
          {SECTIONS.map((section, index) => (
            <section key={section.title} className="sec-item">
              <span className="no" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h2>{section.title}</h2>
                {section.body}
              </div>
            </section>
          ))}
        </div>

        <p className="sec-updated">
          Last updated <time dateTime={LAST_UPDATED}>{LAST_UPDATED}</time>.
        </p>
      </div>

      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(securityPageJsonLd) }}
      />
    </div>
  );
}
