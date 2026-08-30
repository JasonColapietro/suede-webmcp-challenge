import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function migration(name: string): string {
  return readFileSync(
    join(process.cwd(), "docs/migrations", name),
    "utf8",
  ).replace(/\s+/gu, " ").toLowerCase();
}

function executableSql(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
}

const siteVerifications = migration("site-verifications.sql");
const healthChecks = migration("health-checks.sql");
const companyCeoMessages = migration(
  "company-ceo-messages-production-shared-runtime.sql",
);
const companyCeoContractGuard = migration(
  "company-ceo-shared-runtime-contract-v1.sql",
);
const settlementDefault = migration("settlement-live-default-false.sql");
const settlementDefaultStatements = executableSql(
  readFileSync(
    join(
      process.cwd(),
      "docs/migrations/settlement-live-default-false.sql",
    ),
    "utf8",
  ),
);

describe("prepared operational production migrations", () => {
  for (const [name, source] of [
    ["site verifications", siteVerifications],
    ["health checks", healthChecks],
    ["Company CEO messages", companyCeoMessages],
  ] as const) {
    it(`${name} extends only the reviewed shared-runtime boundary`, () => {
      expect(source).toContain(
        "to_regprocedure('agent_studio_private.request_authorized()')",
      );
      expect(source).toContain(
        "authorizer_security_definer is distinct from true",
      );
      expect(source).toContain(
        "search_path=pg_catalog, public, extensions",
      );
      expect(source).toContain("schema_revision = 'shared-runtime-v2'");
      expect(source).toContain("secret_hash ~ '^[0-9a-f]{64}$'");
      expect(source).toContain(
        "has_schema_privilege('anon', 'agent_studio_private', 'usage')",
      );
      expect(source).toContain(
        "using (agent_studio_private.request_authorized()) with check (agent_studio_private.request_authorized())",
      );
      expect(source).not.toContain("to authenticated");
      expect(source.startsWith("--")).toBe(true);
      expect(source).toContain("begin;");
      expect(source.trimEnd().endsWith("commit;")).toBe(true);
    });
  }

  it("keeps site proofs mutable only through the server request role", () => {
    expect(siteVerifications).toContain(
      "grant select, insert, update on table public.site_verifications to anon, service_role",
    );
    expect(siteVerifications).toContain(
      "revoke delete on table public.site_verifications from anon, service_role",
    );
    expect(siteVerifications).toContain(
      "site-verifications primary-key drift",
    );
    expect(siteVerifications).toContain(
      "site-verifications privilege readback failed",
    );
  });

  it("keeps health evidence append-only for every runtime role", () => {
    expect(healthChecks).toContain(
      "grant select, insert on table public.health_checks to anon, service_role",
    );
    expect(healthChecks).toContain(
      "revoke update, delete on table public.health_checks from anon, service_role",
    );
    expect(healthChecks).toContain("health-checks index inventory drift");
    expect(healthChecks).toContain(
      "health-checks privilege readback failed",
    );
  });

  it("opens Company CEO history only through the existing server request boundary", () => {
    expect(companyCeoMessages).toContain(
      "company ceo messages column inventory drift",
    );
    expect(companyCeoMessages).toContain(
      "company ceo messages constraint inventory drift",
    );
    expect(companyCeoMessages).toContain(
      "company ceo messages index inventory drift",
    );
    expect(companyCeoMessages).toContain(
      "company ceo messages pre-apply acl drift",
    );
    expect(companyCeoMessages).toContain(
      "company ceo messages policy readback failed",
    );
    expect(companyCeoMessages).toContain(
      "grant select, insert on table public.company_ceo_messages to anon, service_role",
    );
    expect(companyCeoMessages).toContain(
      "grant usage on sequence public.company_ceo_messages_seq_seq to anon, service_role",
    );
    expect(companyCeoMessages).toContain(
      "revoke all privileges on table public.company_ceo_messages from public, anon, authenticated, service_role",
    );
    expect(companyCeoMessages).toContain(
      "revoke all privileges on sequence public.company_ceo_messages_seq_seq from public, anon, authenticated, service_role",
    );
    expect(companyCeoMessages).not.toContain("to authenticated");
    expect(companyCeoMessages).not.toMatch(/\b(?:update|delete from|truncate)\s+public\.company_ceo_messages\b/gu);
  });

  it("keeps the versioned Company CEO dependency guard validation-only", () => {
    expect(companyCeoContractGuard).toContain(
      "company ceo shared-runtime security contract guard v1",
    );
    expect(companyCeoContractGuard).toContain(
      "pg_get_userbyid(schemas.nspowner) = 'postgres'",
    );
    expect(companyCeoContractGuard).toContain(
      "authorizer_owner is distinct from 'postgres'",
    );
    expect(companyCeoContractGuard).toContain(
      "agent studio shared-runtime marker owner or rls drift",
    );
    expect(companyCeoContractGuard).toContain(
      "agent studio shared-runtime marker policy drift",
    );
    expect(companyCeoContractGuard).toContain(
      "agent studio shared-runtime marker acl drift",
    );
    expect(executableSql(
      readFileSync(
        join(
          process.cwd(),
          "docs/migrations/company-ceo-shared-runtime-contract-v1.sql",
        ),
        "utf8",
      ),
    )).not.toMatch(
      /(?:^|;)\s*(?:create|alter|drop|grant|revoke|insert|update|delete|truncate|comment)\b/gu,
    );
  });

  it("changes only the future Agent settlement default", () => {
    expect(settlementDefault).toContain(
      "alter table agents alter column settlement_live set default false",
    );
    expect(settlementDefaultStatements).not.toMatch(
      /\b(?:update|delete from|truncate|drop)\b/gu,
    );
  });
});
