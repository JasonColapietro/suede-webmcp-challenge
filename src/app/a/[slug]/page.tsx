/**
 * Public agent page — the shareable, machine-callable face of a launched flow.
 * A buyer (human or agent) lands here, sees what it does and what it costs,
 * tries it in dry-run, and copies the one-liner to call it for real.
 */
import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteNav from "@/components/site/SiteNav";
import StorefrontTools from "@/components/webmcp/StorefrontTools";
import SiteFooter from "@/components/site/SiteFooter";
import TryIt from "@/components/agent/TryIt";
import CopyBlock from "@/components/agent/CopyBlock";
import AgentSafetyActions from "@/components/moderation/AgentSafetyActions";
import OwnerBar from "./OwnerBar";
import { getRepo } from "@/lib/db/repo";
import type { AgentRecord, FlowRecord } from "@/lib/db/repo";
import { summarizeGraph } from "@/lib/catalog";
import { describeCron, nextOccurrence } from "@/lib/cron";
import { SITE_URL } from "@/lib/site";
import { getProjectRepo } from "@/lib/projects/provider";
import type { ReadonlyFlowGraph } from "@/lib/projects/types";
import { curatedBusinessService } from "@/lib/curated-business-services";
import { resolvePublicServiceContract, type PublicServiceContract } from "@/lib/public-service-contract";
import { projectAp2Discovery } from "@/lib/discovery/agent-card";
import { publicAp2RuntimeStatus } from "@/lib/rails/ap2/config";
import { isAp2ServiceEligible } from "@/lib/rails/ap2-eligibility";
import { buildPublicAgentMetadataCopy } from "@/lib/metadata-copy";
import {
  isPublishedAgentRecord,
  resolvePublicPaymentReadiness,
  type PublicPaymentReadiness,
  type PublicPaymentState,
} from "@/lib/public-payment-readiness";
import "../../chrome.css";
import "../../site.css";
import "../agent.css";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// Cached render per agent, regenerated on the same staleness window the
// homepage catalog already accepts. Calls/status drift ≤60s is fine here;
// the run endpoint itself is always live. The empty generateStaticParams
// is what actually opts a dynamic segment into on-demand ISR — without it
// the route builds as fully dynamic and `revalidate` is inert.
export const revalidate = 60;
export const dynamicParams = true;

export function generateStaticParams(): { slug: string }[] {
  return [];
}

