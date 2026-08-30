"use client";

/**
 * The /agents storefront shelf: search, schedule and price filters, sort, and
 * the marketplace card (live pulse, emerald per-call price, rail badges, the
 * x402 run endpoint, payout wallet). Server-renders every entry so the whole
 * inventory stays crawlable; pagination only kicks in once the visitor
 * interacts. State resets happen in the initiating events, never in an
 * after-paint effect, following the TemplateGallery/AgentFilter pattern.
 */
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import type { CatalogEntry } from "@/lib/catalog";
import {
  HIDDEN_AGENTS_STORAGE_KEY,
  HIDDEN_AGENTS_EVENT,
  parseHiddenAgentIds,
} from "@/lib/moderation/hidden-agents";

/**
 * The slim public projection the directory page serializes to this client
 * component: card fields plus the public page, run endpoint, and x402 terms
 * URL the call affordance surfaces. payTo is already public (it ships in
 * /api/catalog and the x402 index) and renders as the payout identity.
 */
export type DirectoryAgent = Pick<
  CatalogEntry,
  | "id"
  | "slug"
  | "name"
  | "summary"
  | "description"
  | "priceUsdc"
  | "calls"
  | "settledCalls"
  | "lastCallAt"
  | "createdAt"
  | "schedule"
  | "payTo"
  | "publishedLive"
  | "acceptsPayment"
  | "paymentState"
  | "previewAvailable"
> & { readonly urls: Pick<CatalogEntry["urls"], "public" | "run" | "x402"> };

type ScheduleFilter = "all" | "scheduled" | "on-demand";

const SCHEDULE_CHIPS: { key: ScheduleFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "scheduled", label: "Scheduled" },
  { key: "on-demand", label: "On-demand" },
];

type PriceFilter = "any" | "free" | "paid";

const PRICE_CHIPS: { key: PriceFilter; label: string }[] = [
  { key: "any", label: "Any price" },
  { key: "free", label: "Free" },
  { key: "paid", label: "Paid" },
];

type DirectorySort = "most-called" | "newest" | "price";

const SORTS: { key: DirectorySort; label: string }[] = [
  { key: "most-called", label: "Most called" },
  { key: "newest", label: "Newest" },
  { key: "price", label: "Price" },
];

const PAGE_SIZE = 24;

const ZERO_ADDRESS_PATTERN = /^0x0+$/i;

