"use client";

/**
 * Docs sidebar — persistent section nav on desktop, a collapsible disclosure
 * on mobile. The current page is highlighted from the live pathname, so the
 * one shell in layout.tsx serves every docs page without per-page wiring.
 */
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_SECTIONS, findDocsPage } from "./docs-nav";

export default function DocsSidebar(): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = findDocsPage(pathname);

  return (
    <aside className="docs-side" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="docs-side-toggle lp-touch"
        aria-expanded={open}
        aria-controls="docs-side-nav"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="docs-side-toggle-eyebrow">Documentation</span>
        <span className="docs-side-toggle-current">
          {current ? current.label : "Browse the docs"}
        </span>
        <span className="docs-side-toggle-chevron" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      <nav id="docs-side-nav" className="docs-side-nav" aria-label="Documentation sections">
        {DOCS_SECTIONS.map((section) => (
          <div key={section.title} className="docs-side-group">
            <span className="docs-side-group-title">{section.title}</span>
            <ul>
              {section.pages.map((page) => {
                const isActive = page.href === pathname;
                return (
                  <li key={page.href}>
                    <Link
                      href={page.href}
                      aria-current={isActive ? "page" : undefined}
                      className="docs-side-link"
                      onClick={() => setOpen(false)}
                    >
                      {page.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
