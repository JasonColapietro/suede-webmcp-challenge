/**
 * GET /api/companies/templates — public template metadata for the founding
 * picker on /company: slug, name, mission, pitch, and department names with
 * employee counts. Never sends AgentManifests to the client; those
 * materialize server-side only when a template is founded
 * (POST /api/companies { templateSlug }).
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 12 ("create the company dashboard shell").
 */
import { NextResponse } from "next/server";
import { COMPANY_TEMPLATES } from "@/lib/company/templates";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const templates = COMPANY_TEMPLATES.map((template) => ({
    slug: template.slug,
    name: template.name,
    mission: template.mission,
    pitch: template.pitch,
    departments: template.departments.map((department) => ({
      name: department.name,
      employeeCount: department.employees.length,
    })),
  }));
  return NextResponse.json({ templates });
}
