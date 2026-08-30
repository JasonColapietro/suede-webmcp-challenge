import type { PortfolioSummary } from "@/lib/portfolio/types";
import { num, usd } from "@/lib/portfolio/format";
import { Sparkline } from "@/components/portfolio/charts";
import { DeltaPill } from "@/components/portfolio/ui";

function Tile({
  label,
  children,
  sub,
  earn = false,
}: {
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
  /** One tile per row carries the emerald earn rule: the money answer. */
  earn?: boolean;
}) {
  return (
    <div className={`pf-tile${earn ? " pf-tile--earn" : ""}`}>
      <p className="pf-tile-label">{label}</p>
      <div className="pf-tile-row">{children}</div>
      {sub ? (
        <p className="pf-tile-sub" data-numeric>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <span className="pf-figure" data-numeric>
      {children}
    </span>
  );
}

export function StatTiles({ summary }: { summary: PortfolioSummary }) {
  const last7 = summary.trend.slice(-7).map((p) => p.revenueUsdc);
  const agentWord = summary.agentCount === 1 ? "agent" : "agents";

  return (
    <section className="pf-tiles" aria-label="Portfolio totals">
      <Tile label="Total earned" sub="settled straight to your wallet" earn>
        <Figure>{usd(summary.totalRevenueUsdc)}</Figure>
      </Tile>

      <Tile label="Paid calls" sub={`across ${summary.agentCount} ${agentWord}`}>
        <Figure>{num(summary.totalCalls)}</Figure>
      </Tile>

      <Tile label="Seats earning" sub="called at least once in the last 7 days">
        <Figure>
          {summary.activeAgents}
          <span className="pf-figure-of"> / {summary.agentCount}</span>
        </Figure>
      </Tile>

      <Tile label="Last 7 days" sub="against the 7 days before it">
        <div className="pf-tile-stack">
          <Figure>{usd(summary.revenue7d)}</Figure>
          <DeltaPill fraction={summary.delta7d} />
        </div>
        <span className="pf-tile-spark">
          <Sparkline values={last7} color="var(--primary)" width={92} height={38} />
        </span>
      </Tile>
    </section>
  );
}
