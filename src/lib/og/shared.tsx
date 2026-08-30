/**
 * Shared layout system for every Satori-rendered OG/Twitter card: one frame
 * (wordmark header, footer rail), one typography stack (Instrument Serif
 * display + Geist Sans labels, loaded from local TTFs because Satori cannot
 * read woff2 or variable fonts), and the seat-card anatomy that mirrors the
 * landing page's org-chart language (AgentOrgCard.tsx) so link previews show
 * the same product the page does. Colors come from src/lib/og/palette.ts.
 *
 * next/og replaces its default font when a `fonts` array is passed, so
 * loadOgFonts() must ship both the serif and the sans: any family Satori
 * cannot resolve would otherwise silently fall back to the first font.
 *
 * Node.js runtime only (the OG routes do not export `runtime = "edge"`):
 * fonts are read from disk with literal process.cwd() joins so Next's output
 * file tracing bundles the TTFs into the deployed function.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OG_CANVAS,
  OG_EMERALD,
  OG_HAIRLINE,
  OG_INK,
  OG_MUTED,
  OG_WHITE,
} from "./palette";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

/** Font families registered by loadOgFonts(); use these exact names. */
export const FONT_SERIF = "Instrument Serif";
export const FONT_SANS = "Geist";

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  style: "normal" | "italic";
  weight: 400 | 500 | 700;
}

/** Buffer -> tightly-sliced ArrayBuffer (what ImageResponse's font type wants). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Loads the brand fonts as static TTFs stored next to this module (converted
 * from the app's woff2/variable sources in src/app/fonts, which Satori cannot
 * parse). Disk reads with literal paths, no network fetch at request time.
 */
export async function loadOgFonts(): Promise<OgFont[]> {
  const load = async (file: string): Promise<ArrayBuffer> =>
    toArrayBuffer(await readFile(join(process.cwd(), "src/lib/og/fonts", file)));
  const [serif, serifItalic, sans400, sans500, sans700] = await Promise.all([
    load("instrument-serif-400.ttf"),
    load("instrument-serif-400-italic.ttf"),
    load("geist-sans-400.ttf"),
    load("geist-sans-500.ttf"),
    load("geist-sans-700.ttf"),
  ]);
  return [
    { name: FONT_SERIF, data: serif, style: "normal", weight: 400 },
    { name: FONT_SERIF, data: serifItalic, style: "italic", weight: 400 },
    { name: FONT_SANS, data: sans400, style: "normal", weight: 400 },
    { name: FONT_SANS, data: sans500, style: "normal", weight: 500 },
    { name: FONT_SANS, data: sans700, style: "normal", weight: 700 },
  ];
}

/** Hex color + two-digit hex alpha ("#4f46e5" + "1f") for Satori-safe tints. */
export function tint(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

/** The nav wordmark, restated for cards: serif name + accent-colored pill. */
export function OgWordmark({ badge, accent }: { badge: string; accent: string }): React.JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <div style={{ fontFamily: FONT_SERIF, fontSize: 40, color: OG_INK, letterSpacing: -0.5 }}>
        Suede Agent Studio
      </div>
      <div
        style={{
          fontFamily: FONT_SANS,
          fontSize: 16,
          fontWeight: 500,
          color: accent,
          border: `2px solid ${tint(accent, "40")}`,
          borderRadius: 999,
          padding: "5px 16px",
          letterSpacing: 3,
        }}
      >
        {badge}
      </div>
    </div>
  );
}

/** Small footer/inline pill. */
export function OgChip({ label, color }: { label: string; color: string }): React.JSX.Element {
  return (
    <div
      style={{
        fontFamily: FONT_SANS,
        fontSize: 17,
        fontWeight: 500,
        color,
        border: `2px solid ${OG_HAIRLINE}`,
        borderRadius: 999,
        padding: "6px 16px",
        letterSpacing: 1,
      }}
    >
      {label}
    </div>
  );
}

/**
 * The shared card frame: white page, wordmark header, content area, and a
 * hairline footer rail with the domain plus claim chips. Every route's card
 * composes this so the whole estate reads as one system in a feed.
 */
