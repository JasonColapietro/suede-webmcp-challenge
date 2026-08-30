import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "docs/migrations/company-v1-production-shared-runtime.sql"),
  "utf8",
);
const normalized = sql.replace(/\s+/gu, " ").toLowerCase();

describe("Company v1 shared Supabase runtime bridge", () => {
  it("fails closed unless the reviewed shared-runtime boundary exists", () => {
    expect(normalized).toContain("to_regprocedure('agent_studio_private.request_authorized()')");
    expect(normalized).toContain("schema_revision = 'shared-runtime-v2'");
    expect(normalized).toContain("company v1 table must have rls enabled");
    expect(normalized).toContain("company v1 guided rpc must remain security invoker");
  });

  it("extends the request-secret policy to every Company v1 table", () => {
    for (const table of [
      "settlements",
      "companies",
      "company_departments",
      "company_employees",
      "company_approvals",
    ]) {
      expect(normalized).toContain(`'${table}'`);
    }
    expect(normalized).toContain(
      "create policy agent_studio_server_access on public.%i for all to anon using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())",
    );
  });

  it("allows only the server request role and keeps destructive access closed", () => {
    expect(normalized).toContain(
      "grant select, insert, update on table public.settlements, public.companies, public.company_departments, public.company_employees, public.company_approvals to anon, service_role;",
    );
    expect(normalized).toContain(
      "revoke delete on table public.settlements, public.companies, public.company_departments, public.company_employees, public.company_approvals from anon, service_role;",
    );
    expect(normalized).toContain(
      "revoke all on function public.agent_studio_mutate_guided_flow( text, uuid, timestamptz, text, jsonb, numeric, text ) from public, authenticated;",
    );
    expect(normalized).toContain(
      "grant execute on function public.agent_studio_mutate_guided_flow( text, uuid, timestamptz, text, jsonb, numeric, text ) to anon, service_role;",
    );
    expect(normalized).not.toContain("to public, anon, authenticated");
  });
});
