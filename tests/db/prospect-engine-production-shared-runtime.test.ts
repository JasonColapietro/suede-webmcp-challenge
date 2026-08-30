import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "docs/migrations/prospect-engine-production-shared-runtime.sql"),
  "utf8",
);
const normalized = sql.replace(/\s+/gu, " ").toLowerCase();
const repository = readFileSync(
  join(process.cwd(), "src/lib/db/supabase-repo.ts"),
  "utf8",
);
const serverClient = readFileSync(
  join(process.cwd(), "src/lib/db/supabase-server-client.ts"),
  "utf8",
);
const baseMigration = readFileSync(
  join(process.cwd(), "docs/migrations/prospect-engine-records.sql"),
  "utf8",
).replace(/\s+/gu, " ").toLowerCase();

describe("Prospect Engine shared Supabase runtime bridge", () => {
  it("pairs the private base table with the server-only shared client", () => {
    expect(baseMigration).toContain("create table if not exists public.prospect_records");
    expect(baseMigration).toContain("create table if not exists public.prospect_recipient_suppressions");
    expect(baseMigration).toContain("agent_studio_update_prospect_unless_suppressed");
    expect(baseMigration).toContain("enable row level security");
    expect(baseMigration).toContain("unique (owner_id, domain)");
    expect(repository).toContain("createServerSupabaseClient");
    expect(repository).toContain('.from("prospect_records")');
    expect(serverClient).toContain("return resolveSharedSupabaseServerConfiguration()");
    expect(serverClient).toContain('"x-agent-studio-secret"');
  });

  it("fails closed unless the reviewed shared-runtime boundary and table shape exist", () => {
    expect(normalized).toContain("to_regclass('public.prospect_records')");
    expect(normalized).toContain("to_regprocedure('agent_studio_private.request_authorized()')");
    expect(normalized).toContain("authorizer_security_definer is distinct from true");
    expect(normalized).toContain("search_path=pg_catalog, public, extensions");
    expect(normalized).toContain("schema_revision = 'shared-runtime-v2'");
    expect(normalized).toContain("secret_hash ~ '^[0-9a-f]{64}$'");
    expect(normalized).toContain("has_schema_privilege('anon', 'agent_studio_private', 'usage')");
    expect(normalized).toContain("prospect records table must have rls enabled");
    expect(normalized).toContain("prospect records column inventory drift");
    expect(normalized).toContain("prospect records index inventory drift");
    expect(normalized).toContain("prospect records owner-domain constraint drift");
    expect(normalized).toContain("prospect records table has unexpected rls policies");
    expect(normalized).toContain("prospect suppression registry column inventory drift");
    expect(normalized).toContain("prospect suppression registry primary key drift");
    expect(normalized).toContain("prospect suppression registry check constraint drift");
    expect(normalized).toContain("prospect suppression function security readback failed");
  });

  it("extends only the server request-secret policy to prospect records", () => {
    expect(normalized).toContain(
      "create policy agent_studio_server_access on public.prospect_records for all to anon using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())",
    );
    expect(normalized).not.toContain("to authenticated");
    expect(normalized).toContain("create policy agent_studio_server_access on public.prospect_recipient_suppressions for all to anon");
  });

  it("allows bounded record operations and reads back closed destructive access", () => {
    expect(normalized).toContain(
      "revoke all privileges on table public.prospect_records from public, anon, authenticated, service_role;",
    );
    expect(normalized).toContain(
      "grant select, insert, update on table public.prospect_records to anon, service_role;",
    );
    expect(normalized).toContain(
      "revoke delete on table public.prospect_records from anon, service_role;",
    );
    expect(normalized).toContain("prospect records shared-runtime policy readback failed");
    expect(normalized).toContain("prospect records shared-runtime privilege readback failed");
    expect(normalized).toContain("prospect suppression registry privilege readback failed");
  });
});
