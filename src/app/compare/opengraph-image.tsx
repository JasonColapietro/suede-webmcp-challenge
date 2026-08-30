/**
 * Compare OG card, covering /compare/* alternative pages. Leads with the
 * category's verified differentiator: eligible published services can enable
 * caller-paid x402 settlement separately. Shares src/lib/og/shared.tsx.
 */
import { ImageResponse } from "next/og";
import {
  OG_CANVAS,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_INK,
  OG_MUTED,
  OG_PRIMARY,
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
  "Suede Agent Studio compared with Gumloop, n8n, Zapier and other flow builders: published agents can separately enable x402 payments.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const ROWS: { label: string; suede: string; others: string }[] = [
  { label: "Visual canvas", suede: "Yes", others: "Yes" },
  { label: "Caller payment opt-in", suede: "Eligible", others: "Not native" },
  { label: "USDC settlement", suede: "When enabled", others: "None" },
];

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="COMPARE"
        accent={OG_PRIMARY}
        chips={[
          { label: "CANVAS FOR CANVAS", color: OG_MUTED },
          { label: "PRICE FOR PRICE", color: OG_PRIMARY },
          { label: "X402 WHEN ENABLED", color: OG_EMERALD },
        ]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 40, width: "100%" }}>
          <OgHeadline
            accent={OG_PRIMARY}
            eyebrow="Head to head"
            title="Run flows. Enable caller payments when ready."
            sub="Suede Agent Studio beside Gumloop, n8n, Zapier, Lindy and the rest: canvas for canvas, public state for public state."
            titleSize={54}
            maxWidth={560}
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
              padding: "22px 24px",
            }}
          >
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ display: "flex", width: 190 }} />
              <div
                style={{
                  display: "flex",
                  width: 120,
                  fontFamily: FONT_SANS,
                  fontSize: 15,
                  fontWeight: 700,
                  color: OG_PRIMARY,
                  letterSpacing: 1,
                }}
              >
                SUEDE
              </div>
              <div
                style={{
                  display: "flex",
                  flex: 1,
                  fontFamily: FONT_SANS,
                  fontSize: 15,
                  fontWeight: 700,
                  color: OG_MUTED,
                  letterSpacing: 1,
                }}
              >
                THE REST
              </div>
            </div>
            {ROWS.map((row) => (
              <div
                key={row.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "#ffffff",
                  border: `2px solid ${OG_HAIRLINE}`,
                  borderRadius: 12,
                  padding: "12px 14px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    width: 180,
                    fontFamily: FONT_SANS,
                    fontSize: 16,
                    fontWeight: 500,
                    color: OG_INK,
                  }}
                >
                  {row.label}
                </div>
                <div
                  style={{
                    display: "flex",
                    width: 120,
                    fontFamily: FONT_SANS,
                    fontSize: 16,
                    fontWeight: 700,
                    color: OG_EMERALD,
                  }}
                >
                  {row.suede}
                </div>
                <div
                  style={{
                    display: "flex",
                    flex: 1,
                    fontFamily: FONT_SANS,
                    fontSize: 16,
                    color: OG_MUTED,
                  }}
                >
                  {row.others}
                </div>
              </div>
            ))}
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
