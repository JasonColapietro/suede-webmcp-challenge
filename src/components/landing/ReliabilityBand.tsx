/**
 * Homepage reliability band. Self-contained server component: static, true
 * facts plus a link to the live status page. No client fetch, no numbers — the
 * page makes no uptime claim; /status carries the real, measured data.
 */
import Link from "next/link";

export default function ReliabilityBand(): React.JSX.Element {
  return (
    <section id="reliability" className="lp-section" style={{ paddingTop: 0 }}>
      <div className="lp-shell">
        <span className="lp-eyebrow">Reliability</span>
        <h2 className="lp-section-title">Production-grade, and you can check it.</h2>
        <p className="lp-section-sub">
          An agent you cannot inspect is an agent you have to babysit. Suede
          Agent Studio treats every seat like software: a Test environment
          before Live, immutable saved versions, release-style promotion,
          dry-run settlement by default, and a per-call cost ceiling that halts
          a run before it overspends. The status page reads real checks and
          shows the data as it accumulates. No invented uptime number.
        </p>
        <Link
          href="/status"
          className="lp-band-cta"
          style={{ display: "inline-block", marginTop: "1rem" }}
        >
          See live status →
        </Link>
      </div>
    </section>
  );
}
