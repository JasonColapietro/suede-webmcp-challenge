import { POST as runPublishedAgent } from "@/app/api/agents/[agent]/run/route";
import {
  handleA2ASendMessage,
  type A2AAgentRouteContext,
} from "@/lib/discovery/a2a-http-json";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: A2AAgentRouteContext,
): Promise<Response> {
  return handleA2ASendMessage(request, context, runPublishedAgent);
}
