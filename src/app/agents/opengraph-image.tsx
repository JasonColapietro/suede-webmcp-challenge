/**
 * Agent directory OG card: directory framing with a short stack of published
 * seat cards (same anatomy as the landing org chart). The three illustrative
 * rows mirror the directory's explicit public call states.
 */
import { ImageResponse } from "next/og";
import { OG_AMBER, OG_CANVAS, OG_CYAN, OG_EMERALD, OG_HAIRLINE, OG_PRIMARY, OG_VIOLET } from "@/lib/og/palette";
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
  "Suede Agent Studio directory of published agents with preview, payment-enabled, or unavailable public call state.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const SEATS: OgSeatData[] = [
  { role: "Lead Scorer", agent: "Preview", accent: OG_CYAN, live: true },
  { role: "Frontend Eng", agent: "Payment enabled", accent: OG_VIOLET, live: true, price: "$0.005" },
  { role: "Support Triage", agent: "Unavailable", accent: OG_AMBER },
];

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="DIRECTORY"
        accent={OG_CYAN}
        chips={[
          { label: "STATE EXPLICIT", color: OG_CYAN },
          { label: "X402 WHEN ENABLED", color: OG_PRIMARY },
          { label: "A2A 1.0", color: OG_EMERALD },
        ]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 40, width: "100%" }}>
          <OgHeadline
            accent={OG_CYAN}
            eyebrow="The agent directory"
            title="Hire a seat, not a subscription."
            sub="Inspect every published service's current state. Preview-ready agents can dry-run; payment-enabled agents publish x402 terms."
            titleSize={58}
            maxWidth={600}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              flex: 1,
              alignSelf: "stretch",
              margin: "16px 0",
              backgroundColor: OG_CANVAS,
              border: `2px solid ${OG_HAIRLINE}`,
              borderRadius: 22,
              padding: 22,
            }}
          >
            {SEATS.map((seat) => (
              <OgSeat key={seat.role} seat={seat} width={300} />
            ))}
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
