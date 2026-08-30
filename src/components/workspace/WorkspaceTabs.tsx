/**
 * Persistent operator strip — the one nav that ties the tool surfaces
 * together. Rendered directly under SiteNav on every operator page so
 * Runs, Companies, and Connections are always one click sideways instead
 * of a footer dive. Same mono-label register as the canvas ModeSwitch.
 */
import Link from "next/link";
import "@/app/workspace.css";

export type WorkspaceTabHref = "/flows" | "/resources" | "/runs" | "/company" | "/connections";

const TABS: { href: WorkspaceTabHref; label: string }[] = [
  { href: "/flows", label: "Workspace" },
  { href: "/resources", label: "Resources" },
  { href: "/runs", label: "Runs" },
  { href: "/company", label: "Companies" },
  { href: "/connections", label: "Connections" },
];

export default function WorkspaceTabs({ active }: { active: WorkspaceTabHref }): React.JSX.Element {
  return (
    <nav className="ws-tabs" aria-label="Workspace sections">
      <div className="lp-shell ws-tabs-inner">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="ws-tab"
            aria-current={active === t.href ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
        <Link href="/start" className="ws-tab ws-tab--new">
          New agent →
        </Link>
      </div>
    </nav>
  );
}
