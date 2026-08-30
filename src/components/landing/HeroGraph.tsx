/** Signature hero visual: a server-rendered org chart whose native seat
 * radios select one of thirteen pre-rendered flow strips. CSS handles both
 * selection and pointer preview, so the LCP surface ships no client boundary
 * or hydration cost. */
import { Fragment } from "react";
import HeroOrgChart from "./HeroOrgChart";
import {
  DEFAULT_HERO_SEAT_SLUG,
  SEAT_STEP_META,
  flattenOrg,
  seatSlug,
  type OrgNode,
} from "./AgentOrgCard";

const SEATS = flattenOrg();
const LIVE_SEATS = SEATS.filter((seat) => seat.live).length;

function stripMeter(seat: OrgNode): { label: string; value: string; money: boolean } {
  if (seat.live && seat.price) {
    return { label: "x402 dry-run", value: seat.price.split(" ")[0], money: true };
  }
  if (seat.schedule) {
    return { label: "cron", value: seat.schedule, money: false };
  }
  return { label: "internal", value: "unpriced", money: false };
}

function SeatStrip({ seat }: { seat: OrgNode }): React.JSX.Element {
  const meter = stripMeter(seat);
  return (
    <div className="hg-strip" data-seat={seatSlug(seat)} style={{ ["--c" as string]: seat.color }}>
      <div className="hg-strip-head">
        <span>
          <i className="hg-strip-dot" />
          {seat.role.toLowerCase()} seat · {seat.flow.slug}
        </span>
        <span>
          {meter.label} ·{" "}
          <b className={meter.money ? undefined : "is-quiet"}>{meter.value}</b>
        </span>
      </div>
      <div className="hg-strip-flow">
        {seat.flow.steps.map((step, index) => {
          const meta = SEAT_STEP_META[step.kind];
          const bills = Boolean(step.bills && seat.live && seat.price);
          return (
            <Fragment key={`${step.kind}-${step.label}`}>
              {index > 0 && <i className="hg-wire" />}
              <span
                className="hg-chip"
                style={{ ["--c" as string]: meta.color, ["--ci" as string]: meta.ink }}
              >
                {bills && <i className="hg-chip-dot" />}
                <b>{step.kind}</b>
                <span>{step.label}</span>
                {bills && seat.price && (
                  <em className="hg-chip-cost">{seat.price.split(" ")[0]}</em>
                )}
              </span>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

export default function HeroGraph(): React.JSX.Element {
  return (
    <fieldset className="hg-frame reveal" style={{ animationDelay: "0.25s" }}>
      <legend className="sr-only">Choose a seat to view its flow.</legend>

      <div className="hg-bar" aria-hidden="true">
        <b>company · lead-gen-studio</b>
        <span className="hg-live">
          <i /> {LIVE_SEATS} seats live
        </span>
      </div>

      <HeroOrgChart />

      <div className="hg-divider" aria-hidden="true">
        <span>
          each seat opens into a flow<em> · hover or choose a seat</em>
        </span>
      </div>

      <div
        className="hg-strips"
        data-default-seat={DEFAULT_HERO_SEAT_SLUG}
        aria-hidden="true"
      >
        {SEATS.map((seat) => (
          <SeatStrip seat={seat} key={seat.role} />
        ))}
      </div>
    </fieldset>
  );
}
