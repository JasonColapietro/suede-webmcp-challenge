/**
 * Long-form articles rendered at /articles/[slug].
 *
 * Content is authored here as typed blocks (not MDX) so the article pages
 * stay on the same design system as the rest of the site with zero new
 * dependencies. Every factual claim about the product (prices, caps,
 * defaults, endpoints) mirrors the source of truth in src/lib — when a
 * constant changes, update the prose here too.
 */

export type ArticleBlock =
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "h2"; readonly text: string }
  | { readonly kind: "h3"; readonly text: string }
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "ul"; readonly items: readonly string[] };

export interface ArticleLink {
  readonly href: string;
  readonly label: string;
}

export interface Article {
  readonly slug: string;
  readonly eyebrow: string;
  readonly title: string;
  /** Visible blurb: rendered on /articles and above the article body. */
  readonly description: string;
  /**
   * Optional search-result snippet for the meta description and the OG and
   * Twitter card descriptions. Set it when the visible blurb is too long to
   * survive a SERP intact. Falls back to `description`. The Article JSON-LD
   * keeps using `description`, which is the text a reader actually sees.
   */
  readonly metaDescription?: string;
  readonly datePublished: string;
  readonly dateModified: string;
  readonly blocks: readonly ArticleBlock[];
  readonly related: readonly ArticleLink[];
}

