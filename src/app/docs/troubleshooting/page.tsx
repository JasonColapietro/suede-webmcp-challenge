/**
 * Docs / Troubleshooting — symptom → cause → fix for the failures builders
 * and callers actually hit. Error strings and limits mirror the launch
 * route, run route, webhook auth, and engine guards.
 */
import type { Metadata } from "next";
import Link from "next/link";

const PAGE_TITLE = "Troubleshooting | Docs | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Symptom, cause, fix: launch validation errors, repeated 402s, webhook 401s, cost-ceiling aborts, loop and nesting limits, rate limiting, and payout misconfiguration.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/docs/troubleshooting" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/docs/troubleshooting",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

interface TroubleEntry {
  symptom: string;
  cause: string;
  fix: string;
}

interface TroubleSection {
  id: string;
  eyebrow: string;
  heading: string;
  entries: TroubleEntry[];
}

const SECTIONS: TroubleSection[] = [
  {
    id: "launch",
    eyebrow: "Launching",
    heading: "Launch is rejected",
    entries: [
      {
        symptom: "Launch fails with a structural error about the graph.",
        cause: "The flow isn't fully wired: a node island is disconnected from the main path, or a required connection is missing. Launch validates structure before any writes, so nothing half-publishes.",
        fix: "Open the canvas and trace every node back to the trigger. Delete leftover experiment nodes or wire them in. The error message names what's disconnected.",
      },
      {
        symptom: "Launch fails with an invalid cron message.",
        cause: "The Schedule node's cron expression doesn't parse. The format is five fields, UTC.",
        fix: "Use a five-field expression like 0 9 * * * (daily at 09:00 UTC). The launch error includes the offending string; fix it in the Schedule node's config.",
      },
      {
        symptom: "Launch returns 409.",
        cause: "Either the graph contains a Connector Lab API Operation node (simulation-only; it can never back a live endpoint), or the flow uses a graph feature launch doesn't support yet.",
        fix: "Replace the API Operation node with an HTTP Request node configured for the real API, then relaunch.",
      },
      {
        symptom: "Launch fails saying the payout address is invalid.",
        cause: "The payoutAddress isn't a valid EVM address.",
        fix: "Provide a 0x-prefixed address you control, or omit the field and set it before enabling settlement.",
      },
    ],
  },
  {
    id: "calling",
    eyebrow: "Calling agents",
    heading: "Calls don't behave as expected",
    entries: [
      {
        symptom: "Every call returns 402, even after paying.",
        cause: "The retry isn't carrying a valid payment: the PAYMENT-SIGNATURE header is missing, the authorization doesn't match the quoted amount or payTo, or verification failed on-chain. A rejected payment returns a fresh 402 with the reason appended to the error string.",
        fix: "Read the reason in the 402 body. Re-read the terms from the accepts array on each challenge rather than caching them (a relaunch can change the price), and make sure the wallet holds USDC on Base, not another network.",
      },
      {
        symptom: "The endpoint returns 404 for an agent you know exists.",
        cause: "Only live agents resolve. Unpublished, delisted, and draft agents intentionally return the same 404 as never-existed ones. It could also be an id/slug typo.",
        fix: "Confirm the agent appears in /api/catalog. If you own it, check its status in your workspace and relaunch if needed.",
      },
      {
        symptom: "Calls return 429.",
        cause: "Per-IP rate limiting on the run endpoint: a burst of 10, refilling at 0.5 requests/second.",
        fix: "Honor the Retry-After header and add client-side pacing. For fan-out workloads, queue calls instead of firing them simultaneously from one IP.",
      },
      {
        symptom: "A priced agent returns 503 \"payouts not configured\".",
        cause: "The agent is live and priced, but its creator never set a payout address. The platform refuses to settle money into nowhere.",
        fix: "If it's your agent: set a payout address and relaunch. If it's someone else's: nothing to do on your side; call it in dry-run or wait.",
      },
      {
        symptom: "You expected to be charged but got a free run.",
        cause: "Dry-run resolution kicked in: you sent a dryRun signal, the agent hasn't enabled settlement, or platform settlement isn't live. The response's settled field tells you the truth about payment on every call.",
        fix: "Nothing is wrong. Treat settled: false as the free path; the same request settles for real once the agent is live and you omit the dry-run signal.",
      },
    ],
  },
  {
    id: "runs",
    eyebrow: "Runs",
    heading: "Runs fail or stop early",
    entries: [
      {
        symptom: "A run aborts naming the cost ceiling.",
        cause: "The run hit its in-run spend ceiling (the minimum of the per-run cap, $5 by default, and the agent's remaining daily budget) before a cost-bearing node. Loops are the usual culprit: worst-case loop cost is N times the subflow cost.",
        fix: "Shrink the loop's input, cap maxIterations lower, trim expensive nodes from the subflow, or raise the agent's daily budget deliberately. The abort message says how many iterations completed.",
      },
      {
        symptom: "A loop iteration fails with a nesting-depth error.",
        cause: "The engine's subflow depth guard caps subflow/loop nesting at 16 levels. Each Subflow or Loop node runs its inner flow one level deeper than the run that called it; a nested run that would cross the cap fails with a depth error, surfaced on that node (or that iteration) rather than the whole run.",
        fix: "Flatten the design: hoist inner iterations upward, or restructure so a Transform prepares a flat list a single loop consumes. Sixteen levels is a guard against runaway recursion, not a budget to design toward.",
      },
      {
        symptom: "The Loop node reports success but some items are null.",
        cause: "Working as designed: loops collect per-item errors instead of failing the batch. Failed items are null in result, with details in the errors output.",
        fix: "Consume the errors output; branch on its length if partial success shouldn't count as success for your flow.",
      },
      {
        symptom: "An HTTP node fails instantly on an internal or localhost URL.",
        cause: "The SSRF guard blocks requests to localhost, private ranges (RFC1918), link-local, CGNAT, and .local/.internal hostnames, after resolving the hostname, on every redirect hop.",
        fix: "Point the node at a publicly resolvable URL. For local development against your own service, expose it through a public tunnel.",
      },
      {
        symptom: "A Transform expression is rejected before it runs.",
        cause: "The expression exceeded a hard limit (source length, tokens, nesting depth, AST nodes, evaluation steps, or wall-clock budget), or used a denied identifier: __proto__, constructor, and prototype are blocked everywhere.",
        fix: "Split the work across two Transform nodes, reduce map() fan-out, or move heavy reshaping upstream. The limits table is on the main reference page.",
      },
    ],
  },
  {
    id: "webhooks",
    eyebrow: "Webhooks",
    heading: "Webhook deliveries are rejected",
    entries: [
      {
        symptom: "Every webhook POST returns 401.",
        cause: "Signature verification failed. The same generic 401 covers a bad signature, a stale timestamp (more than 5 minutes off, either direction), and a nonexistent agent, deliberately, so responses can't be used to enumerate agents.",
        fix: "Sign HMAC-SHA256 over the exact string \"<timestamp>.<raw body bytes>\" with the secret from launch, send it as x-suede-webhook-signature (sha256=<hex>) plus x-suede-webhook-timestamp in Unix milliseconds, use content-type application/json, and stay under the 256 KB body cap. The worked signing example is on the main reference page.",
      },
      {
        symptom: "You lost the webhook secret.",
        cause: "The secret is shown exactly once at launch and stored only as a hash: it cannot be recovered, and relaunching deliberately does not rotate it.",
        fix: "Use the secret-rotation action on the agent to mint a new one, then update the third-party service that signs deliveries.",
      },
    ],
  },
];

