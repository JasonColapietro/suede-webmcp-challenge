import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateFacts from "../TemplateFacts";
import "../../chrome.css";
import "../../site.css";

export const metadata: Metadata = {
  title: { absolute: "Invoice Chaser Agent Template: Automate Late Payment Reminders | Suede Agent Studio" },
  description:
    "AI invoice follow-up agent that sends polite, progressively firmer payment reminders for every overdue invoice. Runs every Monday morning. $0.05 per run.",
  alternates: { canonical: "/templates/invoice-chaser" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/templates/invoice-chaser",
    siteName: "Suede Agent Studio",
    title: "Invoice Chaser Agent Template: Automate Late Payment Reminders | Suede Agent Studio",
    description:
      "AI invoice follow-up agent that sends polite, progressively firmer payment reminders for every overdue invoice. Runs every Monday morning. $0.05 per run.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Invoice Chaser Agent Template: Automate Late Payment Reminders | Suede Agent Studio",
    description:
      "AI invoice follow-up agent that sends polite, progressively firmer payment reminders for every overdue invoice. Runs every Monday morning. $0.05 per run.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

const WHAT_IT_DOES = [
  {
    color: "var(--primary)",
    label: "Scans overdue invoices",
    body: "The agent reads your invoice list on a schedule and identifies every unpaid invoice past its due date. It tracks days overdue, last contact date, and total amount outstanding so no client slips through.",
  },
  {
    color: "var(--text-success)",
    label: "Drafts per-client messages",
    body: "Every follow-up is written for that specific client, referencing the invoice number, amount, and due date. The tone is professional and firm without being adversarial, protecting the relationship while moving the money.",
  },
  {
    color: "var(--text-warning)",
    label: "Escalates on repeat offenders",
    body: "Clients who miss two or more consecutive follow-ups get a noticeably firmer message in the next cycle. The agent tracks response history and adjusts language automatically so you never have to calibrate tone manually.",
  },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    text: "Point it at your invoice list: a spreadsheet, a Notion database, or a plain text file with rows of clients, amounts, and due dates.",
  },
  {
    step: "02",
    text: "The agent drafts a tailored follow-up for each overdue invoice, matching tone to how many times that client has already been contacted.",
  },
  {
    step: "03",
    text: "Review each draft and send manually, or flip the switch to let the agent fire automatically every Monday morning without touching it.",
  },
];

export default function InvoiceChaserPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">AR Automation</span>
          <h1>Chase invoices on autopilot, no awkward emails</h1>
          <p>
            The Invoice Chaser agent drafts professional, progressively firmer payment
            reminders for every overdue invoice in your pipeline. It knows who owes what,
            how long they&apos;ve owed it, and how many times you&apos;ve already asked.
            Runs every Monday morning for $0.05 a pass.
          </p>
        </header>

        <TemplateFacts slug="invoice-chaser" />

        <section
          style={{
            marginTop: "3.5rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1.25rem",
          }}
        >
          <div
            style={{
              gridColumn: "1 / -1",
              marginBottom: "0.25rem",
            }}
          >
            <span className="lp-eyebrow">What it does</span>
          </div>
          {WHAT_IT_DOES.map((card) => (
            <div key={card.label} className="card" style={{ padding: "1.5rem" }}>
              <span
                className="eyebrow"
                style={{ color: card.color }}
              >
                {card.label}
              </span>
              <p style={{ color: "var(--text-muted)", lineHeight: 1.65, fontSize: "var(--text-sm)", marginTop: "0.6rem" }}>
                {card.body}
              </p>
            </div>
          ))}
        </section>

        <section style={{ marginTop: "3.5rem" }}>
          <span className="lp-eyebrow">How it works</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              marginTop: "0.5rem",
              marginBottom: "1.5rem",
            }}
          >
            Three steps, then it runs itself
          </h2>
          <ol
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
              counterReset: "steps",
            }}
          >
            {HOW_IT_WORKS.map((item) => (
              <li
                key={item.step}
                className="card"
                style={{
                  padding: "1.1rem 1.5rem",
                  display: "flex",
                  gap: "1.25rem",
                  alignItems: "flex-start",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.7rem",
                    letterSpacing: "0.1em",
                    color: "var(--primary)",
                    fontWeight: 700,
                    flexShrink: 0,
                    paddingTop: "2px",
                  }}
                >
                  {item.step}
                </span>
                <p style={{ margin: 0, color: "var(--text-muted)", lineHeight: 1.6, fontSize: "var(--text-sm)" }}>
                  {item.text}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section
          style={{
            marginTop: "4rem",
            padding: "3rem",
            background: "var(--canvas-bg)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--hairline)",
            textAlign: "center",
          }}
        >
          <span className="lp-eyebrow">Start building</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              marginTop: "0.75rem",
              marginBottom: "1rem",
            }}
          >
            First chase is free
          </h2>
          <p style={{ color: "var(--text-muted)", maxWidth: "44ch", marginInline: "auto", marginBottom: "1.75rem", lineHeight: 1.6 }}>
            Dry-run on your oldest invoice. No wallet needed.
          </p>
          <Link href="/build/new?template=invoice-chaser" className="lp-btn lp-btn--primary">
            Open this template →
          </Link>
          <div className="tg-detail-back">
            <Link href="/templates" className="lp-tpl-more-link">
              Browse all templates →
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
