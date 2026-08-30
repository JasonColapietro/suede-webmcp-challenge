import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const integrationEnabled =
  process.env.AGENT_STUDIO_AIRBYTE_POSTGRES_INTEGRATION === "1"
  || process.env.AGENT_STUDIO_AIRBYTE_POSTGRES17_INTEGRATION === "1";
const postgres17Enabled =
  process.env.AGENT_STUDIO_AIRBYTE_POSTGRES17_INTEGRATION === "1";
const integrationSuite = integrationEnabled
  ? describe.sequential
  : describe.skip;
const migrationPath = join(
  process.cwd(),
  "docs/migrations/agent-studio-airbyte-source.sql",
);
const triggerDisableRollbackPath = join(
  process.cwd(),
  "docs/migrations/agent-studio-airbyte-source-disable-triggers.sql",
);
const stripeRevenueMigrationPath = join(
  process.cwd(),
  "docs/migrations/agent-studio-stripe-revenue-source.sql",
);
const resourceMigrationPath = join(
  process.cwd(),
  "docs/migrations/agent-resource-foundry.sql",
);
const stripeRevenueWriteStopPath = join(
  process.cwd(),
  "docs/migrations/agent-studio-stripe-revenue-source-disable-writes.sql",
);
const migrationOwner = "agent_studio_migration_owner";

const fixture = String.raw`
create role agent_studio_migration_owner
  login
  createrole
  nosuperuser
  nocreatedb
  noreplication
  nobypassrls;
alter role agent_studio_migration_owner
  set createrole_self_grant = 'inherit,set';
grant create on database postgres to agent_studio_migration_owner;
grant usage, create on schema public to agent_studio_migration_owner;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema agent_studio_private;
create schema extensions;
create extension pgcrypto with schema extensions;

create table public.agent_studio_runtime_secrets (
  id text primary key,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  schema_revision text not null check (schema_revision = 'shared-runtime-v2'),
  updated_at timestamptz not null default now()
);
alter table public.agent_studio_runtime_secrets
  owner to agent_studio_migration_owner;
insert into public.agent_studio_runtime_secrets (
  id,
  secret_hash,
  schema_revision
)
values (
  'primary',
  encode(extensions.digest('integration-request-secret', 'sha256'), 'hex'),
  'shared-runtime-v2'
);
alter table public.agent_studio_runtime_secrets enable row level security;
create policy agent_studio_runtime_secrets_deny_all
on public.agent_studio_runtime_secrets
as permissive
for all
to anon
using (false)
with check (false);
revoke all privileges on table public.agent_studio_runtime_secrets
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.agent_studio_runtime_secrets
  to service_role;

create or replace function agent_studio_private.request_authorized()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
  select exists (
    select 1
    from public.agent_studio_runtime_secrets secrets
    where secrets.id = 'primary'
      and secrets.secret_hash = encode(
        extensions.digest(
          coalesce(
            coalesce(current_setting('request.headers', true), '{}')::jsonb
              ->> 'x-agent-studio-secret',
            ''
          ),
          'sha256'
        ),
        'hex'
      )
  );
$$;
alter function agent_studio_private.request_authorized()
  owner to agent_studio_migration_owner;
revoke all privileges on schema agent_studio_private
  from public, authenticated;
grant usage on schema agent_studio_private
  to anon, service_role, agent_studio_migration_owner;
revoke all privileges on function
  agent_studio_private.request_authorized()
  from public, anon, authenticated, service_role;
grant execute on function
  agent_studio_private.request_authorized()
  to anon, service_role, agent_studio_migration_owner;

create schema vault;

create table vault.secrets (
  id uuid primary key default extensions.gen_random_uuid(),
  secret text not null,
  name text not null unique,
  description text
);

create view vault.decrypted_secrets as
select
  secrets.id,
  secrets.name,
  secrets.description,
  secrets.secret as decrypted_secret
from vault.secrets as secrets;

create function vault.create_secret(
  p_secret text,
  p_name text,
  p_description text,
  p_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_id uuid := coalesce(p_id, extensions.gen_random_uuid());
begin
  insert into vault.secrets (id, secret, name, description)
  values (v_id, p_secret, p_name, p_description);
  return v_id;
end
$function$;
revoke all privileges on function
  vault.create_secret(text, text, text, uuid)
  from public;
grant usage on schema extensions, vault
  to agent_studio_migration_owner;
grant select on table vault.secrets, vault.decrypted_secrets
  to agent_studio_migration_owner;
grant execute on function
  vault.create_secret(text, text, text, uuid)
  to agent_studio_migration_owner;
grant execute on function
  extensions.gen_random_bytes(integer),
  extensions.hmac(bytea, bytea, text)
  to agent_studio_migration_owner;

create table public.agents (
  id uuid not null,
  flow_id uuid not null,
  status text not null,
  slug text not null default '',
  price_usdc double precision not null default 0,
  settlement_live boolean not null default false,
  created_at timestamp with time zone not null
);

create table public.flows (
  id uuid primary key,
  owner_id text not null,
  name text not null default '',
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  updated_at bigint not null default 0
);

create table public.runs (
  id uuid not null,
  flow_id uuid not null,
  agent_id uuid,
  trigger text not null,
  status text not null,
  started_at timestamp with time zone not null,
  finished_at timestamp with time zone,
  settled_at text
);

create table public.deployments (
  id uuid not null,
  flow_id uuid not null,
  flow_version_id uuid not null,
  environment_id uuid not null,
  status text not null,
  retired_at timestamp with time zone,
  created_at timestamp with time zone not null
);

create table public.environments (
  id uuid not null,
  kind text not null
);

create table public.flow_versions (
  id uuid not null,
  flow_id uuid,
  version_number integer not null,
  graph jsonb,
  semantic_hash text,
  full_hash text,
  created_by text
);

create table public.dependency_pins (
  flow_version_id uuid not null,
  kind text not null,
  resource_id text not null,
  version text not null,
  content_hash text not null
);

create table public.settlements (
  run_id text not null,
  agent_id text not null,
  owner_id text,
  gross_usdc double precision,
  tx text,
  created_at text not null
);

create table public.credits (
  id text primary key,
  owner_id text not null,
  delta_usdc numeric(20, 8) not null,
  reason text not null,
  tx text,
  created_at text not null
);

create table public.connections (
  id uuid primary key,
  owner_id text not null,
  lifecycle_revision bigint not null default 0,
  updated_at bigint not null
);

create table public.wallets (
  owner_id text primary key
);

create function public.agent_studio_adopt_owner(
  p_from_owner_id text,
  p_to_owner_id text
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $function$
begin
  update public.credits
  set owner_id = p_to_owner_id
  where owner_id = p_from_owner_id;
end
$function$;

create function public.agent_studio_adopt_owner_with_connections(
  p_from_owner_id text,
  p_to_owner_id text
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $function$
begin
  perform public.agent_studio_adopt_owner(
    p_from_owner_id,
    p_to_owner_id
  );
  update public.connections
  set
    owner_id = p_to_owner_id,
    lifecycle_revision = lifecycle_revision + 1,
    updated_at = updated_at + 1
  where owner_id = p_from_owner_id;
end
$function$;

alter table public.agents
  owner to agent_studio_migration_owner;
alter table public.flows
  owner to agent_studio_migration_owner;
alter table public.runs
  owner to agent_studio_migration_owner;
alter table public.deployments
  owner to agent_studio_migration_owner;
alter table public.environments
  owner to agent_studio_migration_owner;
alter table public.flow_versions
  owner to agent_studio_migration_owner;
alter table public.dependency_pins
  owner to agent_studio_migration_owner;
alter table public.settlements
  owner to agent_studio_migration_owner;
alter table public.credits
  owner to agent_studio_migration_owner;
alter table public.connections
  owner to agent_studio_migration_owner;
alter table public.wallets
  owner to agent_studio_migration_owner;
alter function public.agent_studio_adopt_owner(text, text)
  owner to agent_studio_migration_owner;
alter function
  public.agent_studio_adopt_owner_with_connections(text, text)
  owner to agent_studio_migration_owner;
revoke all privileges on function
  public.agent_studio_adopt_owner(text, text),
  public.agent_studio_adopt_owner_with_connections(text, text)
  from public, authenticated;
grant execute on function
  public.agent_studio_adopt_owner(text, text),
  public.agent_studio_adopt_owner_with_connections(text, text)
  to anon, service_role, agent_studio_migration_owner;
`;