// react cache() dedupes the generateMetadata + page-render invocations of the
// same slug within one request — without it the whole DB chain ran twice.
const loadPublicAgent = cache(async (slug: string): Promise<{
  readonly repo: Awaited<ReturnType<typeof getRepo>>;
  readonly agent: AgentRecord;
  readonly flow: FlowRecord;
  readonly graph: ReadonlyFlowGraph;
  readonly service: PublicServiceContract;
  readonly readiness: PublicPaymentReadiness;
} | null> => {
  // Independent of the agent/flow lookups — start it immediately.
  const projectRepoPromise = getProjectRepo().catch(() => null);
  const repo = await getRepo();
  const agent = await repo.getAgentBySlug(slug);
  if (!isPublishedAgentRecord(agent)) return null;
  const flow = await repo.getFlow(agent.flowId);
  if (!flow) return null;
  const projectRepo = await projectRepoPromise;
  // One deployment read serves both the graph resolution and the page's
  // honest "is a paid call actually possible" posture. A repo without the
  // read, or a failed read, fails closed: no Draft graph is projected.
  const activeDeployment =
    projectRepo && typeof projectRepo.getActiveDeployment === "function"
      ? await projectRepo
          .getActiveDeployment({
            flowId: flow.id,
            ownerId: flow.ownerId,
            environmentKind: "live",
          })
          .catch(() => null)
      : null;
  const service = await resolvePublicServiceContract({ flow, agent, projectRepo, activeDeployment });
  if (!service || service.resource?.access.execution === "private") return null;
  const readiness = await resolvePublicPaymentReadiness({
    agent,
    flow,
    repo,
    publishedGraph: service.graph,
    // The service resolver returns only after exact immutable Live authority
    // resolves and matches the active deployment.
    liveExecutionReady: true,
  });
  return { repo, agent, flow, graph: service.graph, service, readiness };
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const published = await loadPublicAgent(slug);
  if (!published) {
    return {
      title: { absolute: "Agent not found | Suede Agent Studio" },
      robots: { index: false, follow: true },
    };
  }
  const { agent, flow, graph, service, readiness } = published;
  const name = service.kind === "resource" ? service.name : flow.name;
  const curated = service.curated ?? curatedBusinessService(agent.slug, graph);
  const desc = service.kind === "resource" ? service.description : curated?.description ?? (
    readiness.state === "payment-enabled"
      ? `${name}: a payment-enabled service at $${agent.priceUsdc.toFixed(3)} per call${
          readiness.previewAvailable
            ? ", with an explicit free preview"
            : ", with no public preview"
        }.`
      : readiness.state === "preview"
        ? `${name}: a callable dry-run preview that does not currently accept payment.`
        : `${name}: a published service that is currently unavailable for public calls.`);
  const copy = buildPublicAgentMetadataCopy({ name, slug, description: desc });
  const ogImage = `${SITE_URL}/opengraph-image`;
  return {
    title: { absolute: copy.title },
    description: copy.description,
    alternates: { canonical: `/a/${slug}` },
    ...(service.resource?.access.discovery === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
    openGraph: {
      type: "website",
      locale: "en_US",
      url: `${SITE_URL}/a/${slug}`,
      siteName: "Suede Agent Studio",
      title: copy.title,
      description: copy.description,
      images: [{ url: ogImage, width: 1200, height: 630, alt: copy.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      site: "@AISUEDE",
      creator: "@johnnysuede",
      images: [ogImage],
    },
  };
}

interface PublishedEndpoint {
  label: string;
  method: string;
  path: string;
  note: string;
}

function endpointsFor(agent: AgentRecord, state: PublicPaymentState): PublishedEndpoint[] {
  const executionNote = state === "payment-enabled"
    ? "Payment-enabled execution over x402 v2."
    : state === "preview"
      ? "Explicit dry-run preview; no payment accepted."
      : "Public execution is currently unavailable.";
  return [
    {
      label: "Run",
      method: "POST",
      path: `/api/agents/${agent.slug}/run`,
      note: executionNote,
    },
    {
      label: "Agent Card",
      method: "GET",
      path: `/api/agents/${agent.slug}/.well-known/agent-card.json`,
      note: "Capability + identity manifest.",
    },
    {
      label: "x402 Manifest",
      method: "GET",
      path: `/api/agents/${agent.slug}/.well-known/x402`,
      note: "Current preview, payment-enabled, or unavailable state for machine callers.",
    },
    {
      label: "A2A",
      method: "GET",
      path: `/api/agents/${agent.slug}/a2a`,
      note: "A2A 1.0 AgentCard and HTTP+JSON interface root.",
    },
    {
      label: "A2A Send",
      method: "POST",
      path: `/api/agents/${agent.slug}/a2a/message:send`,
      note: `Execute via A2A structured data. ${executionNote}`,
    },
  ];
}

export default async function AgentPage({ params }: PageProps): Promise<React.ReactElement> {
  const { slug } = await params;
  const published = await loadPublicAgent(slug);
  if (!published) notFound();
  const { repo, agent, flow, graph, service, readiness } = published;
  const [
    counts,
    settledCounts,
    lastCalls,
    schedules,
    promoOutput,
    ap2Status,
    relay,
  ] =
    await Promise.all([
      repo.countRunsByAgent([agent.id], "agent"),
      typeof repo.countSettledRunsByAgent === "function"
        ? repo.countSettledRunsByAgent([agent.id])
            .catch((): Record<string, number> => ({}))
        : Promise.resolve<Record<string, number>>({}),
      typeof repo.lastAgentCallAt === "function"
        ? repo.lastAgentCallAt([agent.id], "agent")
            .catch((): Record<string, number> => ({}))
        : Promise.resolve<Record<string, number>>({}),
      repo.listSchedulesByAgents([agent.id]),
      repo.getLastPromoOutput(agent.id),
      publicAp2RuntimeStatus(),
      repo.getRelayEndpoint(agent.id).catch(() => undefined),
    ]);
  const calls = counts[agent.id] ?? 0;
  const settledCalls = settledCounts[agent.id] ?? 0;
  const lastCallAt = lastCalls[agent.id] ?? null;
  const acceptsPayment = readiness.acceptsPayment;
  const publishedLive = readiness.publishedLive;
  const payout = readiness.payout;
  const ap2 = isAp2ServiceEligible({
    priceUsdc: agent.priceUsdc,
    acceptsPayment,
    publishedLive,
    fulfillmentSupportsAp2: relay !== undefined
      && (relay === null || relay.protocolVersion === 2),
  }) ? projectAp2Discovery(ap2Status) : null;
  const isCompanyService = readiness.companyService;
  const companyServiceCallable = isCompanyService && acceptsPayment;
  const schedule = schedules.find((s) => s.enabled) ?? null;
  const nextRunAt = schedule ? nextOccurrence(schedule.cron, Date.now()) : null;
  const name = service.kind === "resource" ? service.name : flow.name;
  const summary = summarizeGraph(graph);
  const curated = service.curated ?? curatedBusinessService(agent.slug, graph);
  const resource = service.resource;
  const endpoints = endpointsFor(agent, readiness.state);
  const shortAddr = (addr: string): string => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const agoLabel = (thenMs: number): string => {
    const minutes = Math.floor(Math.max(0, Date.now() - thenMs) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Derive the example body from the flow's real input node so the try-it box
  // and the copy-paste curl work on the first paste instead of hitting a
  // schema mismatch. Long or empty stored defaults become named placeholders.
  const exampleFieldValue = (key: string, v: unknown): unknown => {
    if (typeof v === "string") {
      return v.length > 0 && v.length <= 60 ? v : `your ${key} here`;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    return `your ${key} here`;
  };
  const inputNode = graph.nodes.find((n) => n.type === "input");
  const storedFields =
    inputNode && typeof inputNode.params.fields === "object" &&
    inputNode.params.fields !== null && !Array.isArray(inputNode.params.fields)
      ? (inputNode.params.fields as Record<string, unknown>)
      : null;
  const exampleInput: Record<string, unknown> = resource
    ? { ...service.exampleInput }
    : curated
    ? { ...curated.exampleInput }
    : storedFields && Object.keys(storedFields).length > 0
      ? Object.fromEntries(
          Object.entries(storedFields).map(([k, v]) => [k, exampleFieldValue(k, v)]),
        )
      : { prompt: "your input here" };
  const exampleJson = JSON.stringify(exampleInput);

  const callBody = JSON.stringify(
    readiness.state === "preview"
      ? { input: exampleInput, dryRun: true }
      : { input: exampleInput },
  );
  const curl = [
    `curl -X POST ${SITE_URL}/api/agents/${agent.slug}/run \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${callBody}'`,
  ].join("\n");

  const inputKeys = Object.keys(exampleInput);
  const priceLabel = agent.priceUsdc === 0 ? "Free" : `$${agent.priceUsdc.toFixed(3)}`;
  // A one-line description the flow's author wrote, when there is one. Never
  // invented here: with no stored description the node chain speaks instead.
  const authored = graph.meta?.description;
  const description = resource?.jobContract.jobStatement ?? curated?.description ??
    (typeof authored === "string" && authored.trim() !== "" ? authored.trim().slice(0, 220) : null);
  const publicOutputSchema = resource?.jobContract.outputSchema ?? curated?.outputSchema;
  const outputKeys = publicOutputSchema?.properties
    ? Object.keys(publicOutputSchema.properties as Readonly<Record<string, unknown>>)
    : [];
  const serviceJsonLd = curated
    ? {
        "@context": "https://schema.org",
        "@type": "Service",
        name,
        description: curated.description,
        url: `${SITE_URL}/a/${agent.slug}`,
        provider: {
          "@type": "Organization",
          name: curated.operator,
          url: SITE_URL,
        },
        serviceType: "Machine-callable business operations service",
        audience: { "@type": "BusinessAudience" },
        ...(readiness.state !== "unavailable"
          ? {
              potentialAction: {
                "@type": "Action",
                target: `${SITE_URL}/api/agents/${agent.slug}/run`,
              },
            }
          : {}),
        additionalProperty: [
          { "@type": "PropertyValue", name: "publicCallState", value: readiness.state },
          { "@type": "PropertyValue", name: "priceUsdc", value: agent.priceUsdc },
          ...(acceptsPayment
            ? [{ "@type": "PropertyValue", name: "paymentRail", value: "x402 v2" }]
            : []),
          ...(ap2
            ? [{
                "@type": "PropertyValue",
                name: "authorizationProfile",
                value: "experimental AP2 v0.2 merchant",
              }]
            : []),
          { "@type": "PropertyValue", name: "inputSchema", value: JSON.stringify(curated.inputSchema) },
          { "@type": "PropertyValue", name: "outputSchema", value: JSON.stringify(curated.outputSchema) },
        ],
      }
    : null;

  return (
    <div className="lp ag-page">
      <StorefrontTools />
      {serviceJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(serviceJsonLd).replace(/</gu, "\\u003c"),
          }}
        />
      )}
      <SiteNav active="/agents" />
      <main id="main-content" className="lp-shell lp-page" style={{ maxWidth: 880 }}>
        <OwnerBar flowId={agent.flowId} />
        <nav className="ag-crumbs" aria-label="Breadcrumb">
          <Link href="/agents">Directory</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{name}</span>
        </nav>

        <header className="lp-page-head" style={{ maxWidth: "none" }}>
          <span className="lp-eyebrow">
            {resource ? "Reviewed Resource Product" : curated ? "Suede-curated business service" : "Suede machine-callable agent"}
          </span>
          <h1>{name}</h1>
          {summary && <p className="ag-chain">{summary}</p>}
          <p className="ag-lede">
            {description ??
              "A live agent endpoint. Send it JSON, it runs the flow, it returns the result. No subscription, no API key, no account."}
          </p>
          <div className="ag-chips">
            <span className={`lp-pill ${agent.status === "live" ? "lp-pill--live" : "lp-pill--draft"}`}>
              {agent.status}
            </span>
            <span className="lp-pill">{readiness.state}</span>
            {schedule && (
              <span className="lp-pill lp-pill--sched tabular" title={`cron: ${schedule.cron}`}>
                runs {describeCron(schedule.cron)}
                {nextRunAt !== null &&
                  ` · next ~${Math.max(1, Math.round((nextRunAt - Date.now()) / 3_600_000))}h`}
              </span>
            )}
            <span className="lp-pill lp-pill--calls tabular">
              {calls === 0
                ? "no calls yet"
                : `${calls} ${calls === 1 ? "call" : "calls"} · ${settledCalls} settled`}
            </span>
            {lastCallAt !== null && (
              <span className="lp-pill tabular">last called {agoLabel(lastCallAt)}</span>
            )}
          </div>
        </header>

        {/* The storefront: price, terms, and the two ways in, above everything
            else on the page. */}
        <section className="ag-buy" aria-labelledby="ag-price-heading">
          <div className="ag-buy-top">
            <div className="ag-price">
              <span id="ag-price-heading" className="ag-price-unit">
                Price
              </span>
              <span className="ag-price-figure tabular" data-numeric>
                {priceLabel}
              </span>
              <span className="ag-price-unit">
                {agent.priceUsdc === 0
                  ? "no configured charge"
                  : acceptsPayment
                    ? "per paid call · USDC"
                    : "configured price · payment not active"}
              </span>
              {isCompanyService && acceptsPayment ? (
                <p className="ag-price-note">
                  <b>Company service.</b> Paid calls only: this agent works for a
                  company and does not expose a free public preview.
                </p>
              ) : readiness.state === "unavailable" ? (
                <p className="ag-price-note">
                  <b>Unavailable.</b> This service currently exposes neither a
                  public preview nor a payment path.
                </p>
              ) : acceptsPayment ? (
                <p className="ag-price-note">
                  <b>Preview or pay.</b> An explicit dry-run needs no wallet;
                  paid calls settle only under the advertised x402 v2 terms.
                </p>
              ) : (
                <p className="ag-price-note">
                  <b>Preview only.</b> An explicit dry-run is available without a
                  wallet; this service does not currently accept payment.
                </p>
              )}
            </div>

            <dl className="ag-facts">
              <div className="ag-fact">
                <dt>Call</dt>
                <dd className="mono">POST /api/agents/{agent.slug}/run</dd>
              </div>
              <div className="ag-fact">
                <dt>Payment</dt>
                <dd>
                  {acceptsPayment
                    ? "x402 v2, exact USDC on Base (eip155:8453)."
                    : readiness.state === "preview"
                      ? "Not enabled; explicit dry-run preview only."
                      : "Unavailable; no payment or public preview."}
                </dd>
              </div>
              {ap2 && (
                <div className="ag-fact">
                  <dt>Authorization</dt>
                  <dd>
                    Experimental AP2 v0.2 merchant profile · {ap2.mode}.
                    x402 v2 remains settlement.
                  </dd>
                </div>
              )}
              <div className="ag-fact">
                <dt>{acceptsPayment ? "Settles to" : "Payout"}</dt>
                {payout.source === "unset" ? (
                  <dd>No valid payout address is connected.</dd>
                ) : (
                  <dd className="mono tabular" title={payout.payTo}>
                    {shortAddr(payout.payTo)}
                    {payout.source === "creator" ? " · the builder" : " · Suede"}
                    {!acceptsPayment && " · configured, inactive"}
                  </dd>
                )}
              </div>
              <div className="ag-fact">
                <dt>Cadence</dt>
                <dd>{schedule ? `Runs ${describeCron(schedule.cron)}, plus on demand.` : "On demand, every call."}</dd>
              </div>
            </dl>
          </div>

          <div className="ag-buy-actions">
            {readiness.previewAvailable && (
              <a href="#try-it" className="lp-btn lp-btn--primary lp-btn--sm">
                Try it free →
              </a>
            )}
            {readiness.state !== "unavailable" && (
              <a href="#call-it" className="lp-btn lp-btn--ghost lp-btn--sm">
                Copy the call
              </a>
            )}
            {readiness.state === "unavailable" ? (
              <p className="ag-posture">
                <b>Public calls unavailable.</b> The machine-readable manifests
                report the same state and omit x402 terms.
              </p>
            ) : !publishedLive ? (
              <p className="ag-posture">
                <b>Dry-run only until republished.</b> No live published version
                backs this agent right now, so calls preview the current draft
                and paid settlement stays off. Once the builder republishes it,
                paid calls resolve an immutable published version.
              </p>
            ) : acceptsPayment ? (
              <p className="ag-posture">
                Paid calls use the immutable Live deployment. The separate preview
                action remains explicit and never moves USDC.
              </p>
            ) : (
              <p className="ag-posture">
                The Live service is previewable, but payment is not ready. Use
                the explicit dry-run body shown below.
              </p>
            )}
          </div>
        </section>

        {promoOutput && (
          <div className="ag-campaign">
            <span aria-hidden="true" style={{ fontSize: "1.1rem", lineHeight: 1, flexShrink: 0 }}>
              🎯
            </span>
            <div className="ag-campaign-body">
              <div className="ag-campaign-eyebrow">Active campaign</div>
              <div className="ag-campaign-name">{promoOutput.name}</div>
              <div className="ag-campaign-sub">Running on Suede Promo</div>
            </div>
            <a
              href={promoOutput.campaignUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="lp-btn lp-btn--ghost lp-btn--sm"
              style={{ flexShrink: 0, borderColor: "color-mix(in srgb, var(--warning-amber) 40%, transparent)" }}
            >
              View campaign →
            </a>
          </div>
        )}

        <section className="lp-block" aria-labelledby="ag-io-heading">
          <h2 id="ag-io-heading" className="lp-eyebrow">
            What it takes, what it returns
          </h2>
          <div className="ag-io">
            <div className="ag-io-card">
              <h3>You send</h3>
              <ul>
                {inputKeys.map((k) => (
                  <li key={k} className="ag-io-key">
                    {k}
                  </li>
                ))}
              </ul>
            </div>
            <div className="ag-io-card">
              <h3>You get back</h3>
              {outputKeys.length > 0 ? (
                <ul>
                  {outputKeys.map((key) => (
                    <li key={key} className="ag-io-key">{key}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  JSON: the flow&apos;s output plus a per-node cost ledger, so you can see
                  exactly what the call did and what it cost.
                </p>
              )}
            </div>
          </div>
          {curated && (
            <div className="ag-posture">
              <p><b>Decision boundary.</b> {curated.reviewPolicy}</p>
              <p><b>Data handling.</b> {curated.dataHandling}</p>
            </div>
          )}
          {resource && (
            <div className="ag-posture" data-resource-contract={resource.extensionUri}>
              <p><b>Reviewed job.</b> {resource.jobContract.jobStatement}</p>
              <p><b>Freshness.</b> {resource.freshness}. <b>Access.</b> {resource.access.execution}; {resource.access.discovery} discovery.</p>
              <p><b>Sources.</b> {resource.sourceDisclosure.sourceCount} reviewed source{resource.sourceDisclosure.sourceCount === 1 ? "" : "s"} across {resource.sourceDisclosure.sourceKinds.join(", ") || "no declared kinds"}.</p>
              <p><b>Evidence policy.</b> {resource.evidencePolicy}</p>
              <p><b>Review boundary.</b> {resource.reviewBoundary}</p>
              <p><b>Safe result example.</b> <code>{JSON.stringify(resource.jobContract.safeExample)}</code></p>
              <p className="mono">Pack {resource.resourceVersion} · {resource.semanticHash}</p>
            </div>
          )}
        </section>

        {/* Only the shared readiness resolver may authorize the Try-it path. */}
        {!readiness.previewAvailable ? (
          <section className="lp-block" id="try-it" aria-labelledby="ag-try-heading">
            <h2 id="ag-try-heading" className="lp-eyebrow">
              {isCompanyService ? "Company service" : "Service unavailable"}
            </h2>
            <div className="lp-empty">
              <b>{companyServiceCallable ? "Paid calls only." : "Public calls unavailable."}</b>
              {companyServiceCallable
                ? " This agent works for a company, so there is no free public preview. Call the run endpoint with x402 payment and it executes for real."
                : " This service currently exposes neither a public preview nor payment. Check its machine-readable manifest for current state."}
            </div>
          </section>
        ) : (
          <section className="lp-block" id="try-it" aria-labelledby="ag-try-heading">
            <h2 id="ag-try-heading" className="lp-eyebrow">
              Try it before you pay
            </h2>
            <TryIt agentId={agent.slug} defaultInput={exampleJson} />
          </section>
        )}

        {readiness.state !== "unavailable" && (
          <section className="lp-block" id="call-it" aria-labelledby="ag-call-heading">
            <h2 id="ag-call-heading" className="lp-eyebrow">
              Call it from anywhere
            </h2>
            <CopyBlock code={curl} />
          </section>
        )}

        {acceptsPayment && (
          <section className="lp-block" id="pay-402" aria-labelledby="ag-402-heading">
            <h2 id="ag-402-heading" className="lp-eyebrow">
              Paying for a call: the 402 flow
            </h2>
            <p>
              Call the run endpoint without payment and it answers{" "}
              <code>HTTP 402</code> with this agent&apos;s exact x402 terms: the
              price, the USDC asset on Base, and the address it settles to. Your
              x402 client signs a payment authorization from those terms, then
              retries the same request with a <code>PAYMENT-SIGNATURE</code> header. No
              account, no API key. The full request shape is in{" "}
              <Link href="/docs/api">the API docs</Link> and the payment
              handshake is in <Link href="/docs/payments">the payments docs</Link>.
            </p>
            <CopyBlock
              code={[
                `# 1. Ask for the terms: an unpaid call answers HTTP 402 with x402 terms.`,
                `curl -i -X POST ${SITE_URL}/api/agents/${agent.slug}/run \\`,
                `  -H 'content-type: application/json' \\`,
                `  -d '{ "input": ${exampleJson} }'`,
                ``,
                `# 2. Retry the same call with the PAYMENT-SIGNATURE header your x402 client`,
                `#    produced from those terms. The run executes and settles.`,
                `curl -X POST ${SITE_URL}/api/agents/${agent.slug}/run \\`,
                `  -H 'content-type: application/json' \\`,
                `  -H "PAYMENT-SIGNATURE: $X402_PAYMENT_PAYLOAD" \\`,
                `  -d '{ "input": ${exampleJson} }'`,
              ].join("\n")}
            />
          </section>
        )}

        {ap2 && (
          <section className="lp-block" id="ap2" aria-labelledby="ag-ap2-heading">
            <h2 id="ag-ap2-heading" className="lp-eyebrow">
              Experimental AP2 merchant authorization
            </h2>
            <p>
              This service advertises the experimental AP2 v0.2 merchant
              profile at{" "}
              <code>{ap2.extensionUri}</code>. Negotiate it with{" "}
              <code>A2A-Extensions</code>;{" "}
              <code>X-A2A-Extensions</code> remains a temporary
              sample-client compatibility spelling. The current mode is{" "}
              <code>{ap2.mode}</code>
              {ap2.mode === "required"
                ? ", so priced Live calls require valid mandates before settlement or execution."
                : ", so callers may omit AP2, but a presented invalid authorization never downgrades."}
            </p>
            <p className="ag-posture">
              This is a merchant authorization and Checkout Receipt profile,
              not a credentials-provider or payment-processor claim. x402 v2
              remains the settlement rail and settlement source of truth.
            </p>
          </section>
        )}

        <section className="lp-block" aria-labelledby="ag-endpoints-heading">
          <h2 id="ag-endpoints-heading" className="lp-eyebrow">
            Published endpoints
          </h2>
          <div className="lp-rows">
            {endpoints.map((ep) => (
              <div key={ep.path} className="lp-row" style={{ cursor: "default" }}>
                <span className="lp-pill">{ep.method}</span>
                <div className="grow">
                  <div className="name mono" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
                    {ep.path}
                  </div>
                  <div className="sub">
                    {ep.label} · {ep.note}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="ag-footnav">
          <Link href="/start" className="lp-btn lp-btn--primary lp-btn--sm">
            Build your own →
          </Link>
          <Link href="/agents" className="lp-btn lp-btn--ghost lp-btn--sm">
            ← Back to the directory
          </Link>
        </div>

        <section className="ag-safety" aria-labelledby="agent-safety-heading">
          <h2 id="agent-safety-heading" className="lp-eyebrow">
            Safety
          </h2>
          <p>Report unsafe behavior to Suede moderation, or hide this agent from your directory.</p>
          <AgentSafetyActions agentId={agent.id} />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
