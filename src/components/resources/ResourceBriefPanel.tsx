import type { ResourcePackBundle, ResourcePortfolioItem } from "./client";

export default function ResourceBriefPanel({
  product,
  pack,
}: {
  readonly product: ResourcePortfolioItem;
  readonly pack: ResourcePackBundle | null;
}): React.JSX.Element {
  return (
    <section className="resource-stage" aria-labelledby="resource-brief-heading">
      <div className="resource-stage-head">
        <p className="resource-kicker">01 / Brief</p>
        <h2 id="resource-brief-heading">One buyer, one recurring job</h2>
        <p>Starter lenses change the framing only. Every resource continues through the same source, record, test, and release lifecycle.</p>
      </div>
      <dl className="resource-fact-strip">
        <div><dt>Status</dt><dd>{product.status}</dd></div>
        <div><dt>Execution</dt><dd>{product.executionAccess}</dd></div>
        <div><dt>Discovery</dt><dd>{product.discoveryAccess}</dd></div>
        <div><dt>Releases</dt><dd>{product.releaseCount}</dd></div>
      </dl>
      <div className="resource-split">
        <div><h3>Job</h3><p>{pack?.content.jobContract.jobStatement ?? "The server-current pack receipt is not available."}</p></div>
        <div><h3>Buyer intent</h3><p>{pack?.content.jobContract.buyerIntent ?? "Not available in the current owner read."}</p></div>
      </div>
    </section>
  );
}
