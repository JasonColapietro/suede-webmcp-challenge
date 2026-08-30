"use client";

/** Hero rails marquee with a user-operable pause (WCAG 2.2.2: auto-started
 * motion longer than 5s needs an on-page stop — the OS reduced-motion
 * setting alone doesn't count). Hover/focus pause via CSS as a courtesy. */
import { useState } from "react";

export default function RailsTicker({
  rails,
}: {
  rails: readonly string[];
}): React.JSX.Element {
  const [paused, setPaused] = useState(false);

  return (
    <div className="lp-ticker" data-paused={paused ? "true" : undefined}>
      <span className="sr-only">Supports {rails.join(", ")}.</span>
      <div className="lp-ticker-viewport" aria-hidden="true">
        <div className="lp-ticker-track">
          {[...rails, ...rails].map((r, i) => (
            <span key={r + i}>{r}</span>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="lp-ticker-pause"
        onClick={() => setPaused((p) => !p)}
      >
        {paused ? "Play" : "Pause"}
      </button>
    </div>
  );
}
