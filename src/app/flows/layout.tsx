import type { Metadata } from "next";
import { headers } from "next/headers";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { GooglePlayAccessOnlyProvider } from "@/contexts/google-play-access-only-context";
import { isGooglePlayAccessOnlyHost } from "@/lib/google-play-access-only";
import { requireStudioAccount } from "@/lib/studio-auth";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/flows"),
  title: "My flows",
};

/*
 * Reading the request host makes this subtree dynamic. That is scoped
 * deliberately to /flows — the only route that renders a purchase control —
 * so the marketing and docs pages keep their static rendering.
 */
export default async function FlowsLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireStudioAccount("/flows");
  const host = (await headers()).get("host");
  return (
    <GooglePlayAccessOnlyProvider enabled={isGooglePlayAccessOnlyHost(host)}>
      {children}
    </GooglePlayAccessOnlyProvider>
  );
}
