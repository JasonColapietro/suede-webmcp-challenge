import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/connections"),
  title: "Connections",
  description:
    "Wire your agents to the outside world: manage the accounts and APIs your flows call.",
};

export default function ConnectionsLayout({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
