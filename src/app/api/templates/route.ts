/**
 * GET /api/templates — lists the seed templates, or returns a single template
 * (with its full graph) when a ?slug= query param is provided.
 */
import { NextResponse } from "next/server";
import { SEED_TEMPLATES, getTemplate } from "@/lib/templates";
import { describeCron } from "@/lib/cron";
import { isPublicTemplateMarketingAllowed } from "@/lib/marketing-holds";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get("slug");

  if (slug !== null) {
    const template = getTemplate(slug);
    if (template === undefined) {
      return NextResponse.json({ error: "template not found" }, { status: 404 });
    }
    return NextResponse.json({ template });
  }

  const templates = SEED_TEMPLATES.filter((template) =>
    isPublicTemplateMarketingAllowed(template.slug),
  ).map((template) => {
    const scheduleNode = template.graph.nodes.find((n) => n.type === "schedule");
    const cron = typeof scheduleNode?.params.cron === "string" ? scheduleNode.params.cron : null;
    return {
      slug: template.slug,
      name: template.name,
      pitch: template.pitch,
      description: template.description,
      suggestedPriceUsdc: template.suggestedPriceUsdc,
      cadence: cron ? describeCron(cron) : null,
    };
  });
  return NextResponse.json({ templates });
}
