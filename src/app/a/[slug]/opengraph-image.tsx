/** Per-agent OG card — published name and current public call state. */
import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { getRepo } from "@/lib/db/repo";
import { BRAND_HAIRLINE, BRAND_INK, BRAND_MUTED, BRAND_PRIMARY, BRAND_WHITE } from "@/lib/brand-colors";
import { getProjectRepo } from "@/lib/projects/provider";
import { resolvePublicServiceContract } from "@/lib/public-service-contract";
import { resolvePublicPaymentReadiness } from "@/lib/public-payment-readiness";

export const runtime = "nodejs";
export const alt = "Suede published agent with its current public call and payment state";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INDIGO = BRAND_PRIMARY;
// EMERALD is agent-status specific (not shared across the other OG/icon
// files), so it stays local rather than moving to brand-colors.ts.
const EMERALD = "#10b981";
const INK = BRAND_INK;
const MUTED = BRAND_MUTED;
const HAIRLINE = BRAND_HAIRLINE;

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function AgentOgImage({ params }: Props): Promise<ImageResponse> {
  const { slug } = await params;
  const repo = await getRepo().catch(() => notFound());
  const agent = await repo.getAgentBySlug(slug).catch(() => null);
  if (agent?.status !== "live") notFound();

  const flow = await repo.getFlow(agent.flowId).catch(() => null);
  if (!flow) notFound();

  const projectRepo = await getProjectRepo().catch(() => null);
  const activeDeployment = projectRepo
    ? await projectRepo.getActiveDeployment({
        flowId: flow.id,
        ownerId: flow.ownerId,
        environmentKind: "live",
      }).catch(() => null)
    : null;
  const service = await resolvePublicServiceContract({ flow, agent, projectRepo, activeDeployment });
  if (!service || service.resource?.access.execution === "private") notFound();
  const publishedGraph = service?.graph;
  if (!publishedGraph) notFound();

  const readiness = await resolvePublicPaymentReadiness({
    agent,
    flow,
    repo,
    publishedGraph: service.graph,
    liveExecutionReady: activeDeployment !== null,
  });

  const name = service.kind === "resource" ? service.name : flow.name ?? agent.slug;
  let stateLabel = "UNAVAILABLE";
  let price = "Public calls unavailable";
  let settlement = "No public call path";
  let stateColor = MUTED;
  if (readiness.state === "payment-enabled") {
    stateLabel = "PAYMENT ENABLED";
    price = `$${agent.priceUsdc.toFixed(3)} per paid call`;
    settlement = "x402 v2 · USDC on Base";
    stateColor = EMERALD;
  } else if (readiness.state === "preview") {
    stateLabel = "PREVIEW";
    price = "Free dry-run preview";
    settlement = "No payment accepted";
    stateColor = INDIGO;
  }
  const counts: Record<string, number> = await repo
    .countRunsByAgent([agent.id], "agent")
    .catch(() => ({}));
  const calls = counts[agent.id] ?? 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BRAND_WHITE,
          padding: 72,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 30, color: INK, fontWeight: 700 }}>Suede Agent Studio</div>
          <div
            style={{
              fontSize: 17,
              color: stateColor,
              border: `2px solid ${stateColor}55`,
              borderRadius: 999,
              padding: "4px 14px",
              letterSpacing: 3,
            }}
          >
            {stateLabel}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              fontSize: 70,
              color: INK,
              fontWeight: 700,
              lineHeight: 1.06,
              maxWidth: 1000,
            }}
          >
            {name}
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <div
              style={{
                fontSize: 26,
                color: stateColor,
                border: `2px solid ${stateColor}55`,
                borderRadius: 999,
                padding: "8px 22px",
              }}
            >
              {price}
            </div>
            {calls > 0 && (
              <div
                style={{
                  fontSize: 26,
                  color: INK,
                  border: `2px solid ${HAIRLINE}`,
                  borderRadius: 999,
                  padding: "8px 22px",
                }}
              >
                {`${calls} ${calls === 1 ? "call" : "calls"} served`}
              </div>
            )}
            <div
              style={{
                fontSize: 26,
                color: INDIGO,
                border: `2px solid ${HAIRLINE}`,
                borderRadius: 999,
                padding: "8px 22px",
              }}
            >
              {settlement}
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `2px solid ${HAIRLINE}`,
            paddingTop: 28,
          }}
        >
          <div style={{ fontSize: 24, color: MUTED, letterSpacing: 2 }}>
            {`agents.suedeai.ai/a/${slug}`}
          </div>
          <div style={{ fontSize: 24, color: MUTED }}>State reported by public discovery</div>
        </div>
      </div>
    ),
    size,
  );
}
