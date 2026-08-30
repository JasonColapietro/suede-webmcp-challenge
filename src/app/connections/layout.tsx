import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { requireStudioAccount } from "@/lib/studio-auth";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/connections"),
  title: "Connections",
  description:
    "Wire your agents to the outside world: manage the accounts and APIs your flows call.",
};

export default async function ConnectionsLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireStudioAccount("/connections");
  return <>{children}</>;
}
