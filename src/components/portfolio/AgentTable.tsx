"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AgentWithStats } from "@/lib/portfolio/types";
import { num, timeAgo, usd, usdPrecise } from "@/lib/portfolio/format";
import { Sparkline } from "@/components/portfolio/charts";
import { CategoryTag, StatusBadge } from "@/components/portfolio/ui";
import { categoryColor } from "@/lib/portfolio/category";

type SortKey = "name" | "category" | "price" | "calls" | "revenue" | "lastActive" | "status";
type Dir = "asc" | "desc";

const STATUS_ORDER: Record<string, number> = { live: 0, degraded: 1, down: 2, paused: 3, draft: 4 };

function value(a: AgentWithStats, key: SortKey): number | string {
  switch (key) {
    case "name":
      return a.name.toLowerCase();
    case "category":
      return a.category.toLowerCase();
    case "price":
      return a.priceUsdc;
    case "calls":
      return a.stats.calls;
    case "revenue":
      return a.stats.revenueUsdc;
    case "lastActive":
      return a.stats.lastActiveAt ? new Date(a.stats.lastActiveAt).getTime() : -Infinity;
    case "status":
      return STATUS_ORDER[a.status] ?? 99;
  }
}

const NUMERIC: Record<SortKey, boolean> = {
  name: false,
  category: false,
  price: true,
  calls: true,
  revenue: true,
  lastActive: true,
  status: true,
};

const LABELS: Record<SortKey, string> = {
  name: "Agent",
  category: "Category",
  price: "Price",
  calls: "Calls",
  revenue: "Revenue",
  lastActive: "Last call",
  status: "Status",
};

export function AgentTable({ agents, nowISO }: { agents: AgentWithStats[]; nowISO: string }) {
  const [sort, setSort] = useState<SortKey>("revenue");
  const [dir, setDir] = useState<Dir>("desc");
  const now = useMemo(() => new Date(nowISO), [nowISO]);

  const rows = useMemo(() => {
    return [...agents].sort((a, b) => {
      const av = value(a, sort);
      const bv = value(b, sort);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
  }, [agents, sort, dir]);

  function toggle(key: SortKey) {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(NUMERIC[key] ? "desc" : "asc");
    }
  }

  return (
    <section className="pf-ledger" aria-label="Agents">
      <div className="pf-ledger-head">
        <p className="pf-tile-label">Seats · {agents.length}</p>
        <p className="pf-sortnote">
          sorted by {LABELS[sort].toLowerCase()} {dir === "desc" ? "↓" : "↑"}
        </p>
      </div>

      {/* Wide layout: the full ledger. */}
      <div className="pf-table-wrap">
        <table className="pf-table">
          <thead>
            <tr>
              <Th label="Agent" k="name" sort={sort} dir={dir} onSort={toggle} className="pf-cell-lead" />
              <Th label="Category" k="category" sort={sort} dir={dir} onSort={toggle} className="hidden md:table-cell" />
              <Th label="Price" k="price" sort={sort} dir={dir} onSort={toggle} align="right" />
              <Th label="Calls" k="calls" sort={sort} dir={dir} onSort={toggle} align="right" />
              <Th label="Revenue" k="revenue" sort={sort} dir={dir} onSort={toggle} align="right" />
              <th className="hidden text-left lg:table-cell">
                <span className="pf-tile-label">7d</span>
              </th>
              <Th label="Last call" k="lastActive" sort={sort} dir={dir} onSort={toggle} align="right" />
              <Th label="Status" k="status" sort={sort} dir={dir} onSort={toggle} align="right" className="pf-cell-tail" />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="pf-cell-lead">
                  <Link href={`/portfolio/${a.id}`} className="pf-agent-link">
                    {a.name}
                  </Link>
                  {a.manual ? <span className="pf-manual-tag">manual</span> : null}
                  <span className="mt-0.5 block md:hidden">
                    <CategoryTag category={a.category} />
                  </span>
                </td>
                <td className="hidden md:table-cell">
                  <CategoryTag category={a.category} />
                </td>
                <td className="text-right tabular" data-numeric style={{ color: "var(--text-muted)" }}>
                  {usdPrecise(a.priceUsdc)}
                </td>
                <td className="text-right tabular" data-numeric>
                  {num(a.stats.calls)}
                </td>
                <td className="text-right tabular" data-numeric style={{ fontWeight: 600 }}>
                  {usd(a.stats.revenueUsdc)}
                </td>
                <td className="hidden lg:table-cell">
                  <Sparkline
                    values={a.stats.spark}
                    color={categoryColor(a.category)}
                    width={84}
                    height={26}
                    ariaLabel={`${usd(a.stats.spark.reduce((s, v) => s + v, 0))} revenue last 7 days`}
                  />
                </td>
                <td className="text-right tabular" data-numeric style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                  {timeAgo(a.stats.lastActiveAt, now)}
                </td>
                <td className="pf-cell-tail text-right">
                  <span className="inline-flex justify-end">
                    <StatusBadge status={a.status} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one card per seat, so revenue and status stay on screen
          instead of hiding behind a horizontal scroll. */}
      <div className="pf-seats">
        {rows.map((a) => (
          <article key={a.id} className="pf-seat">
            <div className="pf-seat-top">
              <Link href={`/portfolio/${a.id}`} className="pf-seat-name">
                {a.name}
              </Link>
              <span className="pf-seat-rev" data-numeric>
                {usd(a.stats.revenueUsdc)}
              </span>
            </div>
            <div className="pf-seat-meta">
              <CategoryTag category={a.category} />
              <span>{usdPrecise(a.priceUsdc)}/call</span>
              <span>
                {num(a.stats.calls)} {a.stats.calls === 1 ? "call" : "calls"}
              </span>
              {a.manual ? <span>manual</span> : null}
            </div>
            <div className="pf-seat-foot">
              <span className="pf-seat-meta">{timeAgo(a.stats.lastActiveAt, now)}</span>
              <StatusBadge status={a.status} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Th({
  label,
  k,
  sort,
  dir,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  dir: Dir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort === k;
  return (
    <th
      className={`${align === "right" ? "text-right" : "text-left"} ${className}`}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => onSort(k)} className="pf-sortbtn" data-active={active}>
        {align === "right" && active ? <Caret dir={dir} /> : null}
        {label}
        {align === "left" && active ? <Caret dir={dir} /> : null}
      </button>
    </th>
  );
}

function Caret({ dir }: { dir: Dir }) {
  return <span aria-hidden="true" style={{ fontSize: 8 }}>{dir === "asc" ? "▲" : "▼"}</span>;
}
