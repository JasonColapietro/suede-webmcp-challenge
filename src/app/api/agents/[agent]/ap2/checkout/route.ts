/**
 * Merchant checkout quote for the experimental AP2 v0.2 profile.
 * Delegates to the canonical run preflight so company gates, input contracts,
 * payout resolution, and immutable Live deployment selection cannot drift.
 */
import { POST as runPublishedAgent } from "@/app/api/agents/[agent]/run/route";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ agent: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { agent } = await context.params;
  const url = new URL(`/api/agents/${encodeURIComponent(agent)}/run`, SITE_URL);
  url.searchParams.set("ap2Checkout", "1");
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["x-forwarded-for", "x-real-ip", "user-agent", "traceparent"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return runPublishedAgent(new Request(url, {
    method: "POST",
    headers,
    body: await request.text(),
  }), context);
}
