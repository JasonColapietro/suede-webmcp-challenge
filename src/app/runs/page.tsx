import type { Metadata } from "next";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import RunHistoryClient from "./history-client";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/runs"),
  title: "Run history",
  description:
    "Every run this workspace has recorded: which agent fired, what triggered it, how long it took, and what it cost.",
};

export default function RunsPage(): React.JSX.Element {
  return <RunHistoryClient />;
}
