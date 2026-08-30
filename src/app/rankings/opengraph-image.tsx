/**
 * Rankings OG card, covering /rankings/* list pages. Editorial ranked-list
 * framing with a podium strip. Shares src/lib/og/shared.tsx.
 */
import { ImageResponse } from "next/og";
import {
  OG_AMBER,
  OG_CANVAS,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_INK,
  OG_MUTED,
  OG_PRIMARY,
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

export const alt =
  "Suede Agent Studio rankings: the best AI agent builders, scored on canvas depth, agent rails, pricing, and native earnings.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const CRITERIA = ["Canvas depth", "Agent rails", "Pricing", "Native earnings"];

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="RANKINGS"
        accent={OG_AMBER}
        chips={[
          { label: "SCORED", color: OG_AMBER },
          { label: "COMPARED", color: OG_MUTED },
          { label: "UPDATED", color: OG_PRIMARY },
        ]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 44, width: "100%" }}>
          <OgHeadline
            accent={OG_AMBER}
            eyebrow="The shortlist"
            title="The best AI agent builders, ranked."
            sub="Every serious canvas in the category, scored on what a working agent company actually needs."
            titleSize={58}
            maxWidth={600}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 12,
              flex: 1,
              alignSelf: "stretch",
              margin: "16px 0",
              backgroundColor: OG_CANVAS,
              border: `2px solid ${OG_HAIRLINE}`,
              borderRadius: 22,
              padding: "24px 26px",
            }}
          >
            {CRITERIA.map((criterion, i) => (
              <div key={criterion} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    background: tint(OG_AMBER, "24"),
                    fontFamily: FONT_SERIF,
                    fontSize: 25,
                    color: OG_AMBER,
                    flexShrink: 0,
                  }}
                >
                  {/* String() child: Satori's renderer can crash on raw number children. */}
                  {String(i + 1)}
                </div>
                <div
                  style={{
                    display: "flex",
                    flex: 1,
                    background: "#ffffff",
                    border: `2px solid ${OG_HAIRLINE}`,
                    borderRadius: 12,
                    padding: "11px 16px",
                    fontFamily: FONT_SANS,
                    fontSize: 19,
                    fontWeight: 500,
                    color: OG_INK,
                  }}
                >
                  {criterion}
                </div>
                {i === 3 ? (
                  <div
                    style={{
                      display: "flex",
                      fontFamily: FONT_SANS,
                      fontSize: 14,
                      fontWeight: 700,
                      color: OG_EMERALD,
                      letterSpacing: 1,
                    }}
                  >
                    THE TIEBREAK
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
