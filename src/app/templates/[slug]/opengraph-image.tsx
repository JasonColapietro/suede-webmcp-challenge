/**
 * Per-template OG card for the derived /templates/[slug] detail pages: the
 * template's name, its price-free pitch, and the exact wired flow as chips
 * colored by node group, all derived from the seed graph via
 * getTemplateDetail. Shares the OG frame system in src/lib/og/shared.tsx.
 */
import { ImageResponse } from "next/og";
import { getTemplateDetail } from "@/lib/template-summaries";
import {
  OG_AMBER,
  OG_CYAN,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_INK,
  OG_MUTED,
  OG_PRIMARY,
  OG_VIOLET,
  OG_WHITE,
} from "@/lib/og/palette";
import {
  FONT_SANS,
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgFrame,
  OgHeadline,
  loadOgFonts,
} from "@/lib/og/shared";

export const alt =
  "Suede Agent Studio template: a wired agent flow, priced and ready to launch.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Node-group accents, mirroring GROUP_COLORS in src/lib/template-summaries.ts
 * (Satori cannot read CSS custom properties, so the token vars map to the
 * hand-mirrored hex constants in src/lib/og/palette.ts).
 */
const GROUP_HEX: Record<string, string> = {
  Triggers: OG_VIOLET,
  "I/O": OG_MUTED,
  "Music & IP": OG_CYAN,
  "Docs & Data": OG_CYAN,
  "Comms & CRM": OG_EMERALD,
  "Finance & Ops": OG_AMBER,
  "Dev & Infra": OG_VIOLET,
  AI: OG_PRIMARY,
  Rails: OG_EMERALD,
  Logic: OG_AMBER,
};

/** Keep the sub line inside the card; pitches are one sentence but vary. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export default async function TemplateOgImage({ params }: Props): Promise<ImageResponse> {
  const { slug } = await params;
  const detail = getTemplateDetail(slug);
  const fonts = await loadOgFonts();
  const name = detail?.name ?? "Agent template";
  const pitch = detail
    ? clip(detail.pitchProse, 150)
    : "A wired agent flow, priced and ready to launch.";
  const steps = detail?.steps ?? [];
  const priceChip = detail
    ? `$${detail.priceUsdc.toFixed(2)} / ${(detail.unit ?? "call").toUpperCase()}`
    : "SET YOUR PRICE";
  const cadenceChip = detail?.cadence
    ? `RUNS ${detail.cadence.toUpperCase()}`
    : "ON DEMAND";
  const eyebrow = detail
    ? (detail.department ?? detail.category)
    : "template";

  return new ImageResponse(
    (
      <OgFrame
        badge="TEMPLATE"
        accent={OG_PRIMARY}
        chips={[
          { label: priceChip, color: OG_EMERALD },
          { label: cadenceChip, color: OG_MUTED },
          { label: "OPEN IN STUDIO", color: OG_PRIMARY },
        ]}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 36,
            width: "100%",
          }}
        >
          <OgHeadline
            eyebrow={`${eyebrow} template`}
            accent={OG_PRIMARY}
            title={name}
            sub={pitch}
            titleSize={64}
            maxWidth={1020}
          />
          {steps.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
                width: 1040,
              }}
            >
              {steps.map((step, i) => (
                <div
                  key={`${step.label}-${String(i)}`}
                  style={{ display: "flex", alignItems: "center", gap: 10 }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      fontFamily: FONT_SANS,
                      fontSize: 19,
                      fontWeight: 500,
                      color: OG_INK,
                      border: `2px solid ${OG_HAIRLINE}`,
                      borderRadius: 999,
                      padding: "8px 18px",
                      background: OG_WHITE,
                    }}
                  >
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: GROUP_HEX[step.group ?? ""] ?? OG_MUTED,
                      }}
                    />
                    {step.label}
                  </div>
                  {i < steps.length - 1 ? (
                    <div style={{ fontFamily: FONT_SANS, fontSize: 20, color: OG_MUTED }}>
                      ›
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
