/**
 * Templates OG card: the catalog stat (computed from the same public seed
 * list the page renders, so the number can never drift) plus a strip of
 * template chips in their category accents. Shares the OG frame system in
 * src/lib/og/shared.tsx.
 */
import { ImageResponse } from "next/og";
import { SEED_TEMPLATES } from "@/lib/templates";
import { isPublicTemplateMarketingAllowed } from "@/lib/marketing-holds";
import {
  OG_AMBER,
  OG_CANVAS,
  OG_CYAN,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_INK,
  OG_MUTED,
  OG_PRIMARY,
  OG_VIOLET,
} from "@/lib/og/palette";
import {
  FONT_SANS,
  FONT_SERIF,
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgFrame,
  OgHeadline,
  loadOgFonts,
  tint,
} from "@/lib/og/shared";

const TEMPLATE_COUNT = SEED_TEMPLATES.filter((t) =>
  isPublicTemplateMarketingAllowed(t.slug),
).length;

export const alt = `Suede Agent Studio templates: ${TEMPLATE_COUNT} ready-to-build agent templates. Publish one with an explicit public call state.`;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/** A few flagship templates, colored by their department accents. */
const CHIPS: { label: string; accent: string }[] = [
  { label: "Lead Qualifier", accent: OG_CYAN },
  { label: "Invoice Chaser", accent: OG_EMERALD },
  { label: "Competitor Tracker", accent: OG_VIOLET },
  { label: "Review Responder", accent: OG_AMBER },
  { label: "Meeting Prep", accent: OG_PRIMARY },
];

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="TEMPLATES"
        accent={OG_PRIMARY}
        chips={[
          { label: "OPEN IN STUDIO", color: OG_PRIMARY },
          { label: "PUBLISH STATE", color: OG_EMERALD },
          { label: "X402 WHEN READY", color: OG_MUTED },
        ]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 44, width: "100%" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 28, flex: 1 }}>
            <OgHeadline
              accent={OG_PRIMARY}
              title="A small business in every template."
              sub="Score leads, chase invoices, track competitors. Open one in the studio, publish its state, and enable x402 separately when eligible."
              titleSize={60}
              maxWidth={620}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: 620 }}>
              {CHIPS.map((chip) => (
                <div
                  key={chip.label}
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
                    background: "#ffffff",
                  }}
                >
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: chip.accent,
                    }}
                  />
                  {chip.label}
                </div>
              ))}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: 330,
              alignSelf: "stretch",
              margin: "16px 0",
              backgroundColor: OG_CANVAS,
              border: `2px solid ${OG_HAIRLINE}`,
              borderRadius: 22,
              gap: 2,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontFamily: FONT_SERIF,
                fontSize: 168,
                color: OG_PRIMARY,
                lineHeight: 1,
              }}
            >
              {/* String() child: Satori's renderer can crash on raw number children. */}
              {String(TEMPLATE_COUNT)}
            </div>
            <div
              style={{
                fontFamily: FONT_SANS,
                fontSize: 21,
                fontWeight: 500,
                color: OG_MUTED,
                letterSpacing: 3,
              }}
            >
              TEMPLATES
            </div>
            <div
              style={{
                fontFamily: FONT_SANS,
                fontSize: 17,
                color: tint(OG_INK, "99"),
                marginTop: 6,
              }}
            >
              ready to build
            </div>
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
