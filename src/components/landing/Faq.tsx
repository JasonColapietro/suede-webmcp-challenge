import { buildTemplateCatalogStats } from "@/lib/template-summaries";

const CATALOG = buildTemplateCatalogStats();

export const FAQ_ITEMS = [
  {
    question: "What is Suede Agent Studio?",
    answer:
      "Suede Agent Studio is a visual builder for AI agents. Chart your company on a canvas and staff each seat with an agent. Every seat opens into a flow of input, LLM reasoning, branching, and scheduling nodes. An ordinary published service advertises a callable preview; company services advertise unavailable until their paid-call gates pass. An eligible service can be separately payment-enabled for x402 v2 caller settlement in USDC on Base. Music, media, and workflow integrations are available for specialized agents too.",
  },
  {
    question: "What is a node-graph flow?",
    answer:
      "A flow is a small diagram of work. Each node is one step: take an input, ask a model, branch on the answer, call an endpoint, return an output. The wires between nodes say what feeds what. You drag nodes onto the canvas and connect their ports, and the studio checks at wire time that a port can accept what it is handed. A test run lights each node as it executes, so you can see where a step went wrong and what it cost. Every agent in Suede Agent Studio is one of these flows behind a URL.",
  },
  {
    question: "What is x402?",
    answer:
      "x402 v2 is the caller-settlement protocol for charging per HTTP call. A buyer's wallet signs a payment, the endpoint verifies it and does the work, and settlement lands in USDC on Base. Only payment-enabled services advertise payment acceptance; launch or Live status alone does not. A2A is the agent-to-agent interface, while Stripe provides builder funding.",
  },
  {
    question: "Do I need a wallet or API key to try it?",
    answer:
      "No. A service that advertises preview can be dry-run free without a wallet or API key. Publishing is free too: Suede meters the model and hosts the service. A payout wallet is needed only when an eligible service enables payments; a caller wallet is needed only to authorize a paid call. Stripe card purchases fund builder credit.",
  },
  {
    question: "What is an autonomous company?",
    answer:
      "A company you found from a first-party template. Suede seeds the mission, stands up the departments, and staffs every seat with a specialist agent that has its own flow, role, and budget. Companies open in draft, so live selling and costly changes wait on your explicit approval. Eligible seats can be separately payment-enabled; their settled x402 v2 calls use USDC on Base and route to the configured payout wallet.",
  },
  {
    question: "Is it sturdy enough for a team or an enterprise?",
    answer:
      "The software discipline is there: every flow keeps a mutable draft and immutable saved versions, runs in separate Test and Live environments, and gets promoted the way an engineering team ships a release. Every run writes a per-step USDC cost ledger you can audit, and any flow exports to TypeScript with the Suede SDK so your engineers own the code. A live status page at /status shows real availability as it accumulates.",
  },
  {
    question: "What are the three ways to build?",
    answer:
      "Guided (describe what you want and it's assembled for you), Studio (drag-and-drop node canvas), and Code (every flow can be exported as TypeScript via the Suede SDK and pushed back with one command).",
  },
  {
    question: "Can I build an agent from my company's website?",
    answer:
      "Yes. Paste your URL at /from-website and Suede reads your home page plus up to five more, obeying your robots.txt and touching nothing behind a login. It shows you every page it read and every fact it pulled before you launch anything. The drafted agent answers only from those pages: it will not state a price, policy, or promise your site does not make, and it says the site does not cover it rather than guessing. The per-call price is derived from what a call actually costs to run and never drops below it. Launched agents start unlisted; they join the public directory once you prove you own the domain by placing a one-line file on your site.",
  },
  {
    question: "What can I wire into a flow?",
    answer:
      `${CATALOG.total} public templates ship today: ${CATALOG.business} business, ${CATALOG.personal} personal, and ${CATALOG.creator} creator. Contract review, lead scoring, invoice chasing, competitor tracking, support triage, and more, all built from input, LLM, branch, and schedule nodes. The public Suede gateway offers music, short-form video, and image generation; internal and compatibility profiles are not public offerings.`,
  },
  {
    question: "Who builds Suede Agent Studio?",
    answer:
      "Suede Agent Studio is a Suede Labs AI product, built by founder Jason Colapietro.",
  },
] as const;

export function Faq(): React.JSX.Element {
  return (
    <section id="faq" className="lp-section">
      <div className="lp-shell">
        <span className="lp-eyebrow">FAQ</span>
        <h2 className="lp-faq-title">Frequently asked questions</h2>
        <div className="lp-faq-list">
          {FAQ_ITEMS.map((item, index) => (
            <details key={item.question} className="lp-faq-item" open={index === 0}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
