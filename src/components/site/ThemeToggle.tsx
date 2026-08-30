"use client";

/** Opt-in dark mode switch. Defaults to light (the product's bright system);
 * dark only activates once the visitor toggles it, persisted in
 * localStorage and applied via a `data-theme` attribute on <html> (see the
 * anti-flash script in layout.tsx, which reads the same key on first paint). */
import { useEffect, useState } from "react";

const STORAGE_KEY = "suede-theme";

export default function ThemeToggle(): React.JSX.Element {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  function toggle(): void {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    try {
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
    } catch {
      // localStorage unavailable (private mode) — theme still applies for this load
    }
  }

  return (
    <button
      type="button"
      className="lp-theme-toggle"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={isDark}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {isDark ? (
          <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4.5" />
            <path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
          </>
        )}
      </svg>
    </button>
  );
}
