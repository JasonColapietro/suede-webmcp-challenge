import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

export const metadata: Metadata = noIndexFollowMetadata("/founding");

export default function FoundingLayout({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
