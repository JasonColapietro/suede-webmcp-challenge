import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";

interface MetadataProps {
  readonly params: Promise<{ runId: string }>;
}

interface LayoutProps extends MetadataProps {
  readonly children: React.ReactNode;
}

export async function generateMetadata({ params }: MetadataProps): Promise<Metadata> {
  const { runId } = await params;
  return {
    ...noIndexFollowMetadata(`/runs/${encodeURIComponent(runId)}`),
    title: "Run ledger",
    description:
      "The node-by-node cost ledger for a single flow run: what executed, what it cost, what settled.",
  };
}

export default function RunLayout({ children }: LayoutProps): React.JSX.Element {
  return <>{children}</>;
}