function price(value: number): string {
  if (value === 0) return "Free";
  const trimmed = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${trimmed} / call`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "3m ago" / "5h ago" / "12d ago" recency label for the card. */
function relativeAgo(thenMs: number, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  return "over a year ago";
}

/** "N calls · M settled" honesty line; zero calls stays "newly listed". */
function callsLabel(calls: number, settledCalls: number): string {
  if (calls === 0) return "newly listed";
  const called = `${calls.toLocaleString("en-US")} ${calls === 1 ? "call" : "calls"}`;
  return `${called} · ${settledCalls.toLocaleString("en-US")} settled`;
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

function ChipGroup<Key extends string>({
  label,
  chips,
  active,
  onSelect,
}: {
  label: string;
  chips: readonly { key: Key; label: string }[];
  active: Key;
  onSelect: (key: Key) => void;
}): React.JSX.Element {
  return (
    <div className="lp-cat-fieldset" role="radiogroup" aria-label={label}>
      <div className="lp-cat-chips">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            role="radio"
            className="lp-cat-chip"
            data-active={active === chip.key ? "true" : "false"}
            aria-checked={active === chip.key}
            tabIndex={active === chip.key ? 0 : -1}
            onKeyDown={(event) =>
              radioArrowNav(event, chips.map((c) => c.key), active, (key) =>
                onSelect(key as Key),
              )
            }
            onClick={() => onSelect(chip.key)}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function DirectoryExplorer({
  entries,
}: {
  entries: DirectoryAgent[];
}): React.JSX.Element {
  const [schedule, setSchedule] = useState<ScheduleFilter>("all");
  const [priceBand, setPriceBand] = useState<PriceFilter>("any");
  const [sort, setSort] = useState<DirectorySort>("most-called");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(entries.length);
  const hiddenAgentIdsRaw = useSyncExternalStore(subscribeToHiddenAgents, hiddenSnapshot, () => "");
  const hiddenAgentIds = useMemo(
    () => parseHiddenAgentIds(hiddenAgentIdsRaw),
    [hiddenAgentIdsRaw],
  );

  // Only offer the price filter when the inventory actually spans both bands.
  const showPriceChips = useMemo(
    () =>
      entries.some((entry) => entry.priceUsdc === 0) &&
      entries.some((entry) => entry.priceUsdc > 0),
    [entries],
  );

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (hiddenAgentIds.has(entry.id)) return false;
      if (schedule === "scheduled" && !entry.schedule) return false;
      if (schedule === "on-demand" && entry.schedule) return false;
      if (priceBand === "free" && entry.priceUsdc !== 0) return false;
      if (priceBand === "paid" && entry.priceUsdc === 0) return false;
      if (!normalizedQuery) return true;
      return [entry.name, entry.summary, entry.slug, entry.description ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [entries, hiddenAgentIds, priceBand, query, schedule]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sort === "most-called") {
      arr.sort((a, b) => b.calls - a.calls || b.createdAt - a.createdAt);
    } else if (sort === "newest") {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      arr.sort((a, b) => a.priceUsdc - b.priceUsdc || b.calls - a.calls);
    }
    // A service that cannot accept payment or a preview never outranks one a
    // public caller can use now. Stable within each band.
    return [
      ...arr.filter((entry) =>
        entry.paymentState !== "unavailable" && entry.publishedLive),
      ...arr.filter((entry) =>
        entry.paymentState !== "unavailable" && !entry.publishedLive),
      ...arr.filter((entry) => entry.paymentState === "unavailable"),
    ];
  }, [filtered, sort]);

  const visible = sorted.slice(0, visibleCount);
  const resetFilters = (): void => {
    setSchedule("all");
    setPriceBand("any");
    setQuery("");
    setVisibleCount(PAGE_SIZE);
  };

  return (
    <>
      {/* Real heading between the page h1 and the card h3s so AT heading
          navigation never skips a level. */}
      <h2 className="sr-only">Live agents</h2>
      {/* Pre-launch there is nothing to search, filter, or sort — controls
          over an empty shelf read as broken, so they wait for inventory
          (QA round-2 finding 16). */}
      {entries.length > 0 && (
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
          <ChipGroup
            label="Filter agents by schedule"
            chips={SCHEDULE_CHIPS}
            active={schedule}
            onSelect={(key) => {
              setSchedule(key);
              setVisibleCount(PAGE_SIZE);
            }}
          />
          {showPriceChips && (
            <ChipGroup
              label="Filter agents by price"
              chips={PRICE_CHIPS}
              active={priceBand}
              onSelect={(key) => {
                setPriceBand(key);
                setVisibleCount(PAGE_SIZE);
              }}
            />
          )}
          <ChipGroup
            label="Sort agents"
            chips={SORTS}
            active={sort}
            onSelect={(key) => {
              setSort(key);
              setVisibleCount(PAGE_SIZE);
            }}
          />
        </div>
      )}
      {/* One stable live region announces every result change, including
          zero — unmounting it at zero left screen readers with no
          announcement. At zero the styled empty panel below carries the
          visual message, so the live line goes sr-only instead of reading
          as a doubled error. */}
      <p
        className={filtered.length > 0 || hiddenAgentIds.size > 0 ? "lp-filter-summary" : "sr-only"}
        role="status"
        aria-live="polite"
      >
        {filtered.length > 0 || hiddenAgentIds.size > 0 ? (
          <>
            Showing {Math.min(visibleCount, filtered.length)} of {filtered.length}{" "}
            {filtered.length === 1 ? "agent" : "agents"}.
            {hiddenAgentIds.size > 0 ? ` ${hiddenAgentIds.size} hidden in this browser.` : ""}
          </>
        ) : entries.length === 0 ? (
          "No agents are live yet."
        ) : (
          "No agents match this search."
        )}
      </p>
      {hiddenAgentIds.size > 0 ? (
        <div className="agdir-hidden-actions">
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
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <div className="lp-empty">
          {entries.length === 0 ? (
            <>
              <b>No agents are live yet.</b>
              The first launch takes this shelf. Build a flow, publish it, and its current call readiness appears here.
            </>
          ) : (
            <>
              <b>No agents match this search.</b>
              Try another phrase or reset the filters.
            </>
          )}
          <div className="agdir-empty-actions">
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
        <div className="agdir-grid">
          {visible.map((entry) => (
            <Link key={entry.id} href={entry.urls.public} className="agdir-card">
              <div className="agdir-top">
                {entry.paymentState === "unavailable" ? (
                  <span
                    className="agdir-chip"
                    title="This published service currently supports neither a public preview nor a paid call."
                  >
                    unavailable
                  </span>
                ) : entry.publishedLive ? (
                  <span className="agdir-live">
                    <i /> Live
                  </span>
                ) : (
                  <span
                    className="agdir-chip"
                    title="No active Live deployment backs this agent yet. Calls run in dry-run until it is republished."
                  >
                    dry-run only
                  </span>
                )}
                <span className="agdir-calls tabular">
                  {callsLabel(entry.calls, entry.settledCalls)}
                </span>
              </div>
              <h3>{entry.name}</h3>
              {/* The creator's own pitch replaces the derived node-chain line
                  entirely; both at once read as clutter. */}
              {entry.description ? (
                <p className="agdir-desc">{entry.description}</p>
              ) : (
                <p className="agdir-sum">{entry.summary}</p>
              )}
              <div className="agdir-meta">
                <span className="agdir-price tabular">{price(entry.priceUsdc)}</span>
                {entry.priceUsdc > 0 && entry.paymentState === "preview" && (
                  <span
                    className="agdir-chip"
                    title="Settlement is not live for this agent yet, so calls run free in dry-run and no USDC moves."
                  >
                    not charging yet
                  </span>
                )}
                {entry.lastCallAt !== null && (
                  <span className="agdir-chip tabular" suppressHydrationWarning>
                    last called {relativeAgo(entry.lastCallAt, Date.now())}
                  </span>
                )}
                {entry.schedule && (
                  <span className="agdir-chip agdir-chip--sched tabular">runs {entry.schedule}</span>
                )}
                {entry.acceptsPayment && (
                  <span className="agdir-chip" title="Machine-payable per call: terms published at the agent's x402 endpoint.">
                    x402
                  </span>
                )}
                <span className="agdir-chip" title="Speaks agent-to-agent: agent card and A2A endpoint published.">
                  A2A
                </span>
                {entry.acceptsPayment && !ZERO_ADDRESS_PATTERN.test(entry.payTo) && (
                  <span
                    className="agdir-chip agdir-chip--wallet tabular"
                    title={`Paid calls route to ${entry.payTo}`}
                  >
                    pays {shortAddress(entry.payTo)}
                  </span>
                )}
              </div>
              <div className="agdir-foot">
                <code className="agdir-endpoint" title={`POST ${entry.urls.run}`}>
                  POST {entry.urls.run}
                </code>
                <span className="agdir-go">
                  {entry.paymentState === "payment-enabled"
                    ? "Call this agent →"
                    : entry.previewAvailable
                      ? "Try the preview →"
                      : "View service details →"}
                </span>
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
