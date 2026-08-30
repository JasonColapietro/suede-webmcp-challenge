import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { requireStudioAccount } from "@/lib/studio-auth";

export const metadata: Metadata = noIndexFollowMetadata("/build");

export default async function BuildLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireStudioAccount("/build");
  return <>{children}</>;
}
