"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import type { CatalogEntry } from "@/lib/catalog";

/**
 * The slim projection the directory page serializes to this client component —
 * everything the filter renders, none of the machine URLs or payout address.
 */
export type DirectoryEntry = Pick<
  CatalogEntry,
  "id" | "slug" | "name" | "summary" | "description" | "priceUsdc" | "calls" | "createdAt" | "schedule"
> & { readonly urls: { readonly public: string } };
import {
  HIDDEN_AGENTS_STORAGE_KEY,
  HIDDEN_AGENTS_EVENT,
  parseHiddenAgentIds,
} from "@/lib/moderation/hidden-agents";

type DirectoryFilter = "all" | "scheduled" | "on-demand";

const CHIPS: { key: DirectoryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "scheduled", label: "Scheduled" },
  { key: "on-demand", label: "On-demand" },
];

type DirectorySort = "most-called" | "newest" | "price";

const SORTS: { key: DirectorySort; label: string }[] = [
  { key: "most-called", label: "Most called" },
  { key: "newest", label: "Newest" },
  { key: "price", label: "Price" },
];

const PAGE_SIZE = 24;

function price(value: number): string {
  return value === 0 ? "Free" : `$${value.toFixed(3)} / call`;
}

/**
 * APG radio-group arrow navigation: selection follows focus, wrapping at the
 * ends. The caller's `select` updates state; we then move focus to the newly
 * checked chip inside the same group.
 */
function radioArrowNav(
  event: React.KeyboardEvent<HTMLButtonElement>,
  keys: readonly string[],
  current: string,
  select: (key: string) => void,
): void {
  const idx = keys.indexOf(current);
  let next: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (idx + 1) % keys.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (idx - 1 + keys.length) % keys.length;
  if (next === null) return;
  event.preventDefault();
  select(keys[next]!);
  const radios = event.currentTarget
    .closest('[role="radiogroup"]')
    ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios?.[next]?.focus();
}

function hiddenSnapshot(): string {
  return typeof window === "undefined"
    ? ""
    : window.localStorage.getItem(HIDDEN_AGENTS_STORAGE_KEY) ?? "";
}

function subscribeToHiddenAgents(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent): void => {
    if (event.key === HIDDEN_AGENTS_STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(HIDDEN_AGENTS_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(HIDDEN_AGENTS_EVENT, onStoreChange);
  };
}

export default function AgentFilter({
  entries,
}: {
  entries: DirectoryEntry[];
}): React.JSX.Element {
  const [active, setActive] = useState<DirectoryFilter>("all");
  const [sort, setSort] = useState<DirectorySort>("most-called");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(entries.length);
  const hiddenAgentIdsRaw = useSyncExternalStore(subscribeToHiddenAgents, hiddenSnapshot, () => "");
  const hiddenAgentIds = useMemo(
    () => parseHiddenAgentIds(hiddenAgentIdsRaw),
    [hiddenAgentIdsRaw],
  );

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (hiddenAgentIds.has(entry.id)) return false;
      if (active === "scheduled" && !entry.schedule) return false;
      if (active === "on-demand" && entry.schedule) return false;
      if (!normalizedQuery) return true;
      return [entry.name, entry.summary, entry.slug]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [active, entries, hiddenAgentIds, query]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sort === "most-called") {
      arr.sort((a, b) => b.calls - a.calls || b.createdAt - a.createdAt);
    } else if (sort === "newest") {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      arr.sort((a, b) => a.priceUsdc - b.priceUsdc || b.calls - a.calls);
    }
    return arr;
  }, [filtered, sort]);
  const visible = sorted.slice(0, visibleCount);
  const resetFilters = (): void => {
    setActive("all");
    setQuery("");
    setVisibleCount(PAGE_SIZE);
  };

  return (
    <>
      <div className="lp-catalog-controls">
        <label className="lp-catalog-search">
          <span className="sr-only">Search agents</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
            placeholder="Search agents"
            autoComplete="off"
          />
        </label>
        <div
          className="lp-cat-fieldset"
          role="radiogroup"
          aria-label="Filter agents by schedule"
        >
          <div className="lp-cat-chips">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                className="lp-cat-chip"
                data-active={active === c.key ? "true" : "false"}
                aria-checked={active === c.key}
                tabIndex={active === c.key ? 0 : -1}
                onKeyDown={(event) =>
                  radioArrowNav(event, CHIPS.map((x) => x.key), active, (k) => {
                    setActive(k as DirectoryFilter);
                    setVisibleCount(PAGE_SIZE);
                  })
                }
                onClick={() => {
                  setActive(c.key);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="lp-cat-fieldset" role="radiogroup" aria-label="Sort agents">
          <div className="lp-cat-chips">
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="radio"
                className="lp-cat-chip"
                data-active={sort === s.key ? "true" : "false"}
                aria-checked={sort === s.key}
                tabIndex={sort === s.key ? 0 : -1}
                onKeyDown={(event) =>
                  radioArrowNav(event, SORTS.map((x) => x.key), sort, (k) => {
                    setSort(k as DirectorySort);
                    setVisibleCount(PAGE_SIZE);
                  })
                }
                onClick={() => {
                  setSort(s.key);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="lp-filter-summary" role="status" aria-live="polite">
        Showing {Math.min(visibleCount, filtered.length)} of {filtered.length}{" "}
        {filtered.length === 1 ? "agent" : "agents"}.
        {hiddenAgentIds.size > 0 ? ` ${hiddenAgentIds.size} hidden in this browser.` : ""}
      </p>
      {hiddenAgentIds.size > 0 ? <div style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          className="lp-btn lp-btn--ghost lp-btn--sm"
          onClick={() => {
            globalThis.localStorage?.removeItem(HIDDEN_AGENTS_STORAGE_KEY);
            globalThis.dispatchEvent?.(new Event(HIDDEN_AGENTS_EVENT));
          }}
        >
          Show hidden agents
        </button>
      </div> : null}
      {filtered.length === 0 ? (
        <div className="lp-empty">
          {entries.length === 0 ? (
            <>
              <b>No agents are live yet.</b>
              Build the first one in any setting.
            </>
          ) : (
            <>
              <b>No agents match this search.</b>
              Try another phrase or reset the schedule filter.
            </>
          )}
          <div style={{ marginTop: "1.1rem" }}>
            {entries.length === 0 ? (
              <Link href="/start" className="lp-btn lp-btn--primary">
                Build the first one →
              </Link>
            ) : (
              <button type="button" className="lp-btn lp-btn--ghost" onClick={resetFilters}>
                Clear search and filters
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="lp-dir-grid">
          {visible.map((e) => (
            <Link key={e.id} href={e.urls.public} className="lp-dir-card">
              <h3>{e.name}</h3>
              {e.description ? (
                <>
                  <span className="sum" style={{ fontFamily: "var(--font-ui)", color: "var(--text-secondary)" }}>
                    {e.description}
                  </span>
                  <span className="sum">{e.summary}</span>
                </>
              ) : (
                <span className="sum">{e.summary}</span>
              )}
              <div className="lp-dir-meta">
                <span className="lp-pill lp-pill--price tabular">{price(e.priceUsdc)}</span>
                <span className="lp-pill lp-pill--calls tabular">
                  {e.calls === 0 ? "new" : `${e.calls} ${e.calls === 1 ? "call" : "calls"}`}
                </span>
                {e.schedule && (
                  <span className="lp-pill lp-pill--sched tabular">runs {e.schedule}</span>
                )}
                <span className="lp-pill">x402</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      {visible.length < filtered.length ? (
        <div className="lp-load-more">
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
          </button>
        </div>
      ) : null}
    </>
  );
}