export const ARTICLES: readonly Article[] = [
  {
    slug: "intro-to-agentic-workflows",
    eyebrow: "Fundamentals",
    title: "An introduction to agentic workflows",
    description:
      "What an agentic workflow actually is, how it differs from a script or a chatbot, and the four design decisions that matter before you build one.",
    datePublished: "2026-07-18",
    dateModified: "2026-07-20",
    blocks: [
      {
        kind: "p",
        text: "The phrase \"AI agent\" gets used for everything from an autocomplete widget to a fully autonomous trading bot, which makes it close to useless as a category. This article uses a narrower, more practical definition: an agentic workflow is a multi-step process where at least one step is delegated to a language model's judgment, and the steps are wired together so the whole thing can run without a person driving it.",
      },
      {
        kind: "p",
        text: "That definition draws two useful boundaries. A plain script is not an agentic workflow, because every step is deterministic; nothing in it exercises judgment. And a chatbot is not an agentic workflow either, because a person drives every turn. The interesting territory is in between: processes that run on their own schedule or trigger, make a bounded number of judgment calls along the way, and produce an output someone (or some other system) consumes.",
      },
      { kind: "h2", text: "The anatomy: triggers, judgment steps, deterministic steps, outputs" },
      {
        kind: "p",
        text: "Strip any real agentic workflow down and you find the same four kinds of parts. A trigger starts the run: a cron schedule, an inbound webhook from another system, a paid API call from a caller, or a person pressing run. One or more judgment steps do the work that justifies involving a model at all: classifying a support ticket, scoring a lead, summarizing a diff, drafting a reply. Deterministic steps do everything else: fetching data over HTTP, reshaping JSON between steps, branching on a condition, fanning out over a list. Finally, an output step defines what the run actually produces and where it goes.",
      },
      {
        kind: "p",
        text: "The most common design mistake is collapsing all four into one giant prompt. If your workflow is a single LLM call that receives a blob of context and is asked to fetch, decide, format, and deliver in one go, you have built something that is hard to test, hard to price, and hard to debug. When it misbehaves, you cannot tell which part failed, because there is only one part.",
      },
      { kind: "h2", text: "Why graphs beat prompts for this" },
      {
        kind: "p",
        text: "Representing a workflow as an explicit graph (nodes for steps, edges for data flow) is not just a visual convenience. It changes what you can know about the system.",
      },
      {
        kind: "ul",
        items: [
          "Testability. Each node has defined inputs and outputs, so you can run the whole graph against a sample input and inspect what every intermediate step produced. A failure points at a node, not at a thousand-token prompt.",
          "Cost accounting. When model calls and paid API calls are separate nodes, each run can carry a per-node cost ledger. You know what a run costs before you decide what to charge for it, or whether it is worth running at all.",
          "Bounded judgment. The model only exercises judgment inside its node. Control flow (branching, looping, halting on error) stays deterministic, which is where you want it. A branch node that routes on a field is auditable; a prompt instruction that says \"if the score is low, stop\" is a suggestion.",
          "Replaceability. A node with a defined contract can be swapped (a different model, a different API, a cached result) without rewriting the rest of the workflow.",
        ],
      },
      { kind: "h2", text: "Failure is a design input, not an edge case" },
      {
        kind: "p",
        text: "A workflow that runs unattended will eventually run against bad input, a slow API, an empty list, or a model response that does not parse. The design question is not whether that happens but what the blast radius is when it does. Three patterns cover most of it.",
      },
      {
        kind: "p",
        text: "First, halt on error by default. If a step fails, downstream steps should not run against garbage. Second, when fanning out over a list, collect per-item errors instead of failing the whole batch; one malformed row should not sink the other forty-nine, but the errors must surface in the output rather than vanish. Third, put a hard ceiling on spend per run. An unattended workflow with a loop and a paid step is a machine for turning a bug into a bill; a per-run cost cap converts the worst case from \"unbounded\" to \"a known number.\"",
      },
      { kind: "h2", text: "When not to build one" },
      {
        kind: "p",
        text: "Honesty matters here, because the failure mode of the current moment is agentifying things that did not need it. If every step of the process is deterministic, write a script; it will be faster, cheaper, and easier to reason about. If the process needs judgment but runs twice a year, do it by hand. If a wrong answer is expensive and hard to detect, keep a human in the loop and let the workflow draft rather than decide. Agentic workflows earn their keep in the specific zone where the process runs often, the judgment step is real but bounded, and a wrong answer is cheap to catch or cheap to tolerate.",
      },
      { kind: "h2", text: "How this maps onto Agent Studio" },
      {
        kind: "p",
        text: "Suede Agent Studio is a direct implementation of the model above. Flows are node graphs on a canvas: Input, Schedule, and Webhook nodes are the triggers; the LLM node is the judgment step; HTTP, Transform, Branch, and Loop nodes are the deterministic steps; the Output node defines the result. Runs stream a per-node cost ledger, every run shares an in-run cost ceiling, and loops collect per-item errors instead of failing the batch. Dry-run is the default mode: the graph logic executes for real, but cost-bearing and side-effecting nodes are stubbed, so you can test a workflow end to end without spending anything or calling anyone's API.",
      },
      {
        kind: "p",
        text: "The part that is genuinely different from most workflow builders is what happens after the flow works: you can publish it as a pay-per-call endpoint that other systems (including other agents) pay to invoke, with settlement in USDC over the x402 protocol. That turns a working workflow from an internal tool into a product, which is the subject of the other articles in this series.",
      },
    ],
    related: [
      { href: "/docs/building-flows", label: "Docs: building a flow" },
      { href: "/articles/designing-agent-flows", label: "Designing a good agent flow" },
      { href: "/articles/what-is-x402", label: "What x402 is and why pay-per-call agents matter" },
    ],
  },
  {
    slug: "what-is-x402",
    eyebrow: "Protocol",
    title: "What x402 is, and why pay-per-call agents matter",
    description:
      "HTTP status 402 sat reserved for thirty years. x402 finally uses it: a protocol for paying for a single API call with stablecoins, no account required. Here is how it works and how to use it for paid services.",
    metaDescription:
      "How x402 turns HTTP 402 into pay-per-call: the mechanics in one exchange, why it suits agents, how Agent Studio implements it.",
    datePublished: "2026-07-18",
    dateModified: "2026-07-24",
    blocks: [
      {
        kind: "p",
        text: "HTTP has had a status code for payments since the 1990s. Code 402, \"Payment Required,\" was reserved in the HTTP/1.1 specification for future use, and for roughly three decades that future never arrived. The web built its payment layer elsewhere: merchant accounts, card networks, checkout pages, API keys attached to monthly invoices, all of it designed for humans with browsers and billing departments.",
      },
      {
        kind: "p",
        text: "x402 is an open protocol, introduced by Coinbase in 2025, that finally puts the status code to work. The idea is small and precise: let a server charge for a single HTTP request, and let the client pay for it inside the request-response cycle itself, with no account, no API key, and no prior relationship between the two parties.",
      },
      { kind: "h2", text: "The mechanics in one exchange" },
      {
        kind: "p",
        text: "A caller sends a normal request to a paid endpoint. If no payment is attached, the server responds with status 402 and a machine-readable body describing what it accepts: the price, the asset (typically USDC), the network (typically Base, an Ethereum layer-2), and the address that gets paid. The caller's client reads those terms, signs a payment authorization with its wallet key, and retries the same request with the signed x402 v2 payload in a PAYMENT-SIGNATURE header. The server verifies the authorization, settles the transfer on-chain, runs the actual work, and returns the result, usually with a receipt confirming settlement.",
      },
      {
        kind: "code",
        code: "POST /api/agents/lead-qualifier/run        → 402 Payment Required\n                                              { accepts: [{ amount, asset, payTo, network }] }\n\nPOST /api/agents/lead-qualifier/run\n  PAYMENT-SIGNATURE: <x402 v2 payload>       → 200 OK\n                                              { output, settled: true, transaction }",
      },
      {
        kind: "p",
        text: "Two properties of this exchange do the heavy lifting. The wallet is the identity: the caller never registered, never verified an email, never got issued a key. And the payment is the authorization: the server does not need to check a subscription database, because the money either settled or it did not.",
      },
      { kind: "h2", text: "Why this matters for agents specifically" },
      {
        kind: "p",
        text: "For human developers, x402 is a mild convenience; API keys are annoying but workable. For software agents, the difference is structural. An agent that discovers a useful service at runtime cannot fill in a signup form, wait for an approval email, or negotiate a contract. Every step of the traditional API onboarding funnel assumes a person. x402 collapses that funnel into a protocol interaction an agent can complete in seconds: read the payment terms from the 402 response, decide whether the price is acceptable, sign, retry.",
      },
      {
        kind: "p",
        text: "Pricing granularity matters just as much. Stablecoin settlement on a cheap network makes a $0.04 call economically viable, a price point card networks cannot express once fixed fees are counted. Per-call pricing at that granularity means an agent can buy exactly one unit of work from another agent, which is the precondition for anything resembling an economy of specialized agents buying from each other rather than a handful of monolithic assistants doing everything badly.",
      },
      {
        kind: "p",
        text: "Discovery completes the loop. x402 services conventionally publish their catalog at a well-known URL (/.well-known/x402), listing each endpoint with its payment terms. That gives crawlers, agent frameworks, and other agents a standard place to find what is for sale and what it costs, without a human curating an integration.",
      },
      { kind: "h2", text: "How payment fits into your service" },
      {
        kind: "p",
        text: "x402 brings payment into the API request itself. Configure the caller's funded wallet, the seller's payout address, and current payment terms. Settlement is final with no protocol chargeback mechanism, so pair the endpoint with clear service terms and a support process. Publish your service contract and share it with customers who need the result.",
      },
      {
        kind: "p",
        text: "Pay-per-call works well for recurring machine-to-machine tasks: score a lead, process a document, or retrieve a structured result. A compatible client reads the terms and pays within the request cycle, making small transactions straightforward to integrate.",
      },
      { kind: "h2", text: "How Agent Studio implements it" },
      {
        kind: "p",
        text: "Suede Agent Studio wraps this protocol so a flow builder never handles the raw mechanics. Publishing a flow creates a crawlable service entry that reports preview, payment-enabled, or unavailable state. A payment-enabled request gets the 402 challenge with exact terms; a valid retry settles USDC on Base before the flow executes. Preview-ready services instead accept an explicit dry-run without payment. Every published service is indexed in the crawlable catalog, while x402 terms appear only when payment is actually enabled. Every settled call routes the full amount to the configured payout address. Track settled earnings alongside your service calls.",
      },
    ],
    related: [
      { href: "/docs/api", label: "Docs: calling agents over the API" },
      { href: "/docs/payments", label: "Docs: pricing and payments" },
      { href: "/articles/monetizing-agent-endpoints", label: "Monetizing an agent endpoint" },
    ],
  },
  {
    slug: "designing-agent-flows",
    eyebrow: "Practice",
    title: "Designing a good agent flow",
    description:
      "The difference between a flow that demos well and one that survives unattended runs: narrow LLM steps, deterministic control flow, focused testing, and knowing your worst-case cost.",
    datePublished: "2026-07-18",
    dateModified: "2026-07-20",
    blocks: [
      {
        kind: "p",
        text: "Most agent flows are built forward: start with a trigger, add an LLM node, keep appending steps until the output looks right. Flows built that way tend to demo well and then degrade quietly in production, because nothing in the process forced the builder to decide what the flow is actually contractually responsible for producing. The flows that hold up are built backward.",
      },
      { kind: "h2", text: "Start from the output" },
      {
        kind: "p",
        text: "Before placing a single node, write down the exact shape of what a successful run produces. Not \"a summary\" but a JSON object with named fields, or a drafted message with known length and tone constraints, or a score with a defined range and a threshold that means something. Two tests tell you whether the output definition is real: could a program consume it without a human interpreting it, and could you look at any given run's output and say unambiguously whether it succeeded?",
      },
      {
        kind: "p",
        text: "This matters double if the flow will ever be published as a paid endpoint. A caller paying per run is paying for that output contract. \"Interesting text\" is not a contract.",
      },
      { kind: "h2", text: "Keep the LLM steps narrow" },
      {
        kind: "p",
        text: "The model is the most expensive, slowest, and least predictable component in the graph, so give it the smallest job that still requires judgment. One decision per LLM node is a good default: classify this, score this, draft this. If you find yourself writing a prompt that says \"first extract the fields, then decide the category, then compose a reply,\" that is three nodes wearing one node's trench coat. Split them, and the middle step becomes independently testable.",
      },
      {
        kind: "p",
        text: "Everything that does not require judgment should be a deterministic node. Reshaping JSON, plucking fields, formatting lists: that is Transform work, done by a bounded expression language in microseconds for free, not by a model in seconds for tokens. Fetching data is HTTP-node work. Routing is Branch work: a branch that checks score >= 70 is auditable and free, while a prompt instruction hoping the model routes correctly is neither. A useful rule: the LLM decides values, the graph decides paths.",
      },
      { kind: "h2", text: "Design the failure paths on purpose" },
      {
        kind: "p",
        text: "Decide per step what a failure should do to the run. Agent Studio's engine halts downstream execution when a node on the main path fails, which is the right default; you rarely want an output built on a failed fetch. Loops are the deliberate exception: when a flow fans out over a list, per-item failures land in a separate errors output while the other items complete. The design decision that remains yours is what to do with those errors: surface them in the output contract, or feed them to a branch that decides whether partial success is success. Silently discarding them is the one wrong answer.",
      },
      {
        kind: "p",
        text: "Know your worst case, in dollars. A loop over N items runs the inner flow up to N times, so its worst-case cost is N times the inner cost, whether or not some items fail. The engine enforces a hard in-run spend ceiling ($5 per run by default, and never more than the agent's remaining daily budget), and iteration caps bound loops at 200 items with concurrency capped at 4, but hitting the platform's guardrail should be the backstop, not the plan. If your napkin math says a normal run costs more than a few percent of the ceiling, tighten the flow before shipping it.",
      },
      { kind: "h2", text: "Test with dry runs, and know what a dry run proves" },
      {
        kind: "p",
        text: "Dry-run mode executes the real graph: real wiring, real Transform expressions, real Branch decisions, real Loop iteration. What it stubs is precisely the nodes that cost money or touch the outside world: the LLM node returns without calling the model, and the HTTP node returns a fixed placeholder without making a request. That makes a dry run a complete test of your flow's structure and logic, and no test at all of your prompt quality or the target API's actual behavior. Use dry runs to prove the plumbing, then a small number of live runs in the studio to prove the judgment. Both are cheap; confusing one for the other is not.",
      },
      {
        kind: "p",
        text: "Feed the flow ugly inputs while you are at it: the empty list, the missing field, the 4,000-word ticket, the input in the wrong language. Every input you do not try during testing is an input production will try for you.",
      },
      { kind: "h2", text: "Ship the smallest flow that honors the contract" },
      {
        kind: "p",
        text: "There is a strong temptation, once the canvas is open, to add one more branch, one more enrichment step, one more nice-to-have. Every node you add is another thing that can fail, another line in the cost ledger, and another thing to reason about at 2 a.m. when a run misbehaves. The flows that earn trust unattended are almost boring to look at: a trigger, two or three deterministic steps, one or two narrow LLM steps, an output that matches its contract every single run. Build that first. Let real runs (and, if you publish it, real callers) tell you what the second version needs.",
      },
    ],
    related: [
      { href: "/docs/building-flows", label: "Docs: building a flow" },
      { href: "/docs/troubleshooting", label: "Docs: troubleshooting" },
      { href: "/articles/intro-to-agentic-workflows", label: "An introduction to agentic workflows" },
    ],
  },
  {
    slug: "monetizing-agent-endpoints",
    eyebrow: "Economics",
    title: "Monetizing an agent endpoint",
    description:
      "What it actually takes to earn money from a published agent: the cost floor, why distribution is the hard part, and the numbers to run before you set a price.",
    datePublished: "2026-07-18",
    dateModified: "2026-07-24",
    blocks: [
      {
            "kind": "p",
            "text": "Turn work you already know how to deliver into a service customers can buy per call. Suede AI Agent Studio brings the workflow, published endpoint, payment terms, and earnings record together. Start with one recurring customer task and a result they can use immediately."
      },
      {
            "kind": "h2",
            "text": "Choose the customer and the result"
      },
      {
            "kind": "p",
            "text": "Package a specific job: qualify a lead against a sales team's criteria, flag clauses for contract review, or turn a code diff into a release summary. Define the input, the output, and how the customer will use the result. Build the flow around that contract so the service is straightforward to test and integrate."
      },
      {
            "kind": "h2",
            "text": "Price for a healthy margin"
      },
      {
            "kind": "p",
            "text": "Measure model usage and priced nodes across representative inputs. Include external API charges, retries, and support in your cost estimate. Set your per-call price above that total. Agent Studio records run costs and provides per-run ceilings and daily budgets to help control execution spend. The Payments guide explains the current fees and funding options."
      },
      {
            "kind": "h2",
            "text": "Publish and enable payments"
      },
      {
            "kind": "p",
            "text": "Publish your flow, configure your payout address, complete readiness checks, and enable settlement. A payment-enabled x402 request returns the price and payment terms; the caller signs a USDC authorization on Base and retries. Every settled call routes the full amount to the configured payout address. Agent Studio keeps publication and payment enablement as separate controls."
      },
      {
            "kind": "h2",
            "text": "Connect your service to customers"
      },
      {
            "kind": "p",
            "text": "Share the endpoint with teams that already perform the task. Give them a sample input, a clear output schema, and an integration example for their existing workflow. Published services appear in the directory and machine-readable catalog; payment-enabled entries expose active x402 terms. Use available dry-run previews to test graph logic, then validate output quality with live inputs."
      },
      {
            "kind": "h2",
            "text": "Grow repeat usage"
      },
      {
            "kind": "p",
            "text": "Review completed calls, settled earnings, costs, and customer feedback. Improve the steps that affect output quality and repeat use. Keep the service focused on the recurring job, then add adjacent services when customers ask for them. Use your execution and earnings records to decide where to invest next."
      },
      {
            "kind": "h2",
            "text": "Set up your payment operations"
      },
      {
            "kind": "ul",
            "items": [
                  "Configure a payout address you control before enabling settlement. Receive x402 payments in USDC on Base; use an external exchange or off-ramp to convert them to a bank balance.",
                  "Read current payment terms on each call. Relaunching keeps the service slug while allowing price updates.",
                  "x402 settlement is final and has no protocol chargeback mechanism. Set clear service terms and a customer-support process.",
                  "Set run ceilings and daily budgets to manage the cost of executing your service.",
                  "Use the relay option when you want execution on your own server with payment verification handled by the platform."
            ]
      }
],

