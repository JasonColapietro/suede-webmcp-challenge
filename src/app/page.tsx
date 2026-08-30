import type { Metadata } from "next";
import Link from "next/link";
import { signInUrl } from "@/lib/sign-in-url";
import { SITE_URL } from "@/lib/site";
import "./mystery-landing.css";

export const metadata: Metadata = {
  title: "Build agents that can earn while you sleep. | Suede Agent Studio",
  description:
    "Publish repeatable work as callable services. You decide what goes live and when paid calls are enabled.",
  alternates: { canonical: SITE_URL },
  openGraph: {
    title: "Build agents that can earn while you sleep. | Suede Agent Studio",
    description:
      "Publish repeatable work as callable services. You decide what goes live and when paid calls are enabled.",
    url: SITE_URL,
  },
  twitter: {
    title: "Build agents that can earn while you sleep. | Suede Agent Studio",
    description:
      "Publish repeatable work as callable services. You decide what goes live and when paid calls are enabled.",
  },
};

export default function Home(): React.JSX.Element {
  // The entry deliberately withholds protocol detail: x402 is caller-payment,
  // A2A is the interface, and Stripe funds builder credit elsewhere.
  const entryUrl = signInUrl(`${SITE_URL}/enter`);

  return (
    <div className="mystery-landing">
      <header className="mystery-header">
        <Link href="/" className="mystery-wordmark">
          Suede Agent Studio
        </Link>
        <a href={entryUrl} className="mystery-sign-in">
          Sign in
        </a>
      </header>
      <main id="main-content" className="mystery-main">
        <div className="mystery-signal" aria-hidden="true">
          <span />
        </div>
        <p className="mystery-product">AGENTS THAT EARN</p>
        <h1 aria-label="Build agents that can earn while you sleep.">
          <span>Build agents that can</span>
          <em>earn while you sleep.</em>
        </h1>
        <p className="mystery-support">
          Publish repeatable work as callable services. You decide what goes live and when paid calls are enabled.
        </p>
        <a href={entryUrl} className="mystery-enter">
          Enter Studio
        </a>
      </main>
      <footer className="mystery-footer">
        <a href="/privacy">Privacy</a>
        <a href="/security">Security</a>
        <a href="https://suedeai.ai">Suede Labs</a>
      </footer>
    </div>
  );
}
