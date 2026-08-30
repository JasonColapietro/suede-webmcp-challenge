import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/connections/import-api"),
  title: "Import an API",
  description:
    "Turn any HTTP API into a connection your agents can call from the canvas.",
};

export default function ImportApiLayout({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
