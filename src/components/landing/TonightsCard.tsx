"use client";

/**
 * Small cross-promo widget for Suede Muse's nightly creative-constraint card.
 * Fetches a public, no-auth, CORS-open endpoint client-side. Must never break
 * the host page: renders nothing while loading, on error, or on timeout.
 */
import { useEffect, useState } from "react";

const MUSE_TONIGHT_URL = "https://muse.suedeai.ai/api/tonight";
const FETCH_TIMEOUT_MS = 2500;
const EXCERPT_MAX = 90;

type TonightCard = {
  date: string;
  dateLabel: string;
  suit: string;
  cardNumber: number;
  deckSize: number;
  name: string;
  text: string;
  url: string;
};

function isTonightCard(value: unknown): value is TonightCard {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.dateLabel === "string" &&
    typeof v.name === "string" &&
    typeof v.text === "string" &&
    typeof v.url === "string"
  );
}

function excerpt(text: string): string {
  if (text.length <= EXCERPT_MAX) return text;
  return `${text.slice(0, EXCERPT_MAX).trimEnd()}…`;
}

export default function TonightsCard(): React.JSX.Element | null {
  const [card, setCard] = useState<TonightCard | null>(null);

  useEffect(() => {
    // Deferred to idle: this widget sits at the very bottom of the page, but
    // its cross-origin fetch (DNS + TLS + request to muse.suedeai.ai) used to
    // start during hydration, competing with the load-critical work that TBT
    // and LCP measure. Idle keeps the exact same render behavior — nothing,
    // then the card whenever data arrives — just off the startup path.
    const controller = new AbortController();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let idleId: number | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      fetch(MUSE_TONIGHT_URL, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error("bad status"))))
        .then((data) => {
          if (isTonightCard(data)) setCard(data);
        })
        .catch(() => {
          // Fail silently — this widget must never break the host page.
        })
        .finally(() => clearTimeout(abortTimer));
    };
    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(load, { timeout: 4000 });
    } else {
      startTimer = setTimeout(load, 2000);
    }
    return () => {
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (startTimer !== undefined) clearTimeout(startTimer);
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      controller.abort();
    };
  }, []);

  if (!card) return null;

  return (
    <div className="lp-muse-promo">
      <span className="lp-eyebrow">From Suede Muse, tonight&apos;s card</span>
      <p className="lp-muse-promo-text" style={{ margin: "0.3rem 0 0" }}>
        One of Suede&apos;s creative-vertical companion apps.
      </p>
      <p className="lp-muse-promo-name">{card.name}</p>
      <p className="lp-muse-promo-text">{excerpt(card.text)}</p>
      <a href={card.url} target="_blank" rel="noopener noreferrer">
        See {card.dateLabel} at Muse →
      </a>
    </div>
  );
}
