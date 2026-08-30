import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/company"),
  title: "Company",
};

export default function CompanyLayout({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
