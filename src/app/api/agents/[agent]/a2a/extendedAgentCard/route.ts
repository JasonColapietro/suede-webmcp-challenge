import {
  unsupportedA2AOperation,
  validateA2AAgent,
  type A2AAgentRouteContext,
} from "@/lib/discovery/a2a-http-json";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: A2AAgentRouteContext,
): Promise<Response> {
  const unavailable = await validateA2AAgent(context);
  if (unavailable) return unavailable;
  return unsupportedA2AOperation(request, "GetExtendedAgentCard");
}
