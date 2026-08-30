"use client";

/**
 * Prev/next pager at the foot of every docs page, forming a linear reading
 * path through the documentation (order defined in docs-nav.ts).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_READING_PATH } from "./docs-nav";

export default function DocsPager(): React.JSX.Element | null {
  const pathname = usePathname();
  const index = DOCS_READING_PATH.findIndex((page) => page.href === pathname);
  if (index === -1) return null;

  const prev = index > 0 ? DOCS_READING_PATH[index - 1] : undefined;
  const next =
    index < DOCS_READING_PATH.length - 1 ? DOCS_READING_PATH[index + 1] : undefined;
  if (!prev && !next) return null;

  return (
    <nav className="docs-pager" aria-label="Documentation reading path">
      {prev ? (
        <Link href={prev.href} className="docs-pager-card" rel="prev">
          <span className="docs-pager-dir">Previous</span>
          <span className="docs-pager-title">{prev.label}</span>
          <span className="docs-pager-desc">{prev.description}</span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      {next ? (
        <Link href={next.href} className="docs-pager-card docs-pager-card--next" rel="next">
          <span className="docs-pager-dir">Next</span>
          <span className="docs-pager-title">{next.label}</span>
          <span className="docs-pager-desc">{next.description}</span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}
