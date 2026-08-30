import { StudioAgentDetail } from "@/components/portfolio/StudioAgentDetail";
import "../../chrome.css";
import "../../site.css";

export default async function PortfolioAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudioAgentDetail id={id} />;
}
