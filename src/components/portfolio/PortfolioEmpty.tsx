"use client";

/**
 * The zero state for /portfolio. It is the state a first-time visitor from the
 * homepage hero footnote ("earnings for launched agents land in your
 * portfolio") most often lands on, so it has to explain what will appear here
 * and hand over the two ways to make that happen.
 *
 * The preview tiles are deliberately shape-only: every figure is a literal
 * placeholder dash. Nothing on this component can be read as earnings data.
 */
import Link from "next/link";

const STEPS: readonly { readonly n: string; readonly title: string; readonly body: string; readonly earn?: boolean }[] = [
  {
    n: "1",
    title: "Wire the flow",
    body: "Drop in input, reasoning, branch, and schedule nodes on the canvas until the job runs end to end.",
  },
  {
    n: "2",
    title: "Launch it as a seat",
    body: "Publishing gives the flow a public page, an x402 price in USDC, and a run endpoint any agent can call.",
  },
  {
    n: "3",
    title: "Get paid per call",
    body: "Each settled call posts to this ledger: revenue, call count, cadence, and the day it happened.",
    earn: true,
  },
];

/** Mirrors the real tile row on a populated portfolio, label for label. */
const PREVIEW: readonly string[] = ["Total earned", "Paid calls", "Seats earning", "Last 7 days"];

export function PortfolioEmpty({ onTrack }: { onTrack: () => void }): React.JSX.Element {
  return (
    <section className="pf-empty" aria-labelledby="pf-empty-heading">
      <div className="pf-empty-head">
        <p className="eyebrow">No agents on the payroll yet</p>
        <h2 id="pf-empty-heading">Your first earning seat is one flow away.</h2>
        <p>
          Launch a flow as a pay-per-call agent and it takes a seat here. From then on
          this page is the honest record of what it charged, who called it, and what
          settled to your wallet. Nothing is estimated and nothing is projected.
        </p>
        <div className="pf-empty-actions">
          <Link href="/build/new" className="lp-btn lp-btn--primary">
            Start from a blank canvas
          </Link>
          <Link href="/templates" className="lp-btn lp-btn--ghost">
            Start from a template
          </Link>
          <button type="button" onClick={onTrack} className="lp-btn lp-btn--ghost">
            + Track an agent by hand
          </button>
        </div>
      </div>

      <ol className="pf-steps">
        {STEPS.map((s) => (
          <li key={s.n} className={`pf-step${s.earn ? " pf-step--earn" : ""}`}>
            <span className="pf-step-n" aria-hidden="true">
              {s.n}
            </span>
            <span className="pf-step-body">
              <b>{s.title}</b>
              <span>{s.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="pf-ghost">
        <p className="pf-tile-label">What lands here</p>
        <div className="pf-ghost-grid" aria-hidden="true">
          {PREVIEW.map((label) => (
            <div key={label} className="pf-ghost-tile">
              <p className="pf-tile-label">{label}</p>
              <span className="pf-ghost-dash">&mdash;</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
