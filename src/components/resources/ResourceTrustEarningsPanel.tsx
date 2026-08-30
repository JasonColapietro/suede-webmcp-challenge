import type { ResourceTrust } from "./client";

function count(value: number | null): string { return value === null ? "Not recorded" : String(value); }
function money(value: number | null): string { return value === null ? "Not recorded" : `$${value.toFixed(6)}`; }
function percent(value: number | null): string { return value === null ? "No executions recorded" : `${(value * 100).toFixed(1)}%`; }

export default function ResourceTrustEarningsPanel({ trust }: { readonly trust: ResourceTrust | null }): React.JSX.Element {
  if (!trust) return <section className="resource-stage"><p className="resource-state">Trust facts are not available.</p></section>;
  const facts = [
    ["Calls recorded", count(trust.activity.calls.count)],
    ["Attempted", count(trust.facts.attempted.count)],
    ["Challenged", count(trust.facts.challenged.count)],
    ["Executed", count(trust.facts.executed.count)],
    ["Credited value", money(trust.facts.credited.amountUsdc)],
    ["Settled revenue", money(trust.facts.settled.amountUsdc)],
    ["Refunded", money(trust.facts.refunded.amountUsdc)],
    ["Failed", count(trust.facts.failed.count)],
  ] as const;
  return (
    <section className="resource-stage" aria-labelledby="resource-trust-heading">
      <div className="resource-stage-head">
        <p className="resource-kicker">07 / Trust & Earnings</p>
        <h2 id="resource-trust-heading">Receipt facts, without inference</h2>
        <p>Listings and price challenges are not represented as use, settlement, demand, or revenue.</p>
      </div>
      <div className="resource-trust-register">
        {facts.map(([label, value]) => <div key={label}><span>{label}</span><strong className="tabular">{value}</strong></div>)}
      </div>
      <dl className="resource-fact-strip">
        <div><dt>Schema valid</dt><dd>{percent(trust.rates.schemaValidRate)}</dd></div>
        <div><dt>Evidence coverage</dt><dd>{percent(trust.rates.evidenceCoverageRate)}</dd></div>
        <div><dt>Fresh</dt><dd>{percent(trust.rates.freshRate)}</dd></div>
        <div><dt>Stale</dt><dd>{percent(trust.rates.staleRate)}</dd></div>
        <div><dt>Mixed freshness</dt><dd>{percent(trust.rates.mixedRate)}</dd></div>
        <div><dt>Unknown rate</dt><dd>{percent(trust.rates.unknownRate)}</dd></div>
        <div><dt>Conflict rate</dt><dd>{percent(trust.rates.conflictRate)}</dd></div>
        <div><dt>Recorded price</dt><dd>{money(trust.economics.price.averageUsdc)}</dd></div>
        <div><dt>Execution cost</dt><dd>{money(trust.economics.cost.amountUsdc)}</dd></div>
        <div><dt>Margin</dt><dd>{money(trust.economics.margin.amountUsdc)}</dd></div>
      </dl>
      <p className="resource-boundary-note">
        <b>Demand</b> Not measured · Credited value and price challenges are not revenue · Cost and margin remain Not recorded until receipts measure cost.
      </p>
    </section>
  );
}
