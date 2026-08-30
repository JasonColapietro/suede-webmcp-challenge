/**
 * Landing OG card: the product itself in miniature. A bright editorial frame
 * with the org chart of agents (CEO seat, two departments, live dots, USDC
 * per-call price chips, elbow connectors) on a dotted canvas pane, so a pasted
 * link shows the same company-of-agents the homepage hero does. Seat casting
 * mirrors ORG_BRANCHES in src/components/landing/AgentOrgCard.tsx.
 */
import { ImageResponse } from "next/og";
import {
  OG_CANVAS,
  OG_CYAN,
  OG_EDGE,
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
  OgSeat,
  loadOgFonts,
  type OgSeatData,
} from "@/lib/og/shared";

export const alt =
  "Suede Agent Studio: an org chart of AI agents. A CEO seat leads Growth and Finance departments; live seats earn per call in USDC.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/** Pruned casting from the landing hero org chart (AgentOrgCard.tsx). */
const CEO: OgSeatData = { role: "CEO", agent: "Claude", accent: OG_PRIMARY };

interface OgDept {
  head: OgSeatData;
  reports: OgSeatData[];
  /** Absolute spine height so the elbow rail stops at the last tick. */
  spineHeight: number;
}

const DEPTS: OgDept[] = [
  {
    head: { role: "CMO", agent: "Gemini", accent: OG_CYAN, live: true, price: "$0.008" },
    reports: [
      { role: "Lead Scorer", agent: "Claude", accent: OG_CYAN, live: true, price: "$0.004" },
      { role: "Outreach Writer", agent: "Pi", accent: OG_CYAN, schedule: "daily 9:07a" },
    ],
    spineHeight: 113,
  },
  {
    head: { role: "CFO", agent: "Pi", accent: OG_EMERALD, live: true, price: "$0.012" },
    reports: [
      { role: "Invoice Chaser", agent: "Gemini", accent: OG_EMERALD, schedule: "daily 8:00a" },
    ],
    spineHeight: 41,
  },
];

const SEAT_W = 262;
const REPORT_W = 244;
const DEPT_GAP = 24;
/** Center-to-center distance between the two department columns. */
const RAIL_W = SEAT_W + DEPT_GAP;

function DeptColumn({ dept }: { dept: OgDept }): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: SEAT_W }}>
      <OgSeat seat={dept.head} width={SEAT_W} compact />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "relative",
          marginLeft: 20,
          paddingTop: 10,
          gap: 10,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 2,
            height: dept.spineHeight,
            background: OG_EDGE,
          }}
        />
        {dept.reports.map((report) => (
          <div key={report.role} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ width: 12, height: 2, background: OG_EDGE }} />
            <OgSeat seat={report} width={REPORT_W} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function OpengraphImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    (
      <OgFrame
        badge="STUDIO"
        accent={OG_PRIMARY}
        chips={[
          { label: "PAY-PER-CALL", color: OG_PRIMARY },
          { label: "USDC ON BASE", color: OG_EMERALD },
          { label: "24/7", color: OG_MUTED },
        ]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28, width: "100%" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 18,
              width: 428,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontFamily: FONT_SERIF,
                fontSize: 62,
                color: OG_INK,
                lineHeight: 1.05,
                letterSpacing: -1,
              }}
            >
              Agents that earn, not just run.
            </div>
            <div style={{ fontFamily: FONT_SANS, fontSize: 23, color: OG_MUTED, lineHeight: 1.42 }}>
              Wire a company of agents on one canvas. Every seat is a paid
              endpoint that settles USDC to your wallet.
            </div>
          </div>
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
              backgroundImage: `radial-gradient(circle at 12px 12px, ${OG_EDGE}52 10%, transparent 0%)`,
              backgroundSize: "24px 24px",
              border: `2px solid ${OG_HAIRLINE}`,
              borderRadius: 22,
              padding: 18,
            }}
          >
            <OgSeat seat={CEO} width={230} compact />
            <div style={{ width: 2, height: 14, background: OG_EDGE }} />
            <div
              style={{
                width: RAIL_W,
                height: 15,
                borderTop: `2px solid ${OG_EDGE}`,
                borderLeft: `2px solid ${OG_EDGE}`,
                borderRight: `2px solid ${OG_EDGE}`,
                borderTopLeftRadius: 10,
                borderTopRightRadius: 10,
              }}
            />
            <div style={{ display: "flex", gap: DEPT_GAP }}>
              {DEPTS.map((dept) => (
                <DeptColumn key={dept.head.role} dept={dept} />
              ))}
            </div>
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
