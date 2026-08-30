import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const integrationEnabled = process.env.RESOURCE_FOUNDRY_POSTGRES_INTEGRATION === "1";
const integrationSuite = integrationEnabled ? describe.sequential : describe.skip;

integrationSuite("prepared Resource Foundry PostgreSQL RPC", () => {
  let root = "";
  let dataDirectory = "";
  let socketDirectory = "";
  let logPath = "";
  const port = 56_000 + (process.pid % 1_000);

  const psqlArgs = (database = "postgres"): string[] => [
    "--host", socketDirectory,
    "--port", String(port),
    "--username", "postgres",
    "--dbname", database,
    "--no-psqlrc",
    "--set", "ON_ERROR_STOP=1",
  ];

  const runSql = (sql: string): string => execFileSync(
    "psql",
    [...psqlArgs(), "--tuples-only", "--no-align", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  ).trim();

  const failSql = (sql: string) => spawnSync(
    "psql",
    [...psqlArgs(), "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  );

  const applyResourceMigration = (database = "postgres") => spawnSync("psql", [
    ...psqlArgs(database),
    "--file", join(process.cwd(), "docs/migrations/agent-resource-foundry.sql"),
  ], { encoding: "utf8", timeout: 60_000 });

  const preparedSharedRuntime = (): string => readFileSync(
    join(process.cwd(), "docs/migrations/production-shared-supabase-runtime.sql"),
    "utf8",
  ).replaceAll("__AGENT_STUDIO_SECRET_SHA256__", "a".repeat(64));

  const applySql = (database: string, sql: string) => spawnSync(
    "psql",
    psqlArgs(database),
    { encoding: "utf8", input: sql, timeout: 60_000 },
  );

  const runDatabaseSql = (database: string, sql: string): string => execFileSync(
    "psql",
    [...psqlArgs(database), "--tuples-only", "--no-align", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  ).trim();

  const callSql = (payload: Readonly<Record<string, unknown>>): string => {
    const encoded = JSON.stringify(payload).replaceAll("'", "''");
    return `select public.agent_studio_resource_create_product_with_candidate('${encoded}'::jsonb);`;
  };

  const basePayload = (id: string, slug: string): Record<string, unknown> => ({
    id,
    ownerId: "postgres-integration-owner",
    name: "Postgres integration",
    slug,
    executionAccess: "private",
    discoveryAccess: "unlisted",
    createdBy: "postgres-integration-owner",
    semanticHash: "a".repeat(64),
    content: {
      recordSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      filterFields: [],
      returnFields: ["name"],
      taxonomy: [],
      records: [],
      evidence: [],
      sourceSnapshotIds: [],
      jobContract: {
        jobStatement: "Return reviewed records.",
        buyerIntent: "Verify the atomic prepared RPC.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        outputSchema: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
        unsupportedRequest: "Return unknown.",
        evidenceRequirement: "Return evidence.",
        safeExample: [],
        reviewBoundary: "Reviewed records only.",
        dataHandlingDisclosure: "Private inputs remain private.",
      },
    },
  });

  beforeAll(() => {
    root = mkdtempSync("/tmp/agent-resource-foundry-pg-");
    dataDirectory = join(root, "data");
    socketDirectory = join(root, "socket");
    logPath = join(root, "postgres.log");
    mkdirSync(socketDirectory);
    execFileSync("initdb", [
      "-D", dataDirectory,
      "--auth=trust",
      "--username=postgres",
      "--no-locale",
      "--encoding=UTF8",
    ], { stdio: "pipe", timeout: 30_000 });
    execFileSync("pg_ctl", [
      "-D", dataDirectory,
      "-l", logPath,
      "-o", `-F -c listen_addresses='' -k ${socketDirectory} -p ${port}`,
      "-w", "start",
    ], { stdio: "pipe", timeout: 30_000 });
    runSql(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create schema extensions;
      create extension if not exists pgcrypto with schema extensions;
      create table public.connections (
        owner_id text not null,
        lifecycle_revision integer not null default 0,
        updated_at bigint not null default 0
      );
      create or replace function public.agent_studio_adopt_owner(text,text)
      returns void language plpgsql as $$ begin return; end; $$;
    `);
    const prepared = spawnSync("psql", psqlArgs(), {
      encoding: "utf8",
      input: preparedSharedRuntime(),
      timeout: 60_000,
    });
    if (prepared.status !== 0) {
      throw new Error(prepared.stderr || prepared.error?.message || "prepared runtime failed");
    }
    for (const pass of ["fresh", "rerun"]) {
      const migration = applyResourceMigration();
      if (migration.status !== 0) {
        throw new Error(migration.stderr || migration.error?.message || "Resource migration failed");
      }
      if (pass === "rerun") {
        expect(runSql("select to_regprocedure('public.agent_studio_resource_record_run_receipt(jsonb)') is not null;")).toBe("t");
      }
    }
  }, 120_000);

  beforeEach(() => {
    runSql(`truncate table
      public.resource_evidence_refs,
      public.resource_records,
      public.resource_run_receipts,
      public.resource_releases,
      public.resource_pack_versions,
      public.resource_source_snapshots,
      public.resource_source_assets,
      public.resource_products
      restart identity cascade;`);
  });

  afterAll(() => {
    if (dataDirectory !== "" && existsSync(join(dataDirectory, "postmaster.pid"))) {
      execFileSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], {
        stdio: "pipe", timeout: 30_000,
      });
    }
    if (root !== "") rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("raises the fixed conflict signal for a duplicate owner slug", () => {
    expect(runSql(callSql(basePayload("product-one", "duplicate")))).toContain("product-one");
    const duplicate = failSql(callSql(basePayload("product-two", "duplicate")));
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("RESOURCE_CONFLICT");
    expect(runSql("select count(*) from public.resource_products;")).toBe("1");
    expect(runSql("select count(*) from public.resource_pack_versions;")).toBe("1");
  });

  it.each([
    ["blank", " "],
    ["oversized", "o".repeat(129)],
    ["control", "owner\u007fescape"],
    ["non-NFC", "owner-e\u0301"],
  ])("rejects a %s owner at the SQL boundary before creating a product", (_kind, ownerId) => {
    const payload = { ...basePayload(`invalid-owner-${_kind}`, `invalid-owner-${_kind}`), ownerId };
    const failed = failSql(callSql(payload));
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("RESOURCE_INVALID");
    expect(runSql("select count(*) from public.resource_products;")).toBe("0");
  });

  it("fails closed on weakened validated same-name deploy constraints", () => {
    const database = `resource_baseline_replay_${process.pid}`;
    const expectedConstraints = [
      ["resource_products", "resource_products_owner_id_check"],
      ["resource_evidence_refs", "resource_evidence_refs_field_hash_check"],
      ["resource_evidence_refs", "resource_evidence_refs_confidence_check"],
      ["resource_releases", "resource_releases_owner_id_check"],
      ["resource_releases", "resource_releases_semantic_hash_check"],
      ["resource_releases", "resource_releases_publication_request_hash_check"],
      ["resource_releases", "resource_releases_graph_semantic_hash_check"],
      ["resource_releases", "resource_releases_graph_full_hash_check"],
      ["resource_run_receipts", "resource_run_receipts_owner_id_check"],
      ["resource_run_receipts", "resource_run_receipts_semantic_hash_check"],
    ] as const;
    runSql(`drop database if exists ${database};`);
    runSql(`create database ${database};`);
    try {
      const bootstrap = applySql(database, `
        create schema extensions;
        create extension if not exists pgcrypto with schema extensions;
        create table public.connections(
          owner_id text not null,
          lifecycle_revision integer not null default 0,
          updated_at bigint not null default 0
        );
        create or replace function public.agent_studio_adopt_owner(text,text)
        returns void language plpgsql as $$ begin return; end; $$;
      `);
      if (bootstrap.status !== 0) throw new Error(bootstrap.stderr);
      const sharedRuntime = applySql(database, preparedSharedRuntime());
      if (sharedRuntime.status !== 0) throw new Error(sharedRuntime.stderr);

      const deploy = readFileSync(join(process.cwd(), "src/lib/db/schema.deploy.sql"), "utf8");
      const resourceStart = deploy.indexOf("-- Resource Foundry:");
      const resourceEnd = deploy.indexOf("-- Private Prospect Engine state.");
      expect(resourceStart).toBeGreaterThan(-1);
      expect(resourceEnd).toBeGreaterThan(resourceStart);
      const baseline = applySql(database, deploy.slice(resourceStart, resourceEnd));
      if (baseline.status !== 0) throw new Error(baseline.stderr);

      const constraintWhere = expectedConstraints
        .map(([table, name]) => `(tables.relname='${table}' and constraints.conname='${name}')`)
        .join(" or ");
      const constraintState = () => runDatabaseSql(database, `
        select count(*)||'|'||coalesce(md5(string_agg(
          tables.relname||':'||constraints.conname||':'||
          pg_get_constraintdef(constraints.oid,true),','
          order by tables.relname,constraints.conname
        )), '')
        from pg_constraint constraints
        join pg_class tables on tables.oid=constraints.conrelid
        join pg_namespace schemas on schemas.oid=tables.relnamespace
        where schemas.nspname='public'
          and constraints.contype='c'
          and constraints.convalidated
          and (${constraintWhere});
      `);
      const baselineState = constraintState();

      for (const [table, name] of expectedConstraints) {
        runDatabaseSql(database, `
          alter table public.${table} drop constraint if exists ${name};
          alter table public.${table} add constraint ${name} check (true);
        `);
      }
      expect(constraintState().split("|", 1)[0]).toBe(String(expectedConstraints.length));
      expect(constraintState()).not.toBe(baselineState);
      const weakenedState = constraintState();
      for (const pass of ["reject", "reject replay"]) {
        const migration = applyResourceMigration(database);
        expect(migration.status, pass).not.toBe(0);
        expect(migration.stderr, pass).toMatch(
          /Resource constraint definition drift/iu,
        );
        expect(constraintState(), pass).toBe(weakenedState);
      }
      expect(baselineState.split("|", 1)[0]).toBe(String(expectedConstraints.length));
    } finally {
      runSql(`select pg_terminate_backend(pid) from pg_stat_activity where datname='${database}';`);
      runSql(`drop database if exists ${database};`);
    }
  }, 120_000);

  it("fails closed before mutation when an omitted deploy constraint is weakened", () => {
    const database = `resource_inventory_drift_${process.pid}`;
    runSql(`drop database if exists ${database};`);
    runSql(`create database ${database};`);
    try {
      const bootstrap = applySql(database, `
        create schema extensions;
        create extension if not exists pgcrypto with schema extensions;
        create table public.connections(
          owner_id text not null,
          lifecycle_revision integer not null default 0,
          updated_at bigint not null default 0
        );
        create or replace function public.agent_studio_adopt_owner(text,text)
        returns void language plpgsql as $$ begin return; end; $$;
      `);
      if (bootstrap.status !== 0) throw new Error(bootstrap.stderr);
      const sharedRuntime = applySql(database, preparedSharedRuntime());
      if (sharedRuntime.status !== 0) throw new Error(sharedRuntime.stderr);

      const deploy = readFileSync(join(process.cwd(), "src/lib/db/schema.deploy.sql"), "utf8");
      const resourceStart = deploy.indexOf("-- Resource Foundry:");
      const resourceEnd = deploy.indexOf("-- Private Prospect Engine state.");
      expect(resourceStart).toBeGreaterThan(-1);
      expect(resourceEnd).toBeGreaterThan(resourceStart);
      const baseline = applySql(database, deploy.slice(resourceStart, resourceEnd));
      if (baseline.status !== 0) throw new Error(baseline.stderr);

      runDatabaseSql(database, `
        alter table public.resource_products
          drop constraint resource_products_status_check;
        alter table public.resource_products
          add constraint resource_products_status_check check (true);
      `);
      const resourceCatalogState = () => runDatabaseSql(database, `
        select md5(string_agg(
          tables.relname||':'||constraints.conname||':'||constraints.contype::text||':'||
          constraints.convalidated::text||':'||
          pg_get_constraintdef(constraints.oid,true), E'\\n'
          order by tables.relname,constraints.conname
        ))
        from pg_constraint constraints
        join pg_class tables on tables.oid=constraints.conrelid
        join pg_namespace schemas on schemas.oid=tables.relnamespace
        where schemas.nspname='public'
          and tables.relname=any(array[
            'resource_products','resource_source_assets','resource_source_snapshots',
            'resource_pack_versions','resource_records','resource_evidence_refs',
            'resource_releases','resource_run_receipts'
          ]);
      `);
      expect(runDatabaseSql(database, `
        select pg_get_constraintdef(constraints.oid,true)
        from pg_constraint constraints
        join pg_class tables on tables.oid=constraints.conrelid
        join pg_namespace schemas on schemas.oid=tables.relnamespace
        where schemas.nspname='public'
          and tables.relname='resource_products'
          and constraints.conname='resource_products_status_check';
      `)).toBe("CHECK (true)");
      const weakenedState = resourceCatalogState();

      for (const pass of ["reject", "reject replay"]) {
        const migration = applyResourceMigration(database);
        expect(migration.status, pass).not.toBe(0);
        expect(migration.stderr, pass).toMatch(
          /Resource constraint definition drift on resource_products\.resource_products_status_check/iu,
        );
        expect(resourceCatalogState(), pass).toBe(weakenedState);
      }
    } finally {
      runSql(`select pg_terminate_backend(pid) from pg_stat_activity where datname='${database}';`);
      runSql(`drop database if exists ${database};`);
    }
  }, 120_000);

  it.each([
    ["anon", "anonymous-adoption-owner", "sb:adopted-anon-owner"],
    ["service_role", "service-adoption-owner", "sb:adopted-service-owner"],
  ] as const)("adopts Resource rows through the authorized %s wrapper without exposing its helper", (
    role,
    fromOwner,
    toOwner,
  ) => {
    const requestSecret = "resource-foundry-postgres-role-secret";
    runSql(`
      update public.agent_studio_runtime_secrets
      set secret_hash=encode(extensions.digest('${requestSecret}','sha256'),'hex')
      where id='primary';
      insert into public.resource_products(
        id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at
      ) values(
        'product-${role}','${fromOwner}','Adoption ${role}','adoption-${role}',
        'draft','private','unlisted',clock_timestamp(),clock_timestamp()
      );
      insert into public.connections(owner_id,lifecycle_revision,updated_at)
      values('${fromOwner}',0,0);
    `);

    const requestContext = role === "anon"
      ? `select set_config('request.headers','{"x-agent-studio-secret":"${requestSecret}"}',true);`
      : "select set_config('request.jwt.claim.role','service_role',true);";
    runSql(`
      begin;
      set local role ${role};
      ${requestContext}
      select public.agent_studio_adopt_owner_with_connections('${fromOwner}','${toOwner}');
      commit;
    `);

    expect(runSql(`select owner_id from public.resource_products where id='product-${role}';`))
      .toBe(toOwner);
    expect(runSql(`select owner_id||'|'||lifecycle_revision from public.connections where owner_id='${toOwner}';`))
      .toBe(`${toOwner}|1`);
    expect(runSql(`select
      has_function_privilege('${role}','public.agent_studio_adopt_owner_with_connections(text,text)','execute')::text||'|'||
      has_function_privilege('${role}','public.agent_studio_adopt_resource_owner(text,text)','execute')::text;`))
      .toBe("true|false");
  });

  it.each([
    ["SECURITY INVOKER", "alter function agent_studio_private.request_authorized() security invoker"],
    ["missing anon EXECUTE", "revoke execute on function agent_studio_private.request_authorized() from anon"],
  ] as const)("fails closed before mutation when the request authorizer has %s drift", (_kind, driftSql) => {
    runSql(driftSql);
    try {
      const migration = applyResourceMigration();
      expect(migration.status).not.toBe(0);
      expect(migration.stderr).toContain("Resource authorization prerequisite drift");
    } finally {
      runSql(`
        alter function agent_studio_private.request_authorized() security definer;
        grant execute on function agent_studio_private.request_authorized() to anon,service_role;
      `);
      const restored = applyResourceMigration();
      if (restored.status !== 0) throw new Error(restored.stderr);
    }
  });

  it("rejects an unexpected browser policy instead of composing it with server-only access", () => {
    runSql(`create policy resource_unexpected_browser_access on public.resource_products
      for select to anon using (true);`);
    try {
      const migration = applyResourceMigration();
      expect(migration.status).not.toBe(0);
      expect(migration.stderr).toContain("Resource RLS policy drift");
    } finally {
      runSql("drop policy if exists resource_unexpected_browser_access on public.resource_products;");
      const restored = applyResourceMigration();
      if (restored.status !== 0) throw new Error(restored.stderr);
    }
  });

  it("keeps the owner portfolio bounded while exact lookup reaches the omitted oldest product", () => {
    runSql(`insert into public.resource_products(
      id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at
    ) select
      'product-cap-'||to_char(sequence,'FM000'),'postgres-integration-owner',
      'Capped product '||sequence,'capped-product-'||sequence,'draft','private','unlisted',
      '2026-08-14T12:00:00.000Z'::timestamptz+sequence*interval '1 second',
      '2026-08-14T12:00:00.000Z'::timestamptz+sequence*interval '1 second'
    from generate_series(0,100) sequence;`);

    expect(runSql("select jsonb_array_length(public.agent_studio_resource_list_owned_products('postgres-integration-owner'));"))
      .toBe("100");
    expect(runSql(`select exists(
      select 1 from jsonb_array_elements(public.agent_studio_resource_list_owned_products('postgres-integration-owner')) item
      where item->>'id'='product-cap-000'
    );`)).toBe("f");
    expect(runSql(`select public.agent_studio_resource_get_owned_portfolio_item(
      'postgres-integration-owner','product-cap-000'
    )->>'name';`)).toBe("Capped product 0");
    expect(runSql(`select
      (public.agent_studio_resource_get_owned_portfolio_item('foreign-owner','product-cap-000') is null)::text||'|'||
      (public.agent_studio_resource_get_owned_portfolio_item('postgres-integration-owner','missing-product') is null)::text;`))
      .toBe("true|true");
  });

  it("rolls back product, pack, record, and evidence after a late evidence failure", () => {
    const payload = basePayload("product-rollback", "rollback");
    const content = payload.content as Record<string, unknown>;
    content.records = [{
      id: "record-before-failure",
      fields: { name: "Inserted before evidence" },
      tags: [],
      evidenceIds: ["evidence-failure"],
    }];
    content.evidence = [{
      id: "evidence-failure",
      sourceSnapshotId: "missing-snapshot",
      locator: "manual://missing",
      observedAt: "2026-08-14T12:00:00.000Z",
    }];
    content.sourceSnapshotIds = ["missing-snapshot"];

    const failed = failSql(callSql(payload));
    expect(failed.status).not.toBe(0);
    expect(failed.stderr.toLowerCase()).toContain("foreign key constraint");
    expect(runSql(`select
      (select count(*) from public.resource_products) || '|' ||
      (select count(*) from public.resource_pack_versions) || '|' ||
      (select count(*) from public.resource_records) || '|' ||
      (select count(*) from public.resource_evidence_refs);`)).toBe("0|0|0|0");
  });

  it("rolls back the collected snapshot when candidate replacement conflicts", () => {
    const created = JSON.parse(runSql(callSql(basePayload("product-source-atomic", "source-atomic")))) as {
      candidate: { id: string; revision: number };
    };
    const sourceContent = basePayload("unused", "unused").content as Record<string, unknown>;
    sourceContent.sourceSnapshotIds = ["snapshot-source-atomic"];
    const candidate = {
      ownerId: "postgres-integration-owner",
      resourceProductId: "product-source-atomic",
      expectedCandidatePackVersionId: "stale-candidate",
      expectedRevision: created.candidate.revision,
      content: sourceContent,
      semanticHash: "b".repeat(64),
      createdBy: "postgres-integration-owner",
    };
    const payload = {
      snapshot: {
        id: "snapshot-source-atomic",
        ownerId: "postgres-integration-owner",
        resourceProductId: "product-source-atomic",
        locator: "manual://atomic",
        sourceKind: "manual_text",
        capturedAt: "2026-08-14T12:00:00.000Z",
        contentHash: "c".repeat(64),
        freshnessDeadline: "2026-08-21T12:00:00.000Z",
      },
      candidate,
    };
    const callAtomic = (value: unknown) => `select public.agent_studio_resource_collect_source_candidate('${JSON.stringify(value).replaceAll("'", "''")}'::jsonb);`;
    const conflict = failSql(callAtomic(payload));
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("RESOURCE_CONFLICT");
    expect(runSql("select count(*) from public.resource_source_snapshots;")).toBe("0");
    expect(runSql("select count(*) from public.resource_pack_versions where resource_product_id='product-source-atomic';")).toBe("1");

    const exact = {
      ...payload,
      candidate: { ...candidate, expectedCandidatePackVersionId: created.candidate.id },
    };
    expect(runSql(callAtomic(exact))).toContain("snapshot-source-atomic");
    expect(runSql("select count(*)||'|'||max(revision) from public.resource_pack_versions where resource_product_id='product-source-atomic';"))
      .toBe("1|2");
    expect(runSql("select count(*) from public.resource_source_snapshots;")).toBe("1");

    expect(failSql(callAtomic(exact)).status).not.toBe(0);
    expect(runSql("select count(*) from public.resource_source_snapshots;")).toBe("1");
    expect(runSql("select count(*) from public.resource_pack_versions where resource_product_id='product-source-atomic';")).toBe("1");
  });

  it("rejects cross-product atomic input before either valid write can commit", () => {
    const left = JSON.parse(runSql(callSql(basePayload("product-source-left", "source-left")))) as {
      candidate: { id: string; revision: number };
    };
    const right = JSON.parse(runSql(callSql(basePayload("product-source-right", "source-right")))) as {
      candidate: { id: string; revision: number };
    };
    expect(left.candidate.revision).toBe(1);
    const candidateContent = basePayload("unused", "unused").content as Record<string, unknown>;
    candidateContent.sourceSnapshotIds = [];
    const payload = {
      snapshot: {
        id: "snapshot-source-cross-product",
        ownerId: "postgres-integration-owner",
        resourceProductId: "product-source-left",
        locator: "manual://cross-product",
        sourceKind: "manual_text",
        capturedAt: "2026-08-14T12:00:00.000Z",
        contentHash: "c".repeat(64),
        freshnessDeadline: "2026-08-21T12:00:00.000Z",
      },
      candidate: {
        ownerId: "postgres-integration-owner",
        resourceProductId: "product-source-right",
        expectedCandidatePackVersionId: right.candidate.id,
        expectedRevision: right.candidate.revision,
        content: candidateContent,
        semanticHash: "b".repeat(64),
        createdBy: "postgres-integration-owner",
      },
    };
    const callAtomic = `select public.agent_studio_resource_collect_source_candidate('${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb);`;

    const mismatch = failSql(callAtomic);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("RESOURCE_CONFLICT");
    expect(runSql("select count(*) from public.resource_source_snapshots;")).toBe("0");
    expect(runSql("select count(*)||'|'||max(revision) from public.resource_pack_versions where resource_product_id='product-source-right';"))
      .toBe("1|1");
  });

  it("persists a resource dependency through the prepared flow-version RPC", () => {
    const flowId = "00000000-0000-4000-8000-000000000501";
    const versionId = "00000000-0000-4000-8000-000000000502";
    const graph = JSON.stringify({ id: "resource-flow", name: "Resource flow", nodes: [], edges: [] }).replaceAll("'", "''");
    const dependencies = JSON.stringify([{
      kind: "resource",
      resource_id: "resource-1",
      version: "pack-1",
      content_hash: "b".repeat(64),
    }]).replaceAll("'", "''");
    runSql(`delete from public.flows where id='${flowId}'::uuid;
      insert into public.flows(id,owner_id,name,graph) values(
        '${flowId}'::uuid,'postgres-integration-owner','Resource flow','${graph}'::jsonb
      );`);
    const result = runSql(`select public.agent_studio_create_flow_version(
      '${flowId}'::uuid,
      'postgres-integration-owner',
      '${versionId}'::uuid,
      1,
      'resource pin',
      null,
      '${graph}'::jsonb,
      'Resource flow',
      '${"c".repeat(64)}',
      '${"d".repeat(64)}',
      '${dependencies}'::jsonb,
      false
    );`);
    expect(result).toContain(versionId);
    expect(runSql(`select kind || '|' || resource_id || '|' || version
      from public.dependency_pins where flow_version_id='${versionId}'::uuid;`))
      .toBe("resource|resource-1|pack-1");
  });

  it("returns only owner-scoped source counts and sorted aggregate kinds", () => {
    const owner = "postgres-disclosure-owner";
    const semanticHash = "9".repeat(64);
    const content = basePayload("unused", "unused").content as Record<string, unknown>;
    content.sourceSnapshotIds = ["snapshot-manual-a", "snapshot-rss", "snapshot-manual-b"];
    const encoded = JSON.stringify(content).replaceAll("'", "''");
    runSql(`
      insert into public.resource_products(id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
      values('product-disclosure','${owner}','Disclosure','disclosure','test','private','unlisted',clock_timestamp(),clock_timestamp());
      insert into public.resource_source_assets(id,resource_product_id,locator,source_kind,created_at) values
        ('asset-manual','product-disclosure','private://manual','manual',clock_timestamp()),
        ('asset-rss','product-disclosure','private://rss','rss',clock_timestamp());
      insert into public.resource_source_snapshots(id,resource_product_id,source_asset_id,locator,source_kind,captured_at,content_hash,freshness_deadline,created_at) values
        ('snapshot-manual-a','product-disclosure','asset-manual','private://manual/a','manual',clock_timestamp(),'${"1".repeat(64)}',clock_timestamp()+interval '1 day',clock_timestamp()),
        ('snapshot-rss','product-disclosure','asset-rss','private://rss/a','rss',clock_timestamp(),'${"2".repeat(64)}',clock_timestamp()+interval '1 day',clock_timestamp()),
        ('snapshot-manual-b','product-disclosure','asset-manual','private://manual/b','manual',clock_timestamp(),'${"3".repeat(64)}',clock_timestamp()+interval '1 day',clock_timestamp());
      insert into public.resource_pack_versions(id,resource_product_id,revision,status,semantic_hash,content_json,created_by,created_at)
      values('pack-disclosure','product-disclosure',1,'approved','${semanticHash}','${encoded}'::jsonb,'${owner}',clock_timestamp());
    `);
    const reference = JSON.stringify({
      ownerId: owner,
      resourceProductId: "product-disclosure",
      packVersionId: "pack-disclosure",
      semanticHash,
    }).replaceAll("'", "''");
    const disclosure = runSql(`select public.agent_studio_resource_get_source_disclosure('${reference}'::jsonb);`);
    expect(JSON.parse(disclosure)).toEqual({ source_count: 3, source_kinds: ["manual", "rss"] });
    expect(disclosure).not.toContain("private://");
    const foreign = reference.replace(owner, "different-owner");
    expect(runSql(`select public.agent_studio_resource_get_source_disclosure('${foreign}'::jsonb);`)).toBe("");
  });

  it("binds one idempotent receipt to the exact release, agent, and credited payment fact", () => {
    const owner = "postgres-receipt-owner";
    const semanticHash = "8".repeat(64);
    const evidence = {
      id: "evidence-receipt",
      sourceSnapshotId: "snapshot-receipt",
      locator: "manual://receipt#row-1",
      observedAt: "2026-08-14T12:00:00.000Z",
      fieldHash: "4".repeat(64),
      confidence: 0.9,
    };
    const contentValue = basePayload("unused", "unused").content as Record<string, unknown>;
    contentValue.evidence = [evidence];
    contentValue.sourceSnapshotIds = ["snapshot-receipt"];
    const content = JSON.stringify(contentValue).replaceAll("'", "''");
    runSql(`
      insert into public.resource_products(id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
      values('product-receipt','${owner}','Receipt','receipt','live','paid','public',clock_timestamp(),clock_timestamp());
      insert into public.resource_source_assets(id,resource_product_id,locator,source_kind,created_at)
      values('asset-receipt','product-receipt','manual://receipt','manual',clock_timestamp());
      insert into public.resource_source_snapshots(id,resource_product_id,source_asset_id,locator,source_kind,captured_at,content_hash,freshness_deadline,created_at)
      values('snapshot-receipt','product-receipt','asset-receipt','manual://receipt','manual','2026-08-14T12:00:00.000Z','${"3".repeat(64)}','2026-08-20T12:00:00.000Z',clock_timestamp());
      insert into public.resource_pack_versions(id,resource_product_id,revision,status,semantic_hash,content_json,created_by,created_at)
      values('pack-receipt','product-receipt',1,'live','${semanticHash}','${content}'::jsonb,'${owner}',clock_timestamp());
      insert into public.resource_evidence_refs(pack_version_id,id,source_snapshot_id,locator,observed_at,field_hash,confidence,conflict)
      values('pack-receipt','evidence-receipt','snapshot-receipt','manual://receipt#row-1','2026-08-14T12:00:00.000Z','${"4".repeat(64)}',0.9,null);
      insert into public.resource_releases(id,owner_id,resource_product_id,pack_version_id,semantic_hash,publication_key,publication_request_hash,graph_semantic_hash,graph_full_hash,price_usdc,execution_access,discovery_access,agent_id,flow_id,flow_version_id,deployment_id,environment_id,created_at)
      values('release-receipt','${owner}','product-receipt','pack-receipt','${semanticHash}','publication-receipt','${"7".repeat(64)}','${"6".repeat(64)}','${"5".repeat(64)}',0.05,'paid','public','agent-receipt','flow-receipt','flow-version-receipt','deployment-receipt','environment-receipt',clock_timestamp());
    `);
    const payload = {
      id: "receipt-postgres-1",
      ownerId: owner,
      resourceProductId: "product-receipt",
      packVersionId: "pack-receipt",
      agentId: "agent-receipt",
      runId: "run-receipt",
      flowVersionId: "flow-version-receipt",
      deploymentId: "deployment-receipt",
      paymentId: "credit-debit-1",
      paymentState: "credited",
      priceUsdc: 0.05,
      receipt: {
        resourceProductId: "product-receipt",
        resourceVersion: "pack-receipt",
        semanticHash,
        freshness: "fresh",
        evidence: [evidence],
        unknowns: [],
        conflicts: [],
        outputSchemaValid: true,
      },
      createdAt: "2026-08-14T12:00:00.000Z",
    };
    const encoded = JSON.stringify(payload).replaceAll("'", "''");
    const first = runSql(`select public.agent_studio_resource_record_run_receipt('${encoded}'::jsonb);`);
    expect(runSql(`select public.agent_studio_resource_record_run_receipt('${encoded}'::jsonb);`)).toBe(first);
    expect(runSql(`select agent_id||'|'||payment_id||'|'||payment_state||'|'||price_usdc
      from public.resource_run_receipts where run_id='run-receipt';`))
      .toBe("agent-receipt|credit-debit-1|credited|0.05");
    expect(runSql("select count(*) from public.resource_run_receipts where run_id='run-receipt';")).toBe("1");

    const mismatch = JSON.stringify({ ...payload, paymentState: "settled" }).replaceAll("'", "''");
    const failed = failSql(`select public.agent_studio_resource_record_run_receipt('${mismatch}'::jsonb);`);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("RESOURCE_CONFLICT");
    expect(runSql("select count(*) from public.resource_run_receipts where run_id='run-receipt';")).toBe("1");

    const malformed = JSON.stringify({
      ...payload,
      id: "receipt-postgres-malformed",
      runId: "run-receipt-malformed",
      receipt: { ...payload.receipt, evidence: [{ ...evidence, observedAt: "not-a-timestamp" }] },
    }).replaceAll("'", "''");
    const malformedResult = failSql(`select public.agent_studio_resource_record_run_receipt('${malformed}'::jsonb);`);
    expect(malformedResult.status).not.toBe(0);
    expect(malformedResult.stderr).toContain("RESOURCE_CONFLICT");

    runSql(`
      insert into public.resource_run_receipts(
        id,owner_id,resource_product_id,pack_version_id,agent_id,run_id,flow_version_id,
        deployment_id,payment_id,payment_state,price_usdc,semantic_hash,freshness,
        evidence_json,unknowns_json,conflicts_json,output_schema_valid,created_at)
      values(
        'receipt-postgres-malformed-replay','${owner}','product-receipt','pack-receipt',
        'agent-receipt','run-receipt-malformed-replay','flow-version-receipt','deployment-receipt',
        'credit-debit-1','credited',0.05,'${semanticHash}','fresh',
        '${JSON.stringify([{ ...evidence, observedAt: "not-a-timestamp" }]).replaceAll("'", "''")}'::jsonb,
        '[]'::jsonb,'[]'::jsonb,true,clock_timestamp());
    `);
    const malformedReplay = JSON.stringify({
      ...payload,
      id: "receipt-postgres-malformed-replay",
      runId: "run-receipt-malformed-replay",
      receipt: { ...payload.receipt, evidence: [{ ...evidence, observedAt: "not-a-timestamp" }] },
    }).replaceAll("'", "''");
    const malformedReplayResult = failSql(`select public.agent_studio_resource_record_run_receipt('${malformedReplay}'::jsonb);`);
    expect(malformedReplayResult.status).not.toBe(0);
    expect(malformedReplayResult.stderr).toContain("RESOURCE_CONFLICT");

    const foreign = JSON.stringify({
      ...payload,
      id: "receipt-postgres-foreign",
      runId: "run-receipt-foreign",
      receipt: {
        ...payload.receipt,
        evidence: [{ ...evidence, id: "foreign-evidence", locator: "private://foreign#row" }],
      },
    }).replaceAll("'", "''");
    const foreignResult = failSql(`select public.agent_studio_resource_record_run_receipt('${foreign}'::jsonb);`);
    expect(foreignResult.status).not.toBe(0);
    expect(foreignResult.stderr).toContain("RESOURCE_CONFLICT");
    expect(runSql("select count(*) from public.resource_run_receipts;")).toBe("2");
  });

  it("atomically validates the immutable publication identity and flips Live last", () => {
    const owner = "postgres-publication-owner";
    const ids = {
      organization: "00000000-0000-4000-8000-000000000601",
      workspace: "00000000-0000-4000-8000-000000000602",
      project: "00000000-0000-4000-8000-000000000603",
      environment: "00000000-0000-4000-8000-000000000604",
      flow: "00000000-0000-4000-8000-000000000605",
      agent: "00000000-0000-4000-8000-000000000606",
      priorAgent: "00000000-0000-4000-8000-000000000611",
      version: "00000000-0000-4000-8000-000000000607",
      dependency: "00000000-0000-4000-8000-000000000608",
      deployment: "00000000-0000-4000-8000-000000000609",
      priorDeployment: "00000000-0000-4000-8000-000000000612",
    };
    const semanticHash = "e".repeat(64);
    const graph = JSON.stringify({ id: "publication-flow", name: "Publication", nodes: [], edges: [] }).replaceAll("'", "''");
    const content = JSON.stringify(basePayload("unused", "unused").content).replaceAll("'", "''");
    runSql(`
      insert into public.resource_products(id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
      values('product-publication','${owner}','Publication','publication','test','paid','public',clock_timestamp(),clock_timestamp());
      insert into public.resource_pack_versions(id,resource_product_id,revision,status,semantic_hash,content_json,created_by,created_at)
      values('pack-publication','product-publication',1,'approved','${semanticHash}','${content}'::jsonb,'${owner}',clock_timestamp());
      insert into public.organizations(id,personal_owner_id,name,kind)
      values('${ids.organization}'::uuid,'${owner}','Personal','personal');
      insert into public.workspaces(id,organization_id,name,slug)
      values('${ids.workspace}'::uuid,'${ids.organization}'::uuid,'Personal','publication-workspace');
      insert into public.projects(id,workspace_id,name,slug)
      values('${ids.project}'::uuid,'${ids.workspace}'::uuid,'Publication','publication-project');
      insert into public.environments(id,project_id,name,slug,kind)
      values('${ids.environment}'::uuid,'${ids.project}'::uuid,'Live','live','live');
      insert into public.flows(id,owner_id,name,graph)
      values('${ids.flow}'::uuid,'${owner}','Publication','${graph}'::jsonb);
      insert into public.agents(id,flow_id,slug,status,price_usdc,settlement_live)
      values('${ids.agent}'::uuid,'${ids.flow}'::uuid,'publication-agent','draft',0.05,false);
      insert into public.agents(id,flow_id,slug,status,price_usdc,settlement_live)
      values('${ids.priorAgent}'::uuid,'${ids.flow}'::uuid,'publication-agent-prior','draft',0.05,false);
      insert into public.flow_versions(id,flow_id,version_number,schema_version,graph,semantic_hash,full_hash,created_by)
      values('${ids.version}'::uuid,'${ids.flow}'::uuid,1,1,'${graph}'::jsonb,'${"a".repeat(64)}','${"b".repeat(64)}','${owner}');
      insert into public.dependency_pins(id,flow_version_id,kind,resource_id,version,content_hash)
      values('${ids.dependency}'::uuid,'${ids.version}'::uuid,'resource','product-publication','pack-publication','${semanticHash}');
      insert into public.deployments(id,flow_id,flow_version_id,environment_id,status)
      values('${ids.deployment}'::uuid,'${ids.flow}'::uuid,'${ids.version}'::uuid,'${ids.environment}'::uuid,'live');
      insert into public.deployments(id,flow_id,flow_version_id,environment_id,status,created_at,retired_at)
      values('${ids.priorDeployment}'::uuid,'${ids.flow}'::uuid,'${ids.version}'::uuid,
        '${ids.environment}'::uuid,'retired',clock_timestamp()-interval '1 day',clock_timestamp()-interval '23 hours');
      insert into public.resource_releases(
        id,owner_id,resource_product_id,pack_version_id,semantic_hash,publication_key,
        publication_request_hash,graph_semantic_hash,graph_full_hash,price_usdc,
        execution_access,discovery_access,agent_id,flow_id,flow_version_id,deployment_id,
        environment_id,created_at
      ) values(
        'release-publication-prior','${owner}','product-publication','pack-publication','${semanticHash}',
        'publication-postgres-prior','${"c".repeat(64)}','${"a".repeat(64)}','${"b".repeat(64)}',
        0.05,'paid','public','${ids.priorAgent}','${ids.flow}','${ids.version}',
        '${ids.priorDeployment}','${ids.environment}',clock_timestamp()-interval '1 day'
      );
    `);
    const payload = {
      ownerId: owner,
      resourceProductId: "product-publication",
      packVersionId: "pack-publication",
      semanticHash,
      publicationKey: "publication-postgres",
      publicationRequestHash: "d".repeat(64),
      graphSemanticHash: "a".repeat(64),
      graphFullHash: "b".repeat(64),
      priceUsdc: 0.05,
      executionAccess: "paid",
      discoveryAccess: "public",
      agentId: ids.agent,
      flowId: ids.flow,
      flowVersionId: ids.version,
      deploymentId: ids.deployment,
      environmentId: ids.environment,
    };
    const mismatched = JSON.stringify({ ...payload, graphFullHash: "f".repeat(64) }).replaceAll("'", "''");
    expect(failSql(`select public.agent_studio_resource_create_release('${mismatched}'::jsonb);`).status)
      .not.toBe(0);
    expect(runSql(`select
      (select status from public.resource_products where id='product-publication') || '|' ||
      (select status from public.resource_pack_versions where id='pack-publication') || '|' ||
      (select status from public.agents where id='${ids.agent}'::uuid) || '|' ||
      (select count(*) from public.resource_releases where deployment_id='${ids.deployment}');`))
      .toBe("test|approved|draft|0");
    const encoded = JSON.stringify(payload).replaceAll("'", "''");
    const released = runSql(`select public.agent_studio_resource_create_release('${encoded}'::jsonb);`);
    expect(released).toContain(ids.deployment);
    expect(runSql(`select
      (select status from public.resource_products where id='product-publication') || '|' ||
      (select status from public.resource_pack_versions where id='pack-publication') || '|' ||
      (select status from public.agents where id='${ids.agent}'::uuid) || '|' ||
      (select count(*) from public.resource_releases where deployment_id='${ids.deployment}');`))
      .toBe("live|live|live|1");
    expect(runSql(`select public.agent_studio_resource_create_release('${encoded}'::jsonb);`))
      .toBe(released);
    expect(runSql(`select public.agent_studio_resource_get_release_by_publication(
      '${owner}','product-publication','publication-postgres');`)).toBe(released);

    const releaseId = runSql(`select id from public.resource_releases
      where resource_product_id='product-publication' order by created_at desc,id desc limit 1;`);
    const lifecycleSecret = "resource-lifecycle-role-secret";
    runSql(`update public.agent_studio_runtime_secrets
      set secret_hash=encode(extensions.digest('${lifecycleSecret}','sha256'),'hex')
      where id='primary';`);
    expect(runSql(`select
      has_function_privilege('anon','public.agent_studio_resource_list_owned_releases(text,text,integer)','execute')::text||'|'||
      has_function_privilege('service_role','public.agent_studio_resource_list_owned_releases(text,text,integer)','execute')::text||'|'||
      has_function_privilege('authenticated','public.agent_studio_resource_list_owned_releases(text,text,integer)','execute')::text;`))
      .toBe("true|true|false");
    const historyAsAnon = (productId = "product-publication", limit = 20) => {
      const output = runSql(`
        begin;
        set local role anon;
        set local request.headers='{"x-agent-studio-secret":"${lifecycleSecret}"}';
        select public.agent_studio_resource_list_owned_releases('${owner}','${productId}',${limit});
        commit;
      `);
      return output.split(/\r?\n/u).find((line) => line.startsWith("[")) ?? output;
    };
    const liveHistory = JSON.parse(historyAsAnon()) as Array<Record<string, unknown>>;
    expect(liveHistory).toHaveLength(2);
    expect(liveHistory[0]).toMatchObject({
      resourceProductId: "product-publication", agentStatus: "live",
      deploymentId: ids.deployment, deploymentStatus: "live", deploymentRetiredAt: null,
    });
    expect(liveHistory[1]).toMatchObject({
      id: "release-publication-prior", agentStatus: "draft",
      deploymentId: ids.priorDeployment, deploymentStatus: "retired",
    });
    expect(liveHistory[1]?.deploymentRetiredAt).toBeTypeOf("string");
    expect(liveHistory.some((item) => "content" in item || "sourceSnapshotIds" in item)).toBe(false);
    expect(JSON.parse(historyAsAnon("missing-publication"))).toEqual([]);
    expect(failSql(`select public.agent_studio_resource_list_owned_releases(
      '${owner}','product-publication',51);`).status).not.toBe(0);
    expect(failSql(`set role authenticated; select public.agent_studio_resource_list_owned_releases(
      '${owner}','product-publication',20);`).status).not.toBe(0);
    const lifecyclePayload = (action: "pause" | "resume" | "retire", expectedStatus: "live" | "paused") =>
      JSON.stringify({
        ownerId: owner, resourceProductId: "product-publication", action, expectedStatus,
        releaseId, agentId: ids.agent, deploymentId: ids.deployment,
      }).replaceAll("'", "''");
    const lifecycleAsAnon = (action: "pause" | "resume" | "retire", expectedStatus: "live" | "paused") => `
      begin;
      set local role anon;
      select set_config('request.headers','{"x-agent-studio-secret":"${lifecycleSecret}"}',true);
      select public.agent_studio_resource_transition_release_lifecycle(
        '${lifecyclePayload(action, expectedStatus)}'::jsonb
      );
      commit;`;

    runSql(lifecycleAsAnon("pause", "live"));
    const pausedHistory = JSON.parse(historyAsAnon()) as Array<Record<string, unknown>>;
    expect(pausedHistory[0]).toMatchObject({
      agentStatus: "draft", deploymentStatus: "retired",
    });
    expect(pausedHistory[0]?.deploymentRetiredAt).toBeTypeOf("string");
    expect(runSql(`select
      (select status from public.resource_products where id='product-publication') || '|' ||
      (select status from public.agents where id='${ids.agent}'::uuid) || '|' ||
      (select status from public.deployments where id='${ids.deployment}'::uuid) || '|' ||
      ((select retired_at is not null from public.deployments where id='${ids.deployment}'::uuid)::text);`))
      .toBe("paused|draft|retired|true");
    expect(runSql(`select coalesce(public.agent_studio_resource_get_release_by_agent('${ids.agent}')::text,'null');`))
      .toBe("null");
    expect(runSql(`select public.agent_studio_resource_get_release_by_publication(
      '${owner}','product-publication','publication-postgres');`)).toBe(released);

    const competingDeployment = "00000000-0000-4000-8000-000000000610";
    runSql(`insert into public.deployments(id,flow_id,flow_version_id,environment_id,status)
      values('${competingDeployment}'::uuid,'${ids.flow}'::uuid,'${ids.version}'::uuid,
        '${ids.environment}'::uuid,'live');`);
    expect(failSql(lifecycleAsAnon("resume", "paused")).status).not.toBe(0);
    expect(runSql("select status from public.resource_products where id='product-publication';"))
      .toBe("paused");
    runSql(`delete from public.deployments where id='${competingDeployment}'::uuid;`);

    runSql(lifecycleAsAnon("resume", "paused"));
    expect(runSql(`select
      (select status from public.resource_products where id='product-publication') || '|' ||
      (select status from public.agents where id='${ids.agent}'::uuid) || '|' ||
      (select status from public.deployments where id='${ids.deployment}'::uuid) || '|' ||
      ((select retired_at is null from public.deployments where id='${ids.deployment}'::uuid)::text);`))
      .toBe("live|live|live|true");
    expect(runSql(`select coalesce(public.agent_studio_resource_get_release_by_agent('${ids.agent}')::text,'null');`))
      .toBe(released);

    runSql(lifecycleAsAnon("retire", "live"));
    expect(runSql(`select
      (select status from public.resource_products where id='product-publication') || '|' ||
      (select status from public.resource_pack_versions where id='pack-publication') || '|' ||
      (select status from public.agents where id='${ids.agent}'::uuid) || '|' ||
      (select status from public.deployments where id='${ids.deployment}'::uuid);`))
      .toBe("retired|retired|draft|retired");
    expect(runSql(`select coalesce(public.agent_studio_resource_get_release_by_agent('${ids.agent}')::text,'null');`))
      .toBe("null");
    expect(runSql(`select public.agent_studio_resource_get_release_by_publication(
      '${owner}','product-publication','publication-postgres');`)).toBe(released);
    expect(failSql(lifecycleAsAnon("resume", "paused")).status).not.toBe(0);
  });

  it("upgrades a Task 6 receipt only through an exact free immutable release", () => {
    const owner = "postgres-legacy-receipt-owner";
    const semanticHash = "4".repeat(64);
    const content = JSON.stringify(basePayload("unused", "unused").content).replaceAll("'", "''");
    runSql(`
      drop trigger if exists resource_run_receipts_immutable on public.resource_run_receipts;
      alter table public.resource_run_receipts drop column agent_id;
      alter table public.resource_run_receipts drop column payment_id;
      alter table public.resource_run_receipts drop column payment_state;
      alter table public.resource_run_receipts drop column price_usdc;
      insert into public.resource_products(id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
      values('product-legacy-receipt','${owner}','Legacy receipt','legacy-receipt','live','free','public',clock_timestamp(),clock_timestamp());
      insert into public.resource_pack_versions(id,resource_product_id,revision,status,semantic_hash,content_json,created_by,created_at)
      values('pack-legacy-receipt','product-legacy-receipt',1,'live','${semanticHash}','${content}'::jsonb,'${owner}',clock_timestamp());
      insert into public.resource_releases(id,owner_id,resource_product_id,pack_version_id,semantic_hash,publication_key,publication_request_hash,graph_semantic_hash,graph_full_hash,price_usdc,execution_access,discovery_access,agent_id,flow_id,flow_version_id,deployment_id,environment_id,created_at)
      values('release-legacy-receipt','${owner}','product-legacy-receipt','pack-legacy-receipt','${semanticHash}','publication-legacy-receipt','${"3".repeat(64)}','${"2".repeat(64)}','${"1".repeat(64)}',0,'free','public','agent-legacy-receipt','flow-legacy-receipt','flow-version-legacy-receipt','deployment-legacy-receipt','environment-legacy-receipt',clock_timestamp());
      insert into public.resource_run_receipts(id,owner_id,resource_product_id,pack_version_id,run_id,flow_version_id,deployment_id,semantic_hash,freshness,evidence_json,unknowns_json,conflicts_json,output_schema_valid,created_at)
      values('receipt-legacy','${owner}','product-legacy-receipt','pack-legacy-receipt','run-legacy','flow-version-legacy-receipt','deployment-legacy-receipt','${semanticHash}','fresh','[]','[]','[]',true,clock_timestamp());
    `);
    execFileSync("psql", [
      ...psqlArgs(),
      "--file", join(process.cwd(), "docs/migrations/agent-resource-foundry.sql"),
    ], { stdio: "pipe", timeout: 60_000 });
    expect(runSql(`select agent_id||'|'||payment_state||'|'||price_usdc||'|'||coalesce(payment_id,'null')
      from public.resource_run_receipts where run_id='run-legacy';`))
      .toBe("agent-legacy-receipt|free|0|null");
  });
});
