import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { requireStudioAccount } from "@/lib/studio-auth";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/portfolio"),
  title: "Portfolio",
};

export default async function PortfolioLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireStudioAccount("/portfolio");
  return <>{children}</>;
}
