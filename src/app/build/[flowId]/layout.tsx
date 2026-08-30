import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

interface MetadataProps {
  readonly params: Promise<{ flowId: string }>;
}

interface LayoutProps extends MetadataProps {
  readonly children: React.ReactNode;
}

export async function generateMetadata({ params }: MetadataProps): Promise<Metadata> {
  const { flowId } = await params;
  return noIndexFollowMetadata(`/build/${encodeURIComponent(flowId)}`);
}

export default function BuildLayout({ children }: LayoutProps): React.JSX.Element {
  return <>{children}</>;
}
