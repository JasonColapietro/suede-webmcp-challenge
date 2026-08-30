import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/portfolio"),
  title: "Portfolio",
};

export default function PortfolioLayout({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
