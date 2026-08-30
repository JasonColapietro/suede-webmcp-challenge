/**
 * Company OG card: founding framing with a compact org glyph (CEO seat over
 * two department heads) so a shared dashboard link still shows the product.
 * Shares src/lib/og/shared.tsx.
 */
import { ImageResponse } from "next/og";
import {
  OG_CANVAS,
  OG_CYAN,
  OG_EDGE,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_MUTED,
  OG_PRIMARY,
} from "@/lib/og/palette";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgFrame,
  OgHeadline,
  OgSeat,
  loadOgFonts,
  type OgSeatData,
} from "@/lib/og/shared";

export const alt =
  "Suede Agent Studio Company: direct the CEO, run the agent org, and review governance evidence.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const CEO: OgSeatData = { role: "CEO", agent: "Claude", accent: OG_PRIMARY };
const HEADS: OgSeatData[] = [
  { role: "CMO", agent: "Gemini", accent: OG_CYAN, live: true, price: "$0.008" },
  { role: "CFO", agent: "Pi", accent: OG_EMERALD, live: true, price: "$0.012" },
];

const SEAT_W = 200;
const GAP = 20;

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="COMPANY"
        accent={OG_PRIMARY}
        chips={[
          { label: "DEPARTMENTS", color: OG_PRIMARY },
          { label: "GOVERNANCE", color: OG_MUTED },
          { label: "BOOKS", color: OG_EMERALD },
        ]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 32, width: "100%" }}>
          <OgHeadline
            accent={OG_PRIMARY}
            eyebrow="Founder command"
            title="Direct the CEO. Run the org."
            sub="Build the team, delegate work, and keep budgets, approvals, and activity visible."
            titleSize={58}
            maxWidth={560}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              alignSelf: "stretch",
              margin: "16px 0",
              backgroundColor: OG_CANVAS,
              border: `2px solid ${OG_HAIRLINE}`,
              borderRadius: 22,
              padding: 20,
            }}
          >
            <OgSeat seat={CEO} width={SEAT_W} compact />
            <div style={{ width: 2, height: 16, background: OG_EDGE }} />
            <div
              style={{
                width: SEAT_W + GAP,
                height: 16,
                borderTop: `2px solid ${OG_EDGE}`,
                borderLeft: `2px solid ${OG_EDGE}`,
                borderRight: `2px solid ${OG_EDGE}`,
                borderTopLeftRadius: 10,
                borderTopRightRadius: 10,
              }}
            />
            <div style={{ display: "flex", gap: GAP }}>
              {HEADS.map((seat) => (
                <OgSeat key={seat.role} seat={seat} width={SEAT_W} compact />
              ))}
            </div>
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
