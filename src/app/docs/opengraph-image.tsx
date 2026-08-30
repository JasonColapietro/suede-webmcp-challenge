/**
 * Docs OG card: the four architecture units (Canvas, Flow Contract, Engine,
 * Runtime) as a connected pipeline, matching the architecture described in
 * AGENTS.md and /docs/architecture. Shares src/lib/og/shared.tsx.
 */
import { ImageResponse } from "next/og";
import {
  OG_CANVAS,
  OG_DOCS_BLUE,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_INK,
  OG_MUTED,
  OG_PRIMARY,
  OG_WHITE,
} from "@/lib/og/palette";
import {
  FONT_SANS,
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgFrame,
  OgHeadline,
  loadOgFonts,
  tint,
} from "@/lib/og/shared";

export const alt =
  "Suede Agent Studio docs: canvas, flow contract, engine, and runtime. Build on the canvas or write TypeScript, then publish a paid agent.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const UNITS: { step: string; name: string; detail: string }[] = [
  { step: "01", name: "Canvas", detail: "wire the graph" },
  { step: "02", name: "Flow Contract", detail: "one typed FlowGraph" },
  { step: "03", name: "Engine", detail: "topological runs" },
  { step: "04", name: "Runtime", detail: "paid x402 endpoints" },
];

function UnitBlock({ unit }: { unit: (typeof UNITS)[number] }): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        background: OG_WHITE,
        border: `2px solid ${OG_HAIRLINE}`,
        borderRadius: 16,
        padding: "16px 20px",
        width: 236,
        /* Mirrors tokens.css --shadow-card. */
        boxShadow: "0 1px 3px rgba(17, 19, 23, 0.08), 0 6px 18px rgba(17, 19, 23, 0.06)",
      }}
    >
      <div
        style={{
          fontFamily: FONT_SANS,
          fontSize: 15,
          fontWeight: 700,
          color: OG_DOCS_BLUE,
          letterSpacing: 2,
        }}
      >
        {unit.step}
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: 23, fontWeight: 700, color: OG_INK, whiteSpace: "nowrap" }}>
        {unit.name}
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: 16, color: OG_MUTED, whiteSpace: "nowrap" }}>
        {unit.detail}
      </div>
    </div>
  );
}

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="DOCS"
        accent={OG_DOCS_BLUE}
        chips={[
          { label: "CANVAS OR CODE", color: OG_DOCS_BLUE },
          { label: "TYPESCRIPT SDK", color: OG_PRIMARY },
          { label: "x402", color: OG_EMERALD },
        ]}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 34,
            width: "100%",
          }}
        >
          <OgHeadline
            accent={OG_DOCS_BLUE}
            eyebrow="Documentation"
            title="From canvas to paid endpoint."
            sub="Build on the canvas or write TypeScript with @suedeai/agents. Four units, one studio, documented end to end."
            titleSize={56}
            maxWidth={900}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: OG_CANVAS,
              border: `2px solid ${OG_HAIRLINE}`,
              borderRadius: 20,
              padding: "20px 22px",
              alignSelf: "flex-start",
            }}
          >
            {UNITS.map((unit, i) => (
              <div key={unit.step} style={{ display: "flex", alignItems: "center" }}>
                {i > 0 ? (
                  <div style={{ width: 22, height: 2, background: tint(OG_DOCS_BLUE, "66") }} />
                ) : null}
                <UnitBlock unit={unit} />
              </div>
            ))}
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
