import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { requireStudioAccount } from "@/lib/studio-auth";

export const metadata: Metadata = noIndexFollowMetadata("/founding");

export default async function FoundingLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireStudioAccount("/founding");
  return <>{children}</>;
}
