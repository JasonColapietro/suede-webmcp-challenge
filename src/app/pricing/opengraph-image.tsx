/**
 * Pricing OG card: the payout promise, stated as an equation. What the caller
 * pays is what the wallet receives; launch and dry-run stay free. Copy keeps
 * to the pricing page's payout-first rule. Shares src/lib/og/shared.tsx.
 */
import { ImageResponse } from "next/og";
import {
  OG_CANVAS,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_INK,
  OG_MUTED,
  OG_PRIMARY,
  OG_WHITE,
} from "@/lib/og/palette";
import {
  FONT_SANS,
  FONT_SERIF,
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgFrame,
  loadOgFonts,
  tint,
} from "@/lib/og/shared";

export const alt =
  "Suede Agent Studio pricing: a $0.010 call pays $0.010 to your wallet. Launch is free, dry-run is free, and priced calls settle in USDC on Base.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

function EquationCard({ label, value, accent }: { label: string; value: string; accent: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        background: OG_WHITE,
        border: `2px solid ${OG_HAIRLINE}`,
        borderRadius: 20,
        padding: "26px 44px",
        /* Mirrors tokens.css --shadow-card. */
        boxShadow: "0 1px 3px rgba(17, 19, 23, 0.08), 0 6px 18px rgba(17, 19, 23, 0.06)",
      }}
    >
      <div
        style={{
          fontFamily: FONT_SANS,
          fontSize: 17,
          fontWeight: 700,
          color: OG_MUTED,
          letterSpacing: 3,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: FONT_SERIF, fontSize: 76, color: accent, lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="PRICING"
        accent={OG_EMERALD}
        chips={[
          { label: "LAUNCH FREE", color: OG_PRIMARY },
          { label: "DRY-RUN FREE", color: OG_MUTED },
          { label: "USDC ON BASE", color: OG_EMERALD },
        ]}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 30,
            width: "100%",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                fontFamily: FONT_SANS,
                fontSize: 19,
                fontWeight: 700,
                color: OG_EMERALD,
                letterSpacing: 4,
              }}
            >
              THE PAYOUT PROMISE
            </div>
            <div
              style={{
                fontFamily: FONT_SERIF,
                fontSize: 58,
                color: OG_INK,
                letterSpacing: -1,
                textAlign: "center",
              }}
            >
              The price you set is the price you keep.
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 26,
              backgroundColor: OG_CANVAS,
              border: `2px solid ${OG_HAIRLINE}`,
              borderRadius: 24,
              padding: "24px 40px",
            }}
          >
            <EquationCard label="CALLER PAYS" value="$0.010" accent={OG_INK} />
            <div style={{ fontFamily: FONT_SERIF, fontSize: 64, color: tint(OG_INK, "8c") }}>=</div>
            <EquationCard label="YOUR WALLET GETS" value="$0.010" accent={OG_EMERALD} />
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
