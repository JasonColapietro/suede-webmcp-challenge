import type { Metadata } from "next";
import { OG_IMAGE } from "@/lib/site";

const DEFAULT_OPEN_GRAPH_IMAGE = {
  url: OG_IMAGE,
  width: 1200,
  height: 630,
  alt: "Suede Agent Studio",
} as const;

/**
 * Next.js child metadata objects replace their parent's Open Graph and Twitter
 * objects. Fill only missing child images so every public share card keeps the
 * canonical site image without changing page copy, canonicals, or robots.
 */
export function withDefaultSocialImages(metadata: Metadata): Metadata {
  return {
    ...metadata,
    ...(metadata.openGraph
      ? {
          openGraph: {
            ...metadata.openGraph,
            images: metadata.openGraph.images ?? [DEFAULT_OPEN_GRAPH_IMAGE],
          },
        }
      : {}),
    ...(metadata.twitter
      ? {
          twitter: {
            ...metadata.twitter,
            images: metadata.twitter.images ?? [OG_IMAGE],
          },
        }
      : {}),
  };
}
