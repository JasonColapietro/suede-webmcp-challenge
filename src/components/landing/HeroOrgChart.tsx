/** The hero is the one explorable org surface on the landing page. Its
 * current main hierarchy remains shared with every other org illustration,
 * while native radio inputs make each seat a real, zero-JS flow choice. */
import { AgentOrgTree, ORG_BRANCHES, ORG_ROOT, flattenOrg } from "./AgentOrgCard";

function describeOrg(): string {
  const seats = flattenOrg();
  const earning = seats.filter((seat) => seat.live && seat.price).length;
  const scheduled = seats.filter((seat) => seat.schedule).length;
  return (
    `Company org chart: ${seats.length} seats, every one an AI agent. ` +
    `CEO ${ORG_ROOT.agent} at the top, with ${ORG_BRANCHES.length} departments reporting in: ` +
    `${ORG_BRANCHES.map((branch) => `${branch.dept} under ${branch.node.role} ${branch.node.agent}`).join(", ")}. ` +
    `${earning} seats earn per paid call in USDC; ${scheduled} run on a cron schedule. ` +
    "Choose a seat with touch or the arrow keys to inspect its price, cadence, and four-step flow."
  );
}

export default function HeroOrgChart(): React.JSX.Element {
  return (
    <div
      className="hg-org"
      role="group"
      aria-labelledby="hero-org-title"
      aria-describedby="hero-org-summary"
    >
      <h2 id="hero-org-title" className="sr-only">
        Example company org chart
      </h2>
      <p id="hero-org-summary" className="sr-only">
        {describeOrg()}
      </p>
      <AgentOrgTree variant="hero" idPrefix="hero" interactive />
    </div>
  );
}
