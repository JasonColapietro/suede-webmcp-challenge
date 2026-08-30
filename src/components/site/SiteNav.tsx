/** Shared persistent nav for public pages — same system as the landing nav. */
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import SignInControl from "./SignInControl";
import { BUILD_SETTINGS, BUILD_SETTINGS_LEDE, buildSettingHref } from "@/lib/build-settings";

// One link per user job — Build, buy (Directory), compose (Companies),
// price, learn (Docs), operate (Workspace) — everything explanatory lives in
// the footer (About, Templates, Launch Pad, Grader, comparisons). Adding a
// link widens the row — re-measure and bump chrome.css's hamburger cutover
// (@media max-width) so the desktop row never clips. Links marked `trim`
// drop out of the inline row in the 1025-1220px band (both stay in the
// footer and the hamburger panel); the full row returns at 1221px+.
//
// Build is NOT in this list: it is a disclosure, not a link, so that the three
// settings (Guided, Studio, Code) are visible at the moment the choice is made
// rather than only after a visitor has already walked through one of them. It
// occupies the same single row slot, so the width budget above is unchanged.
const LINKS: { href: string; label: string; trim?: boolean }[] = [
  { href: "/agents", label: "Directory" },
  { href: "/company", label: "Companies" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/flows", label: "Workspace", trim: true },
];

const CONTEXT_LABELS: Record<string, string> = {
  // One name per destination: these must match the nav link labels above, or
  // the wordmark context contradicts the link the visitor just clicked.
  "/": "Studio",
  "/agents": "Directory",
  "/launch": "Launch Pad",
  "/company": "Companies",
  "/pricing": "Pricing",
  "/docs": "Docs",
  "/about": "About",
  "/flows": "Workspace",
  "/resources": "Resources",
  "/start": "Build",
  "/templates": "Templates",
  "/status": "Status",
  "/compare/gumloop-alternative": "Compare",
  "/rankings/best-ai-agent-builders": "Rankings",
  "/runs": "Runs",
  "/grade": "Grader",
  "/portfolio": "Portfolio",
  "/articles": "Articles",
  "/contact": "Contact",
  "/founding": "Founding",
  "/founder": "Founder",
  "/privacy": "Privacy",
  "/security": "Security",
  "/account-deletion": "Account deletion",
  "/connections": "Connections",
};

// Secondary destinations that hang off the Build decision. Workspace earns its
// place here because it drops out of the inline row between 1025-1220px via
// data-trim; the menu is what keeps the canvas and the saved flows one click
// away at that width instead of a footer dive.
const BUILD_MENU_LINKS: { href: string; label: string }[] = [
  { href: "/flows", label: "Workspace" },
  { href: "/templates", label: "Templates" },
];

/** The Build disclosure. `<details>`/`<summary>` is the pattern the hamburger
 *  in this same file already uses: click-driven so it works on touch, and
 *  keyboard-operable with no JS. The primary "Start building" CTA still routes
 *  straight to Guided, so the one-click path to the common door is not lost. */
function BuildMenu({ active }: { active?: string }): React.JSX.Element {
  const isActive = active === "/start" || active === "/build" || active === "/code";
  return (
    <details className="lp-nav-build">
      <summary
        className="lp-nav-build-summary"
        data-active={isActive ? "true" : undefined}
      >
        Build
      </summary>
      <div className="lp-nav-build-panel">
        <p className="lp-nav-build-lede">{BUILD_SETTINGS_LEDE}</p>
        {BUILD_SETTINGS.map((s) => (
          <Link key={s.id} href={buildSettingHref(s.id, null)} className="lp-nav-build-setting">
            <b>{s.label}</b>
            <span>{s.blurb}</span>
          </Link>
        ))}
        <div className="lp-nav-build-more">
          {BUILD_MENU_LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </details>
  );
}

export default function SiteNav({ active }: { active?: string }): React.JSX.Element {
  const contextLabel = active ? CONTEXT_LABELS[active] ?? "Studio" : "Studio";

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <nav className="lp-nav" aria-label="Primary">
      <div className="lp-shell lp-nav-inner">
        <Link href="/" className="lp-wordmark" style={{ textDecoration: "none", color: "inherit" }}>
          <b>Suede Agent Studio</b>
          <span>{contextLabel}</span>
        </Link>
        <div className="lp-nav-links">
          <BuildMenu active={active} />
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              data-trim={l.trim ? "true" : undefined}
              aria-current={active === l.href ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <details className="lp-nav-menu">
          <summary className="lp-nav-summary">
            <span className="sr-only">Navigation menu</span>
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </summary>
          <div className="lp-nav-menu-panel">
            <div className="lp-nav-menu-build">
              <span className="lp-nav-menu-build-head">Build</span>
              {BUILD_SETTINGS.map((s) => (
                <Link key={s.id} href={buildSettingHref(s.id, null)}>
                  {s.label}
                </Link>
              ))}
            </div>
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active === l.href ? "page" : undefined}
              >
                {l.label}
              </Link>
            ))}
            <Link href="/start" className="lp-nav-menu-cta">
              Start building
            </Link>
          </div>
        </details>
        <ThemeToggle />
        <SignInControl />
        <Link href="/start" className="lp-btn lp-btn--primary lp-btn--sm">
          Start building
        </Link>
      </div>
      </nav>
    </>
  );
}