type PsqlSession = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  complete: Promise<string>;
};

integrationSuite(
  "Agent Studio Airbyte settlement concurrency (PostgreSQL)",
  () => {
    let root = "";
    let dataDirectory = "";
    let socketDirectory = "";
    let logPath = "";
    let port = 0;
    let dockerContainer = "";

    const psqlArgs = (user = "postgres") => [
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      socketDirectory,
      "-p",
      String(port),
      "-U",
      user,
      "-d",
      "postgres",
    ];

    const runPsql = (
      sql: string,
      user = "postgres",
    ): string =>
      execFileSync("psql", psqlArgs(user), {
        encoding: "utf8",
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: "5",
        },
        input: sql,
        timeout: 30_000,
      }).trim();

    const runPsqlFile = (
      path: string,
      user: string,
    ): string =>
      execFileSync("psql", [...psqlArgs(user), "--file", path], {
        encoding: "utf8",
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: "5",
        },
        timeout: 30_000,
      }).trim();

    const runPsqlFileFailure = (
      path: string,
      user: string,
    ): { status: number | null; stderr: string } => {
      const result = spawnSync(
        "psql",
        [...psqlArgs(user), "--file", path],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PGCONNECT_TIMEOUT: "5",
          },
          timeout: 30_000,
        },
      );
      if (result.error !== undefined) {
        throw result.error;
      }
      return {
        status: result.status,
        stderr: result.stderr,
      };
    };

    const runPsqlFailure = (
      sql: string,
      user = "postgres",
    ): { status: number | null; stderr: string } => {
      const result = spawnSync(
        "psql",
        psqlArgs(user),
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PGCONNECT_TIMEOUT: "5",
          },
          input: sql,
          timeout: 30_000,
        },
      );
      if (result.error !== undefined) {
        throw result.error;
      }
      return {
        status: result.status,
        stderr: result.stderr,
      };
    };

    const runMigration = (): string =>
      runPsqlFile(migrationPath, migrationOwner);

    const runTriggerDisableRollback = (): string =>
      runPsqlFile(triggerDisableRollbackPath, migrationOwner);

    const runStripeRevenueMigration = (): string =>
      runPsqlFile(stripeRevenueMigrationPath, migrationOwner);

    const runResourceMigration = (): string =>
      runPsqlFile(resourceMigrationPath, migrationOwner);

    const runStripeRevenueWriteStop = (): string =>
      runPsqlFile(stripeRevenueWriteStopPath, migrationOwner);

    const startPsql = (
      sql: string,
      readyMarker?: string,
      user = "postgres",
    ): PsqlSession => {
      const child = spawn("psql", psqlArgs(user), {
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: "5",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let resolveReady: (() => void) | undefined;
      let rejectReady: ((error: Error) => void) | undefined;
      let markerObserved = readyMarker === undefined;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
        if (markerObserved) {
          resolve();
        }
      });
      const complete = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`psql timed out\n${stdout}\n${stderr}`));
        }, 30_000);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (
            !markerObserved
            && readyMarker !== undefined
            && stdout.includes(readyMarker)
          ) {
            markerObserved = true;
            resolveReady?.();
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          clearTimeout(timeout);
          rejectReady?.(error);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            if (!markerObserved) {
              rejectReady?.(
                new Error(
                  `psql exited before marker ${readyMarker}\n${stdout}\n${stderr}`,
                ),
              );
            }
            resolve(stdout.trim());
          } else {
            const error = new Error(
              `psql exited ${code}\n${stdout}\n${stderr}`,
            );
            rejectReady?.(error);
            reject(error);
          }
        });
      });
      child.stdin.end(sql);
      return { child, ready, complete };
    };

    const seedRun = (runId: string, agentId: string): void => {
      runPsql(`
        insert into public.agents (
          id,
          flow_id,
          status,
          created_at
        ) values (
          '${agentId}',
          '22222222-2222-4222-8222-222222222222',
          'live',
          pg_catalog.clock_timestamp()
        );
        insert into public.runs (
          id,
          flow_id,
          agent_id,
          trigger,
          status,
          started_at
        ) values (
          '${runId}',
          '22222222-2222-4222-8222-222222222222',
          '${agentId}',
          'agent',
          'done',
          pg_catalog.clock_timestamp()
        );
      `);
    };

    const evidenceCounts = (
      runId: string,
      agentId: string,
    ): string =>
      runPsql(`
        select
          (
            select pg_catalog.count(*)
            from public.settlements
            where run_id = '${runId}'
              and agent_id = '${agentId}'
          )
          || '|' ||
          (
            select pg_catalog.count(*)
            from public.runs
            where id = '${runId}'
              and settled_at is not null
          )
          || '|' ||
          (
            select pg_catalog.count(*)
            from airbyte_source_private.agent_outcome_events
            where event_name = 'paid_call_settled'
              and source_key_hash =
                airbyte_source_private.hmac_sha256(
                  'agent_studio_db:source:settlement',
                  '${runId}'
                )
          );
      `);

    beforeAll(() => {
      if (postgres17Enabled) {
        dockerContainer = `agent-studio-airbyte-pg17-${process.pid}`;
        execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "--detach",
            "--name",
            dockerContainer,
            "--env",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "--publish",
            "127.0.0.1::5432",
            "postgres:17-alpine",
          ],
          { stdio: "pipe", timeout: 60_000 },
        );
        const mapping = execFileSync(
          "docker",
          ["port", dockerContainer, "5432/tcp"],
          { encoding: "utf8", timeout: 30_000 },
        ).trim();
        const parsedPort = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
        if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
          throw new Error(`Could not parse Docker PostgreSQL port: ${mapping}`);
        }
        socketDirectory = "127.0.0.1";
        port = parsedPort;

        let ready = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            execFileSync(
              "docker",
              [
                "exec",
                dockerContainer,
                "pg_isready",
                "--username=postgres",
                "--dbname=postgres",
              ],
              { stdio: "pipe", timeout: 5_000 },
            );
            ready = true;
            break;
          } catch {
            Atomics.wait(
              new Int32Array(new SharedArrayBuffer(4)),
              0,
              0,
              250,
            );
          }
        }
        if (!ready) {
          throw new Error("Disposable PostgreSQL 17 did not become ready");
        }
        ready = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            ready = runPsql("select 1;") === "1";
            if (ready) {
              break;
            }
          } catch {
            Atomics.wait(
              new Int32Array(new SharedArrayBuffer(4)),
              0,
              0,
              250,
            );
          }
        }
        if (!ready) {
          throw new Error(
            "Disposable PostgreSQL 17 host connection did not become ready",
          );
        }
      } else {
        // PostgreSQL limits Unix socket paths to roughly 100 bytes. macOS
        // expands os.tmpdir() under /var/folders, so keep this explicit root
        // short enough for the socket filename on every supported Unix host.
        root = mkdtempSync("/tmp/agent-studio-airbyte-pg-");
        dataDirectory = join(root, "data");
        socketDirectory = join(root, "socket");
        logPath = join(root, "postgres.log");
        port = 55_432 + (process.pid % 1_000);
        mkdirSync(socketDirectory);
        execFileSync(
          "initdb",
          [
            "-D",
            dataDirectory,
            "--auth=trust",
            "--username=postgres",
            "--no-locale",
            "--encoding=UTF8",
          ],
          { stdio: "pipe", timeout: 30_000 },
        );
        execFileSync(
          "pg_ctl",
          [
            "-D",
            dataDirectory,
            "-l",
            logPath,
            "-o",
            `-F -c listen_addresses='' -k ${socketDirectory} -p ${port}`,
            "-w",
            "start",
          ],
          { stdio: "pipe", timeout: 30_000 },
        );
      }
      runPsql(fixture);
    }, 120_000);

    afterAll(() => {
      if (dockerContainer !== "") {
        try {
          execFileSync(
            "docker",
            ["rm", "--force", dockerContainer],
            { stdio: "pipe", timeout: 30_000 },
          );
        } catch {
          // The container uses --rm and may already be absent after a failure.
        }
      }
      if (
        dataDirectory !== ""
        && existsSync(join(dataDirectory, "postmaster.pid"))
      ) {
        execFileSync(
          "pg_ctl",
          ["-D", dataDirectory, "-m", "fast", "-w", "stop"],
          { stdio: "pipe", timeout: 30_000 },
        );
      }
      if (root !== "") {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);

    it(
      "applies twice and survives trigger disable/reapply as non-superuser CREATEROLE",
      () => {
        const serverVersion = runPsql(
          "show server_version_num;",
        );
        if (postgres17Enabled) {
          expect(serverVersion).toMatch(/^17\d{4}$/u);
        }
        expect(
          runPsql(
            "select replace(current_setting('createrole_self_grant'), ' ', '');",
            migrationOwner,
          ),
        ).toBe("inherit,set");

        runMigration();
        expect(
          runPsql(`
            select string_agg(
              memberships.roleid::regrole::text || '>' ||
              memberships.member::regrole::text || ':' ||
              memberships.admin_option::text || ':' ||
              memberships.inherit_option::text || ':' ||
              memberships.set_option::text,
              ',' order by
                memberships.roleid::regrole::text,
                memberships.member::regrole::text
            )
            from pg_catalog.pg_auth_members as memberships
            where memberships.roleid =
              'suede_agent_studio_airbyte_reader'::regrole;
          `),
        ).toBe(
          "suede_agent_studio_airbyte_reader>"
          + "agent_studio_migration_owner:true:false:false",
        );
        expect(
          runPsql(`
            select
              pg_catalog.pg_has_role(
                'agent_studio_migration_owner',
                'suede_agent_studio_airbyte_reader',
                'usage'
              )::text || '|' ||
              pg_catalog.pg_has_role(
                'agent_studio_migration_owner',
                'suede_agent_studio_airbyte_reader',
                'set'
              )::text;
          `),
        ).toBe("false|false");

        runPsql(`
          create role suede_agent_studio_airbyte_login
            login
            inherit
            nosuperuser
            nocreatedb
            nocreaterole
            noreplication
            nobypassrls;
          grant suede_agent_studio_airbyte_reader
            to suede_agent_studio_airbyte_login
            with admin false, inherit true, set false;
        `);
        runMigration();

        const exactMemberships = [
          "suede_agent_studio_airbyte_reader>"
          + "agent_studio_migration_owner:true:false:false",
          "suede_agent_studio_airbyte_reader>"
          + "suede_agent_studio_airbyte_login:false:true:false",
        ].join(",");
        const membershipQuery = `
          select string_agg(
            memberships.roleid::regrole::text || '>' ||
            memberships.member::regrole::text || ':' ||
            memberships.admin_option::text || ':' ||
            memberships.inherit_option::text || ':' ||
            memberships.set_option::text,
            ',' order by
              memberships.roleid::regrole::text,
              memberships.member::regrole::text
          )
          from pg_catalog.pg_auth_members as memberships
          where memberships.roleid =
            'suede_agent_studio_airbyte_reader'::regrole;
        `;
        expect(runPsql(membershipQuery)).toBe(exactMemberships);
        expect(
          runPsql(`
            select pg_catalog.count(*)
            from airbyte_source_private.agent_outcome_events;
          `),
        ).toBe("0");

        runPsql(`
          create role agent_studio_rogue_member nologin;
          grant suede_agent_studio_airbyte_reader
            to agent_studio_rogue_member
            with admin false, inherit true, set false;
        `);
        const rejectedMigration = runPsqlFileFailure(
          migrationPath,
          migrationOwner,
        );
        expect(rejectedMigration.status).not.toBe(0);
        expect(rejectedMigration.stderr).toMatch(
          /has unsafe attributes, memberships, or grants/iu,
        );
        runPsql(`
          revoke suede_agent_studio_airbyte_reader
            from agent_studio_rogue_member;
          drop role agent_studio_rogue_member;
        `);

        runTriggerDisableRollback();
        expect(
          runPsql(`
            select pg_catalog.count(*)
            from pg_catalog.pg_trigger as triggers
            where not triggers.tgisinternal
              and triggers.tgname in (
                'agent_studio_airbyte_agents',
                'agent_studio_airbyte_test_runs',
                'agent_studio_airbyte_settled_runs',
                'agent_studio_airbyte_deployments',
                'agent_studio_airbyte_settlements'
              );
          `),
        ).toBe("0");
        expect(
          runPsql(`
            select
              (
                pg_catalog.to_regclass(
                  'airbyte_source_private.agent_outcome_events'
                ) is not null
              )::text || '|' ||
              (
                pg_catalog.to_regclass(
                  'airbyte_source.normalized_agent_outcomes'
                ) is not null
              )::text || '|' ||
              (
                select pg_catalog.count(*)::text
                from vault.secrets
                where name =
                  'suede_agent_studio_airbyte_identity_hmac_v1'
              ) || '|' ||
              (
                select pg_catalog.count(*)::text
                from pg_catalog.pg_trigger as triggers
                where not triggers.tgisinternal
                  and triggers.tgname =
                    'agent_outcome_events_append_only'
              );
          `),
        ).toBe("true|true|1|1");

        runMigration();
        expect(
          runPsql(`
            select pg_catalog.count(*)
            from pg_catalog.pg_trigger as triggers
            where not triggers.tgisinternal
              and triggers.tgname in (
                'agent_studio_airbyte_agents',
                'agent_studio_airbyte_test_runs',
                'agent_studio_airbyte_settled_runs',
                'agent_studio_airbyte_deployments',
                'agent_studio_airbyte_settlements',
                'agent_outcome_events_append_only'
              );
          `),
        ).toBe("6");
        expect(runPsql(membershipQuery)).toBe(exactMemberships);
      },
      60_000,
    );

    it(
      "emits once when the settlement insert starts first",
      async () => {
        const runId = "33333333-3333-4333-8333-333333333331";
        const agentId = "11111111-1111-4111-8111-111111111111";
        seedRun(runId, agentId);

        const settlement = startPsql(
          `
            begin;
            insert into public.settlements (
              run_id,
              agent_id,
              created_at
            ) values (
              '${runId}',
              '${agentId}',
              '2026-07-29T12:00:00.000Z'
            );
            select 'settlement-insert-held';
            select pg_catalog.pg_sleep(1);
            commit;
          `,
          "settlement-insert-held",
        );
        await settlement.ready;
        const settledRun = startPsql(`
          begin;
          update public.runs
          set settled_at = '2026-07-29T12:00:00.000Z'
          where id = '${runId}';
          commit;
        `);

        await Promise.all([
          settlement.complete,
          settledRun.complete,
        ]);
        expect(evidenceCounts(runId, agentId)).toBe("1|1|1");
      },
      30_000,
    );

    it(
      "emits once when the settled run update starts first",
      async () => {
        const runId = "33333333-3333-4333-8333-333333333332";
        const agentId = "11111111-1111-4111-8111-111111111112";
        seedRun(runId, agentId);

        const settledRun = startPsql(
          `
            begin;
            update public.runs
            set settled_at = '2026-07-29T12:00:01.000Z'
            where id = '${runId}';
            select 'settled-run-update-held';
            select pg_catalog.pg_sleep(1);
            commit;
          `,
          "settled-run-update-held",
        );
        await settledRun.ready;
        const settlement = startPsql(`
          begin;
          insert into public.settlements (
            run_id,
            agent_id,
            created_at
          ) values (
            '${runId}',
            '${agentId}',
            '2026-07-29T12:00:01.000Z'
          );
          commit;
        `);

        await Promise.all([
          settledRun.complete,
          settlement.complete,
        ]);
        expect(evidenceCounts(runId, agentId)).toBe("1|1|1");
      },
      30_000,
    );

    it(
      "applies the Stripe receipt source twice and atomically handles refunds behind exact ACLs",
      async () => {
        runPsql(`
          create role agent_studio_revenue_rogue nologin;
          grant suede_agent_studio_airbyte_reader
            to agent_studio_revenue_rogue
            with admin false, inherit true, set false;
        `);
        const rejectedRogue = runPsqlFileFailure(
          stripeRevenueMigrationPath,
          migrationOwner,
        );
        expect(rejectedRogue.status).not.toBe(0);
        expect(rejectedRogue.stderr).toMatch(
          /reader capability or membership is unsafe/iu,
        );
        runPsql(`
          revoke suede_agent_studio_airbyte_reader
            from agent_studio_revenue_rogue;
          drop role agent_studio_revenue_rogue;
          alter table public.credits
            alter column delta_usdc type numeric(20, 7);
        `);
        const rejectedCreditScale = runPsqlFileFailure(
          stripeRevenueMigrationPath,
          migrationOwner,
        );
        expect(rejectedCreditScale.status).not.toBe(0);
        expect(rejectedCreditScale.stderr).toMatch(
          /agent studio credits schema drifted/iu,
        );
        runPsql(`
          alter table public.credits
            alter column delta_usdc type numeric(20, 8);
          insert into public.credits (
            id,
            owner_id,
            delta_usdc,
            reason,
            tx,
            created_at
          ) values
            (
              'historical-stripe-credit-1',
              'owner-historical-pg',
              5,
              'stripe-topup',
              'cs_pgHistorical0001',
              '2026-07-30T12:00:00.000Z'
            ),
            (
              'historical-stripe-credit-2',
              'owner-historical-pg',
              5,
              'stripe-topup',
              'cs_pgHistorical0002',
              '2026-07-30T12:01:00.000Z'
            );
        `);

        // Resource -> Stripe: the Resource migration first owns the shared
        // wrapper, then Stripe must replace only the composition shell while
        // retaining Resource adoption through its domain helper.
        runResourceMigration();
        runResourceMigration();
        expect(runPsql(`
          select
            pg_catalog.to_regprocedure(
              'public.agent_studio_adopt_resource_owner(text,text)'
            ) is not null;
        `)).toBe("t");

        runStripeRevenueMigration();
        runStripeRevenueMigration();

        const stripeWrapperMetadata = (): string => runPsql(`
          select
            functions.proowner::regrole::text || '|' ||
            functions.prosecdef::text || '|' ||
            pg_catalog.array_to_string(functions.proconfig,',')
          from pg_catalog.pg_proc as functions
          where functions.oid=
            'public.agent_studio_adopt_owner_with_connections(text,text)'::regprocedure;
        `);
        const stripeWrapperDefinitionMd5 = (): string => runPsql(`
          select pg_catalog.md5(pg_catalog.pg_get_functiondef(functions.oid))
          from pg_catalog.pg_proc as functions
          where functions.oid=
            'public.agent_studio_adopt_owner_with_connections(text,text)'::regprocedure;
        `);
        const reviewedStripeWrapperMetadata = stripeWrapperMetadata();
        const reviewedStripeWrapperDefinitionMd5 = stripeWrapperDefinitionMd5();

        // Stripe -> Resource must reject a same-owner, same-hardening no-op
        // wrapper before any Resource convergence can become durable.
        runPsql(`
          alter table public.resource_products
            drop constraint resource_products_owner_id_check;
          create or replace function
            public.agent_studio_adopt_owner_with_connections(
              p_from_owner_id text,
              p_to_owner_id text
            )
          returns void
          language plpgsql
          volatile
          security definer
          set search_path = pg_catalog, pg_temp
          set row_security = off
          as $function$
          begin
            return;
          end
          $function$;
        `, migrationOwner);
        expect(stripeWrapperMetadata()).toBe(reviewedStripeWrapperMetadata);
        expect(stripeWrapperDefinitionMd5()).not.toBe(
          reviewedStripeWrapperDefinitionMd5,
        );
        try {
          const rejectedNoopStripeWrapper = runPsqlFileFailure(
            resourceMigrationPath,
            migrationOwner,
          );
          expect(rejectedNoopStripeWrapper.status).not.toBe(0);
          expect(rejectedNoopStripeWrapper.stderr).toMatch(
            /unsafe Stripe owner wrapper/iu,
          );
          expect(runPsql(`
            select pg_catalog.count(*)
            from pg_catalog.pg_constraint as constraints
            where constraints.conrelid='public.resource_products'::regclass
              and constraints.conname='resource_products_owner_id_check';
          `)).toBe("0");
        } finally {
          runStripeRevenueMigration();
          runResourceMigration();
        }
        expect(stripeWrapperDefinitionMd5()).toBe(
          reviewedStripeWrapperDefinitionMd5,
        );

        const adoptOwner = (fromOwner: string, toOwner: string): string =>
          runPsql(`
            begin;
            set local "request.jwt.claim.role"='service_role';
            select public.agent_studio_adopt_owner_with_connections(
              '${fromOwner}',
              '${toOwner}'
            );
            commit;
          `);
        const seedAdoption = (
          suffix: string,
          fromOwner: string,
          slug = `migration-order-${suffix}`,
        ): void => {
          runPsql(`
            insert into public.resource_products (
              id,owner_id,name,slug,status,execution_access,
              discovery_access,created_at,updated_at
            ) values (
              'resource-order-${suffix}',
              '${fromOwner}',
              'Migration order ${suffix}',
              '${slug}',
              'draft','private','unlisted',
              clock_timestamp(),clock_timestamp()
            );
            insert into public.credits (
              id,owner_id,delta_usdc,reason,tx,created_at
            ) values (
              'credit-order-${suffix}',
              '${fromOwner}',1,'migration-order',null,
              '2026-08-15T00:00:00.000Z'
            );
            insert into public.connections (
              id,owner_id,lifecycle_revision,updated_at
            ) values (
              extensions.gen_random_uuid(),
              '${fromOwner}',0,1
            );
          `);
        };
        const adoptionState = (suffix: string, fromOwner: string): string =>
          runPsql(`
            select
              (select owner_id from public.resource_products
                where id='resource-order-${suffix}') || '|' ||
              (select owner_id from public.credits
                where id='credit-order-${suffix}') || '|' ||
              (select owner_id from public.connections
                where owner_id in ('${fromOwner}',
                  (select owner_id from public.resource_products
                    where id='resource-order-${suffix}'))
                order by owner_id limit 1) || '|' ||
              (select pg_catalog.count(*) from
                airbyte_source_private.stripe_owner_adoptions
                where from_owner_id='${fromOwner}');
          `);

        const beforeStripeFrom = "owner-resource-before-stripe-from";
        const beforeStripeTo = "owner-resource-before-stripe-to";
        seedAdoption("before-stripe", beforeStripeFrom);
        adoptOwner(beforeStripeFrom, beforeStripeTo);
        adoptOwner(beforeStripeFrom, beforeStripeTo);
        expect(adoptionState("before-stripe", beforeStripeFrom)).toBe(
          `${beforeStripeTo}|${beforeStripeTo}|${beforeStripeTo}|1`,
        );

        // Stripe -> Resource: reapplying Resource must verify and retain the
        // hardened Stripe wrapper while making its helper immediately visible.
        runResourceMigration();
        expect(runPsql(`
          select functions.prosecdef::text || '|' ||
            pg_catalog.array_to_string(functions.proconfig,',')
          from pg_catalog.pg_proc as functions
          where functions.oid=
            'public.agent_studio_adopt_owner_with_connections(text,text)'::regprocedure;
        `)).toContain("true|search_path=pg_catalog, pg_temp");
        const afterStripeFrom = "owner-resource-after-stripe-from";
        const afterStripeTo = "owner-resource-after-stripe-to";
        seedAdoption("after-stripe", afterStripeFrom);
        adoptOwner(afterStripeFrom, afterStripeTo);
        expect(adoptionState("after-stripe", afterStripeFrom)).toBe(
          `${afterStripeTo}|${afterStripeTo}|${afterStripeTo}|1`,
        );

        // A Resource constraint failure happens after the Stripe helper has
        // tentatively moved credits/connections and inserted the alias. The
        // single function transaction must roll every domain back together.
        const rollbackFrom = "owner-resource-rollback-from";
        const rollbackTo = "owner-resource-rollback-to";
        seedAdoption("rollback-from", rollbackFrom, "rollback-conflict");
        runPsql(`
          insert into public.resource_products (
            id,owner_id,name,slug,status,execution_access,
            discovery_access,created_at,updated_at
          ) values (
            'resource-order-rollback-target',
            '${rollbackTo}','Rollback target','rollback-conflict',
            'draft','private','unlisted',clock_timestamp(),clock_timestamp()
          );
        `);
        const rolledBack = runPsqlFailure(`
          begin;
          set local "request.jwt.claim.role"='service_role';
          select public.agent_studio_adopt_owner_with_connections(
            '${rollbackFrom}',
            '${rollbackTo}'
          );
          commit;
        `);
        expect(rolledBack.status).not.toBe(0);
        expect(runPsql(`
          select
            (select owner_id from public.resource_products
              where id='resource-order-rollback-from') || '|' ||
            (select owner_id from public.credits
              where id='credit-order-rollback-from') || '|' ||
            (select owner_id from public.connections
              where owner_id='${rollbackFrom}') || '|' ||
            (select pg_catalog.count(*) from
              airbyte_source_private.stripe_owner_adoptions
              where from_owner_id='${rollbackFrom}');
        `)).toBe(`${rollbackFrom}|${rollbackFrom}|${rollbackFrom}|0`);
        const backfillRequest = String.raw`{
          "schema_version":"1",
          "project_id":"suede-agent-studio",
          "expected_event_count":"2",
          "expected_total_amount_cents":"1000",
          "events":[
            {
              "slot":1,
              "provider_event_id":"evt_pgHistorical0001",
              "owner_id":"owner-historical-pg",
              "provider_checkout_session_id":"cs_pgHistorical0001",
              "provider_payment_intent_id":"pi_pgHistorical0001",
              "amount_total_cents":500,
              "currency":"USD",
              "terminal_status":"paid",
              "refund_state":"none",
              "provider_product_id":null,
              "provider_price_id":null,
              "occurred_at":"2026-07-30T12:00:00.000Z"
            },
            {
              "slot":2,
              "provider_event_id":"evt_pgHistorical0002",
              "owner_id":"owner-historical-pg",
              "provider_checkout_session_id":"cs_pgHistorical0002",
              "provider_payment_intent_id":"pi_pgHistorical0002",
              "amount_total_cents":500,
              "currency":"USD",
              "terminal_status":"paid",
              "refund_state":"none",
              "provider_product_id":null,
              "provider_price_id":null,
              "occurred_at":"2026-07-30T12:01:00.000Z"
            }
          ]
        }`;
        const callBackfill = (request: string): string => runPsql(`
          select
            backfilled_count::text || '|' ||
            total_amount_cents::text
          from airbyte_source_private.backfill_two_verified_stripe_topups(
            $request$${request}$request$::jsonb
          );
        `, migrationOwner);
        expect(callBackfill(backfillRequest)).toBe("2|1000");
        expect(callBackfill(backfillRequest)).toBe("0|1000");
        const conflictingBackfill = runPsqlFailure(
          `
            select *
            from airbyte_source_private.backfill_two_verified_stripe_topups(
              $request$${backfillRequest.replace(
                "evt_pgHistorical0001",
                "evt_pgHistoricalConflict0001",
              )}$request$::jsonb
            );
          `,
          migrationOwner,
        );
        expect(conflictingBackfill.status).not.toBe(0);
        expect(conflictingBackfill.stderr).toMatch(
          /conflicting stripe backfill replay/iu,
        );
        expect(
          runPsql(`
            select
              (
                select pg_catalog.count(*)::text
                from airbyte_source_private.stripe_revenue_receipts
              ) || '|' || (
                select pg_catalog.sum(amount_total_cents)::text
                from airbyte_source_private.stripe_revenue_receipts
              ) || '|' || (
                select pg_catalog.bool_and(
                  tx not like 'cs_%'
                  and tx like 'stripe-receipt:%'
                )::text
                from public.credits
                where id in (
                  'historical-stripe-credit-1',
                  'historical-stripe-credit-2'
                )
              );
          `),
        ).toBe("2|1000|true");

        const rejectedAnonWriter = runPsqlFailure(`
          set role anon;
          select *
          from public.agent_studio_record_stripe_revenue_event(
            'refund',
            'evt_pgUnauthorized0001',
            null,
            null,
            'pi_pgUnauthorized0001',
            're_pgUnauthorized0001',
            500,
            'USD',
            'succeeded',
            null,
            null,
            pg_catalog.date_trunc(
              'milliseconds',
              pg_catalog.clock_timestamp()
            ),
            null
          );
        `);
        expect(rejectedAnonWriter.status).not.toBe(0);
        expect(rejectedAnonWriter.stderr).toMatch(
          /agent studio stripe writer is unauthorized/iu,
        );
        const rejectedAnonEntitlement = runPsqlFailure(`
          set role anon;
          select public.agent_studio_has_paid_entitlement(
            'owner-private-pg'
          );
        `);
        expect(rejectedAnonEntitlement.status).not.toBe(0);
        expect(rejectedAnonEntitlement.stderr).toMatch(
          /agent studio paid entitlement is unauthorized/iu,
        );
        const rejectedAnonAdoption = runPsqlFailure(`
          set role anon;
          select public.agent_studio_adopt_owner_with_connections(
            'owner-unauthorized-from-pg',
            'owner-unauthorized-to-pg'
          );
        `);
        expect(rejectedAnonAdoption.status).not.toBe(0);
        expect(rejectedAnonAdoption.stderr).toMatch(
          /agent studio owner adoption is unauthorized/iu,
        );
        const rejectedDirectBaseAdoption = runPsqlFailure(`
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select public.agent_studio_adopt_owner(
            'owner-base-bypass-from-pg',
            'owner-base-bypass-to-pg'
          );
        `);
        expect(rejectedDirectBaseAdoption.status).not.toBe(0);
        expect(rejectedDirectBaseAdoption.stderr).toMatch(
          /permission denied for function agent_studio_adopt_owner/iu,
        );
        expect(
          runPsql(`
            set role anon;
            set request.headers =
              '{"x-agent-studio-secret":"integration-request-secret"}';
            select
              recorded::text || '|' ||
              credit_delta_usdc::text || '|' ||
              refund_state
            from public.agent_studio_record_stripe_revenue_event(
              'refund',
              'evt_pgProtectedAnon0001',
              null,
              null,
              'pi_pgProtectedAnon0001',
              're_pgProtectedAnon0001',
              500,
              'USD',
              'succeeded',
              null,
              null,
              pg_catalog.date_trunc(
                'milliseconds',
                pg_catalog.clock_timestamp()
              ),
              null
            );
            reset role;
          `),
        ).toBe("false|0|none");
        expect(
          runPsql(`
            set role anon;
            set request.headers =
              '{"x-agent-studio-secret":"integration-request-secret"}';
            select public.agent_studio_has_paid_entitlement(
              'owner-private-pg'
            )::text;
            reset role;
          `),
        ).toBe("false");
        expect(
          runPsql(`
            set role anon;
            set request.headers =
              '{"x-agent-studio-secret":"integration-request-secret"}';
            select public.agent_studio_adopt_owner_with_connections(
              'owner-protected-anon-from-pg',
              'owner-protected-anon-to-pg'
            );
            reset role;
          `),
        ).toBe("");
        const rejectedAliasMutation = runPsqlFailure(
          `
            update airbyte_source_private.stripe_owner_adoptions
            set to_owner_id = 'owner-alias-mutation-pg'
            where from_owner_id = 'owner-protected-anon-from-pg';
          `,
          migrationOwner,
        );
        expect(rejectedAliasMutation.status).not.toBe(0);
        expect(rejectedAliasMutation.stderr).toMatch(
          /private stripe evidence is append-only/iu,
        );

        const rejectedLegacyCredit = runPsqlFailure(
          `
            insert into public.credits (
              id,
              owner_id,
              delta_usdc,
              reason,
              tx,
              created_at
            ) values (
              'legacy-credit-replay',
              'owner-private-pg',
              5,
              'stripe-topup',
              'cs_pgLegacyReplay0001',
              pg_catalog.clock_timestamp()::text
            );
          `,
          migrationOwner,
        );
        expect(rejectedLegacyCredit.status).not.toBe(0);
        expect(rejectedLegacyCredit.stderr).toMatch(
          /legacy agent studio stripe credit writes are disabled/iu,
        );

        const callWriter = (argumentsSql: string): string => runPsql(`
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select
            recorded::text || '|' ||
            credit_delta_usdc::text || '|' ||
            refund_state
          from public.agent_studio_record_stripe_revenue_event(
            ${argumentsSql}
          );
          reset role;
        `);
        const callEntitlement = (ownerId: string): string => runPsql(`
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select public.agent_studio_has_paid_entitlement(
            '${ownerId}'
          )::text;
          reset role;
        `);
        expect(callWriter(`
          'payment',
          'evt_pgPayment0001',
          'owner-private-pg',
          'cs_pgPayment0001',
          'pi_pgPayment0001',
          null,
          500,
          'USD',
          'paid',
          'prod_pgGateway0001',
          'price_pgGateway0001',
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp() - interval '4 seconds'
          ),
          5.5
        `)).toBe("true|5.50000000|none");
        expect(callEntitlement("owner-private-pg")).toBe("true");

        expect(callWriter(`
          'payment',
          'evt_pgPaymentUpdated0001',
          'owner-private-pg',
          'cs_pgPayment0001',
          'pi_pgPayment0001',
          null,
          500,
          'USD',
          'paid',
          'prod_pgGateway0001',
          'price_pgGateway0001',
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp() - interval '3 seconds'
          ),
          5.5
        `)).toBe("false|5.50000000|none");

        const adoptionFirst = startPsql(
          `
            begin;
            set role service_role;
            set request.jwt.claim.role = 'service_role';
            select public.agent_studio_adopt_owner_with_connections(
              'owner-private-pg',
              'owner-account-pg'
            );
            select 'stripe-adoption-held';
            select pg_catalog.pg_sleep(5);
            commit;
          `,
          "stripe-adoption-held",
        );
        await adoptionFirst.ready;
        const refundAfterAdoptionStarted = startPsql(`
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select
            recorded::text || '|' ||
            credit_delta_usdc::text || '|' ||
            refund_state
          from public.agent_studio_record_stripe_revenue_event(
            'refund',
            'evt_pgRefund0001',
            null,
            null,
            'pi_pgPayment0001',
            're_pgRefund0001',
            200,
            'USD',
            'succeeded',
            null,
            null,
            pg_catalog.date_trunc(
              'milliseconds',
              pg_catalog.clock_timestamp() - interval '2 seconds'
            ),
            null
          );
          reset role;
        `);
        const [, concurrentRefundResult] = await Promise.all([
          adoptionFirst.complete,
          refundAfterAdoptionStarted.complete,
        ]);
        expect(concurrentRefundResult).toBe("true|-2.20000000|partial");
        expect(callEntitlement("owner-account-pg")).toBe("true");
        expect(callWriter(`
          'payment',
          'evt_pgPaymentUpdatedAfterAdoption0001',
          'owner-private-pg',
          'cs_pgPayment0001',
          'pi_pgPayment0001',
          null,
          500,
          'USD',
          'paid',
          'prod_pgGateway0001',
          'price_pgGateway0001',
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp()
          ),
          5.5
        `)).toBe("false|5.50000000|none");

        expect(callWriter(`
          'refund',
          'evt_pgRefundUpdated0001',
          null,
          null,
          'pi_pgPayment0001',
          're_pgRefund0001',
          200,
          'USD',
          'succeeded',
          null,
          null,
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp() - interval '1 second'
          ),
          null
        `)).toBe("false|-2.20000000|partial");

        expect(callWriter(`
          'refund',
          'evt_pgRefund0002',
          null,
          null,
          'pi_pgPayment0001',
          're_pgRefund0002',
          300,
          'USD',
          'succeeded',
          null,
          null,
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp()
          ),
          null
        `)).toBe("true|-3.30000000|full");
        expect(callEntitlement("owner-account-pg")).toBe("false");

        expect(callWriter(`
          'refund',
          'evt_pgForeignRefund0001',
          null,
          null,
          'pi_pgForeignPayment0001',
          're_pgForeignRefund0001',
          500,
          'USD',
          'succeeded',
          null,
          null,
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp()
          ),
          null
        `)).toBe("false|0|none");

        expect(
          runPsql(`
            select
              pg_catalog.count(*)::text || '|' ||
              pg_catalog.sum(delta_usdc)::text || '|' ||
              pg_catalog.bool_and(tx like 'stripe-receipt:%')::text
            from public.credits
            where owner_id = 'owner-account-pg';
          `),
        ).toBe("3|0.00000000|true");
        expect(
          runPsql(`
            select
              coalesce(
                pg_catalog.sum(delta_usdc),
                0::numeric
              )::text
            from public.credits
            where owner_id = 'owner-private-pg';
          `),
        ).toBe("0");
        expect(
          runPsql(`
            select
              event_name || '|' ||
              currency || '|' ||
              gross_amount_cents::text || '|' ||
              status || '|' ||
              refund_state || '|' ||
              (event_id ~ '^[0-9a-f]{64}$')::text || '|' ||
              (account_key ~ '^[0-9a-f]{64}$')::text || '|' ||
              (
                external_transaction_ref ~ '^[0-9a-f]{64}$'
              )::text
            from airbyte_source.normalized_revenue_events
            order by source_revision_at;
          `, "suede_agent_studio_airbyte_login"),
        ).toBe([
          "payment_succeeded|USD|500|succeeded|none|true|true|true",
          "payment_succeeded|USD|500|succeeded|none|true|true|true",
          "payment_succeeded|USD|500|succeeded|none|true|true|true",
          "payment_refunded|USD|-200|refunded|partial|true|true|true",
          "payment_refunded|USD|-300|refunded|full|true|true|true",
        ].join("\n"));
        expect(
          runPsql(`
            select pg_catalog.count(distinct account_key)::text
            from airbyte_source.normalized_revenue_events
            where product_id is not null;
          `, "suede_agent_studio_airbyte_login"),
        ).toBe("1");
        expect(
          runPsql(`
            select
              pg_catalog.has_table_privilege(
                'service_role',
                'airbyte_source.normalized_revenue_events',
                'select'
              )::text || '|' ||
              pg_catalog.has_table_privilege(
                'suede_agent_studio_airbyte_login',
                'airbyte_source_private.stripe_revenue_receipts',
                'select'
              )::text || '|' ||
              pg_catalog.has_function_privilege(
                'service_role',
                'airbyte_source_private.backfill_two_verified_stripe_topups(jsonb)',
                'execute'
              )::text;
          `),
        ).toBe("false|false|false");
        expect(
          runPsql(`
            select
              pg_catalog.has_function_privilege(
                'service_role',
                'public.agent_studio_adopt_owner_with_connections(text,text)',
                'execute'
              )::text || '|' ||
              pg_catalog.has_function_privilege(
                'service_role',
                'public.agent_studio_adopt_owner(text,text)',
                'execute'
              )::text || '|' ||
              pg_catalog.has_function_privilege(
                'anon',
                'public.agent_studio_adopt_owner_with_connections(text,text)',
                'execute'
              )::text || '|' ||
              pg_catalog.has_function_privilege(
                'anon',
                'public.agent_studio_adopt_owner(text,text)',
                'execute'
              )::text;
          `),
        ).toBe("true|false|true|false");

        runPsql(`
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select public.agent_studio_adopt_owner_with_connections(
            'owner-delayed-account-pg',
            'owner-delayed-final-pg'
          );
          reset role;
        `);
        const adoptionBeforeDelayedPayment = startPsql(
          `
            begin;
            set role service_role;
            set request.jwt.claim.role = 'service_role';
            select public.agent_studio_adopt_owner_with_connections(
              'owner-delayed-anonymous-pg',
              'owner-delayed-account-pg'
            );
            select 'stripe-delayed-adoption-held';
            select pg_catalog.pg_sleep(3);
            commit;
          `,
          "stripe-delayed-adoption-held",
        );
        await adoptionBeforeDelayedPayment.ready;
        const delayedPayment = startPsql(`
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select
            recorded::text || '|' ||
            credit_delta_usdc::text || '|' ||
            refund_state
          from public.agent_studio_record_stripe_revenue_event(
            'payment',
            'evt_pgDelayedPayment0001',
            'owner-delayed-anonymous-pg',
            'cs_pgDelayedPayment0001',
            'pi_pgDelayedPayment0001',
            null,
            500,
            'USD',
            'paid',
            'prod_pgGatewayDelayed0001',
            'price_pgGatewayDelayed0001',
            pg_catalog.date_trunc(
              'milliseconds',
              pg_catalog.clock_timestamp() - interval '2 seconds'
            ),
            5
          );
          reset role;
        `);
        const [, delayedPaymentResult] = await Promise.all([
          adoptionBeforeDelayedPayment.complete,
          delayedPayment.complete,
        ]);
        expect(delayedPaymentResult).toBe("true|5.00000000|none");
        expect(callEntitlement("owner-delayed-anonymous-pg")).toBe("false");
        expect(callEntitlement("owner-delayed-account-pg")).toBe("false");
        expect(callEntitlement("owner-delayed-final-pg")).toBe("true");
        expect(
          runPsql(`
            select
              credits.owner_id || '|' || receipts.owner_id
            from airbyte_source_private.stripe_revenue_receipts as receipts
            join public.credits as credits
              on credits.id = receipts.credit_id
            where receipts.provider_payment_intent_id =
              'pi_pgDelayedPayment0001';
          `),
        ).toBe("owner-delayed-final-pg|owner-delayed-final-pg");
        expect(callWriter(`
          'payment',
          'evt_pgDelayedPaymentReplay0001',
          'owner-delayed-anonymous-pg',
          'cs_pgDelayedPayment0001',
          'pi_pgDelayedPayment0001',
          null,
          500,
          'USD',
          'paid',
          'prod_pgGatewayDelayed0001',
          'price_pgGatewayDelayed0001',
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp()
          ),
          5
        `)).toBe("false|5.00000000|none");
        expect(callEntitlement("owner-delayed-account-pg")).toBe("false");
        expect(callEntitlement("owner-delayed-final-pg")).toBe("true");
        expect(
          runPsql(`
            select
              credits.owner_id || '|' || receipts.owner_id
            from airbyte_source_private.stripe_revenue_receipts as receipts
            join public.credits as credits
              on credits.id = receipts.credit_id
            where receipts.provider_payment_intent_id =
              'pi_pgDelayedPayment0001';
          `),
        ).toBe("owner-delayed-final-pg|owner-delayed-final-pg");

        runPsql(`
          insert into public.credits (
            id,
            owner_id,
            delta_usdc,
            reason,
            tx,
            created_at
          ) values (
            'late-canonical-retry-credit',
            'owner-delayed-anonymous-pg',
            1,
            'topup',
            'late-canonical-retry',
            pg_catalog.clock_timestamp()::text
          );
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select public.agent_studio_adopt_owner_with_connections(
            'owner-delayed-anonymous-pg',
            'owner-delayed-final-pg'
          );
          reset role;
        `);
        expect(
          runPsql(`
            select
              adoptions.to_owner_id || '|' || credits.owner_id
            from airbyte_source_private.stripe_owner_adoptions as adoptions
            join public.credits as credits
              on credits.id = 'late-canonical-retry-credit'
            where adoptions.from_owner_id =
              'owner-delayed-anonymous-pg';
          `),
        ).toBe("owner-delayed-account-pg|owner-delayed-final-pg");

        const upstreamDepthOwners = [
          ...Array.from(
            { length: 15 },
            (_, index) => `owner-depth-up-${index}-pg`,
          ),
          "owner-depth-join-pg",
        ];
        const downstreamDepthOwners = [
          ...Array.from(
            { length: 15 },
            (_, index) => `owner-depth-down-${index}-pg`,
          ),
          "owner-depth-terminal-pg",
        ];
        const depthAdoptions: string[] = [];
        for (let index = 0; index < 15; index += 1) {
          depthAdoptions.push(`
            select public.agent_studio_adopt_owner_with_connections(
              '${upstreamDepthOwners[index]}',
              '${upstreamDepthOwners[index + 1]}'
            );
          `);
          depthAdoptions.push(`
            select public.agent_studio_adopt_owner_with_connections(
              '${downstreamDepthOwners[index]}',
              '${downstreamDepthOwners[index + 1]}'
            );
          `);
        }
        runPsql(`
          begin;
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          ${depthAdoptions.join("\n")}
          select public.agent_studio_adopt_owner_with_connections(
            'owner-depth-join-pg',
            'owner-depth-down-0-pg'
          );
          reset role;
          commit;
        `);
        expect(callWriter(`
          'payment',
          'evt_pgDepthPayment0001',
          'owner-depth-up-0-pg',
          'cs_pgDepthPayment0001',
          'pi_pgDepthPayment0001',
          null,
          500,
          'USD',
          'paid',
          'prod_pgGatewayDepth0001',
          'price_pgGatewayDepth0001',
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp()
          ),
          5
        `)).toBe("true|5.00000000|none");
        runPsql(`
          insert into public.connections (
            id,
            owner_id,
            lifecycle_revision,
            updated_at
          ) values (
            '44444444-4444-4444-8444-444444444444',
            'owner-depth-terminal-pg',
            0,
            1
          );
        `);
        const rejectedDepthOverflow = runPsqlFailure(`
          set role service_role;
          set request.jwt.claim.role = 'service_role';
          select public.agent_studio_adopt_owner_with_connections(
            'owner-depth-terminal-pg',
            'owner-depth-overflow-pg'
          );
        `);
        expect(rejectedDepthOverflow.status).not.toBe(0);
        expect(rejectedDepthOverflow.stderr).toMatch(
          /owner adoption chain is too deep/iu,
        );
        expect(
          runPsql(`
            select
              (
                select pg_catalog.count(*)::text
                from airbyte_source_private.stripe_owner_adoptions
                where from_owner_id like 'owner-depth-%'
              ) || '|' || (
                select pg_catalog.count(*)::text
                from airbyte_source_private.stripe_owner_adoptions
                where from_owner_id = 'owner-depth-terminal-pg'
              ) || '|' || (
                select credits.owner_id
                from airbyte_source_private.stripe_revenue_receipts
                  as receipts
                join public.credits as credits
                  on credits.id = receipts.credit_id
                where receipts.provider_payment_intent_id =
                  'pi_pgDepthPayment0001'
              ) || '|' || (
                select
                  connections.owner_id || ':' ||
                  connections.lifecycle_revision::text
                from public.connections as connections
                where connections.id =
                  '44444444-4444-4444-8444-444444444444'
              );
          `),
        ).toBe(
          "31|0|owner-depth-terminal-pg|owner-depth-terminal-pg:0",
        );

        expect(callWriter(`
          'payment',
          'evt_pgCommitPayment0001',
          'owner-commit-pg',
          'cs_pgCommitPayment0001',
          'pi_pgCommitPayment0001',
          null,
          5000,
          'USD',
          'paid',
          'prod_pgGatewayCommit0001',
          'price_pgGatewayCommit0001',
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp() - interval '2 seconds'
          ),
          54.545455
        `)).toBe("true|54.54545500|none");
        expect(callEntitlement("owner-commit-pg")).toBe("true");
        expect(callWriter(`
          'refund',
          'evt_pgCommitRefund0001',
          null,
          null,
          'pi_pgCommitPayment0001',
          're_pgCommitRefund0001',
          3000,
          'USD',
          'succeeded',
          null,
          null,
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp() - interval '1 second'
          ),
          null
        `)).toBe("true|-32.72727300|partial");
        expect(callEntitlement("owner-commit-pg")).toBe("true");
        expect(callWriter(`
          'refund',
          'evt_pgCommitRefund0002',
          null,
          null,
          'pi_pgCommitPayment0001',
          're_pgCommitRefund0002',
          2000,
          'USD',
          'succeeded',
          null,
          null,
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp()
          ),
          null
        `)).toBe("true|-21.81818200|full");
        expect(
          runPsql(`
            select coalesce(
              pg_catalog.sum(delta_usdc),
              0::numeric
            )::text
            from public.credits
            where owner_id = 'owner-commit-pg';
          `),
        ).toBe("0.00000000");
        expect(callEntitlement("owner-commit-pg")).toBe("false");
        runPsql(`
          update public.credits
          set reason = case
            when delta_usdc > 0 then 'topup'
            else 'gateway:tampered'
          end
          where owner_id = 'owner-commit-pg';
        `);
        expect(callEntitlement("owner-commit-pg")).toBe("false");

        runPsql(`
          insert into public.credits (
            id,
            owner_id,
            delta_usdc,
            reason,
            tx,
            created_at
          ) values
            (
              'spent-entitlement-credit',
              'owner-spent-pg',
              1,
              'topup',
              '0xspent-entitlement',
              pg_catalog.clock_timestamp()::text
            ),
            (
              'spent-entitlement-debit',
              'owner-spent-pg',
              -1,
              'gateway:llm',
              null,
              pg_catalog.clock_timestamp()::text
            );
        `);
        expect(callEntitlement("owner-spent-pg")).toBe("true");

        expect(callWriter(`
          'payment',
          'evt_pgRefundFirstPayment0001',
          'owner-refund-first-pg',
          'cs_pgRefundFirstPayment0001',
          'pi_pgRefundFirstPayment0001',
          null,
          700,
          'USD',
          'paid',
          'prod_pgGateway0002',
          'price_pgGateway0002',
          pg_catalog.date_trunc(
            'milliseconds',
            pg_catalog.clock_timestamp() - interval '1 second'
          ),
          7.7
        `)).toBe("true|7.70000000|none");
        const refundFirst = startPsql(
          `
            begin;
            set role service_role;
            set request.jwt.claim.role = 'service_role';
            select
              recorded::text || '|' ||
              credit_delta_usdc::text || '|' ||
              refund_state
            from public.agent_studio_record_stripe_revenue_event(
              'refund',
              'evt_pgRefundFirst0001',
              null,
              null,
              'pi_pgRefundFirstPayment0001',
              're_pgRefundFirst0001',
              700,
              'USD',
              'succeeded',
              null,
              null,
              pg_catalog.date_trunc(
                'milliseconds',
                pg_catalog.clock_timestamp()
              ),
              null
            );
            reset role;
            select 'stripe-refund-held';
            select pg_catalog.pg_sleep(5);
            commit;
          `,
          "stripe-refund-held",
        );
        await refundFirst.ready;
        const rejectedRacingAdoption = runPsqlFailure(`
          update public.credits
          set owner_id = 'owner-refund-first-account-pg'
          where owner_id = 'owner-refund-first-pg';
        `);
        expect(rejectedRacingAdoption.status).not.toBe(0);
        expect(rejectedRacingAdoption.stderr).toMatch(
          /retry agent studio credit-owner update after stripe mutation/iu,
        );
        await expect(refundFirst.complete).resolves.toContain(
          "true|-7.70000000|full",
        );
        runPsql(`
          update public.credits
          set owner_id = 'owner-refund-first-account-pg'
          where owner_id = 'owner-refund-first-pg';
        `);
        expect(
          runPsql(`
            select
              (
                select coalesce(
                  pg_catalog.sum(delta_usdc),
                  0::numeric
                )::text
                from public.credits
                where owner_id = 'owner-refund-first-pg'
              ) || '|' || (
                select coalesce(
                  pg_catalog.sum(delta_usdc),
                  0::numeric
                )::text
                from public.credits
                where owner_id = 'owner-refund-first-account-pg'
              ) || '|' || (
                select pg_catalog.count(distinct owner_id)::text
                from airbyte_source_private.stripe_revenue_receipts
                where provider_payment_intent_id =
                  'pi_pgRefundFirstPayment0001'
              );
          `),
        ).toBe("0|0.00000000|1");

        runStripeRevenueWriteStop();
        expect(
          runPsql(`
            select
              pg_catalog.has_function_privilege(
                'service_role',
                'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
                'execute'
              )::text || '|' ||
              pg_catalog.has_function_privilege(
                'anon',
                'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
                'execute'
              )::text || '|' ||
              (
                select pg_catalog.count(*)::text
                from airbyte_source.normalized_revenue_events
              );
          `, "suede_agent_studio_airbyte_login"),
        ).toBe("false|false|12");
        expect(callEntitlement("owner-spent-pg")).toBe("true");

        runStripeRevenueMigration();
        expect(
          runPsql(`
            select
              pg_catalog.has_function_privilege(
                'service_role',
                'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
                'execute'
              )::text || '|' ||
              pg_catalog.has_function_privilege(
                'anon',
                'public.agent_studio_record_stripe_revenue_event(text,text,text,text,text,text,bigint,text,text,text,text,timestamp with time zone,numeric)',
                'execute'
              )::text;
          `),
        ).toBe("true|true");
      },
      120_000,
    );
  },
);
