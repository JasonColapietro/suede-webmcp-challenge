/**
 * Hand-rolled SVG charts (no chart library) for the portfolio dashboard.
 * Colors are passed as CSS custom-property strings so they inherit the Suede palette.
 */
import { shortDay } from "@/lib/portfolio/format";

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function hashId(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function Sparkline({
  values,
  color = "var(--primary)",
  width = 104,
  height = 30,
  strokeWidth = 1.5,
  ariaLabel,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  /** When the sparkline is a cell's only content, pass a summary so the data
   * has a non-visual representation (same pattern as AreaChart/BarChart);
   * omitted = decorative, hidden from assistive tech. */
  ariaLabel?: string;
}) {
  const a11y = ariaLabel
    ? ({ role: "img", "aria-label": ariaLabel } as const)
    : ({ "aria-hidden": true } as const);
  if (values.length === 0) return <svg width={width} height={height} {...a11y} />;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const pt = (v: number, i: number) => {
    const x = pad + (values.length === 1 ? innerW / 2 : (i / (values.length - 1)) * innerW);
    const y = pad + innerH - ((v - min) / span) * innerH;
    return [x, y] as const;
  };
  const pts = values.map(pt);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  const id = `spark-${hashId(values.join(",") + color)}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} {...a11y} style={{ display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={1.8} fill={color} />
    </svg>
  );
}

export interface SeriesPoint {
  label: string;
  value: number;
}

export function AreaChart({
  points,
  color = "var(--primary)",
  height = 240,
  format = (n: number) => n.toFixed(0),
  ariaLabel,
  viewBoxWidth = 820,
}: {
  points: SeriesPoint[];
  color?: string;
  height?: number;
  format?: (n: number) => string;
  ariaLabel: string;
  /**
   * User-space width of the viewBox. The SVG always fills its container, so
   * this is really a text-scale control: a 820-unit chart squeezed into a
   * 311px phone column renders its 11-unit axis labels at ~4px. Callers that
   * render a phone variant pass a narrow value so the labels stay legible.
   */
  viewBoxWidth?: number;
}) {
  const W = viewBoxWidth;
  const H = height;
  // 56 clipped a two-decimal five-figure label ("$10.00" measured 48px into a
  // 46px gutter). 68 clears the widest label the compact formatter emits.
  const padL = 68;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const x = (i: number) => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
  const id = `area-${hashId(ariaLabel + color + points.length + W)}`;
  // Narrow variants get three gridlines instead of five: at phone scale the
  // five-line set stacks its labels into an unreadable column.
  const gridLines = W < 600 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const last = points[points.length - 1];
  const xTickIdx = points.length <= 1 ? [0] : [0, Math.floor((points.length - 1) / 3), Math.floor((2 * (points.length - 1)) / 3), points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      style={{ display: "block", height: "auto" }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {gridLines.map((g) => {
        const yy = padT + innerH - g * innerH;
        return (
          <g key={g}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={padL - 10} y={yy + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" className="tabular">
              {format(g * max)}
            </text>
          </g>
        );
      })}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(last.value)} r={3.5} fill={color} />
      <circle cx={x(points.length - 1)} cy={y(last.value)} r={6.5} fill={color} fillOpacity={0.16} />
      {xTickIdx.map((i) => (
        <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize={11} fill="var(--text-muted)">
          {shortDay(points[i].label)}
        </text>
      ))}
    </svg>
  );
}

export function BarChart({
  points,
  color = "var(--registry-cyan)",
  height = 160,
  ariaLabel,
}: {
  points: SeriesPoint[];
  color?: string;
  height?: number;
  ariaLabel: string;
}) {
  const W = 820;
  const H = height;
  const padL = 40;
  const padR = 16;
  const padT = 12;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const n = points.length;
  const gap = n > 40 ? 1 : 2;
  const bw = Math.max(1, innerW / n - gap);
  const xTickIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={ariaLabel} style={{ display: "block", height: "auto" }}>
      {[0, 0.5, 1].map((g) => {
        const yy = padT + innerH - g * innerH;
        return (
          <g key={g}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={padL - 8} y={yy + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" className="tabular">
              {Math.round(g * max)}
            </text>
          </g>
        );
      })}
      {points.map((p, i) => {
        const h = (p.value / max) * innerH;
        const xx = padL + (i / n) * innerW + gap / 2;
        const yy = padT + innerH - h;
        return <rect key={i} x={xx} y={yy} width={bw} height={Math.max(0, h)} rx={1} fill={color} fillOpacity={0.85} />;
      })}
      {xTickIdx.map((i) => (
        <text key={i} x={padL + (i / n) * innerW + bw / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={11} fill="var(--text-muted)">
          {shortDay(points[i].label)}
        </text>
      ))}
    </svg>
  );
}
