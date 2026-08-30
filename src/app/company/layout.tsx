import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { requireStudioAccount } from "@/lib/studio-auth";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/company"),
  title: "Company",
};

export default async function CompanyLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireStudioAccount("/company");
  return <>{children}</>;
}
