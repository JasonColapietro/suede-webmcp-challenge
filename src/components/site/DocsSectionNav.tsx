/** Section navigation strip shared by every /docs page. */
import Link from "next/link";

export const DOCS_PAGES: { href: string; label: string }[] = [
  { href: "/docs", label: "Reference" },
  { href: "/docs/overview", label: "Overview" },
  { href: "/docs/building-flows", label: "Building flows" },
  { href: "/docs/launching", label: "Launching" },
  { href: "/docs/payments", label: "Payments" },
  { href: "/docs/api", label: "API for callers" },
  { href: "/docs/mcp", label: "MCP endpoint" },
  { href: "/docs/examples", label: "Examples" },
  { href: "/docs/reliability", label: "Reliability" },
  { href: "/docs/faq", label: "FAQ" },
  { href: "/docs/troubleshooting", label: "Troubleshooting" },
];

export default function DocsSectionNav({ active }: { active: string }): React.JSX.Element {
  return (
    <nav
      aria-label="Documentation sections"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.4rem",
        marginBottom: "2.25rem",
      }}
    >
      {DOCS_PAGES.map((page) => {
        const isActive = page.href === active;
        return (
          <Link
            key={page.href}
            href={page.href}
            aria-current={isActive ? "page" : undefined}
            className="docs-nav-pill"
          >
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}