export function OgFrame({
  badge,
  accent,
  chips,
  children,
}: {
  badge: string;
  accent: string;
  chips: readonly { label: string; color: string }[];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: OG_WHITE,
        padding: "48px 60px 40px",
        fontFamily: FONT_SANS,
      }}
    >
      <OgWordmark badge={badge} accent={accent} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>{children}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `2px solid ${OG_HAIRLINE}`,
          paddingTop: 22,
        }}
      >
        <div style={{ fontFamily: FONT_SANS, fontSize: 21, color: OG_MUTED, letterSpacing: 2 }}>
          agents.suedeai.ai
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {chips.map((chip) => (
            <OgChip key={chip.label} label={chip.label} color={chip.color} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Serif display headline + muted support line, the left column of most cards. */
export function OgHeadline({
  eyebrow,
  accent,
  title,
  sub,
  titleSize = 66,
  maxWidth = 980,
}: {
  eyebrow?: string;
  accent: string;
  title: string;
  sub?: string;
  titleSize?: number;
  maxWidth?: number;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth }}>
      {eyebrow ? (
        <div
          style={{
            fontFamily: FONT_SANS,
            fontSize: 19,
            fontWeight: 700,
            color: accent,
            letterSpacing: 4,
          }}
        >
          {eyebrow.toUpperCase()}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: FONT_SERIF,
          fontSize: titleSize,
          color: OG_INK,
          lineHeight: 1.04,
          letterSpacing: -1,
        }}
      >
        {title}
      </div>
      {sub ? (
        <div style={{ fontFamily: FONT_SANS, fontSize: 25, color: OG_MUTED, lineHeight: 1.4 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export interface OgSeatData {
  role: string;
  agent: string;
  accent: string;
  live?: boolean;
  price?: string;
  schedule?: string;
}

/**
 * One org-chart seat, the same anatomy as the landing page's OrgSeat: brand
 * initial in a department-tinted tile, role first, agent second, live dot and
 * per-call price only where the seat earns, cadence chip where a cron drives
 * it.
 */
export function OgSeat({
  seat,
  width = 264,
  compact = false,
}: {
  seat: OgSeatData;
  width?: number;
  compact?: boolean;
}): React.JSX.Element {
  const pad = compact ? "10px 14px" : "12px 16px";
  const markSize = compact ? 38 : 44;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width,
        background: OG_WHITE,
        border: `2px solid ${OG_HAIRLINE}`,
        borderRadius: 14,
        padding: pad,
        /* Mirrors tokens.css --shadow-card. */
        boxShadow: "0 1px 3px rgba(17, 19, 23, 0.08), 0 6px 18px rgba(17, 19, 23, 0.06)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: markSize,
          height: markSize,
          borderRadius: 11,
          background: tint(seat.accent, "1f"),
          color: seat.accent,
          fontFamily: FONT_SANS,
          fontSize: compact ? 18 : 21,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {seat.agent.slice(0, 1)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div
            style={{
              fontFamily: FONT_SANS,
              fontSize: compact ? 18 : 20,
              fontWeight: 700,
              color: OG_INK,
              whiteSpace: "nowrap",
            }}
          >
            {seat.role}
          </div>
          {seat.live ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  background: OG_EMERALD,
                }}
              />
              <div
                style={{
                  fontFamily: FONT_SANS,
                  fontSize: 13,
                  fontWeight: 700,
                  color: OG_EMERALD,
                  letterSpacing: 1,
                }}
              >
                LIVE
              </div>
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontFamily: FONT_SANS, fontSize: 15, color: OG_MUTED }}>{seat.agent}</div>
          {seat.price ? (
            <div
              style={{
                fontFamily: FONT_SANS,
                fontSize: 13,
                fontWeight: 700,
                color: OG_EMERALD,
                background: tint(OG_EMERALD, "17"),
                borderRadius: 999,
                padding: "2px 9px",
                whiteSpace: "nowrap",
              }}
            >
              {seat.price}
            </div>
          ) : null}
          {!seat.price && seat.schedule ? (
            <div
              style={{
                fontFamily: FONT_SANS,
                fontSize: 13,
                fontWeight: 500,
                color: OG_MUTED,
                background: OG_CANVAS,
                border: `1px solid ${OG_HAIRLINE}`,
                borderRadius: 999,
                padding: "2px 9px",
                whiteSpace: "nowrap",
              }}
            >
              {seat.schedule}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
