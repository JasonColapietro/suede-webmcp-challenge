import type { Metadata } from "next";

function canonicalPath(value: string): string {
  const withoutFragment = value.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  if (withoutQuery === "") return "/";
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

/**
 * Metadata contract for owner-specific and interactive app routes that should
 * remain crawlable for link discovery but must not compete with durable public
 * landing pages. Canonicals deliberately discard query and fragment variants.
 */
export function noIndexFollowMetadata(canonical: string): Metadata {
  return {
    alternates: { canonical: canonicalPath(canonical) },
    robots: {
      index: false,
      follow: true,
      googleBot: { index: false, follow: true },
    },
  };
}
