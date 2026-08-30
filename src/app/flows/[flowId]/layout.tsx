import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent",
  description:
    "Everything one agent is and does: price, schedule, earnings, runs, and every way to change it.",
};

export default function AgentHubLayout({ children }: { children: React.ReactNode }): React.ReactNode {
  return children;
}