export default function TroubleshootingPage(): React.JSX.Element {
  return (
    <>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Docs · Troubleshooting</span>
          <h1>Symptom, cause, fix</h1>
          <p>
            Most failures in this product are guardrails doing their job with
            a specific error attached. This page maps the errors you&apos;ll
            actually see to what tripped them and what to change.
          </p>
        </header>

        {SECTIONS.map((section, index) => (
          <section
            key={section.id}
            className="lp-doc lp-block"
            id={section.id}
            style={index === 0 ? { marginTop: 0 } : undefined}
          >
            <span className="lp-eyebrow">{section.eyebrow}</span>
            <h2>{section.heading}</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", marginTop: "1rem" }}>
              {section.entries.map((entry) => (
                <div key={entry.symptom} className="card" style={{ padding: "1.4rem 1.6rem" }}>
                  <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>{entry.symptom}</h3>
                  <p style={{ marginBottom: "0.5rem" }}>
                    <strong>Why:</strong> {entry.cause}
                  </p>
                  <p style={{ marginBottom: 0 }}>
                    <strong>Fix:</strong> {entry.fix}
                  </p>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="lp-doc lp-block">
          <span className="lp-eyebrow">Still stuck</span>
          <h2>Escalate with the facts</h2>
          <p>
            If none of the above matches, grab the run id from the response
            (or the run dock), the exact status code and error body, and{" "}
            <Link href="/contact" style={{ color: "var(--primary)" }}>
              contact us
            </Link>
            . The{" "}
            <Link href="/docs/api" style={{ color: "var(--primary)" }}>
              status code table
            </Link>{" "}
            is the fastest way to classify a failing call before reporting it.
          </p>
        </section>
    </>
  );
}
