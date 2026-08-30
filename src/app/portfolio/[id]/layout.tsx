import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

interface MetadataProps {
  readonly params: Promise<{ id: string }>;
}

interface LayoutProps extends MetadataProps {
  readonly children: React.ReactNode;
}

export async function generateMetadata({ params }: MetadataProps): Promise<Metadata> {
  const { id } = await params;
  return noIndexFollowMetadata(`/portfolio/${encodeURIComponent(id)}`);
}

export default function PortfolioAgentLayout({ children }: LayoutProps): React.JSX.Element {
  return <>{children}</>;
}
