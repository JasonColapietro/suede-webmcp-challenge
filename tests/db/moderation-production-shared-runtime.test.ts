import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "docs/migrations/moderation-production-shared-runtime.sql"),
  "utf8",
);
const normalized = sql.replace(/\s+/gu, " ").toLowerCase();

describe("moderation shared Supabase runtime bridge", () => {
  it("fails closed unless the reviewed shared-runtime boundary exists", () => {
    expect(normalized).toContain("to_regclass('public.moderation_reports')");
    expect(normalized).toContain("to_regprocedure('agent_studio_private.request_authorized()')");
    expect(normalized).toContain("authorizer_security_definer is distinct from true");
    expect(normalized).toContain("search_path=pg_catalog, public, extensions");
    expect(normalized).toContain("schema_revision = 'shared-runtime-v2'");
    expect(normalized).toContain("secret_hash ~ '^[0-9a-f]{64}$'");
    expect(normalized).toContain("has_schema_privilege('anon', 'agent_studio_private', 'usage')");
    expect(normalized).toContain("moderation table must have rls enabled");
    expect(normalized).toContain("moderation table column inventory drift");
    expect(normalized).toContain("moderation table index inventory drift");
    expect(normalized).toContain("moderation table has unexpected rls policies");
  });

  it("extends only the server request-secret policy to moderation reports", () => {
    expect(normalized).toContain(
      "create policy agent_studio_server_access on public.moderation_reports for all to anon using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())",
    );
    expect(normalized).not.toContain("to authenticated");
  });

  it("allows bounded queue operations while keeping destructive access closed", () => {
    expect(normalized).toContain(
      "grant select, insert, update on table public.moderation_reports to anon, service_role;",
    );
    expect(normalized).toContain(
      "revoke delete on table public.moderation_reports from anon, service_role;",
    );
    expect(normalized).toContain(
      "revoke all privileges on table public.moderation_reports from public, anon, authenticated, service_role;",
    );
    expect(normalized).toContain("moderation shared-runtime privilege readback failed");
  });
});
