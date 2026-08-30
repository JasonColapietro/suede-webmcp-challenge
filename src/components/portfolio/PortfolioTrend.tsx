import type { PortfolioSummary } from "@/lib/portfolio/types";
import { AreaChart } from "@/components/portfolio/charts";
import { compactUsd, usd } from "@/lib/portfolio/format";

export function PortfolioTrend({ summary }: { summary: PortfolioSummary }) {
  const points = summary.trend.map((p) => ({ label: p.day, value: p.revenueUsdc }));
  const peak = Math.max(...points.map((p) => p.value), 0);

  return (
    <section className="pf-panel" aria-labelledby="pf-trend-heading">
      <div className="pf-panel-head">
        <div>
          <p id="pf-trend-heading" className="pf-tile-label">
            Revenue · last {summary.trend.length} days
          </p>
          <p className="pf-tile-sub" data-numeric>
            USDC settled per day, portfolio-wide
          </p>
        </div>
        {peak > 0 ? (
          <p className="pf-panel-note">peak {usd(peak)}/day</p>
        ) : null}
      </div>
      {peak > 0 ? (
        // Two renders of the same series, one per breakpoint. The SVG scales
        // its own text with the viewBox, so a single 820-unit chart squeezed
        // into a phone column draws 4px axis labels. Only one is ever in the
        // layout (and therefore in the accessibility tree) at a time.
        <>
          <div className="pf-chart pf-chart--wide">
            <AreaChart
              points={points}
              color="var(--primary)"
              height={240}
              format={compactUsd}
              ariaLabel="Portfolio revenue per day"
            />
          </div>
          <div className="pf-chart pf-chart--narrow">
            <AreaChart
              points={points}
              color="var(--primary)"
              height={200}
              viewBoxWidth={380}
              format={compactUsd}
              ariaLabel="Portfolio revenue per day"
            />
          </div>
        </>
      ) : (
        // A flat line pinned to an invented axis reads as a broken chart. Say
        // the true thing instead: nothing has settled in this window.
        <div className="pf-flat">
          <b>Nothing settled in this window.</b>
          <p>
            The moment one of your agents takes a paid call, the day it happened
            shows up on this line.
          </p>
        </div>
      )}
    </section>
  );
}
