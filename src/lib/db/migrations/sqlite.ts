import Database from "better-sqlite3";
import { createHash } from "node:crypto";

interface SqliteMigration {
  version: number;
  name: string;
  signature: string;
  up(db: Database.Database): void | "ap2-v40-quarantined";
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

interface SqliteColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function assertNullableColumn(
  db: Database.Database,
  table: string,
  column: string,
  expectedType: string,
): void {
  const row = (db.prepare(`PRAGMA table_info(${table})`).all() as SqliteColumnInfo[])
    .find((candidate) => candidate.name === column);
  if (
    !row ||
    row.type.trim().toUpperCase() !== expectedType ||
    row.notnull !== 0 ||
    row.dflt_value !== null ||
    row.pk !== 0
  ) {
    throw new Error(`SQLite ${table}.${column} definition mismatch`);
  }
}

function assertIndexColumns(
  db: Database.Database,
  table: string,
  index: string,
  expectedColumns: readonly string[],
): void {
  const indexRow = (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>).find((candidate) => candidate.name === index);
  const columns = (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{
    seqno: number;
    name: string;
  }>).sort((left, right) => left.seqno - right.seqno).map((row) => row.name);
  if (!indexRow || indexRow.unique !== 0 || indexRow.partial !== 0 ||
      columns.length !== expectedColumns.length ||
      columns.some((column, position) => column !== expectedColumns[position])) {
    throw new Error(`SQLite ${index} definition mismatch`);
  }
}

function enableForeignKeys(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  const state = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  if (state.foreign_keys !== 1) {
    throw new Error("SQLite foreign-key enforcement could not be enabled");
  }
}

function assertForeignKeyIntegrity(db: Database.Database): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all() as Array<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>;
  if (violations.length === 0) return;
  const first = violations[0];
  throw new Error(
    `SQLite foreign key integrity check failed: ${first.table} row ${first.rowid ?? "unknown"} references ${first.parent}`,
  );
}

const INITIAL_CORE_SQL = `
  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
    graph TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL, price_usdc REAL NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, agent_id TEXT,
    trigger TEXT NOT NULL, status TEXT NOT NULL, total_cost_usdc REAL NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
    node_type TEXT NOT NULL, status TEXT NOT NULL, cost_usdc REAL NOT NULL,
    output TEXT, error TEXT
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cron TEXT NOT NULL,
    enabled INTEGER NOT NULL, last_run_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS wallets (
    owner_id TEXT PRIMARY KEY, address TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'base-mainnet', label TEXT
  );
`;

const RELAY_USAGE_CREDITS_SQL = `
  CREATE TABLE IF NOT EXISTS relay_endpoints (
    agent_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE (agent_id)
  );
  CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
    units INTEGER NOT NULL, cost_usdc REAL NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credits (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, delta_usdc REAL NOT NULL,
    reason TEXT NOT NULL, tx TEXT, created_at TEXT NOT NULL
  );
`;

const WEBHOOK_ENDPOINTS_SQL = `
  CREATE TABLE IF NOT EXISTS webhook_endpoints (
    agent_id TEXT NOT NULL, secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE (agent_id)
  );
`;

const PROJECTS_AND_VERSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    personal_owner_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (organization_id, slug)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug)
  );

  CREATE TABLE IF NOT EXISTS workbooks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, slug)
  );

  CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, slug)
  );

  CREATE TABLE IF NOT EXISTS flow_project_bindings (
    flow_id TEXT PRIMARY KEY REFERENCES flows(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    workbook_id TEXT NOT NULL REFERENCES workbooks(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flow_versions (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flows(id),
    version_number INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    label TEXT,
    description TEXT,
    graph TEXT NOT NULL,
    semantic_hash TEXT NOT NULL,
    full_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (flow_id, version_number)
  );

  CREATE TABLE IF NOT EXISTS dependency_pins (
    id TEXT PRIMARY KEY,
    flow_version_id TEXT NOT NULL REFERENCES flow_versions(id),
    kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    version TEXT NOT NULL,
    content_hash TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (flow_version_id, kind, resource_id)
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flows(id),
    flow_version_id TEXT NOT NULL REFERENCES flow_versions(id),
    environment_id TEXT NOT NULL REFERENCES environments(id),
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    retired_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_organization_id
    ON workspaces(organization_id);
  CREATE INDEX IF NOT EXISTS idx_projects_workspace_id
    ON projects(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workbooks_project_id
    ON workbooks(project_id);
  CREATE INDEX IF NOT EXISTS idx_environments_project_id
    ON environments(project_id);
  CREATE INDEX IF NOT EXISTS idx_flow_project_bindings_project_id
    ON flow_project_bindings(project_id);
  CREATE INDEX IF NOT EXISTS idx_flow_project_bindings_workbook_id
    ON flow_project_bindings(workbook_id);
  CREATE INDEX IF NOT EXISTS idx_flow_versions_flow_id
    ON flow_versions(flow_id);
  CREATE INDEX IF NOT EXISTS idx_dependency_pins_flow_version_id
    ON dependency_pins(flow_version_id);
  CREATE INDEX IF NOT EXISTS idx_deployments_flow_id
    ON deployments(flow_id);
  CREATE INDEX IF NOT EXISTS idx_deployments_flow_version_id
    ON deployments(flow_version_id);
  CREATE INDEX IF NOT EXISTS idx_deployments_environment_id
    ON deployments(environment_id);
`;

const DEPLOYMENT_INTEGRITY_SQL = `
  CREATE UNIQUE INDEX uq_environments_project_kind
    ON environments(project_id, kind);
  CREATE UNIQUE INDEX uq_deployments_active_flow_environment
    ON deployments(flow_id, environment_id)
    WHERE retired_at IS NULL;
  CREATE INDEX idx_deployments_flow_history
    ON deployments(flow_id, created_at DESC, id DESC);
`;

const DEPLOYMENT_INTEGRITY_INDEX_DEFINITIONS = [
  {
    name: "uq_environments_project_kind",
    sql: "CREATE UNIQUE INDEX uq_environments_project_kind ON environments(project_id, kind)",
  },
  {
    name: "uq_deployments_active_flow_environment",
    sql: `CREATE UNIQUE INDEX uq_deployments_active_flow_environment
      ON deployments(flow_id, environment_id) WHERE retired_at IS NULL`,
  },
  {
    name: "idx_deployments_flow_history",
    sql: `CREATE INDEX idx_deployments_flow_history
      ON deployments(flow_id, created_at DESC, id DESC)`,
  },
] as const;

const WORKBOOK_FLOW_TABS_SQL = `
  CREATE TABLE workbook_flow_tabs (
    id TEXT PRIMARY KEY,
    workbook_id TEXT NOT NULL REFERENCES workbooks(id),
    flow_id TEXT NOT NULL UNIQUE REFERENCES flows(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workbook_id, flow_id),
    UNIQUE (workbook_id, position)
  );
  CREATE INDEX idx_workbook_flow_tabs_workbook_order
    ON workbook_flow_tabs(workbook_id, position, id);
  CREATE INDEX idx_workbook_flow_tabs_flow_id
    ON workbook_flow_tabs(flow_id);
`;

const WORKBOOK_FLOW_TABS_SIGNATURE = `${WORKBOOK_FLOW_TABS_SQL}
backfill:v1:sha256(workbook_id+NUL+flow_id):binding-created-at:workbook-created-flow-order`;

const SUBFLOW_IMPACT_RECEIPTS_SQL = `
  CREATE TABLE subflow_impact_receipts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 32 AND 256),
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 512),
    child_flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE
      CHECK(length(child_flow_id) BETWEEN 1 AND 512),
    old_interface_hash TEXT NOT NULL CHECK(old_interface_hash = 'none' OR length(old_interface_hash) = 64 AND old_interface_hash NOT GLOB '*[^0-9a-f]*'),
    proposed_interface_hash TEXT NOT NULL CHECK(proposed_interface_hash = 'none' OR length(proposed_interface_hash) = 64 AND proposed_interface_hash NOT GLOB '*[^0-9a-f]*'),
    dependent_set_hash TEXT NOT NULL CHECK(length(dependent_set_hash) = 64 AND dependent_set_hash NOT GLOB '*[^0-9a-f]*'),
    issued_at INTEGER NOT NULL CHECK(issued_at >= 0),
    expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
    consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at BETWEEN issued_at AND expires_at)
  );
  CREATE UNIQUE INDEX uq_subflow_impact_receipts_owner_child
    ON subflow_impact_receipts(owner_id, child_flow_id);
  CREATE INDEX idx_subflow_impact_receipts_expiry
    ON subflow_impact_receipts(expires_at, consumed_at);
  CREATE INDEX idx_subflow_impact_receipts_child
    ON subflow_impact_receipts(child_flow_id, id);
  CREATE INDEX idx_flows_owner_id ON flows(owner_id, id);
  CREATE TRIGGER subflow_impact_receipts_owner_insert
    BEFORE INSERT ON subflow_impact_receipts
    WHEN NOT EXISTS (
      SELECT 1 FROM flows
      WHERE id = NEW.child_flow_id AND owner_id = NEW.owner_id
    )
    BEGIN SELECT RAISE(ABORT, 'impact receipt owner mismatch'); END;
  CREATE TRIGGER subflow_impact_receipts_owner_update
    BEFORE UPDATE OF owner_id, child_flow_id ON subflow_impact_receipts
    WHEN NOT EXISTS (
      SELECT 1 FROM flows
      WHERE id = NEW.child_flow_id AND owner_id = NEW.owner_id
    )
    BEGIN SELECT RAISE(ABORT, 'impact receipt owner mismatch'); END;
`;

const SUBFLOW_IMPACT_RECEIPT_DEFINITIONS = [
  {
    type: "table",
    name: "subflow_impact_receipts",
    sql: `CREATE TABLE subflow_impact_receipts (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 32 AND 256),
      owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 512),
      child_flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE
        CHECK(length(child_flow_id) BETWEEN 1 AND 512),
      old_interface_hash TEXT NOT NULL CHECK(old_interface_hash = 'none' OR length(old_interface_hash) = 64 AND old_interface_hash NOT GLOB '*[^0-9a-f]*'),
      proposed_interface_hash TEXT NOT NULL CHECK(proposed_interface_hash = 'none' OR length(proposed_interface_hash) = 64 AND proposed_interface_hash NOT GLOB '*[^0-9a-f]*'),
      dependent_set_hash TEXT NOT NULL CHECK(length(dependent_set_hash) = 64 AND dependent_set_hash NOT GLOB '*[^0-9a-f]*'),
      issued_at INTEGER NOT NULL CHECK(issued_at >= 0),
      expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
      consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at BETWEEN issued_at AND expires_at)
    )`,
  },
  {
    type: "index",
    name: "uq_subflow_impact_receipts_owner_child",
    sql: `CREATE UNIQUE INDEX uq_subflow_impact_receipts_owner_child
      ON subflow_impact_receipts(owner_id, child_flow_id)`,
  },
  {
    type: "index",
    name: "idx_subflow_impact_receipts_expiry",
    sql: `CREATE INDEX idx_subflow_impact_receipts_expiry
      ON subflow_impact_receipts(expires_at, consumed_at)`,
  },
  {
    type: "index",
    name: "idx_subflow_impact_receipts_child",
    sql: `CREATE INDEX idx_subflow_impact_receipts_child
      ON subflow_impact_receipts(child_flow_id, id)`,
  },
  {
    type: "index",
    name: "idx_flows_owner_id",
    sql: "CREATE INDEX idx_flows_owner_id ON flows(owner_id, id)",
  },
  {
    type: "trigger",
    name: "subflow_impact_receipts_owner_insert",
    sql: `CREATE TRIGGER subflow_impact_receipts_owner_insert
      BEFORE INSERT ON subflow_impact_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM flows
        WHERE id = NEW.child_flow_id AND owner_id = NEW.owner_id
      )
      BEGIN SELECT RAISE(ABORT, 'impact receipt owner mismatch'); END`,
  },
  {
    type: "trigger",
    name: "subflow_impact_receipts_owner_update",
    sql: `CREATE TRIGGER subflow_impact_receipts_owner_update
      BEFORE UPDATE OF owner_id, child_flow_id ON subflow_impact_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM flows
        WHERE id = NEW.child_flow_id AND owner_id = NEW.owner_id
      )
      BEGIN SELECT RAISE(ABORT, 'impact receipt owner mismatch'); END`,
  },
] as const;

const SUBFLOW_API_READ_INDEX_SQL = `
  CREATE INDEX idx_flows_owner_name_id ON flows(owner_id, name, id);
  CREATE INDEX idx_flow_versions_flow_number_id
    ON flow_versions(flow_id, version_number DESC, id DESC);
`;

const DURABLE_RUNTIME_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_flows_id_owner
    ON flows(id, owner_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_versions_id_flow
    ON flow_versions(id, flow_id);
  CREATE TABLE IF NOT EXISTS durable_executions (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 512),
    flow_id TEXT NOT NULL CHECK(length(flow_id) BETWEEN 1 AND 512),
    flow_version_id TEXT NOT NULL CHECK(length(flow_version_id) BETWEEN 1 AND 512),
    deployment_id TEXT REFERENCES deployments(id),
    environment_id TEXT REFERENCES environments(id),
    parent_execution_id TEXT REFERENCES durable_executions(id),
    checkpoint_id TEXT,
    frozen_definition_json TEXT NOT NULL CHECK(length(CAST(frozen_definition_json AS BLOB)) BETWEEN 2 AND 262144 AND json_valid(frozen_definition_json)),
    definition_hash TEXT NOT NULL CHECK(length(definition_hash) = 64 AND definition_hash NOT GLOB '*[^0-9a-f]*'),
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('api', 'schedule', 'webhook', 'retry', 'fork')),
    trigger_id TEXT CHECK(trigger_id IS NULL OR length(trigger_id) BETWEEN 1 AND 512),
    state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'dead')),
    desired_state TEXT NOT NULL CHECK(desired_state IN ('running', 'paused', 'cancelled')),
    next_event_seq INTEGER NOT NULL CHECK(typeof(next_event_seq) = 'integer' AND next_event_seq BETWEEN 1 AND 9007199254740991),
    projected_event_seq INTEGER NOT NULL CHECK(typeof(projected_event_seq) = 'integer' AND projected_event_seq BETWEEN 0 AND 9007199254740991 AND projected_event_seq < next_event_seq),
    projection_json TEXT NOT NULL CHECK(length(CAST(projection_json AS BLOB)) BETWEEN 2 AND 262144 AND json_valid(projection_json)),
    result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 131072 AND json_valid(result_json)),
    error_text TEXT CHECK(error_text IS NULL OR length(CAST(error_text AS BLOB)) <= 8192),
    cost_micro_usdc INTEGER NOT NULL CHECK(typeof(cost_micro_usdc) = 'integer' AND cost_micro_usdc BETWEEN 0 AND 9007199254740991),
    token_count INTEGER NOT NULL CHECK(typeof(token_count) = 'integer' AND token_count BETWEEN 0 AND 9007199254740991),
    cost_budget_micro_usdc INTEGER NOT NULL CHECK(typeof(cost_budget_micro_usdc) = 'integer' AND cost_budget_micro_usdc BETWEEN 0 AND 9007199254740991),
    token_budget INTEGER NOT NULL CHECK(typeof(token_budget) = 'integer' AND token_budget BETWEEN 0 AND 9007199254740991),
    deadline_at INTEGER CHECK(deadline_at IS NULL OR typeof(deadline_at) = 'integer' AND deadline_at BETWEEN 0 AND 9007199254740991),
    attempt_number INTEGER NOT NULL CHECK(typeof(attempt_number) = 'integer' AND attempt_number BETWEEN 0 AND 100),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991),
    finished_at INTEGER CHECK(finished_at IS NULL OR typeof(finished_at) = 'integer' AND finished_at BETWEEN created_at AND 9007199254740991),
    CHECK(checkpoint_id IS NULL OR parent_execution_id IS NOT NULL),
    FOREIGN KEY(flow_id, owner_id) REFERENCES flows(id, owner_id),
    FOREIGN KEY(flow_version_id, flow_id) REFERENCES flow_versions(id, flow_id),
    FOREIGN KEY(parent_execution_id, checkpoint_id) REFERENCES execution_checkpoints(execution_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_durable_executions_owner_created
    ON durable_executions(owner_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_durable_executions_flow_version
    ON durable_executions(flow_id, flow_version_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS execution_events (
    execution_id TEXT NOT NULL REFERENCES durable_executions(id) ON DELETE RESTRICT,
    seq INTEGER NOT NULL CHECK(typeof(seq) = 'integer' AND seq BETWEEN 1 AND 9007199254740991),
    schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
    attempt INTEGER NOT NULL CHECK(typeof(attempt) = 'integer' AND attempt BETWEEN 0 AND 100),
    type TEXT NOT NULL CHECK(type IN ('execution.created','job.enqueued','job.claimed','attempt.started','node.started','node.logged','node.completed','node.failed','control.requested','attempt.retry_scheduled','execution.paused','execution.resumed','execution.cancelled','execution.succeeded','execution.failed','execution.dead_lettered')),
    at INTEGER NOT NULL CHECK(typeof(at) = 'integer' AND at BETWEEN 0 AND 9007199254740991),
    payload_json TEXT NOT NULL CHECK(
      length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 262144 AND json_valid(payload_json)
      AND CASE
        WHEN type IN ('node.failed','attempt.retry_scheduled','execution.failed','execution.dead_lettered')
          THEN json_type(payload_json, '$.error') = 'text' AND length(CAST(json_extract(payload_json, '$.error') AS BLOB)) BETWEEN 1 AND 8192
        WHEN type = 'execution.cancelled'
          THEN json_type(payload_json, '$.reason') = 'text' AND length(CAST(json_extract(payload_json, '$.reason') AS BLOB)) BETWEEN 1 AND 8192
        ELSE 1
      END
    ),
    PRIMARY KEY(execution_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_execution_events_execution_sequence
    ON execution_events(execution_id, seq);
  CREATE TRIGGER IF NOT EXISTS execution_events_no_update BEFORE UPDATE ON execution_events
    BEGIN SELECT RAISE(ABORT, 'execution events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS execution_events_no_delete BEFORE DELETE ON execution_events
    BEGIN SELECT RAISE(ABORT, 'execution events are append-only'); END;

  CREATE TABLE IF NOT EXISTS execution_jobs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
    execution_id TEXT NOT NULL UNIQUE REFERENCES durable_executions(id) ON DELETE RESTRICT,
    logical_key TEXT NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 256),
    state TEXT NOT NULL CHECK(state IN ('ready', 'leased', 'retry', 'completed', 'cancelled', 'dead')),
    priority INTEGER NOT NULL CHECK(typeof(priority) = 'integer' AND priority BETWEEN 0 AND 1000000),
    available_at INTEGER NOT NULL CHECK(typeof(available_at) = 'integer' AND available_at BETWEEN 0 AND 9007199254740991),
    max_attempts INTEGER NOT NULL CHECK(typeof(max_attempts) = 'integer' AND max_attempts BETWEEN 1 AND 100),
    attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND max_attempts),
    lease_owner TEXT CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 512),
    lease_token_hash TEXT CHECK(lease_token_hash IS NULL OR length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*'),
    lease_expires_at INTEGER CHECK(lease_expires_at IS NULL OR typeof(lease_expires_at) = 'integer' AND lease_expires_at BETWEEN 0 AND 9007199254740991),
    heartbeat_at INTEGER CHECK(heartbeat_at IS NULL OR typeof(heartbeat_at) = 'integer' AND heartbeat_at BETWEEN 0 AND 9007199254740991),
    last_error TEXT CHECK(last_error IS NULL OR length(CAST(last_error AS BLOB)) <= 8192),
    dead_lettered_at INTEGER CHECK(dead_lettered_at IS NULL OR typeof(dead_lettered_at) = 'integer' AND dead_lettered_at BETWEEN 0 AND 9007199254740991),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991),
    UNIQUE(execution_id, logical_key),
    UNIQUE(execution_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_execution_jobs_claim
    ON execution_jobs(state, priority DESC, available_at ASC, created_at ASC, id ASC);

  CREATE TABLE IF NOT EXISTS execution_attempts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
    execution_id TEXT NOT NULL REFERENCES durable_executions(id) ON DELETE RESTRICT,
    job_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(typeof(attempt_number) = 'integer' AND attempt_number BETWEEN 1 AND 100),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 512),
    lease_token_hash TEXT NOT NULL CHECK(length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK(state IN ('leased', 'succeeded', 'failed', 'cancelled', 'lost')),
    started_at INTEGER NOT NULL CHECK(typeof(started_at) = 'integer' AND started_at BETWEEN 0 AND 9007199254740991),
    heartbeat_at INTEGER NOT NULL CHECK(typeof(heartbeat_at) = 'integer' AND heartbeat_at BETWEEN started_at AND 9007199254740991),
    finished_at INTEGER CHECK(finished_at IS NULL OR typeof(finished_at) = 'integer' AND finished_at BETWEEN started_at AND 9007199254740991),
    error_text TEXT CHECK(error_text IS NULL OR length(CAST(error_text AS BLOB)) <= 8192),
    UNIQUE(job_id, attempt_number),
    UNIQUE(job_id, id, lease_token_hash),
    UNIQUE(execution_id, id),
    FOREIGN KEY(execution_id, job_id) REFERENCES execution_jobs(execution_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_execution_attempts_job
    ON execution_attempts(job_id, attempt_number DESC);

  CREATE TABLE IF NOT EXISTS execution_checkpoints (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
    execution_id TEXT NOT NULL REFERENCES durable_executions(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL CHECK(typeof(event_seq) = 'integer' AND event_seq BETWEEN 1 AND 9007199254740991),
    state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB)) BETWEEN 2 AND 262144 AND json_valid(state_json)),
    state_hash TEXT NOT NULL CHECK(length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    UNIQUE(execution_id, event_seq),
    UNIQUE(execution_id, id),
    FOREIGN KEY(execution_id, attempt_id) REFERENCES execution_attempts(execution_id, id),
    FOREIGN KEY(execution_id, event_seq) REFERENCES execution_events(execution_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_execution_checkpoints_execution_sequence
    ON execution_checkpoints(execution_id, event_seq DESC);
  CREATE TRIGGER IF NOT EXISTS execution_checkpoints_no_update BEFORE UPDATE ON execution_checkpoints
    BEGIN SELECT RAISE(ABORT, 'execution checkpoints are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS execution_checkpoints_no_delete BEFORE DELETE ON execution_checkpoints
    BEGIN SELECT RAISE(ABORT, 'execution checkpoints are append-only'); END;

  CREATE TABLE IF NOT EXISTS execution_idempotency (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 512),
    namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 128),
    key_hash TEXT NOT NULL CHECK(length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    execution_id TEXT NOT NULL REFERENCES durable_executions(id) ON DELETE RESTRICT,
    job_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('committed')),
    response_json TEXT NOT NULL CHECK(length(CAST(response_json AS BLOB)) BETWEEN 2 AND 16384 AND json_valid(response_json)),
    expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991),
    committed_at INTEGER NOT NULL CHECK(typeof(committed_at) = 'integer' AND committed_at BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY(execution_id, job_id) REFERENCES execution_jobs(execution_id, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_idempotency_scope
    ON execution_idempotency(owner_id, namespace, key_hash);
  CREATE INDEX IF NOT EXISTS idx_execution_idempotency_expiry
    ON execution_idempotency(expires_at, id);
  CREATE TRIGGER IF NOT EXISTS execution_idempotency_owner_insert BEFORE INSERT ON execution_idempotency
    WHEN NOT EXISTS (SELECT 1 FROM durable_executions WHERE id = NEW.execution_id AND owner_id = NEW.owner_id)
    BEGIN SELECT RAISE(ABORT, 'execution idempotency owner mismatch'); END;
  CREATE TRIGGER IF NOT EXISTS execution_idempotency_owner_update BEFORE UPDATE OF owner_id, execution_id ON execution_idempotency
    WHEN NOT EXISTS (SELECT 1 FROM durable_executions WHERE id = NEW.execution_id AND owner_id = NEW.owner_id)
    BEGIN SELECT RAISE(ABORT, 'execution idempotency owner mismatch'); END;
`;

const DURABLE_RUNTIME_OBJECTS = [
  ...["durable_executions", "execution_events", "execution_jobs", "execution_attempts", "execution_checkpoints", "execution_idempotency"].map((name) => ({ type: "table", name })),
  ...["uq_flows_id_owner", "uq_flow_versions_id_flow", "idx_durable_executions_owner_created", "idx_durable_executions_flow_version", "idx_execution_events_execution_sequence", "idx_execution_jobs_claim", "idx_execution_attempts_job", "idx_execution_checkpoints_execution_sequence", "uq_execution_idempotency_scope", "idx_execution_idempotency_expiry"].map((name) => ({ type: "index", name })),
  ...["execution_events_no_update", "execution_events_no_delete", "execution_checkpoints_no_update", "execution_checkpoints_no_delete", "execution_idempotency_owner_insert", "execution_idempotency_owner_update"].map((name) => ({ type: "trigger", name })),
] as const;

const DURABLE_INVOCATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS execution_invocations (
    execution_id TEXT PRIMARY KEY REFERENCES durable_executions(id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
    snapshot_json TEXT NOT NULL CHECK(length(CAST(snapshot_json AS BLOB)) BETWEEN 2 AND 1572864 AND json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
    snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991)
  );
  CREATE TRIGGER IF NOT EXISTS execution_invocations_no_update BEFORE UPDATE ON execution_invocations
    BEGIN SELECT RAISE(ABORT, 'execution invocations are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS execution_invocations_no_delete BEFORE DELETE ON execution_invocations
    BEGIN SELECT RAISE(ABORT, 'execution invocations are append-only'); END;
`;

const DURABLE_INVOCATION_OBJECTS = [
  { type: "table", name: "execution_invocations" },
  { type: "trigger", name: "execution_invocations_no_update" },
  { type: "trigger", name: "execution_invocations_no_delete" },
] as const;

const DURABLE_EVENT_USAGE_SQL = `
  CREATE TABLE IF NOT EXISTS execution_event_usage (
    execution_id TEXT PRIMARY KEY REFERENCES durable_executions(id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
    total_event_bytes INTEGER NOT NULL CHECK(typeof(total_event_bytes) = 'integer' AND total_event_bytes BETWEEN 0 AND 9175040),
    node_event_bytes INTEGER NOT NULL CHECK(typeof(node_event_bytes) = 'integer' AND node_event_bytes BETWEEN 0 AND 8912896 AND node_event_bytes <= total_event_bytes),
    total_event_limit INTEGER NOT NULL CHECK(typeof(total_event_limit) = 'integer' AND total_event_limit BETWEEN total_event_bytes AND 9175040),
    node_event_limit INTEGER NOT NULL CHECK(typeof(node_event_limit) = 'integer' AND node_event_limit BETWEEN node_event_bytes AND 8962048),
    event_count INTEGER NOT NULL CHECK(typeof(event_count) = 'integer' AND event_count BETWEEN 0 AND 9007199254740991),
    event_count_limit INTEGER NOT NULL CHECK(typeof(event_count_limit) = 'integer' AND event_count_limit BETWEEN event_count AND 10514),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991)
  );
  INSERT INTO execution_event_usage (execution_id, schema_version, total_event_bytes, node_event_bytes, total_event_limit, node_event_limit, event_count, event_count_limit, updated_at)
  SELECT x.id, 1,
         COALESCE(SUM(length(CAST(e.payload_json AS BLOB))), 0),
         COALESCE(SUM(CASE WHEN e.type LIKE 'node.%' THEN length(CAST(e.payload_json AS BLOB)) ELSE 0 END), 0),
         MAX(2097152, COALESCE(SUM(length(CAST(e.payload_json AS BLOB))), 0) + 262144),
         MAX(49152, COALESCE(SUM(CASE WHEN e.type LIKE 'node.%' THEN length(CAST(e.payload_json AS BLOB)) ELSE 0 END), 0) + 49152),
         COUNT(e.seq),
         MAX(4096, COUNT(e.seq) + 512),
         COALESCE(MAX(e.at), x.updated_at)
  FROM durable_executions x LEFT JOIN execution_events e ON e.execution_id = x.id
  GROUP BY x.id;
  CREATE TABLE IF NOT EXISTS execution_job_quarantine (
    job_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('invalid_durable_invocation','durable_mirror_mismatch','durable_event_usage_mismatch')),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY(execution_id, job_id) REFERENCES execution_jobs(execution_id, id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_execution_job_quarantine_execution ON execution_job_quarantine(execution_id, job_id);
  CREATE TRIGGER IF NOT EXISTS execution_job_quarantine_no_update BEFORE UPDATE ON execution_job_quarantine
    BEGIN SELECT RAISE(ABORT, 'execution job quarantine is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS execution_job_quarantine_no_delete BEFORE DELETE ON execution_job_quarantine
    BEGIN SELECT RAISE(ABORT, 'execution job quarantine is append-only'); END;
`;

const DURABLE_EVENT_USAGE_OBJECTS = [
  { type: "table", name: "execution_event_usage" },
  { type: "table", name: "execution_job_quarantine" },
  { type: "index", name: "idx_execution_job_quarantine_execution" },
  { type: "trigger", name: "execution_job_quarantine_no_update" },
  { type: "trigger", name: "execution_job_quarantine_no_delete" },
] as const;

const DURABLE_PARENT_OWNER_SQL = `
  CREATE TRIGGER IF NOT EXISTS durable_executions_parent_owner_insert BEFORE INSERT ON durable_executions
    WHEN NEW.parent_execution_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM durable_executions parent WHERE parent.id = NEW.parent_execution_id AND parent.owner_id = NEW.owner_id
    )
    BEGIN SELECT RAISE(ABORT, 'durable parent owner mismatch'); END;
  CREATE TRIGGER IF NOT EXISTS durable_executions_parent_owner_update BEFORE UPDATE OF owner_id, parent_execution_id ON durable_executions
    WHEN (NEW.parent_execution_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM durable_executions parent WHERE parent.id = NEW.parent_execution_id AND parent.owner_id = NEW.owner_id
    )) OR EXISTS (
      SELECT 1 FROM durable_executions child WHERE child.parent_execution_id = NEW.id AND child.owner_id <> NEW.owner_id
    )
    BEGIN SELECT RAISE(ABORT, 'durable parent owner mismatch'); END;
`;

function connectionPublicConfigValidSql(row: "NEW" | "candidate"): string {
  return `
  ${row}.public_config = json(${row}.public_config)
  AND (
    (${row}.kind IN ('bearer', 'basic')
      AND (SELECT count(*) FROM json_each(${row}.public_config)) = 0)
    OR
    (${row}.kind = 'api_key'
      AND (SELECT count(*) FROM json_each(${row}.public_config)) = 1
      AND json_type(${row}.public_config, '$.headerName') = 'text'
      AND length(json_extract(${row}.public_config, '$.headerName')) BETWEEN 1 AND 64
      AND json_extract(${row}.public_config, '$.headerName')
        NOT GLOB '*[^!#$%&''*+.^_\`|~0-9A-Za-z-]*'
      AND lower(json_extract(${row}.public_config, '$.headerName')) NOT IN
        ('host','cookie','connection','keep-alive','proxy-authenticate','proxy-authorization',
         'proxy-connection','te','trailer','transfer-encoding','upgrade','__proto__','prototype','constructor'))
    OR
    (${row}.kind = 'custom_headers'
      AND (SELECT count(*) FROM json_each(${row}.public_config)) = 1
      AND json_type(${row}.public_config, '$.headerNames') = 'array'
      AND json_array_length(${row}.public_config, '$.headerNames') BETWEEN 1 AND 16
      AND NOT EXISTS (
        SELECT 1 FROM json_each(${row}.public_config, '$.headerNames') header
        WHERE header.type <> 'text'
          OR length(header.value) NOT BETWEEN 1 AND 64
          OR header.value GLOB '*[^!#$%&''*+.^_\`|~0-9A-Za-z-]*'
          OR lower(header.value) IN
            ('host','cookie','connection','keep-alive','proxy-authenticate','proxy-authorization',
             'proxy-connection','te','trailer','transfer-encoding','upgrade','__proto__','prototype','constructor')
      )
      AND (SELECT count(*) FROM json_each(${row}.public_config, '$.headerNames')) =
          (SELECT count(DISTINCT lower(header.value)) FROM json_each(${row}.public_config, '$.headerNames') header)
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(${row}.public_config, '$.headerNames') left_header
        JOIN json_each(${row}.public_config, '$.headerNames') right_header
          ON right_header.key = left_header.key + 1
        WHERE lower(left_header.value) >= lower(right_header.value)
      ))
  )
`;
}

const CONNECTION_PUBLIC_CONFIG_VALID_SQL = connectionPublicConfigValidSql("NEW");
const CONNECTION_PUBLIC_CONFIG_ROW_VALID_SQL = connectionPublicConfigValidSql("candidate");

const LOGICAL_CONNECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY
      CHECK(length(id) BETWEEN 1 AND 256),
    owner_id TEXT NOT NULL
      CHECK(length(owner_id) BETWEEN 1 AND 512),
    name TEXT NOT NULL
      CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 120 AND name = trim(name)),
    kind TEXT NOT NULL
      CHECK(kind IN ('api_key', 'bearer', 'basic', 'custom_headers')),
    public_config TEXT NOT NULL
      CHECK(length(CAST(public_config AS BLOB)) BETWEEN 2 AND 32768
        AND json_valid(public_config)
        AND json_type(public_config) = 'object'),
    schema_version INTEGER NOT NULL
      CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
    lifecycle_revision INTEGER NOT NULL
      CHECK(typeof(lifecycle_revision) = 'integer' AND lifecycle_revision BETWEEN 1 AND 9007199254740991),
    created_at INTEGER NOT NULL
      CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL
      CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991)
  );

  CREATE TABLE IF NOT EXISTS connection_slots (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
    environment TEXT NOT NULL CHECK(environment IN ('test', 'live')),
    status TEXT NOT NULL CHECK(status IN ('configured', 'revoked')),
    secret_version INTEGER NOT NULL
      CHECK(typeof(secret_version) = 'integer' AND secret_version BETWEEN 1 AND 9007199254740991),
    key_version INTEGER
      CHECK(key_version IS NULL OR typeof(key_version) = 'integer' AND key_version BETWEEN 1 AND 9007199254740991),
    nonce BLOB,
    ciphertext BLOB,
    auth_tag BLOB,
    configured_at INTEGER NOT NULL
      CHECK(typeof(configured_at) = 'integer' AND configured_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL
      CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN configured_at AND 9007199254740991),
    revoked_at INTEGER
      CHECK(revoked_at IS NULL OR typeof(revoked_at) = 'integer' AND revoked_at BETWEEN configured_at AND updated_at),
    PRIMARY KEY(connection_id, environment),
    CHECK(
      (status = 'configured'
        AND key_version IS NOT NULL
        AND typeof(nonce) = 'blob' AND length(nonce) = 12
        AND typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 1 AND 32768
        AND typeof(auth_tag) = 'blob' AND length(auth_tag) = 16
        AND revoked_at IS NULL)
      OR
      (status = 'revoked'
        AND key_version IS NULL
        AND nonce IS NULL
        AND ciphertext IS NULL
        AND auth_tag IS NULL
        AND revoked_at IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_connections_owner_updated
    ON connections(owner_id, updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_connections_owner_name
    ON connections(owner_id, name, id);
  CREATE INDEX IF NOT EXISTS idx_connection_slots_status_environment
    ON connection_slots(status, environment, connection_id);
`;

const LOGICAL_CONNECTION_HARDENING_SQL = `
  CREATE TRIGGER IF NOT EXISTS connections_public_config_insert
    BEFORE INSERT ON connections
    WHEN COALESCE((${CONNECTION_PUBLIC_CONFIG_VALID_SQL}), 0) = 0
    BEGIN SELECT RAISE(ABORT, 'invalid connection public config'); END;

  CREATE TRIGGER IF NOT EXISTS connections_public_config_update
    BEFORE UPDATE OF kind, public_config ON connections
    WHEN COALESCE((${CONNECTION_PUBLIC_CONFIG_VALID_SQL}), 0) = 0
    BEGIN SELECT RAISE(ABORT, 'invalid connection public config'); END;

  CREATE TRIGGER IF NOT EXISTS connections_revision_update
    BEFORE UPDATE ON connections
    WHEN NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    BEGIN SELECT RAISE(ABORT, 'invalid connection lifecycle revision'); END;

  CREATE TRIGGER IF NOT EXISTS connections_identity_update
    BEFORE UPDATE OF kind, public_config ON connections
    WHEN (NEW.kind <> OLD.kind OR NEW.public_config <> OLD.public_config)
      AND EXISTS (SELECT 1 FROM connection_slots WHERE connection_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'configured connection identity is immutable'); END;

  CREATE TRIGGER IF NOT EXISTS connection_slots_transition_update
    BEFORE UPDATE ON connection_slots
    WHEN NEW.connection_id <> OLD.connection_id
      OR NEW.environment <> OLD.environment
      OR NOT (
        (OLD.status = 'configured' AND NEW.status = 'configured'
          AND NEW.secret_version = OLD.secret_version + 1)
        OR
        (OLD.status = 'configured' AND NEW.status = 'revoked'
          AND NEW.secret_version = OLD.secret_version)
        OR
        (OLD.status = 'revoked' AND NEW.status = 'configured'
          AND NEW.secret_version = OLD.secret_version + 1)
      )
    BEGIN SELECT RAISE(ABORT, 'invalid connection slot transition'); END;

  CREATE TRIGGER IF NOT EXISTS connection_slots_key_version_insert
    BEFORE INSERT ON connection_slots
    WHEN NEW.status = 'configured' AND COALESCE(NEW.key_version = 1, 0) = 0
    BEGIN SELECT RAISE(ABORT, 'invalid connection slot key version'); END;

  CREATE TRIGGER IF NOT EXISTS connection_slots_key_version_update
    BEFORE UPDATE OF status, key_version ON connection_slots
    WHEN NEW.status = 'configured' AND COALESCE(NEW.key_version = 1, 0) = 0
    BEGIN SELECT RAISE(ABORT, 'invalid connection slot key version'); END;

  CREATE TRIGGER IF NOT EXISTS connection_slots_delete
    BEFORE DELETE ON connection_slots
    BEGIN SELECT RAISE(ABORT, 'connection slots are append-only'); END;

  CREATE TRIGGER IF NOT EXISTS connections_delete
    BEFORE DELETE ON connections
    BEGIN SELECT RAISE(ABORT, 'connections are append-only'); END;
`;

const LOGICAL_CONNECTION_REPLACEMENT_GUARDS_SQL = `
  CREATE TRIGGER IF NOT EXISTS connections_insert_conflict
    BEFORE INSERT ON connections
    WHEN EXISTS (SELECT 1 FROM connections existing WHERE existing.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'connection replacement is forbidden'); END;

  CREATE TRIGGER IF NOT EXISTS connection_slots_insert_conflict
    BEFORE INSERT ON connection_slots
    WHEN EXISTS (
      SELECT 1 FROM connection_slots existing
      WHERE existing.connection_id = NEW.connection_id
        AND existing.environment = NEW.environment
    )
    BEGIN SELECT RAISE(ABORT, 'connection slot replacement is forbidden'); END;
`;

const LOGICAL_CONNECTION_CRYPTO_OWNER_COLUMN_SQL =
  "ALTER TABLE connections ADD COLUMN crypto_owner_id TEXT NOT NULL DEFAULT ''";

const LOGICAL_CONNECTION_REVISION_TRIGGER_RESTORE_SQL = `
  CREATE TRIGGER connections_revision_update
    BEFORE UPDATE ON connections
    WHEN NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
    BEGIN SELECT RAISE(ABORT, 'invalid connection lifecycle revision'); END;
`;

const LOGICAL_CONNECTION_CRYPTO_OWNER_GUARDS_SQL = `
  CREATE TRIGGER IF NOT EXISTS connections_crypto_owner_insert
    BEFORE INSERT ON connections
    WHEN COALESCE(
      length(NEW.crypto_owner_id) BETWEEN 1 AND 512
      AND NEW.crypto_owner_id = NEW.owner_id,
      0
    ) = 0
    BEGIN SELECT RAISE(ABORT, 'invalid connection cryptographic owner'); END;

  CREATE TRIGGER IF NOT EXISTS connections_crypto_owner_update
    BEFORE UPDATE OF crypto_owner_id ON connections
    WHEN NEW.crypto_owner_id IS NOT OLD.crypto_owner_id
    BEGIN SELECT RAISE(ABORT, 'connection cryptographic owner is immutable'); END;
`;

const LOGICAL_CONNECTION_CRYPTO_OWNER_SIGNATURE = `
  ${LOGICAL_CONNECTION_CRYPTO_OWNER_COLUMN_SQL};
  DROP TRIGGER connections_revision_update;
  UPDATE connections SET crypto_owner_id = owner_id WHERE crypto_owner_id = '';
  ${LOGICAL_CONNECTION_REVISION_TRIGGER_RESTORE_SQL}
  ${LOGICAL_CONNECTION_CRYPTO_OWNER_GUARDS_SQL}
`;

function sqliteUuidCheck(column: string): string {
  return `typeof(${column}) = 'text'
    AND length(${column}) = 36
    AND length(replace(${column}, '-', '')) = 32
    AND replace(${column}, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(${column}, 9, 1) = '-'
    AND substr(${column}, 14, 1) = '-'
    AND substr(${column}, 15, 1) IN ('1','2','3','4','5')
    AND substr(${column}, 19, 1) = '-'
    AND substr(${column}, 20, 1) IN ('8','9','a','b')
    AND substr(${column}, 24, 1) = '-'`;
}

const CONTROL_AUDIT_EVENTS_SQL = `
  CREATE TABLE control_audit_events (
    id TEXT PRIMARY KEY
      CHECK(typeof(id) = 'text' AND length(id) = 36),
    schema_version INTEGER NOT NULL
      CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
    owner_id TEXT NOT NULL
      CHECK(typeof(owner_id) = 'text' AND length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 512),
    actor_id TEXT NOT NULL
      CHECK(typeof(actor_id) = 'text' AND length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 512),
    correlation_id TEXT NOT NULL
      CHECK(typeof(correlation_id) = 'text' AND length(correlation_id) = 36),
    action TEXT NOT NULL
      CHECK(action IN ('connector.import','connector.operation.create','connector.simulation')),
    resource_kind TEXT NOT NULL
      CHECK(resource_kind IN ('connector_definition','operation_version','simulation')),
    resource_id TEXT NOT NULL
      CHECK(${sqliteUuidCheck("resource_id")}),
    resource_version_id TEXT
      CHECK(resource_version_id IS NULL OR (${sqliteUuidCheck("resource_version_id")})),
    projection_hash TEXT
      CHECK(projection_hash IS NULL OR length(projection_hash) = 64
        AND projection_hash NOT GLOB '*[^0-9a-f]*'),
    schema_hash TEXT
      CHECK(schema_hash IS NULL OR length(schema_hash) = 64
        AND schema_hash NOT GLOB '*[^0-9a-f]*'),
    outcome TEXT NOT NULL CHECK(outcome IN ('completed','refused')),
    error_code TEXT CHECK(error_code IS NULL OR error_code IN (
      'PARSE_REFUSED','PROJECTION_REFUSED','RATE_REFUSED','TIMEOUT_REFUSED',
      'PERSISTENCE_REFUSED','POLICY_REFUSED','CONNECTION_REFUSED',
      'DRIFT_REFUSED','SIMULATION_REFUSED','AUDIT_UNAVAILABLE'
    )),
    effect TEXT NOT NULL CHECK(effect = 'write'),
    connection_kind TEXT
      CHECK(connection_kind IS NULL OR connection_kind IN ('api_key','bearer','basic','custom_headers')),
    connection_suffix TEXT
      CHECK(connection_suffix IS NULL OR length(connection_suffix) BETWEEN 4 AND 12
        AND connection_suffix NOT GLOB '*[^0-9A-Za-z_-]*'),
    test_slot_status TEXT
      CHECK(test_slot_status IS NULL OR test_slot_status IN ('configured','missing','revoked')),
    duration_ms INTEGER NOT NULL
      CHECK(typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 86400000),
    egress_count INTEGER NOT NULL
      CHECK(typeof(egress_count) = 'integer' AND egress_count = 0),
    cost_micro_usdc INTEGER NOT NULL
      CHECK(typeof(cost_micro_usdc) = 'integer' AND cost_micro_usdc = 0),
    created_at INTEGER NOT NULL
      CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    CHECK(
      (outcome = 'completed' AND error_code IS NULL)
      OR (outcome = 'refused' AND error_code IS NOT NULL)
    ),
    CHECK(
      (action = 'connector.import' AND resource_kind = 'connector_definition')
      OR (action = 'connector.operation.create' AND resource_kind = 'operation_version')
      OR (action = 'connector.simulation' AND resource_kind = 'simulation')
    ),
    CHECK(
      (connection_kind IS NULL AND connection_suffix IS NULL AND test_slot_status IS NULL)
      OR (connection_kind IS NOT NULL AND connection_suffix IS NOT NULL AND test_slot_status IS NOT NULL)
    ),
    CHECK(
      action = 'connector.simulation'
      OR (connection_kind IS NULL AND connection_suffix IS NULL AND test_slot_status IS NULL)
    ),
    CHECK(
      outcome = 'refused'
      OR (action = 'connector.import'
        AND resource_version_id IS NOT NULL AND projection_hash IS NOT NULL AND schema_hash IS NULL)
      OR (action IN ('connector.operation.create','connector.simulation')
        AND resource_version_id IS NOT NULL AND projection_hash IS NOT NULL AND schema_hash IS NOT NULL)
    )
  );
  CREATE INDEX idx_control_audit_events_owner_created
    ON control_audit_events(owner_id, created_at DESC, id DESC);
  CREATE INDEX idx_control_audit_events_owner_correlation
    ON control_audit_events(owner_id, correlation_id, id);
  CREATE INDEX idx_control_audit_events_owner_resource
    ON control_audit_events(owner_id, resource_kind, resource_id, created_at DESC, id DESC);
  CREATE UNIQUE INDEX uq_control_audit_events_owner_correlation_action
    ON control_audit_events(owner_id, correlation_id, action);
  CREATE TRIGGER control_audit_events_no_update BEFORE UPDATE ON control_audit_events
    BEGIN SELECT RAISE(ABORT, 'control audit events are append-only'); END;
  CREATE TRIGGER control_audit_events_no_delete BEFORE DELETE ON control_audit_events
    BEGIN SELECT RAISE(ABORT, 'control audit events are append-only'); END;
`;

const CONTROL_AUDIT_EVENT_OBJECTS = [
  { type: "table", name: "control_audit_events" },
  { type: "index", name: "idx_control_audit_events_owner_created" },
  { type: "index", name: "idx_control_audit_events_owner_correlation" },
  { type: "index", name: "idx_control_audit_events_owner_resource" },
  { type: "index", name: "uq_control_audit_events_owner_correlation_action" },
  { type: "trigger", name: "control_audit_events_no_update" },
  { type: "trigger", name: "control_audit_events_no_delete" },
] as const;

const IMMUTABLE_CONNECTOR_ASSETS_SQL = `
  CREATE TABLE connector_identities (
    id TEXT PRIMARY KEY CHECK(${sqliteUuidCheck("id")}),
    owner_id TEXT NOT NULL
      CHECK(typeof(owner_id) = 'text' AND length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 512),
    display_label TEXT NOT NULL
      CHECK(typeof(display_label) = 'text' AND display_label = trim(display_label)
        AND length(CAST(display_label AS BLOB)) BETWEEN 1 AND 120),
    archived_at INTEGER
      CHECK(archived_at IS NULL OR typeof(archived_at) = 'integer' AND archived_at BETWEEN 0 AND 9007199254740991),
    lifecycle_revision INTEGER NOT NULL
      CHECK(typeof(lifecycle_revision) = 'integer' AND lifecycle_revision BETWEEN 1 AND 9007199254740991),
    created_at INTEGER NOT NULL
      CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL
      CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991)
  );
  CREATE UNIQUE INDEX uq_connector_identities_owner_id ON connector_identities(owner_id, id);
  CREATE INDEX idx_connector_identities_owner_updated
    ON connector_identities(owner_id, updated_at DESC, id DESC);

  CREATE TABLE connector_definition_versions (
    id TEXT PRIMARY KEY CHECK(${sqliteUuidCheck("id")}),
    owner_id TEXT NOT NULL
      CHECK(typeof(owner_id) = 'text' AND length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 512),
    connector_id TEXT NOT NULL CHECK(${sqliteUuidCheck("connector_id")}),
    version_number INTEGER NOT NULL
      CHECK(typeof(version_number) = 'integer' AND version_number BETWEEN 1 AND 9007199254740991),
    projection_json TEXT NOT NULL
      CHECK(typeof(projection_json) = 'text' AND json_valid(projection_json)
        AND json_type(projection_json) = 'object'
        AND length(CAST(projection_json AS BLOB)) BETWEEN 2 AND 262144),
    connector_projection_hash TEXT NOT NULL
      CHECK(length(connector_projection_hash) = 64 AND connector_projection_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL
      CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY(owner_id, connector_id) REFERENCES connector_identities(owner_id, id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX uq_connector_definition_owner_version
    ON connector_definition_versions(owner_id, connector_id, version_number);
  CREATE UNIQUE INDEX uq_connector_definition_owner_hash
    ON connector_definition_versions(owner_id, connector_id, connector_projection_hash);
  CREATE UNIQUE INDEX uq_connector_definition_owner_id
    ON connector_definition_versions(owner_id, id);
  CREATE INDEX idx_connector_definition_owner_created
    ON connector_definition_versions(owner_id, connector_id, created_at DESC, id DESC);

  CREATE TABLE connector_operation_versions (
    id TEXT PRIMARY KEY CHECK(${sqliteUuidCheck("id")}),
    owner_id TEXT NOT NULL
      CHECK(typeof(owner_id) = 'text' AND length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 512),
    connector_definition_version_id TEXT NOT NULL
      CHECK(${sqliteUuidCheck("connector_definition_version_id")}),
    operation_id TEXT NOT NULL
      CHECK(typeof(operation_id) = 'text' AND length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 512),
    projection_json TEXT NOT NULL
      CHECK(typeof(projection_json) = 'text' AND json_valid(projection_json)
        AND json_type(projection_json) = 'object'
        AND length(CAST(projection_json AS BLOB)) BETWEEN 2 AND 262144),
    operation_projection_hash TEXT NOT NULL
      CHECK(length(operation_projection_hash) = 64 AND operation_projection_hash NOT GLOB '*[^0-9a-f]*'),
    schema_hash TEXT NOT NULL
      CHECK(length(schema_hash) = 64 AND schema_hash NOT GLOB '*[^0-9a-f]*'),
    author_annotation_json TEXT
      CHECK(author_annotation_json IS NULL OR typeof(author_annotation_json) = 'text'
        AND json_valid(author_annotation_json) AND json_type(author_annotation_json) = 'object'
        AND length(CAST(author_annotation_json AS BLOB)) BETWEEN 2 AND 2048),
    created_at INTEGER NOT NULL
      CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY(owner_id, connector_definition_version_id)
      REFERENCES connector_definition_versions(owner_id, id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX uq_connector_operation_owner_definition_operation
    ON connector_operation_versions(owner_id, connector_definition_version_id, operation_id);
  CREATE INDEX idx_connector_operation_owner_created
    ON connector_operation_versions(owner_id, connector_definition_version_id, created_at DESC, id DESC);

  CREATE TABLE connector_import_rate_reservations (
    id TEXT PRIMARY KEY CHECK(${sqliteUuidCheck("id")}),
    owner_id TEXT NOT NULL
      CHECK(typeof(owner_id) = 'text' AND length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 512),
    correlation_id TEXT NOT NULL CHECK(${sqliteUuidCheck("correlation_id")}),
    reserved_at INTEGER NOT NULL
      CHECK(typeof(reserved_at) = 'integer' AND reserved_at BETWEEN 0 AND 9007199254740991),
    UNIQUE(owner_id, correlation_id)
  );
  CREATE INDEX idx_connector_import_rate_owner_time
    ON connector_import_rate_reservations(owner_id, reserved_at DESC, id DESC);

  CREATE TRIGGER connector_identities_identity_no_update BEFORE UPDATE ON connector_identities
    WHEN NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.created_at <> OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'connector identity fields are immutable'); END;
  CREATE TRIGGER connector_identities_revision_update
    BEFORE UPDATE OF display_label, archived_at, lifecycle_revision, updated_at ON connector_identities
    WHEN NEW.lifecycle_revision <> OLD.lifecycle_revision + 1
      OR NEW.updated_at < OLD.updated_at
      OR (NEW.display_label = OLD.display_label AND NEW.archived_at IS OLD.archived_at)
    BEGIN SELECT RAISE(ABORT, 'invalid connector lifecycle revision'); END;
  CREATE TRIGGER connector_identities_insert_conflict BEFORE INSERT ON connector_identities
    WHEN EXISTS (SELECT 1 FROM connector_identities existing WHERE existing.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'connector replacement is forbidden'); END;
  CREATE TRIGGER connector_definition_versions_no_update BEFORE UPDATE ON connector_definition_versions
    BEGIN SELECT RAISE(ABORT, 'connector definition versions are append-only'); END;
  CREATE TRIGGER connector_definition_versions_no_delete BEFORE DELETE ON connector_definition_versions
    BEGIN SELECT RAISE(ABORT, 'connector definition versions are append-only'); END;
  CREATE TRIGGER connector_definition_versions_insert_conflict BEFORE INSERT ON connector_definition_versions
    WHEN EXISTS (SELECT 1 FROM connector_definition_versions existing
      WHERE existing.id = NEW.id
        OR existing.owner_id = NEW.owner_id AND existing.connector_id = NEW.connector_id
          AND existing.version_number = NEW.version_number
        OR existing.owner_id = NEW.owner_id AND existing.connector_id = NEW.connector_id
          AND existing.connector_projection_hash = NEW.connector_projection_hash)
    BEGIN SELECT RAISE(ABORT, 'connector definition replacement is forbidden'); END;
  CREATE TRIGGER connector_operation_versions_no_update BEFORE UPDATE ON connector_operation_versions
    BEGIN SELECT RAISE(ABORT, 'connector operation versions are append-only'); END;
  CREATE TRIGGER connector_operation_versions_no_delete BEFORE DELETE ON connector_operation_versions
    BEGIN SELECT RAISE(ABORT, 'connector operation versions are append-only'); END;
  CREATE TRIGGER connector_operation_versions_insert_conflict BEFORE INSERT ON connector_operation_versions
    WHEN EXISTS (SELECT 1 FROM connector_operation_versions existing
      WHERE existing.id = NEW.id
        OR existing.owner_id = NEW.owner_id
          AND existing.connector_definition_version_id = NEW.connector_definition_version_id
          AND existing.operation_id = NEW.operation_id)
    BEGIN SELECT RAISE(ABORT, 'connector operation replacement is forbidden'); END;
  CREATE TRIGGER connector_import_rate_no_update BEFORE UPDATE ON connector_import_rate_reservations
    BEGIN SELECT RAISE(ABORT, 'connector import rate reservations are append-only'); END;
  CREATE TRIGGER connector_import_rate_no_delete BEFORE DELETE ON connector_import_rate_reservations
    BEGIN SELECT RAISE(ABORT, 'connector import rate reservations are append-only'); END;
  CREATE TRIGGER connector_import_rate_insert_conflict BEFORE INSERT ON connector_import_rate_reservations
    WHEN EXISTS (SELECT 1 FROM connector_import_rate_reservations existing
      WHERE existing.id = NEW.id
        OR existing.owner_id = NEW.owner_id AND existing.correlation_id = NEW.correlation_id)
    BEGIN SELECT RAISE(ABORT, 'connector import rate replacement is forbidden'); END;
`;

const CONNECTOR_PORTABILITY_LOOKUP_SQL = `
  CREATE INDEX idx_connector_definition_owner_projection_hash
    ON connector_definition_versions(owner_id, connector_projection_hash, connector_id, id);
`;

const CONNECTOR_OPERATION_LIST_LOOKUP_SQL = `
  CREATE TABLE connector_operation_list_entries (
    owner_id TEXT NOT NULL
      CHECK(typeof(owner_id) = 'text' AND length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 512),
    connector_id TEXT NOT NULL CHECK(${sqliteUuidCheck("connector_id")}),
    operation_version_id TEXT NOT NULL CHECK(${sqliteUuidCheck("operation_version_id")}),
    created_at INTEGER NOT NULL
      CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(owner_id, connector_id, created_at DESC, operation_version_id DESC),
    FOREIGN KEY(owner_id, connector_id) REFERENCES connector_identities(owner_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(operation_version_id) REFERENCES connector_operation_versions(id) ON DELETE RESTRICT
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX uq_connector_operation_list_version
    ON connector_operation_list_entries(operation_version_id);

  INSERT INTO connector_operation_list_entries
    (owner_id, connector_id, operation_version_id, created_at)
  SELECT operation.owner_id, definition.connector_id, operation.id, operation.created_at
  FROM connector_operation_versions operation
  JOIN connector_definition_versions definition
    ON definition.owner_id = operation.owner_id
   AND definition.id = operation.connector_definition_version_id;

  CREATE TRIGGER connector_operation_list_insert
    AFTER INSERT ON connector_operation_versions
    BEGIN
      INSERT INTO connector_operation_list_entries
        (owner_id, connector_id, operation_version_id, created_at)
      SELECT NEW.owner_id, definition.connector_id, NEW.id, NEW.created_at
      FROM connector_definition_versions definition
      WHERE definition.owner_id = NEW.owner_id
        AND definition.id = NEW.connector_definition_version_id;
    END;
  CREATE TRIGGER connector_operation_list_no_update
    BEFORE UPDATE ON connector_operation_list_entries
    BEGIN SELECT RAISE(ABORT, 'connector operation list entries are immutable'); END;
  CREATE TRIGGER connector_operation_list_no_delete
    BEFORE DELETE ON connector_operation_list_entries
    BEGIN SELECT RAISE(ABORT, 'connector operation list entries are immutable'); END;
`;

const IMMUTABLE_CONNECTOR_ASSET_OBJECTS = [
  ...["connector_identities", "connector_definition_versions", "connector_operation_versions", "connector_import_rate_reservations"]
    .map((name) => ({ type: "table", name })),
  ...["uq_connector_identities_owner_id", "idx_connector_identities_owner_updated", "uq_connector_definition_owner_version",
    "uq_connector_definition_owner_hash", "uq_connector_definition_owner_id", "idx_connector_definition_owner_created",
    "uq_connector_operation_owner_definition_operation", "idx_connector_operation_owner_created",
    "idx_connector_import_rate_owner_time"].map((name) => ({ type: "index", name })),
  ...["connector_identities_identity_no_update", "connector_identities_revision_update", "connector_identities_insert_conflict",
    "connector_definition_versions_no_update", "connector_definition_versions_no_delete", "connector_definition_versions_insert_conflict",
    "connector_operation_versions_no_update", "connector_operation_versions_no_delete", "connector_operation_versions_insert_conflict",
    "connector_import_rate_no_update", "connector_import_rate_no_delete", "connector_import_rate_insert_conflict"]
    .map((name) => ({ type: "trigger", name })),
] as const;

const LOGICAL_CONNECTION_BASE_OBJECTS = [
  { type: "table", name: "connections" },
  { type: "table", name: "connection_slots" },
  { type: "index", name: "idx_connections_owner_updated" },
  { type: "index", name: "idx_connections_owner_name" },
  { type: "index", name: "idx_connection_slots_status_environment" },
] as const;

const LOGICAL_CONNECTION_HARDENING_OBJECTS = [
  ...LOGICAL_CONNECTION_BASE_OBJECTS,
  { type: "trigger", name: "connections_public_config_insert" },
  { type: "trigger", name: "connections_public_config_update" },
  { type: "trigger", name: "connections_revision_update" },
  { type: "trigger", name: "connections_identity_update" },
  { type: "trigger", name: "connection_slots_transition_update" },
  { type: "trigger", name: "connection_slots_key_version_insert" },
  { type: "trigger", name: "connection_slots_key_version_update" },
  { type: "trigger", name: "connection_slots_delete" },
  { type: "trigger", name: "connections_delete" },
] as const;

const LOGICAL_CONNECTION_REPLACEMENT_GUARD_OBJECTS = [
  ...LOGICAL_CONNECTION_HARDENING_OBJECTS,
  { type: "trigger", name: "connections_insert_conflict" },
  { type: "trigger", name: "connection_slots_insert_conflict" },
] as const;

const LOGICAL_CONNECTION_CRYPTO_OWNER_OBJECTS = [
  ...LOGICAL_CONNECTION_REPLACEMENT_GUARD_OBJECTS,
  { type: "trigger", name: "connections_crypto_owner_insert" },
  { type: "trigger", name: "connections_crypto_owner_update" },
] as const;

function assertLogicalConnectionIntegrity(
  db: Database.Database,
  version: 14 | 15 | 16 | 28,
  cryptoOwnerColumn = version === 28,
): void {
  const expected = new Database(":memory:");
  try {
    expected.exec(LOGICAL_CONNECTIONS_SQL);
    if (version >= 15) expected.exec(LOGICAL_CONNECTION_HARDENING_SQL);
    if (version >= 16) expected.exec(LOGICAL_CONNECTION_REPLACEMENT_GUARDS_SQL);
    if (cryptoOwnerColumn) expected.exec(LOGICAL_CONNECTION_CRYPTO_OWNER_COLUMN_SQL);
    if (version === 28) expected.exec(LOGICAL_CONNECTION_CRYPTO_OWNER_GUARDS_SQL);
    const objects = version === 28
      ? LOGICAL_CONNECTION_CRYPTO_OWNER_OBJECTS
      : version === 16
        ? LOGICAL_CONNECTION_REPLACEMENT_GUARD_OBJECTS
        : version === 15
          ? LOGICAL_CONNECTION_HARDENING_OBJECTS
          : LOGICAL_CONNECTION_BASE_OBJECTS;
    for (const object of objects) {
      const expectedRow = expected
        .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row?.sql || !expectedRow?.sql || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite logical connection ${object.type} ${object.name} definition mismatch`);
      }
    }
    if (cryptoOwnerColumn) {
      const column = (db.prepare("PRAGMA table_info(connections)").all() as SqliteColumnInfo[])
        .find((candidate) => candidate.name === "crypto_owner_id");
      if (
        !column ||
        column.type.trim().toUpperCase() !== "TEXT" ||
        column.notnull !== 1 ||
        column.dflt_value !== "''" ||
        column.pk !== 0
      ) {
        throw new Error("SQLite logical connection crypto_owner_id definition mismatch");
      }
    }
    if (version === 28) {
      const invalid = db.prepare(`SELECT id FROM connections
        WHERE typeof(crypto_owner_id) <> 'text'
          OR length(crypto_owner_id) NOT BETWEEN 1 AND 512
        LIMIT 1`).get();
      if (invalid) throw new Error("SQLite logical connection cryptographic owner data mismatch");
    }
  } finally {
    expected.close();
  }
}

function assertControlAuditIntegrity(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec(CONTROL_AUDIT_EVENTS_SQL);
    for (const object of CONTROL_AUDIT_EVENT_OBJECTS) {
      const expectedRow = expected
        .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row?.sql || !expectedRow?.sql || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite control audit ${object.type} ${object.name} definition mismatch`);
      }
    }
  } finally {
    expected.close();
  }
}

function assertImmutableConnectorAssetIntegrity(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec(IMMUTABLE_CONNECTOR_ASSETS_SQL);
    for (const object of IMMUTABLE_CONNECTOR_ASSET_OBJECTS) {
      const expectedRow = expected
        .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row?.sql || !expectedRow?.sql || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite connector asset ${object.type} ${object.name} definition mismatch`);
      }
    }
  } finally {
    expected.close();
  }
}

function assertConnectorPortabilityLookupIntegrity(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec(IMMUTABLE_CONNECTOR_ASSETS_SQL);
    expected.exec(CONNECTOR_PORTABILITY_LOOKUP_SQL);
    const name = "idx_connector_definition_owner_projection_hash";
    const expectedRow = expected.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(name) as { sql: string | null } | undefined;
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(name) as { sql: string | null } | undefined;
    if (!row?.sql || !expectedRow?.sql || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
      throw new Error(`SQLite connector portability index ${name} definition mismatch`);
    }
  } finally {
    expected.close();
  }
}

const CONNECTOR_OPERATION_LIST_OBJECTS = [
  { type: "table", name: "connector_operation_list_entries" },
  { type: "index", name: "uq_connector_operation_list_version" },
  { type: "trigger", name: "connector_operation_list_insert" },
  { type: "trigger", name: "connector_operation_list_no_update" },
  { type: "trigger", name: "connector_operation_list_no_delete" },
] as const;

function assertConnectorOperationListIntegrity(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec(IMMUTABLE_CONNECTOR_ASSETS_SQL);
    expected.exec(CONNECTOR_OPERATION_LIST_LOOKUP_SQL);
    for (const object of CONNECTOR_OPERATION_LIST_OBJECTS) {
      const expectedRow = expected.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
        .get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row?.sql || !expectedRow?.sql || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite connector operation list ${object.type} ${object.name} definition mismatch`);
      }
    }
    const missing = db.prepare(`SELECT operation.id
      FROM connector_operation_versions operation
      JOIN connector_definition_versions definition
        ON definition.owner_id = operation.owner_id
       AND definition.id = operation.connector_definition_version_id
      LEFT JOIN connector_operation_list_entries listing
        ON listing.owner_id = operation.owner_id
       AND listing.connector_id = definition.connector_id
       AND listing.operation_version_id = operation.id
       AND listing.created_at = operation.created_at
      WHERE listing.operation_version_id IS NULL LIMIT 1`).get();
    if (missing) throw new Error("SQLite connector operation list backfill mismatch");
  } finally {
    expected.close();
  }
}

const DURABLE_PARENT_OWNER_OBJECTS = [
  { type: "trigger", name: "durable_executions_parent_owner_insert" },
  { type: "trigger", name: "durable_executions_parent_owner_update" },
] as const;

function assertDurableRuntimeIntegrity(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec("CREATE TABLE flows (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL); CREATE TABLE flow_versions (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL);");
    expected.exec(DURABLE_RUNTIME_SQL);
    for (const object of DURABLE_RUNTIME_OBJECTS) {
      const expectedRow = expected.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row || row.sql === null || !expectedRow || expectedRow.sql === null || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite durable runtime ${object.type} ${object.name} definition mismatch`);
      }
    }
  } finally {
    expected.close();
  }
}

function assertDurableInvocationIntegrity(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec("CREATE TABLE durable_executions (id TEXT PRIMARY KEY);");
    expected.exec(DURABLE_INVOCATIONS_SQL);
    for (const object of DURABLE_INVOCATION_OBJECTS) {
      const expectedRow = expected.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row || row.sql === null || !expectedRow || expectedRow.sql === null || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite durable invocation ${object.type} ${object.name} definition mismatch`);
      }
    }
  } finally {
    expected.close();
  }
}

function assertDurableEventUsageIntegrity(db: Database.Database): void {
  const expected = new Database(":memory:");
  try {
    expected.exec("CREATE TABLE durable_executions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL); CREATE TABLE execution_events (execution_id TEXT, seq INTEGER, type TEXT, at INTEGER, payload_json TEXT);");
    expected.exec(DURABLE_EVENT_USAGE_SQL);
    for (const object of DURABLE_EVENT_USAGE_OBJECTS) {
      const expectedRow = expected.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row || row.sql === null || !expectedRow || expectedRow.sql === null || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite durable event usage ${object.type} ${object.name} definition mismatch`);
      }
    }
  } finally { expected.close(); }
}

function assertDurableParentOwnerIntegrity(db: Database.Database): void {
  const invalid = db.prepare(
    `SELECT child.id FROM durable_executions child LEFT JOIN durable_executions parent ON parent.id = child.parent_execution_id
     WHERE child.parent_execution_id IS NOT NULL AND (parent.id IS NULL OR parent.owner_id <> child.owner_id) LIMIT 1`,
  ).get();
  if (invalid) throw new Error("SQLite durable parent owner integrity mismatch");
  const expected = new Database(":memory:");
  try {
    expected.exec("CREATE TABLE durable_executions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_execution_id TEXT);");
    expected.exec(DURABLE_PARENT_OWNER_SQL);
    for (const object of DURABLE_PARENT_OWNER_OBJECTS) {
      const expectedRow = expected.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql: string | null } | undefined;
      if (!row?.sql || !expectedRow?.sql || normalizeSql(row.sql) !== normalizeSql(expectedRow.sql)) throw new Error(`SQLite durable parent owner ${object.type} ${object.name} definition mismatch`);
    }
  } finally { expected.close(); }
}

const SUBFLOW_API_READ_INDEX_DEFINITIONS = [
  {
    name: "idx_flows_owner_name_id",
    sql: "CREATE INDEX idx_flows_owner_name_id ON flows(owner_id, name, id)",
  },
  {
    name: "idx_flow_versions_flow_number_id",
    sql: `CREATE INDEX idx_flow_versions_flow_number_id
      ON flow_versions(flow_id, version_number DESC, id DESC)`,
  },
] as const;

const WORKBOOK_FLOW_TAB_INDEX_DEFINITIONS = [
  {
    name: "idx_workbook_flow_tabs_workbook_order",
    sql: `CREATE INDEX idx_workbook_flow_tabs_workbook_order
      ON workbook_flow_tabs(workbook_id, position, id)`,
  },
  {
    name: "idx_workbook_flow_tabs_flow_id",
    sql: `CREATE INDEX idx_workbook_flow_tabs_flow_id
      ON workbook_flow_tabs(flow_id)`,
  },
] as const;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}

function assertDeploymentIntegrityIndexes(db: Database.Database): void {
  for (const definition of DEPLOYMENT_INTEGRITY_INDEX_DEFINITIONS) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(definition.name) as { sql: string | null } | undefined;
    if (!row || row.sql === null) {
      throw new Error(`SQLite deployment integrity index ${definition.name} is missing`);
    }
    if (normalizeSql(row.sql) !== normalizeSql(definition.sql)) {
      throw new Error(`SQLite deployment integrity index ${definition.name} definition mismatch`);
    }
  }
}

function assertSubflowApiReadIndex(db: Database.Database): void {
  for (const definition of SUBFLOW_API_READ_INDEX_DEFINITIONS) {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(definition.name) as { sql: string | null } | undefined;
    if (!row || row.sql === null || normalizeSql(row.sql) !== normalizeSql(definition.sql)) {
      throw new Error(`SQLite subflow API read index ${definition.name} definition mismatch`);
    }
  }
}

function assertSubflowImpactReceiptIntegrity(db: Database.Database): void {
  for (const definition of SUBFLOW_IMPACT_RECEIPT_DEFINITIONS) {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
    ).get(definition.type, definition.name) as { sql: string | null } | undefined;
    if (!row || row.sql === null) {
      throw new Error(`SQLite subflow impact receipt ${definition.type} ${definition.name} is missing`);
    }
    if (normalizeSql(row.sql) !== normalizeSql(definition.sql)) {
      throw new Error(`SQLite subflow impact receipt ${definition.type} ${definition.name} definition mismatch`);
    }
  }
  const ownerMismatch = db.prepare(
    `SELECT r.id FROM subflow_impact_receipts r
     LEFT JOIN flows f ON f.id = r.child_flow_id AND f.owner_id = r.owner_id
     WHERE f.id IS NULL LIMIT 1`,
  ).get() as { id: string } | undefined;
  if (ownerMismatch) {
    throw new Error(`SQLite subflow impact receipt owner-chain mismatch for ${ownerMismatch.id}`);
  }
}

interface WorkbookBindingIntegrityRow {
  flow_id: string;
  binding_project_id: string;
  workbook_id: string;
  created_at: number;
  flow_name: string | null;
  flow_owner_id: string | null;
  workbook_project_id: string | null;
  project_id: string | null;
  workspace_id: string | null;
  organization_id: string | null;
  organization_owner_id: string | null;
}

function workbookBindingRows(db: Database.Database): WorkbookBindingIntegrityRow[] {
  return db
    .prepare(
      `SELECT b.flow_id,
              b.project_id AS binding_project_id,
              b.workbook_id,
              b.created_at,
              f.name AS flow_name,
              f.owner_id AS flow_owner_id,
              w.project_id AS workbook_project_id,
              p.id AS project_id,
              ws.id AS workspace_id,
              o.id AS organization_id,
              o.personal_owner_id AS organization_owner_id
       FROM flow_project_bindings b
       LEFT JOIN flows f ON f.id = b.flow_id
       LEFT JOIN workbooks w ON w.id = b.workbook_id
       LEFT JOIN projects p ON p.id = b.project_id
       LEFT JOIN workspaces ws ON ws.id = p.workspace_id
       LEFT JOIN organizations o ON o.id = ws.organization_id
       ORDER BY b.workbook_id ASC, b.created_at ASC, b.flow_id ASC`,
    )
    .all() as WorkbookBindingIntegrityRow[];
}

function assertWorkbookBindingOwnerIntegrity(
  rows: readonly WorkbookBindingIntegrityRow[],
): void {
  for (const row of rows) {
    const valid =
      row.flow_name !== null &&
      row.flow_owner_id !== null &&
      row.workbook_project_id !== null &&
      row.project_id !== null &&
      row.workspace_id !== null &&
      row.organization_id !== null &&
      row.organization_owner_id !== null &&
      row.binding_project_id === row.workbook_project_id &&
      row.binding_project_id === row.project_id &&
      row.flow_owner_id === row.organization_owner_id;
    if (!valid) {
      throw new Error(`Workbook tab owner-chain integrity failed for flow ${row.flow_id}`);
    }
  }
}

function backfillWorkbookFlowTabs(db: Database.Database): void {
  const rows = workbookBindingRows(db);
  assertWorkbookBindingOwnerIntegrity(rows);
  const positions = new Map<string, number>();
  const insert = db.prepare(
    `INSERT INTO workbook_flow_tabs
      (id, workbook_id, flow_id, title, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const position = positions.get(row.workbook_id) ?? 0;
    const title =
      position === 0 ? "Main" : row.flow_name!.trim() || `Flow ${position + 1}`;
    const id = `wft_${createHash("sha256")
      .update(`${row.workbook_id}\0${row.flow_id}`, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    insert.run(
      id,
      row.workbook_id,
      row.flow_id,
      title,
      position,
      row.created_at,
      row.created_at,
    );
    positions.set(row.workbook_id, position + 1);
  }
}

function assertWorkbookFlowTabIntegrity(db: Database.Database): void {
  for (const definition of WORKBOOK_FLOW_TAB_INDEX_DEFINITIONS) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(definition.name) as { sql: string | null } | undefined;
    if (!row || row.sql === null) {
      throw new Error(`SQLite workbook tab index ${definition.name} is missing`);
    }
    if (normalizeSql(row.sql) !== normalizeSql(definition.sql)) {
      throw new Error(`SQLite workbook tab index ${definition.name} definition mismatch`);
    }
  }

  assertForeignKeyIntegrity(db);
  assertWorkbookBindingOwnerIntegrity(workbookBindingRows(db));

  const duplicateChecks = [
    {
      label: "workbook membership",
      sql: `SELECT workbook_id, flow_id FROM workbook_flow_tabs
            GROUP BY workbook_id, flow_id HAVING COUNT(*) <> 1 LIMIT 1`,
    },
    {
      label: "flow membership",
      sql: `SELECT flow_id FROM workbook_flow_tabs
            GROUP BY flow_id HAVING COUNT(*) <> 1 LIMIT 1`,
    },
    {
      label: "position",
      sql: `SELECT workbook_id, position FROM workbook_flow_tabs
            GROUP BY workbook_id, position HAVING COUNT(*) <> 1 LIMIT 1`,
    },
  ] as const;
  for (const check of duplicateChecks) {
    if (db.prepare(check.sql).get()) {
      throw new Error(`SQLite workbook tab duplicate ${check.label}`);
    }
  }

  const ordered = db
    .prepare(
      `SELECT workbook_id, position FROM workbook_flow_tabs
       ORDER BY workbook_id ASC, position ASC, id ASC`,
    )
    .all() as Array<{ workbook_id: string; position: number }>;
  let workbookId: string | undefined;
  let expectedPosition = 0;
  for (const row of ordered) {
    if (row.workbook_id !== workbookId) {
      workbookId = row.workbook_id;
      expectedPosition = 0;
    }
    if (!Number.isInteger(row.position) || row.position !== expectedPosition) {
      throw new Error(`SQLite workbook tab positions are not contiguous for ${row.workbook_id}`);
    }
    expectedPosition += 1;
  }

  const bindingWithoutTab = db
    .prepare(
      `SELECT b.flow_id
       FROM flow_project_bindings b
       LEFT JOIN workbook_flow_tabs t
         ON t.flow_id = b.flow_id AND t.workbook_id = b.workbook_id
       WHERE t.id IS NULL
       LIMIT 1`,
    )
    .get() as { flow_id: string } | undefined;
  if (bindingWithoutTab) {
    throw new Error(`SQLite workbook binding missing tab for flow ${bindingWithoutTab.flow_id}`);
  }

  const tabWithoutBinding = db
    .prepare(
      `SELECT t.id
       FROM workbook_flow_tabs t
       LEFT JOIN flow_project_bindings b
         ON b.flow_id = t.flow_id AND b.workbook_id = t.workbook_id
       WHERE b.flow_id IS NULL
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (tabWithoutBinding) {
    throw new Error(`SQLite workbook tab missing binding for tab ${tabWithoutBinding.id}`);
  }
}

const SETTLEMENT_COLUMNS = [
  {
    table: "agents",
    column: "settlement_live",
    sql: "ALTER TABLE agents ADD COLUMN settlement_live INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "runs",
    column: "settled_at",
    sql: "ALTER TABLE runs ADD COLUMN settled_at TEXT",
  },
] as const;

const RUN_TRIGGER_INPUT_COLUMNS = [
  {
    table: "runs",
    column: "trigger_input",
    sql: "ALTER TABLE runs ADD COLUMN trigger_input TEXT",
  },
  {
    table: "runs",
    column: "run_variables",
    sql: "ALTER TABLE runs ADD COLUMN run_variables TEXT",
  },
] as const;

const SETTLEMENTS_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS settlements (
    run_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    gross_usdc REAL NOT NULL,
    creator_usdc REAL NOT NULL,
    platform_usdc REAL NOT NULL,
    pay_to TEXT NOT NULL,
    payout_source TEXT NOT NULL,
    payer TEXT,
    tx TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_settlements_owner ON settlements (owner_id);
  CREATE INDEX IF NOT EXISTS idx_settlements_agent ON settlements (agent_id);
`;

// Immutable migration 40 input. Do not add later AP2 fields here: its exact
// bytes are already checksummed in deployed SQLite ledgers. Schema evolution
// belongs in a new migration.
const AP2_AUTHORIZATIONS_V40_SQL = `
  CREATE TABLE IF NOT EXISTS ap2_authorizations (
    id TEXT PRIMARY KEY,
    mandate_reference TEXT NOT NULL UNIQUE,
    payment_nonce_hash TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject_id TEXT,
    checkout_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    network TEXT NOT NULL,
    asset TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    amount_minor_usd INTEGER NOT NULL CHECK (amount_minor_usd >= 0),
    payee_id TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'authorized', 'settling', 'settled', 'executing', 'completed',
      'rejected', 'failed', 'pending_reconciliation'
    )),
    decision_code TEXT,
    receipt_json TEXT,
    result_json TEXT,
    expires_at TEXT NOT NULL,
    run_id TEXT,
    tx TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ap2_authorizations_state_updated
    ON ap2_authorizations (state, updated_at);
  CREATE INDEX IF NOT EXISTS idx_ap2_authorizations_agent_created
    ON ap2_authorizations (agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ap2_authorizations_run
    ON ap2_authorizations (run_id);
`;

const AP2_AUTHORIZATIONS_V42_SQL = `
  DROP TABLE ap2_authorizations;
  CREATE TABLE ap2_authorizations (
    id TEXT PRIMARY KEY,
    mandate_reference TEXT NOT NULL UNIQUE,
    payment_nonce_hash TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject_id TEXT,
    checkout_hash TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    network TEXT NOT NULL,
    asset TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    amount_minor_usd INTEGER NOT NULL CHECK (amount_minor_usd >= 0),
    payee_id TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    payer TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'authorized', 'settling', 'settled', 'executing', 'completed',
      'rejected', 'failed', 'pending_reconciliation'
    )),
    decision_code TEXT,
    receipt_json TEXT,
    result_json TEXT,
    expires_at TEXT NOT NULL,
    payment_valid_before TEXT NOT NULL,
    run_id TEXT,
    tx TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_ap2_authorizations_state_updated
    ON ap2_authorizations (state, updated_at);
  CREATE INDEX idx_ap2_authorizations_agent_created
    ON ap2_authorizations (agent_id, created_at);
  CREATE INDEX idx_ap2_authorizations_run
    ON ap2_authorizations (run_id);
`;

const RELAY_PROTOCOL_V2_SQL = `
  ALTER TABLE relay_endpoints ADD COLUMN protocol_version INTEGER NOT NULL
    DEFAULT 1 CHECK (protocol_version IN (1, 2));
`;

function applyRelayProtocolV2Migration(db: Database.Database): void {
  const column = (db.prepare("PRAGMA table_info(relay_endpoints)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>).find((candidate) => candidate.name === "protocol_version");
  if (!column) {
    db.exec(RELAY_PROTOCOL_V2_SQL);
    return;
  }
  if (
    column.type.toUpperCase() !== "INTEGER"
    || column.notnull !== 1
    || column.dflt_value !== "1"
  ) {
    throw new Error("SQLite relay_endpoints.protocol_version definition mismatch");
  }
}

function ap2UniqueIdentityExists(
  db: Database.Database,
  expectedColumn: string,
): boolean {
  const indexes = db.prepare("PRAGMA index_list(ap2_authorizations)").all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  return indexes.some((index) => {
    if (index.unique !== 1 || index.partial !== 0) return false;
    const columns = db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{
      seqno: number;
      name: string;
    }>;
    return columns.length === 1 && columns[0]?.name === expectedColumn;
  });
}

function assertAp2AuthorizationIndexes(db: Database.Database): void {
  assertIndexColumns(
    db,
    "ap2_authorizations",
    "idx_ap2_authorizations_state_updated",
    ["state", "updated_at"],
  );
  assertIndexColumns(
    db,
    "ap2_authorizations",
    "idx_ap2_authorizations_agent_created",
    ["agent_id", "created_at"],
  );
  assertIndexColumns(
    db,
    "ap2_authorizations",
    "idx_ap2_authorizations_run",
    ["run_id"],
  );
}

function assertAp2AuthorizationV40Integrity(db: Database.Database): void {
  assertAp2AuthorizationIndexes(db);
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ap2_authorizations'",
  ).get() as { sql: string | null } | undefined;
  const sql = table?.sql?.replace(/\s+/gu, " ").toLowerCase() ?? "";
  if (
    !ap2UniqueIdentityExists(db, "mandate_reference")
    || !ap2UniqueIdentityExists(db, "payment_nonce_hash")
    || ap2UniqueIdentityExists(db, "checkout_hash")
    || hasColumn(db, "ap2_authorizations", "payer")
    || hasColumn(db, "ap2_authorizations", "payment_valid_before")
    || !sql.includes("pending_reconciliation")
  ) {
    throw new Error("SQLite AP2 v40 authorization definition mismatch");
  }
}

function assertAp2AuthorizationV42Integrity(db: Database.Database): void {
  assertAp2AuthorizationIndexes(db);
  const columns = db.prepare("PRAGMA table_info(ap2_authorizations)").all() as SqliteColumnInfo[];
  const requiredText = (name: string): boolean => columns.some((column) =>
    column.name === name
    && column.type.trim().toUpperCase() === "TEXT"
    && column.notnull === 1
    && column.dflt_value === null);
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ap2_authorizations'",
  ).get() as { sql: string | null } | undefined;
  const sql = table?.sql?.replace(/\s+/gu, " ").toLowerCase() ?? "";
  if (
    !ap2UniqueIdentityExists(db, "mandate_reference")
    || !ap2UniqueIdentityExists(db, "payment_nonce_hash")
    || !ap2UniqueIdentityExists(db, "checkout_hash")
    || !requiredText("payer")
    || !requiredText("payment_valid_before")
    || !sql.includes("pending_reconciliation")
  ) {
    throw new Error("SQLite AP2 v42 replay-store attestation mismatch");
  }
}

function ap2AuthorizationV42IntegrityMatches(db: Database.Database): boolean {
  try {
    assertAp2AuthorizationV42Integrity(db);
    return true;
  } catch {
    return false;
  }
}

function assertAp2AuthorizationAtLeastV40Integrity(db: Database.Database): void {
  if (ap2AuthorizationV42IntegrityMatches(db)) return;
  assertAp2AuthorizationV40Integrity(db);
}

function applyAp2ReplayHardeningMigration(
  db: Database.Database,
): void | "ap2-v40-quarantined" {
  // Test fixtures and interrupted ledger restoration can replay an older
  // suffix against the already-hardened table. Accept only the exact v42
  // shape; every partial or weaker shape still fails closed below.
  if (ap2AuthorizationV42IntegrityMatches(db)) return;
  assertAp2AuthorizationV40Integrity(db);
  const row = db.prepare("SELECT COUNT(*) AS count FROM ap2_authorizations").get() as {
    count: number;
  };
  if (row.count !== 0) {
    // v40 did not persist the exact payer facts needed to create the v42
    // replay identities. Leave every byte and the migration prefix untouched.
    // Absence of the v42 ledger row keeps AP2 readiness false while the rest
    // of the application can dark-start for explicit operator remediation.
    return "ap2-v40-quarantined";
  }
  db.exec(AP2_AUTHORIZATIONS_V42_SQL);
  assertAp2AuthorizationV42Integrity(db);
}

const COMPANIES_SQL = `
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
    mission TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    fire_cost_threshold_usdc REAL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies (owner_id);
  CREATE TABLE IF NOT EXISTS company_departments (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL, monthly_budget_usdc REAL
  );
  CREATE INDEX IF NOT EXISTS idx_departments_company ON company_departments (company_id);
  CREATE TABLE IF NOT EXISTS company_employees (
    agent_id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
    department_id TEXT NOT NULL REFERENCES company_departments(id),
    job_description TEXT NOT NULL, publish_gated INTEGER NOT NULL DEFAULT 0,
    monthly_budget_usdc REAL
  );
  CREATE INDEX IF NOT EXISTS idx_employees_company ON company_employees (company_id);
  CREATE TABLE IF NOT EXISTS company_approvals (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
    kind TEXT NOT NULL, subject_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', reason TEXT,
    created_at TEXT NOT NULL, decided_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_company ON company_approvals (company_id, status);
`;

const COMPANY_EMPLOYEE_HISTORY_SQL = `
  ALTER TABLE company_employees ADD COLUMN removed_at TEXT;
  CREATE INDEX IF NOT EXISTS idx_employees_company_active
    ON company_employees (company_id, removed_at);
`;

const COMPANY_EMPLOYEE_PAYTO_SQL = `
  ALTER TABLE company_employees ADD COLUMN pay_to TEXT;
`;

// Org chart + heartbeat. Additive and nullable with no DEFAULT, exactly like
// pay_to and removed_at above: a stored default would make every legacy row
// claim a value nobody wrote, and assertNullableColumn refuses one.
// `role` stays NULL for rows hired before the column; src/lib/company/roles.ts
// resolves that NULL instead of the schema replacing it with 'worker'.
const COMPANY_ORG_ROLES_SQL = `
  ALTER TABLE company_employees ADD COLUMN role TEXT
    CHECK (role IS NULL OR role IN ('ceo', 'manager', 'worker'));
  ALTER TABLE company_employees ADD COLUMN reports_to TEXT;
  ALTER TABLE company_employees ADD COLUMN lifecycle_status TEXT
    CHECK (lifecycle_status IS NULL OR lifecycle_status IN (
      'idle', 'running', 'error', 'paused', 'budget_paused'
    ));
  ALTER TABLE company_employees ADD COLUMN heartbeat_enabled INTEGER
    CHECK (heartbeat_enabled IS NULL OR heartbeat_enabled IN (0, 1));
  ALTER TABLE company_employees ADD COLUMN heartbeat_interval_seconds INTEGER
    CHECK (heartbeat_interval_seconds IS NULL OR heartbeat_interval_seconds > 0);
  ALTER TABLE company_employees ADD COLUMN last_heartbeat_at TEXT;
  CREATE INDEX IF NOT EXISTS idx_employees_reports_to
    ON company_employees (reports_to);
`;

const COMPANY_ORG_ROLE_COLUMNS = [
  {
    column: "role",
    type: "TEXT",
    sql: `ALTER TABLE company_employees ADD COLUMN role TEXT
      CHECK (role IS NULL OR role IN ('ceo', 'manager', 'worker'))`,
  },
  {
    column: "reports_to",
    type: "TEXT",
    sql: "ALTER TABLE company_employees ADD COLUMN reports_to TEXT",
  },
  {
    column: "lifecycle_status",
    type: "TEXT",
    sql: `ALTER TABLE company_employees ADD COLUMN lifecycle_status TEXT
      CHECK (lifecycle_status IS NULL OR lifecycle_status IN (
        'idle', 'running', 'error', 'paused', 'budget_paused'
      ))`,
  },
  {
    column: "heartbeat_enabled",
    type: "INTEGER",
    sql: `ALTER TABLE company_employees ADD COLUMN heartbeat_enabled INTEGER
      CHECK (heartbeat_enabled IS NULL OR heartbeat_enabled IN (0, 1))`,
  },
  {
    column: "heartbeat_interval_seconds",
    type: "INTEGER",
    sql: `ALTER TABLE company_employees ADD COLUMN heartbeat_interval_seconds INTEGER
      CHECK (heartbeat_interval_seconds IS NULL OR heartbeat_interval_seconds > 0)`,
  },
  {
    column: "last_heartbeat_at",
    type: "TEXT",
    sql: "ALTER TABLE company_employees ADD COLUMN last_heartbeat_at TEXT",
  },
] as const;

// One row per employee holding the markdown documents it boots with. No FK
// (matches the settlements ledger and agent_listings): the table is written
// from the app and stays dark-deploy safe against a schema that lacks it.
const COMPANY_EMPLOYEE_INSTRUCTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS company_employee_instructions (
    agent_id TEXT PRIMARY KEY,
    agents_md TEXT,
    soul_md TEXT,
    heartbeat_md TEXT,
    tools_md TEXT,
    session_summary TEXT,
    updated_at TEXT NOT NULL
  );
`;

const AGENT_RESOURCE_FOUNDRY_SQL = `
  CREATE TABLE IF NOT EXISTS resource_products (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    owner_id TEXT NOT NULL CHECK(length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 128),
    name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 160),
    slug TEXT NOT NULL CHECK(length(CAST(slug AS BLOB)) BETWEEN 1 AND 160),
    status TEXT NOT NULL CHECK(status IN ('draft','test','live','paused','retired')),
    execution_access TEXT NOT NULL CHECK(execution_access IN ('free','paid','private')),
    discovery_access TEXT NOT NULL CHECK(discovery_access IN ('public','unlisted')),
    created_at TEXT NOT NULL CHECK(length(created_at) = 24 AND created_at LIKE '%Z'),
    updated_at TEXT NOT NULL CHECK(length(updated_at) = 24 AND updated_at LIKE '%Z'),
    UNIQUE(owner_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_products_owner_status
    ON resource_products(owner_id, status, updated_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS resource_source_assets (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    resource_product_id TEXT NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
    locator TEXT NOT NULL CHECK(length(CAST(locator AS BLOB)) BETWEEN 1 AND 1024),
    source_kind TEXT NOT NULL CHECK(length(CAST(source_kind AS BLOB)) BETWEEN 1 AND 128),
    created_at TEXT NOT NULL CHECK(length(created_at) = 24 AND created_at LIKE '%Z'),
    UNIQUE(resource_product_id, locator, source_kind)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_source_assets_product
    ON resource_source_assets(resource_product_id, created_at, id);

  CREATE TABLE IF NOT EXISTS resource_source_snapshots (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    resource_product_id TEXT NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
    source_asset_id TEXT NOT NULL REFERENCES resource_source_assets(id) ON DELETE RESTRICT,
    locator TEXT NOT NULL CHECK(length(CAST(locator AS BLOB)) BETWEEN 1 AND 1024),
    source_kind TEXT NOT NULL CHECK(length(CAST(source_kind AS BLOB)) BETWEEN 1 AND 128),
    captured_at TEXT NOT NULL CHECK(length(captured_at) = 24 AND captured_at LIKE '%Z'),
    source_published_at TEXT CHECK(source_published_at IS NULL OR length(source_published_at) = 24 AND source_published_at LIKE '%Z'),
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    freshness_deadline TEXT NOT NULL CHECK(length(freshness_deadline) = 24 AND freshness_deadline LIKE '%Z'),
    provenance TEXT CHECK(provenance IS NULL OR provenance IN ('mine','licensed_or_permissioned','public_source','other_or_unspecified')),
    provenance_note TEXT CHECK(provenance_note IS NULL OR length(CAST(provenance_note AS BLOB)) BETWEEN 1 AND 1024),
    created_at TEXT NOT NULL CHECK(length(created_at) = 24 AND created_at LIKE '%Z')
  );
  CREATE INDEX IF NOT EXISTS idx_resource_source_snapshots_product
    ON resource_source_snapshots(resource_product_id, captured_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_resource_source_snapshots_asset
    ON resource_source_snapshots(source_asset_id, captured_at DESC, id DESC);
  CREATE TRIGGER IF NOT EXISTS resource_source_snapshots_no_update
    BEFORE UPDATE ON resource_source_snapshots
    BEGIN SELECT RAISE(ABORT, 'Resource source snapshots are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS resource_source_snapshots_no_delete
    BEFORE DELETE ON resource_source_snapshots
    BEGIN SELECT RAISE(ABORT, 'Resource source snapshots are append-only'); END;

  CREATE TABLE IF NOT EXISTS resource_pack_versions (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    resource_product_id TEXT NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
    status TEXT NOT NULL CHECK(status IN ('candidate','approved','live','retired')),
    semantic_hash TEXT NOT NULL CHECK(length(semantic_hash) = 64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
    content_json TEXT NOT NULL CHECK(json_valid(content_json) AND length(CAST(content_json AS BLOB)) BETWEEN 2 AND 524288),
    created_by TEXT NOT NULL CHECK(length(CAST(created_by AS BLOB)) BETWEEN 1 AND 128),
    created_at TEXT NOT NULL CHECK(length(created_at) = 24 AND created_at LIKE '%Z'),
    approved_by TEXT CHECK(approved_by IS NULL OR length(CAST(approved_by AS BLOB)) BETWEEN 1 AND 128),
    approved_at TEXT CHECK(approved_at IS NULL OR length(approved_at) = 24 AND approved_at LIKE '%Z'),
    UNIQUE(resource_product_id, revision),
    UNIQUE(resource_product_id, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_pack_candidate
    ON resource_pack_versions(resource_product_id) WHERE status = 'candidate';
  CREATE INDEX IF NOT EXISTS idx_resource_pack_product_status
    ON resource_pack_versions(resource_product_id, status, revision DESC, id DESC);
  CREATE TRIGGER IF NOT EXISTS resource_pack_versions_immutable_content
    BEFORE UPDATE ON resource_pack_versions
    WHEN OLD.status IN ('approved','live','retired') AND (
      (OLD.status = 'approved' AND NEW.status NOT IN ('approved','live','retired')) OR
      (OLD.status = 'live' AND NEW.status NOT IN ('live','retired')) OR
      (OLD.status = 'retired' AND NEW.status <> 'retired') OR
      NEW.id <> OLD.id OR NEW.resource_product_id <> OLD.resource_product_id OR
      NEW.revision <> OLD.revision OR NEW.semantic_hash <> OLD.semantic_hash OR
      NEW.content_json <> OLD.content_json OR NEW.created_by <> OLD.created_by OR
      NEW.created_at <> OLD.created_at OR NEW.approved_by IS NOT OLD.approved_by OR
      NEW.approved_at IS NOT OLD.approved_at
    )
    BEGIN SELECT RAISE(ABORT, 'Resource pack content is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS resource_pack_versions_no_delete_immutable
    BEFORE DELETE ON resource_pack_versions WHEN OLD.status IN ('approved','live','retired')
    BEGIN SELECT RAISE(ABORT, 'Resource pack versions are append-only'); END;

  CREATE TABLE IF NOT EXISTS resource_records (
    pack_version_id TEXT NOT NULL REFERENCES resource_pack_versions(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
    tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
    evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
    unknowns_json TEXT CHECK(unknowns_json IS NULL OR json_valid(unknowns_json)),
    conflicts_json TEXT CHECK(conflicts_json IS NULL OR json_valid(conflicts_json)),
    PRIMARY KEY(pack_version_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_records_pack ON resource_records(pack_version_id, id);
  CREATE TRIGGER IF NOT EXISTS resource_records_no_update_immutable
    BEFORE UPDATE ON resource_records
    WHEN EXISTS (
      SELECT 1 FROM resource_pack_versions
      WHERE id IN (OLD.pack_version_id, NEW.pack_version_id)
        AND status IN ('approved','live','retired')
    )
    BEGIN SELECT RAISE(ABORT, 'Resource pack content is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS resource_records_no_delete_immutable
    BEFORE DELETE ON resource_records
    WHEN EXISTS (
      SELECT 1 FROM resource_pack_versions
      WHERE id = OLD.pack_version_id AND status IN ('approved','live','retired')
    )
    BEGIN SELECT RAISE(ABORT, 'Resource pack content is append-only'); END;

  CREATE TABLE IF NOT EXISTS resource_evidence_refs (
    pack_version_id TEXT NOT NULL REFERENCES resource_pack_versions(id) ON DELETE CASCADE,
    id TEXT NOT NULL CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    source_snapshot_id TEXT NOT NULL REFERENCES resource_source_snapshots(id) ON DELETE RESTRICT,
    locator TEXT NOT NULL CHECK(length(CAST(locator AS BLOB)) BETWEEN 1 AND 1024),
    observed_at TEXT NOT NULL CHECK(length(observed_at) = 24 AND observed_at LIKE '%Z'),
    field_hash TEXT CHECK(field_hash IS NULL OR length(field_hash) = 64 AND field_hash NOT GLOB '*[^0-9a-f]*'),
    confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
    conflict TEXT CHECK(conflict IS NULL OR length(CAST(conflict AS BLOB)) BETWEEN 1 AND 128),
    PRIMARY KEY(pack_version_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_evidence_pack ON resource_evidence_refs(pack_version_id, id);
  CREATE INDEX IF NOT EXISTS idx_resource_evidence_snapshot ON resource_evidence_refs(source_snapshot_id, pack_version_id);
  CREATE TRIGGER IF NOT EXISTS resource_evidence_refs_no_update_immutable
    BEFORE UPDATE ON resource_evidence_refs
    WHEN EXISTS (
      SELECT 1 FROM resource_pack_versions
      WHERE id IN (OLD.pack_version_id, NEW.pack_version_id)
        AND status IN ('approved','live','retired')
    )
    BEGIN SELECT RAISE(ABORT, 'Resource pack content is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS resource_evidence_refs_no_delete_immutable
    BEFORE DELETE ON resource_evidence_refs
    WHEN EXISTS (
      SELECT 1 FROM resource_pack_versions
      WHERE id = OLD.pack_version_id AND status IN ('approved','live','retired')
    )
    BEGIN SELECT RAISE(ABORT, 'Resource pack content is append-only'); END;

  CREATE TABLE IF NOT EXISTS resource_releases (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    owner_id TEXT NOT NULL CHECK(length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 128),
    resource_product_id TEXT NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
    pack_version_id TEXT NOT NULL REFERENCES resource_pack_versions(id) ON DELETE RESTRICT,
    semantic_hash TEXT NOT NULL CHECK(length(semantic_hash) = 64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
    agent_id TEXT NOT NULL CHECK(length(CAST(agent_id AS BLOB)) BETWEEN 1 AND 128),
    flow_id TEXT NOT NULL CHECK(length(CAST(flow_id AS BLOB)) BETWEEN 1 AND 128),
    flow_version_id TEXT NOT NULL CHECK(length(CAST(flow_version_id AS BLOB)) BETWEEN 1 AND 128),
    deployment_id TEXT NOT NULL UNIQUE CHECK(length(CAST(deployment_id AS BLOB)) BETWEEN 1 AND 128),
    environment_id TEXT NOT NULL CHECK(length(CAST(environment_id AS BLOB)) BETWEEN 1 AND 128),
    created_at TEXT NOT NULL CHECK(length(created_at) = 24 AND created_at LIKE '%Z'),
    FOREIGN KEY(resource_product_id, pack_version_id)
      REFERENCES resource_pack_versions(resource_product_id, id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_resource_releases_agent
    ON resource_releases(agent_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_resource_releases_owner_product
    ON resource_releases(owner_id, resource_product_id, created_at DESC, id DESC);
  CREATE TRIGGER IF NOT EXISTS resource_releases_no_update
    BEFORE UPDATE ON resource_releases
    WHEN NEW.id <> OLD.id OR NEW.resource_product_id <> OLD.resource_product_id OR
      NEW.pack_version_id <> OLD.pack_version_id OR NEW.semantic_hash <> OLD.semantic_hash OR
      NEW.agent_id <> OLD.agent_id OR NEW.flow_id <> OLD.flow_id OR
      NEW.flow_version_id <> OLD.flow_version_id OR NEW.deployment_id <> OLD.deployment_id OR
      NEW.environment_id <> OLD.environment_id OR NEW.created_at <> OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'Resource releases are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS resource_releases_no_delete
    BEFORE DELETE ON resource_releases
    BEGIN SELECT RAISE(ABORT, 'Resource releases are append-only'); END;

  CREATE TABLE IF NOT EXISTS resource_run_receipts (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    owner_id TEXT NOT NULL CHECK(length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 128),
    resource_product_id TEXT NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
    pack_version_id TEXT NOT NULL REFERENCES resource_pack_versions(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL UNIQUE CHECK(length(CAST(run_id AS BLOB)) BETWEEN 1 AND 128),
    flow_version_id TEXT NOT NULL CHECK(length(CAST(flow_version_id AS BLOB)) BETWEEN 1 AND 128),
    deployment_id TEXT NOT NULL CHECK(length(CAST(deployment_id AS BLOB)) BETWEEN 1 AND 128),
    semantic_hash TEXT NOT NULL CHECK(length(semantic_hash) = 64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
    freshness TEXT NOT NULL CHECK(freshness IN ('fresh','stale','mixed')),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    unknowns_json TEXT NOT NULL CHECK(json_valid(unknowns_json)),
    conflicts_json TEXT NOT NULL CHECK(json_valid(conflicts_json)),
    output_schema_valid INTEGER NOT NULL CHECK(output_schema_valid IN (0,1)),
    created_at TEXT NOT NULL CHECK(length(created_at) = 24 AND created_at LIKE '%Z'),
    FOREIGN KEY(resource_product_id, pack_version_id)
      REFERENCES resource_pack_versions(resource_product_id, id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_resource_receipts_owner_product
    ON resource_run_receipts(owner_id, resource_product_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_resource_receipts_pack
    ON resource_run_receipts(pack_version_id, created_at DESC, id DESC);
  CREATE TRIGGER IF NOT EXISTS resource_run_receipts_no_update
    BEFORE UPDATE ON resource_run_receipts
    WHEN NEW.id <> OLD.id OR NEW.resource_product_id <> OLD.resource_product_id OR
      NEW.pack_version_id <> OLD.pack_version_id OR NEW.run_id <> OLD.run_id OR
      NEW.flow_version_id <> OLD.flow_version_id OR NEW.deployment_id <> OLD.deployment_id OR
      NEW.semantic_hash <> OLD.semantic_hash OR NEW.freshness <> OLD.freshness OR
      NEW.evidence_json <> OLD.evidence_json OR NEW.unknowns_json <> OLD.unknowns_json OR
      NEW.conflicts_json <> OLD.conflicts_json OR
      NEW.output_schema_valid <> OLD.output_schema_valid OR NEW.created_at <> OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'Resource run receipts are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS resource_run_receipts_no_delete
    BEFORE DELETE ON resource_run_receipts
    BEGIN SELECT RAISE(ABORT, 'Resource run receipts are append-only'); END;
`;

const RESOURCE_TABLE_COLUMNS = {
  resource_products: ["id","owner_id","name","slug","status","execution_access","discovery_access","created_at","updated_at"],
  resource_source_assets: ["id","resource_product_id","locator","source_kind","created_at"],
  resource_source_snapshots: ["id","resource_product_id","source_asset_id","locator","source_kind","captured_at","source_published_at","content_hash","freshness_deadline","provenance","provenance_note","created_at"],
  resource_pack_versions: ["id","resource_product_id","revision","status","semantic_hash","content_json","created_by","created_at","approved_by","approved_at"],
  resource_records: ["pack_version_id","id","fields_json","tags_json","evidence_ids_json","unknowns_json","conflicts_json"],
  resource_evidence_refs: ["pack_version_id","id","source_snapshot_id","locator","observed_at","field_hash","confidence","conflict"],
  resource_releases: ["id","owner_id","resource_product_id","pack_version_id","semantic_hash","agent_id","flow_id","flow_version_id","deployment_id","environment_id","created_at"],
  resource_run_receipts: ["id","owner_id","resource_product_id","pack_version_id","run_id","flow_version_id","deployment_id","semantic_hash","freshness","evidence_json","unknowns_json","conflicts_json","output_schema_valid","created_at"],
} as const;

const RESOURCE_SCHEMA_OBJECTS = [
  ...Object.keys(RESOURCE_TABLE_COLUMNS).map((name) => ({ type: "table", name })),
  ...[
    "idx_resource_products_owner_status", "idx_resource_source_assets_product",
    "idx_resource_source_snapshots_product", "idx_resource_source_snapshots_asset",
    "uq_resource_pack_candidate", "idx_resource_pack_product_status",
    "idx_resource_records_pack", "idx_resource_evidence_pack",
    "idx_resource_evidence_snapshot", "idx_resource_releases_agent",
    "idx_resource_releases_owner_product", "idx_resource_receipts_owner_product",
    "idx_resource_receipts_pack",
  ].map((name) => ({ type: "index", name })),
  ...[
    "resource_source_snapshots_no_update", "resource_source_snapshots_no_delete",
    "resource_pack_versions_immutable_content", "resource_pack_versions_no_delete_immutable",
    "resource_records_no_update_immutable", "resource_records_no_delete_immutable",
    "resource_evidence_refs_no_update_immutable", "resource_evidence_refs_no_delete_immutable",
    "resource_releases_no_update", "resource_releases_no_delete",
    "resource_run_receipts_no_update", "resource_run_receipts_no_delete",
  ].map((name) => ({ type: "trigger", name })),
] as const;

function assertResourceFoundryIntegrity(db: Database.Database): void {
  const publicationRelease = hasColumn(db, "resource_releases", "publication_key");
  const receiptPaymentFacts = hasColumn(db, "resource_run_receipts", "payment_state");
  for (const [table, expected] of Object.entries(RESOURCE_TABLE_COLUMNS)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as SqliteColumnInfo[])
      .map((column) => column.name);
    if (table === "resource_releases" && publicationRelease) continue;
    if (table === "resource_run_receipts" && receiptPaymentFacts) continue;
    if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) {
      throw new Error(`SQLite ${table} definition mismatch`);
    }
  }
  assertIndexColumns(db, "resource_products", "idx_resource_products_owner_status", ["owner_id","status","updated_at","id"]);
  assertIndexColumns(db, "resource_source_assets", "idx_resource_source_assets_product", ["resource_product_id","created_at","id"]);
  assertIndexColumns(db, "resource_source_snapshots", "idx_resource_source_snapshots_product", ["resource_product_id","captured_at","id"]);
  assertIndexColumns(db, "resource_pack_versions", "idx_resource_pack_product_status", ["resource_product_id","status","revision","id"]);
  assertIndexColumns(db, "resource_releases", "idx_resource_releases_owner_product", ["owner_id","resource_product_id","created_at","id"]);
  assertIndexColumns(db, "resource_run_receipts", "idx_resource_receipts_owner_product", ["owner_id","resource_product_id","created_at","id"]);
  const expected = new Database(":memory:");
  try {
    expected.exec(AGENT_RESOURCE_FOUNDRY_SQL);
    for (const object of RESOURCE_SCHEMA_OBJECTS) {
      if (publicationRelease && object.name.startsWith("resource_releases")) continue;
      if (receiptPaymentFacts && (object.name.includes("resource_run_receipts") || object.name.includes("resource_receipts"))) continue;
      const actualRow = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type=? AND name=?",
      ).get(object.type, object.name) as { sql: string | null } | undefined;
      const expectedRow = expected.prepare(
        "SELECT sql FROM sqlite_master WHERE type=? AND name=?",
      ).get(object.type, object.name) as { sql: string | null } | undefined;
      if (!actualRow?.sql || !expectedRow?.sql || normalizeSql(actualRow.sql) !== normalizeSql(expectedRow.sql)) {
        throw new Error(`SQLite resource ${object.type} ${object.name} definition mismatch`);
      }
    }
  } finally {
    expected.close();
  }
  if (publicationRelease) assertResourceReleasePublicationIntegrity(db);
}

const RESOURCE_RUN_RECEIPT_PAYMENT_FACTS_SQL = `
  DROP TRIGGER resource_run_receipts_no_update;
  DROP TRIGGER resource_run_receipts_no_delete;
  DROP INDEX idx_resource_receipts_owner_product;
  DROP INDEX idx_resource_receipts_pack;
  ALTER TABLE resource_run_receipts RENAME TO resource_run_receipts_v39;
  CREATE TABLE resource_run_receipts (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    owner_id TEXT NOT NULL CHECK(length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 128),
    resource_product_id TEXT NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
    pack_version_id TEXT NOT NULL REFERENCES resource_pack_versions(id) ON DELETE RESTRICT,
    agent_id TEXT NOT NULL CHECK(length(CAST(agent_id AS BLOB)) BETWEEN 1 AND 128),
    run_id TEXT NOT NULL UNIQUE CHECK(length(CAST(run_id AS BLOB)) BETWEEN 1 AND 128),
    flow_version_id TEXT NOT NULL CHECK(length(CAST(flow_version_id AS BLOB)) BETWEEN 1 AND 128),
    deployment_id TEXT NOT NULL CHECK(length(CAST(deployment_id AS BLOB)) BETWEEN 1 AND 128),
    payment_id TEXT CHECK(payment_id IS NULL OR length(CAST(payment_id AS BLOB)) BETWEEN 1 AND 256),
    payment_state TEXT NOT NULL CHECK(payment_state IN ('free','challenged','credited','settled','refunded','failed')),
    price_usdc REAL NOT NULL CHECK(typeof(price_usdc) IN ('real','integer') AND price_usdc>=0),
    semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
    freshness TEXT NOT NULL CHECK(freshness IN ('fresh','stale','mixed')),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    unknowns_json TEXT NOT NULL CHECK(json_valid(unknowns_json)),
    conflicts_json TEXT NOT NULL CHECK(json_valid(conflicts_json)),
    output_schema_valid INTEGER NOT NULL CHECK(output_schema_valid IN (0,1)),
    created_at TEXT NOT NULL CHECK(length(created_at)=24 AND created_at LIKE '%Z'),
    FOREIGN KEY(resource_product_id,pack_version_id)
      REFERENCES resource_pack_versions(resource_product_id,id) ON DELETE RESTRICT
  );
  INSERT INTO resource_run_receipts(
    id,owner_id,resource_product_id,pack_version_id,agent_id,run_id,flow_version_id,deployment_id,
    payment_id,payment_state,price_usdc,semantic_hash,freshness,evidence_json,unknowns_json,
    conflicts_json,output_schema_valid,created_at
  )
  SELECT receipt.id,receipt.owner_id,receipt.resource_product_id,receipt.pack_version_id,release.agent_id,
    receipt.run_id,receipt.flow_version_id,receipt.deployment_id,settlement.tx,
    CASE WHEN settlement.run_id IS NULL THEN 'free' ELSE 'settled' END,release.price_usdc,
    receipt.semantic_hash,receipt.freshness,receipt.evidence_json,receipt.unknowns_json,
    receipt.conflicts_json,receipt.output_schema_valid,receipt.created_at
  FROM resource_run_receipts_v39 receipt
  JOIN resource_releases release ON release.owner_id=receipt.owner_id
    AND release.resource_product_id=receipt.resource_product_id
    AND release.pack_version_id=receipt.pack_version_id
    AND release.flow_version_id=receipt.flow_version_id
    AND release.deployment_id=receipt.deployment_id
  LEFT JOIN settlements settlement ON settlement.run_id=receipt.run_id
    AND settlement.owner_id=receipt.owner_id AND settlement.agent_id=release.agent_id
    AND settlement.gross_usdc=release.price_usdc;
  DROP TABLE resource_run_receipts_v39;
  CREATE INDEX idx_resource_receipts_owner_product
    ON resource_run_receipts(owner_id,resource_product_id,created_at DESC,id DESC);
  CREATE INDEX idx_resource_receipts_pack
    ON resource_run_receipts(pack_version_id,created_at DESC,id DESC);
  CREATE TRIGGER resource_run_receipts_no_update BEFORE UPDATE ON resource_run_receipts
    WHEN NEW.id<>OLD.id OR NEW.resource_product_id<>OLD.resource_product_id OR
      NEW.pack_version_id<>OLD.pack_version_id OR NEW.agent_id<>OLD.agent_id OR NEW.run_id<>OLD.run_id OR
      NEW.flow_version_id<>OLD.flow_version_id OR NEW.deployment_id<>OLD.deployment_id OR
      NEW.payment_id IS NOT OLD.payment_id OR NEW.payment_state<>OLD.payment_state OR NEW.price_usdc<>OLD.price_usdc OR
      NEW.semantic_hash<>OLD.semantic_hash OR NEW.freshness<>OLD.freshness OR NEW.evidence_json<>OLD.evidence_json OR
      NEW.unknowns_json<>OLD.unknowns_json OR NEW.conflicts_json<>OLD.conflicts_json OR
      NEW.output_schema_valid<>OLD.output_schema_valid OR NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Resource run receipts are append-only'); END;
  CREATE TRIGGER resource_run_receipts_no_delete BEFORE DELETE ON resource_run_receipts
    BEGIN SELECT RAISE(ABORT,'Resource run receipts are append-only'); END;
`;

function assertResourceRunReceiptPaymentFactsIntegrity(db: Database.Database): void {
  const expected = [
    "id","owner_id","resource_product_id","pack_version_id","agent_id","run_id","flow_version_id",
    "deployment_id","payment_id","payment_state","price_usdc","semantic_hash","freshness","evidence_json",
    "unknowns_json","conflicts_json","output_schema_valid","created_at",
  ];
  const actual = (db.prepare("PRAGMA table_info(resource_run_receipts)").all() as SqliteColumnInfo[]).map((column) => column.name);
  if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
    throw new Error("SQLite resource receipt payment facts definition mismatch");
  }
  const update = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='resource_run_receipts_no_update'").get() as { sql: string } | undefined;
  const remove = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='resource_run_receipts_no_delete'").get() as { sql: string } | undefined;
  const normalized = normalizeSql(update?.sql ?? "");
  if (!remove?.sql || !normalizeSql(remove.sql).includes("resource run receipts are append-only") ||
      ["agent_id", "payment_id", "payment_state", "price_usdc"].some((column) => !normalized.includes(`new.${column}`))) {
    throw new Error("SQLite resource receipt trigger definition mismatch");
  }
}

const RESOURCE_RELEASE_PUBLICATION_SQL = `
  DROP TRIGGER resource_releases_no_update;
  DROP TRIGGER resource_releases_no_delete;
  DROP INDEX idx_resource_releases_agent;
  DROP INDEX idx_resource_releases_owner_product;
  ALTER TABLE resource_releases RENAME TO resource_releases_v38;

  UPDATE agents SET price_usdc=0
  WHERE id IN (
    SELECT release.agent_id FROM resource_releases_v38 release
    JOIN resource_products product ON product.id=release.resource_product_id
    WHERE product.execution_access IN ('free','private')
  );

  CREATE TABLE resource_releases (
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    owner_id TEXT NOT NULL CHECK(length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 128),
    resource_product_id TEXT NOT NULL REFERENCES resource_products(id) ON DELETE RESTRICT,
    pack_version_id TEXT NOT NULL REFERENCES resource_pack_versions(id) ON DELETE RESTRICT,
    semantic_hash TEXT NOT NULL CHECK(length(semantic_hash)=64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
    publication_key TEXT NOT NULL CHECK(length(CAST(publication_key AS BLOB)) BETWEEN 1 AND 256),
    publication_request_hash TEXT NOT NULL CHECK(length(publication_request_hash)=64 AND publication_request_hash NOT GLOB '*[^0-9a-f]*'),
    graph_semantic_hash TEXT NOT NULL CHECK(length(graph_semantic_hash)=64 AND graph_semantic_hash NOT GLOB '*[^0-9a-f]*'),
    graph_full_hash TEXT NOT NULL CHECK(length(graph_full_hash)=64 AND graph_full_hash NOT GLOB '*[^0-9a-f]*'),
    price_usdc REAL NOT NULL CHECK(typeof(price_usdc) IN ('real','integer') AND price_usdc>=0),
    execution_access TEXT NOT NULL CHECK(execution_access IN ('free','paid','private')),
    discovery_access TEXT NOT NULL CHECK(discovery_access IN ('public','unlisted')),
    agent_id TEXT NOT NULL CHECK(length(CAST(agent_id AS BLOB)) BETWEEN 1 AND 128),
    flow_id TEXT NOT NULL CHECK(length(CAST(flow_id AS BLOB)) BETWEEN 1 AND 128),
    flow_version_id TEXT NOT NULL CHECK(length(CAST(flow_version_id AS BLOB)) BETWEEN 1 AND 128),
    deployment_id TEXT NOT NULL UNIQUE CHECK(length(CAST(deployment_id AS BLOB)) BETWEEN 1 AND 128),
    environment_id TEXT NOT NULL CHECK(length(CAST(environment_id AS BLOB)) BETWEEN 1 AND 128),
    created_at TEXT NOT NULL CHECK(length(created_at)=24 AND created_at LIKE '%Z'),
    CHECK(execution_access='paid' OR price_usdc=0),
    UNIQUE(owner_id,resource_product_id,publication_key),
    FOREIGN KEY(resource_product_id,pack_version_id)
      REFERENCES resource_pack_versions(resource_product_id,id) ON DELETE RESTRICT
  );

  INSERT INTO resource_releases (
    id,owner_id,resource_product_id,pack_version_id,semantic_hash,
    publication_key,publication_request_hash,graph_semantic_hash,graph_full_hash,
    price_usdc,execution_access,discovery_access,agent_id,flow_id,flow_version_id,
    deployment_id,environment_id,created_at
  )
  SELECT release.id,release.owner_id,release.resource_product_id,release.pack_version_id,release.semantic_hash,
    'legacy:'||release.id,release.semantic_hash,version.semantic_hash,version.full_hash,
    agent.price_usdc,product.execution_access,product.discovery_access,release.agent_id,release.flow_id,
    release.flow_version_id,release.deployment_id,release.environment_id,release.created_at
  FROM resource_releases_v38 release
  JOIN resource_products product ON product.id=release.resource_product_id AND product.owner_id=release.owner_id
  JOIN agents agent ON agent.id=release.agent_id AND agent.flow_id=release.flow_id
  JOIN flow_versions version ON version.id=release.flow_version_id AND version.flow_id=release.flow_id;

  DROP TABLE resource_releases_v38;
  CREATE INDEX IF NOT EXISTS idx_resource_releases_agent
    ON resource_releases(agent_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_resource_releases_owner_product
    ON resource_releases(owner_id, resource_product_id, created_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_releases_publication
    ON resource_releases(owner_id,resource_product_id,publication_key);
  CREATE TRIGGER resource_releases_no_update
    BEFORE UPDATE ON resource_releases
    WHEN NEW.id<>OLD.id OR NEW.resource_product_id<>OLD.resource_product_id OR
      NEW.pack_version_id<>OLD.pack_version_id OR NEW.semantic_hash<>OLD.semantic_hash OR
      NEW.publication_key<>OLD.publication_key OR NEW.publication_request_hash<>OLD.publication_request_hash OR
      NEW.graph_semantic_hash<>OLD.graph_semantic_hash OR NEW.graph_full_hash<>OLD.graph_full_hash OR
      NEW.price_usdc<>OLD.price_usdc OR NEW.execution_access<>OLD.execution_access OR
      NEW.discovery_access<>OLD.discovery_access OR NEW.agent_id<>OLD.agent_id OR
      NEW.flow_id<>OLD.flow_id OR NEW.flow_version_id<>OLD.flow_version_id OR
      NEW.deployment_id<>OLD.deployment_id OR NEW.environment_id<>OLD.environment_id OR
      NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Resource releases are append-only'); END;
  CREATE TRIGGER resource_releases_no_delete
    BEFORE DELETE ON resource_releases
    BEGIN SELECT RAISE(ABORT,'Resource releases are append-only'); END;
`;

function assertResourceReleasePublicationIntegrity(db: Database.Database): void {
  const expected = [
    "id","owner_id","resource_product_id","pack_version_id","semantic_hash",
    "publication_key","publication_request_hash","graph_semantic_hash","graph_full_hash",
    "price_usdc","execution_access","discovery_access","agent_id","flow_id",
    "flow_version_id","deployment_id","environment_id","created_at",
  ];
  const actual = (db.prepare("PRAGMA table_info(resource_releases)").all() as SqliteColumnInfo[])
    .map((column) => column.name);
  if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
    throw new Error("SQLite resource release publication definition mismatch");
  }
  const index = (db.prepare("PRAGMA index_list(resource_releases)").all() as Array<{
    name: string;
    unique: number;
  }>).find((candidate) => candidate.name === "uq_resource_releases_publication");
  const indexColumns = (db.prepare("PRAGMA index_info(uq_resource_releases_publication)").all() as Array<{
    seqno: number;
    name: string;
  }>).sort((left, right) => left.seqno - right.seqno).map((column) => column.name);
  if (!index || index.unique !== 1 ||
      indexColumns.join(",") !== "owner_id,resource_product_id,publication_key") {
    throw new Error("SQLite resource release publication index mismatch");
  }
  const updateTrigger = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='resource_releases_no_update'`).get() as { sql: string } | undefined;
  const deleteTrigger = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='resource_releases_no_delete'`).get() as { sql: string } | undefined;
  const normalizedUpdate = normalizeSql(updateTrigger?.sql ?? "");
  for (const column of [
    "publication_key", "publication_request_hash", "graph_semantic_hash", "graph_full_hash",
    "price_usdc", "execution_access", "discovery_access",
  ]) {
    if (!normalizedUpdate.includes(`new.${column}<>old.${column}`)) {
      throw new Error("SQLite resource release publication trigger mismatch");
    }
  }
  if (!deleteTrigger?.sql || !normalizeSql(deleteTrigger.sql).includes("resource releases are append-only")) {
    throw new Error("SQLite resource release publication trigger mismatch");
  }
  const invalid = db.prepare(`SELECT id FROM resource_releases
    WHERE publication_key IS NULL OR publication_request_hash IS NULL OR
      graph_semantic_hash IS NULL OR graph_full_hash IS NULL OR
      execution_access NOT IN ('free','paid','private') OR
      discovery_access NOT IN ('public','unlisted') OR
      (execution_access<>'paid' AND price_usdc<>0) LIMIT 1`).get();
  if (invalid) throw new Error("SQLite resource release publication data mismatch");
}

const COMPANY_APPROVAL_SNAPSHOT_SQL = `
  ALTER TABLE company_approvals ADD COLUMN action_summary TEXT;
  ALTER TABLE company_approvals ADD COLUMN cost_basis TEXT
    CHECK (cost_basis IS NULL OR cost_basis IN ('quoted', 'estimated', 'unavailable'));
  ALTER TABLE company_approvals ADD COLUMN cost_usdc REAL
    CHECK (cost_usdc IS NULL OR cost_usdc >= 0);
  ALTER TABLE company_approvals ADD COLUMN cost_note TEXT;
`;

const COMPANY_ACTIVITY_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_runs_company_activity
    ON runs (agent_id, started_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_approvals_company_activity
    ON company_approvals (company_id, created_at DESC, id DESC);
`;

const MODERATION_REPORTS_SQL = `
  CREATE TABLE IF NOT EXISTS moderation_reports (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
    reporter_owner_id TEXT NOT NULL CHECK (length(reporter_owner_id) BETWEEN 1 AND 256),
    subject_owner_id TEXT NOT NULL CHECK (length(subject_owner_id) BETWEEN 1 AND 256),
    subject_type TEXT NOT NULL
      CHECK (subject_type IN ('run_output', 'agent_output', 'agent')),
    flow_id TEXT CHECK (flow_id IS NULL OR length(flow_id) BETWEEN 1 AND 256),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
    node_id TEXT CHECK (node_id IS NULL OR length(node_id) BETWEEN 1 AND 256),
    agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 1 AND 256),
    reason TEXT NOT NULL CHECK (reason IN (
      'sexual_content',
      'hate_or_harassment',
      'violence_or_self_harm',
      'illegal_or_dangerous',
      'privacy_or_personal_data',
      'deceptive_or_misleading',
      'other_unsafe_content'
    )),
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
    reviewer_notes TEXT CHECK (reviewer_notes IS NULL OR length(reviewer_notes) <= 2000),
    reviewed_by TEXT CHECK (reviewed_by IS NULL OR length(reviewed_by) BETWEEN 1 AND 320),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_at TEXT,
    CHECK (
      (subject_type = 'run_output' AND flow_id IS NOT NULL AND run_id IS NOT NULL AND agent_id IS NULL)
      OR (subject_type = 'agent_output' AND flow_id IS NOT NULL AND agent_id IS NOT NULL AND node_id IS NULL)
      OR (subject_type = 'agent' AND flow_id IS NOT NULL AND agent_id IS NOT NULL AND run_id IS NULL AND node_id IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_moderation_reports_queue
    ON moderation_reports (status, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_moderation_reports_reporter
    ON moderation_reports (reporter_owner_id, created_at DESC, id DESC);
`;

const COMPANY_APPROVAL_SNAPSHOT_COLUMNS = [
  { column: "action_summary", type: "TEXT", sql: "ALTER TABLE company_approvals ADD COLUMN action_summary TEXT" },
  {
    column: "cost_basis",
    type: "TEXT",
    sql: `ALTER TABLE company_approvals ADD COLUMN cost_basis TEXT
      CHECK (cost_basis IS NULL OR cost_basis IN ('quoted', 'estimated', 'unavailable'))`,
  },
  {
    column: "cost_usdc",
    type: "REAL",
    sql: `ALTER TABLE company_approvals ADD COLUMN cost_usdc REAL
      CHECK (cost_usdc IS NULL OR cost_usdc >= 0)`,
  },
  { column: "cost_note", type: "TEXT", sql: "ALTER TABLE company_approvals ADD COLUMN cost_note TEXT" },
] as const;

function assertCompanyEmployeeHistoryIntegrity(db: Database.Database): void {
  assertNullableColumn(db, "company_employees", "removed_at", "TEXT");
  assertIndexColumns(
    db,
    "company_employees",
    "idx_employees_company_active",
    ["company_id", "removed_at"],
  );
}

function applyCompanyEmployeePayToMigration(db: Database.Database): void {
  if (!hasColumn(db, "company_employees", "pay_to")) {
    db.exec("ALTER TABLE company_employees ADD COLUMN pay_to TEXT");
  }
  assertNullableColumn(db, "company_employees", "pay_to", "TEXT");
}

function applyCompanyOrgRolesMigration(db: Database.Database): void {
  for (const column of COMPANY_ORG_ROLE_COLUMNS) {
    if (!hasColumn(db, "company_employees", column.column)) db.exec(column.sql);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_employees_reports_to
    ON company_employees (reports_to)`);
  for (const column of COMPANY_ORG_ROLE_COLUMNS) {
    assertNullableColumn(db, "company_employees", column.column, column.type);
  }
  assertIndexColumns(db, "company_employees", "idx_employees_reports_to", ["reports_to"]);
}

function applyCompanyEmployeeHistoryMigration(db: Database.Database): void {
  if (!hasColumn(db, "company_employees", "removed_at")) {
    db.exec("ALTER TABLE company_employees ADD COLUMN removed_at TEXT");
  }
  assertNullableColumn(db, "company_employees", "removed_at", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_employees_company_active
    ON company_employees (company_id, removed_at)`);
  assertCompanyEmployeeHistoryIntegrity(db);
}

function assertCompanyApprovalSnapshotIntegrity(db: Database.Database): void {
  for (const column of COMPANY_APPROVAL_SNAPSHOT_COLUMNS) {
    assertNullableColumn(db, "company_approvals", column.column, column.type);
  }
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'company_approvals'",
  ).get() as { sql: string | null } | undefined;
  const sql = row?.sql ? normalizeSql(row.sql) : "";
  if (!sql.includes("check (cost_basis is null or cost_basis in ('quoted', 'estimated', 'unavailable'))") ||
      !sql.includes("check (cost_usdc is null or cost_usdc >= 0)")) {
    throw new Error("SQLite company approval snapshot constraint definition mismatch");
  }
}

function applyCompanyApprovalSnapshotMigration(db: Database.Database): void {
  for (const column of COMPANY_APPROVAL_SNAPSHOT_COLUMNS) {
    if (!hasColumn(db, "company_approvals", column.column)) db.exec(column.sql);
  }
  assertCompanyApprovalSnapshotIntegrity(db);
}

function assertCompanyActivityIndexIntegrity(db: Database.Database): void {
  assertIndexColumns(db, "runs", "idx_runs_company_activity", ["agent_id", "started_at", "id"]);
  assertIndexColumns(
    db,
    "company_approvals",
    "idx_approvals_company_activity",
    ["company_id", "created_at", "id"],
  );
}

// One row per (agent, venue) discovery submission — real receipts for the
// distribution console, not a marketing claim. UNIQUE(agent_id, venue_id) makes
// upsertAgentListing idempotent per pair. No FK (matches the settlements
// ledger): the table is written from the app and stays dark-deploy safe.
const AGENT_LISTINGS_SQL = `
  CREATE TABLE IF NOT EXISTS agent_listings (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'listed', 'failed', 'pending')),
    external_url TEXT,
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (agent_id, venue_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_listings_agent ON agent_listings (agent_id);
`;

const HEALTH_CHECKS_SQL = `
  CREATE TABLE IF NOT EXISTS health_checks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'down')),
    db_ok INTEGER NOT NULL,
    db_latency_ms INTEGER,
    gateway_ok INTEGER NOT NULL,
    gateway_latency_ms INTEGER,
    facilitator_ok INTEGER NOT NULL,
    facilitator_latency_ms INTEGER,
    checked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_health_checks_checked_at
    ON health_checks (checked_at DESC);
`;

const COMPANY_CEO_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS company_ceo_messages (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    proposal TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ceo_messages_company
    ON company_ceo_messages (company_id, created_at, id);
`;

const SITE_VERIFICATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS site_verifications (
    owner_id TEXT NOT NULL,
    host TEXT NOT NULL,
    method TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, host)
  );
`;

const STRIPE_REVENUE_RECEIPTS_SQL = `
  CREATE TABLE IF NOT EXISTS stripe_revenue_receipts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund')),
    owner_id TEXT NOT NULL CHECK (length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 512),
    provider_event_id TEXT NOT NULL UNIQUE
      CHECK (provider_event_id LIKE 'evt\\_%' ESCAPE '\\'
        AND length(CAST(provider_event_id AS BLOB)) BETWEEN 6 AND 255),
    provider_checkout_session_id TEXT
      CHECK (provider_checkout_session_id IS NULL OR
        provider_checkout_session_id LIKE 'cs\\_%' ESCAPE '\\'
        AND length(CAST(provider_checkout_session_id AS BLOB)) BETWEEN 6 AND 255),
    provider_payment_intent_id TEXT NOT NULL
      CHECK (provider_payment_intent_id LIKE 'pi\\_%' ESCAPE '\\'
        AND length(CAST(provider_payment_intent_id AS BLOB)) BETWEEN 6 AND 255),
    provider_refund_id TEXT
      CHECK (provider_refund_id IS NULL OR
        provider_refund_id LIKE 're\\_%' ESCAPE '\\'
        AND length(CAST(provider_refund_id AS BLOB)) BETWEEN 6 AND 255),
    amount_total_cents INTEGER NOT NULL
      CHECK (typeof(amount_total_cents) = 'integer'
        AND amount_total_cents BETWEEN 1 AND 9007199254740991),
    currency TEXT NOT NULL CHECK (currency = 'USD'),
    terminal_status TEXT NOT NULL CHECK (terminal_status IN ('paid', 'succeeded')),
    refund_state TEXT NOT NULL CHECK (refund_state IN ('none', 'partial', 'full')),
    provider_product_id TEXT
      CHECK (provider_product_id IS NULL OR
        provider_product_id LIKE 'prod\\_%' ESCAPE '\\'
        AND length(CAST(provider_product_id AS BLOB)) BETWEEN 6 AND 255),
    provider_price_id TEXT
      CHECK (provider_price_id IS NULL OR
        provider_price_id LIKE 'price\\_%' ESCAPE '\\'
        AND length(CAST(provider_price_id AS BLOB)) BETWEEN 7 AND 255),
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24 AND occurred_at LIKE '%Z'),
    source_revision_at TEXT NOT NULL UNIQUE
      CHECK (length(source_revision_at) = 24 AND source_revision_at LIKE '%Z'),
    credit_delta_usdc REAL NOT NULL,
    credit_id TEXT NOT NULL UNIQUE REFERENCES credits(id) ON DELETE RESTRICT,
    parent_receipt_id TEXT REFERENCES stripe_revenue_receipts(id) ON DELETE RESTRICT,
    CHECK (
      (
        kind = 'payment'
        AND provider_checkout_session_id IS NOT NULL
        AND provider_refund_id IS NULL
        AND terminal_status = 'paid'
        AND refund_state = 'none'
        AND credit_delta_usdc > 0
        AND parent_receipt_id IS NULL
      )
      OR
      (
        kind = 'refund'
        AND provider_checkout_session_id IS NULL
        AND provider_refund_id IS NOT NULL
        AND terminal_status = 'succeeded'
        AND refund_state IN ('partial', 'full')
        AND credit_delta_usdc < 0
        AND parent_receipt_id IS NOT NULL
      )
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_revenue_payment_session
    ON stripe_revenue_receipts(provider_checkout_session_id)
    WHERE kind = 'payment';
  CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_revenue_payment_intent
    ON stripe_revenue_receipts(provider_payment_intent_id)
    WHERE kind = 'payment';
  CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_revenue_refund
    ON stripe_revenue_receipts(provider_refund_id)
    WHERE kind = 'refund';
  CREATE INDEX IF NOT EXISTS idx_stripe_revenue_payment_intent
    ON stripe_revenue_receipts(provider_payment_intent_id, kind, occurred_at, id);
  CREATE TRIGGER IF NOT EXISTS stripe_revenue_receipts_no_update
    BEFORE UPDATE ON stripe_revenue_receipts
    BEGIN SELECT RAISE(ABORT, 'Stripe revenue receipts are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS stripe_revenue_receipts_no_delete
    BEFORE DELETE ON stripe_revenue_receipts
    BEGIN SELECT RAISE(ABORT, 'Stripe revenue receipts are append-only'); END;
`;

const STRIPE_OWNER_ADOPTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS stripe_owner_adoptions (
    from_owner_id TEXT PRIMARY KEY
      CHECK (length(CAST(from_owner_id AS BLOB)) BETWEEN 1 AND 512),
    to_owner_id TEXT NOT NULL
      CHECK (length(CAST(to_owner_id AS BLOB)) BETWEEN 1 AND 512),
    adopted_at TEXT NOT NULL
      CHECK (length(adopted_at) = 24 AND adopted_at LIKE '%Z'),
    CHECK (from_owner_id <> to_owner_id)
  );
  CREATE TRIGGER IF NOT EXISTS stripe_owner_adoptions_no_update
    BEFORE UPDATE ON stripe_owner_adoptions
    BEGIN SELECT RAISE(ABORT, 'Stripe owner adoptions are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS stripe_owner_adoptions_no_delete
    BEFORE DELETE ON stripe_owner_adoptions
    BEGIN SELECT RAISE(ABORT, 'Stripe owner adoptions are append-only'); END;
  CREATE INDEX IF NOT EXISTS idx_stripe_owner_adoptions_to
    ON stripe_owner_adoptions(to_owner_id);
`;

const PROSPECT_RECORDS_SQL = `
  CREATE TABLE IF NOT EXISTS prospect_records (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    stage TEXT NOT NULL,
    record_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_id, domain)
  );
  CREATE INDEX IF NOT EXISTS idx_prospect_records_owner_updated
    ON prospect_records(owner_id, updated_at DESC);
`;

const PROSPECT_SUPPRESSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS prospect_recipient_suppressions (
    owner_id TEXT NOT NULL,
    email_sha256 TEXT NOT NULL CHECK (length(email_sha256) = 67 AND email_sha256 LIKE 'v1:%'),
    reason TEXT NOT NULL CHECK (reason IN ('opt-out', 'operator')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, email_sha256)
  );
`;

const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "initial-core",
    signature: INITIAL_CORE_SQL,
    up(db): void {
      db.exec(INITIAL_CORE_SQL);
    },
  },
  {
    version: 2,
    name: "relay-usage-credits",
    signature: RELAY_USAGE_CREDITS_SQL,
    up(db): void {
      db.exec(RELAY_USAGE_CREDITS_SQL);
    },
  },
  {
    version: 3,
    name: "settlement-columns",
    signature: SETTLEMENT_COLUMNS.map((operation) => operation.sql).join("|"),
    up(db): void {
      for (const operation of SETTLEMENT_COLUMNS) {
        if (!hasColumn(db, operation.table, operation.column)) db.exec(operation.sql);
      }
    },
  },
  {
    version: 4,
    name: "webhook-endpoints",
    signature: WEBHOOK_ENDPOINTS_SQL,
    up(db): void {
      db.exec(WEBHOOK_ENDPOINTS_SQL);
    },
  },
  {
    version: 5,
    name: "projects-and-versions",
    signature: PROJECTS_AND_VERSIONS_SQL,
    up(db): void {
      db.exec(PROJECTS_AND_VERSIONS_SQL);
    },
  },
  {
    version: 6,
    name: "deployment-integrity",
    signature: DEPLOYMENT_INTEGRITY_SQL,
    up(db): void {
      db.exec(DEPLOYMENT_INTEGRITY_SQL);
    },
  },
  {
    version: 7,
    name: "workbook-flow-tabs",
    signature: WORKBOOK_FLOW_TABS_SIGNATURE,
    up(db): void {
      db.exec(WORKBOOK_FLOW_TABS_SQL);
      backfillWorkbookFlowTabs(db);
    },
  },
  {
    version: 8,
    name: "subflow-impact-receipts",
    signature: SUBFLOW_IMPACT_RECEIPTS_SQL,
    up(db): void {
      db.exec(SUBFLOW_IMPACT_RECEIPTS_SQL);
    },
  },
  {
    version: 9,
    name: "subflow-api-read-index",
    signature: SUBFLOW_API_READ_INDEX_SQL,
    up(db): void {
      db.exec(SUBFLOW_API_READ_INDEX_SQL);
    },
  },
  {
    version: 10,
    name: "durable-runtime",
    signature: DURABLE_RUNTIME_SQL,
    up(db): void {
      db.exec(DURABLE_RUNTIME_SQL);
    },
  },
  {
    version: 11,
    name: "durable-invocations",
    signature: DURABLE_INVOCATIONS_SQL,
    up(db): void {
      db.exec(DURABLE_INVOCATIONS_SQL);
    },
  },
  {
    version: 12,
    name: "durable-event-usage",
    signature: DURABLE_EVENT_USAGE_SQL,
    up(db): void { db.exec(DURABLE_EVENT_USAGE_SQL); },
  },
  {
    version: 13,
    name: "durable-parent-owner-integrity",
    signature: DURABLE_PARENT_OWNER_SQL,
    up(db): void {
      const invalid = db.prepare(
        `SELECT child.id FROM durable_executions child LEFT JOIN durable_executions parent ON parent.id = child.parent_execution_id
         WHERE child.parent_execution_id IS NOT NULL AND (parent.id IS NULL OR parent.owner_id <> child.owner_id) LIMIT 1`,
      ).get();
      if (invalid) throw new Error("Cannot migrate cross-owner durable parent lineage");
      db.exec(DURABLE_PARENT_OWNER_SQL);
    },
  },
  {
    version: 14,
    name: "logical-connections",
    signature: LOGICAL_CONNECTIONS_SQL,
    up(db): void {
      db.exec(LOGICAL_CONNECTIONS_SQL);
    },
  },
  {
    version: 15,
    name: "logical-connection-hardening",
    signature: `${LOGICAL_CONNECTION_HARDENING_SQL}\n${CONNECTION_PUBLIC_CONFIG_ROW_VALID_SQL}`,
    up(db): void {
      const invalidPublicConfig = db.prepare(
        `SELECT id FROM connections candidate
         WHERE COALESCE((${CONNECTION_PUBLIC_CONFIG_ROW_VALID_SQL}), 0) = 0
         LIMIT 1`,
      ).get();
      if (invalidPublicConfig) throw new Error("Cannot harden invalid connection public config");
      const invalidKeyVersion = db.prepare(
        `SELECT connection_id FROM connection_slots
         WHERE status = 'configured' AND COALESCE(key_version = 1, 0) = 0
         LIMIT 1`,
      ).get();
      if (invalidKeyVersion) throw new Error("Cannot harden invalid connection slot key version");
      db.exec(LOGICAL_CONNECTION_HARDENING_SQL);
    },
  },
  {
    version: 16,
    name: "logical-connection-replacement-guards",
    signature: LOGICAL_CONNECTION_REPLACEMENT_GUARDS_SQL,
    up(db): void {
      db.exec(LOGICAL_CONNECTION_REPLACEMENT_GUARDS_SQL);
    },
  },
  {
    version: 17,
    name: "control-audit-events",
    signature: CONTROL_AUDIT_EVENTS_SQL,
    up(db): void {
      db.exec(CONTROL_AUDIT_EVENTS_SQL);
    },
  },
  {
    version: 18,
    name: "immutable-connector-assets",
    signature: IMMUTABLE_CONNECTOR_ASSETS_SQL,
    up(db): void {
      db.exec(IMMUTABLE_CONNECTOR_ASSETS_SQL);
    },
  },
  {
    version: 19,
    name: "connector-portability-lookup",
    signature: CONNECTOR_PORTABILITY_LOOKUP_SQL,
    up(db): void {
      db.exec(CONNECTOR_PORTABILITY_LOOKUP_SQL);
    },
  },
  {
    version: 20,
    name: "connector-operation-list-lookup",
    signature: CONNECTOR_OPERATION_LIST_LOOKUP_SQL,
    up(db): void {
      db.exec(CONNECTOR_OPERATION_LIST_LOOKUP_SQL);
    },
  },
  {
    version: 21,
    name: "settlements-ledger",
    signature: SETTLEMENTS_LEDGER_SQL,
    up(db): void {
      db.exec(SETTLEMENTS_LEDGER_SQL);
    },
  },
  {
    version: 22,
    name: "companies-core",
    signature: COMPANIES_SQL,
    up(db): void {
      db.exec(COMPANIES_SQL);
    },
  },
  {
    version: 23,
    name: "company-employee-history",
    signature: COMPANY_EMPLOYEE_HISTORY_SQL,
    up(db): void {
      applyCompanyEmployeeHistoryMigration(db);
    },
  },
  {
    version: 24,
    name: "company-approval-snapshot",
    signature: COMPANY_APPROVAL_SNAPSHOT_SQL,
    up(db): void {
      applyCompanyApprovalSnapshotMigration(db);
    },
  },
  {
    version: 25,
    name: "company-activity-indexes",
    signature: COMPANY_ACTIVITY_INDEXES_SQL,
    up(db): void {
      db.exec(COMPANY_ACTIVITY_INDEXES_SQL);
      assertCompanyActivityIndexIntegrity(db);
    },
  },
  {
    version: 26,
    name: "moderation-reports",
    signature: MODERATION_REPORTS_SQL,
    up(db): void {
      db.exec(MODERATION_REPORTS_SQL);
      assertIndexColumns(
        db,
        "moderation_reports",
        "idx_moderation_reports_queue",
        ["status", "created_at", "id"],
      );
      assertIndexColumns(
        db,
        "moderation_reports",
        "idx_moderation_reports_reporter",
        ["reporter_owner_id", "created_at", "id"],
      );
    },
  },
  {
    version: 27,
    name: "run-trigger-input",
    signature: RUN_TRIGGER_INPUT_COLUMNS.map((operation) => operation.sql).join("|"),
    up(db): void {
      for (const operation of RUN_TRIGGER_INPUT_COLUMNS) {
        if (!hasColumn(db, operation.table, operation.column)) db.exec(operation.sql);
      }
    },
  },
  {
    version: 28,
    name: "logical-connection-crypto-owner",
    signature: LOGICAL_CONNECTION_CRYPTO_OWNER_SIGNATURE,
    up(db): void {
      if (!hasColumn(db, "connections", "crypto_owner_id")) {
        db.exec(LOGICAL_CONNECTION_CRYPTO_OWNER_COLUMN_SQL);
      }
      // Backfill must not manufacture a lifecycle revision. The migration
      // transaction restores this exact historical trigger before commit.
      db.exec("DROP TRIGGER connections_revision_update");
      db.prepare("UPDATE connections SET crypto_owner_id = owner_id WHERE crypto_owner_id = ''").run();
      db.exec(LOGICAL_CONNECTION_REVISION_TRIGGER_RESTORE_SQL);
      db.exec(LOGICAL_CONNECTION_CRYPTO_OWNER_GUARDS_SQL);
    },
  },
  {
    version: 29,
    name: "agent-listings",
    signature: AGENT_LISTINGS_SQL,
    up(db): void {
      db.exec(AGENT_LISTINGS_SQL);
    },
  },
  {
    version: 30,
    name: "health-checks",
    signature: HEALTH_CHECKS_SQL,
    up(db): void {
      db.exec(HEALTH_CHECKS_SQL);
    },
  },
  {
    version: 31,
    name: "company-ceo-messages",
    signature: COMPANY_CEO_MESSAGES_SQL,
    up(db): void {
      db.exec(COMPANY_CEO_MESSAGES_SQL);
    },
  },
  {
    version: 32,
    name: "company-employee-payto",
    signature: COMPANY_EMPLOYEE_PAYTO_SQL,
    up(db): void {
      applyCompanyEmployeePayToMigration(db);
    },
  },
  {
    version: 33,
    name: "site-verifications",
    signature: SITE_VERIFICATIONS_SQL,
    up(db): void {
      db.exec(SITE_VERIFICATIONS_SQL);
    },
  },
  {
    version: 34,
    name: "stripe-revenue-receipts",
    signature: STRIPE_REVENUE_RECEIPTS_SQL,
    up(db): void {
      db.exec(STRIPE_REVENUE_RECEIPTS_SQL);
    },
  },
  {
    version: 35,
    name: "stripe-owner-adoptions",
    signature: STRIPE_OWNER_ADOPTIONS_SQL,
    up(db): void {
      db.exec(STRIPE_OWNER_ADOPTIONS_SQL);
      assertIndexColumns(
        db,
        "stripe_owner_adoptions",
        "idx_stripe_owner_adoptions_to",
        ["to_owner_id"],
      );
    },
  },
  {
    version: 36,
    name: "company-org-roles",
    signature: COMPANY_ORG_ROLES_SQL,
    up(db): void {
      applyCompanyOrgRolesMigration(db);
    },
  },
  {
    version: 37,
    name: "company-employee-instructions",
    signature: COMPANY_EMPLOYEE_INSTRUCTIONS_SQL,
    up(db): void {
      db.exec(COMPANY_EMPLOYEE_INSTRUCTIONS_SQL);
    },
  },
  {
    version: 38,
    name: "prospect-records",
    signature: PROSPECT_RECORDS_SQL,
    up(db): void {
      db.exec(PROSPECT_RECORDS_SQL);
      assertIndexColumns(
        db,
        "prospect_records",
        "idx_prospect_records_owner_updated",
        ["owner_id", "updated_at"],
      );
    },
  },
  {
    version: 39,
    name: "prospect-recipient-suppressions",
    signature: PROSPECT_SUPPRESSIONS_SQL,
    up(db): void {
      db.exec(PROSPECT_SUPPRESSIONS_SQL);
    },
  },
  {
    version: 40,
    name: "ap2-authorizations",
    signature: AP2_AUTHORIZATIONS_V40_SQL,
    up(db): void {
      db.exec(AP2_AUTHORIZATIONS_V40_SQL);
      assertAp2AuthorizationAtLeastV40Integrity(db);
    },
  },
  {
    version: 41,
    name: "relay-protocol-v2",
    signature: RELAY_PROTOCOL_V2_SQL,
    up(db): void {
      applyRelayProtocolV2Migration(db);
    },
  },
  {
    version: 42,
    name: "ap2-replay-hardening",
    signature: AP2_AUTHORIZATIONS_V42_SQL,
    up(db): void | "ap2-v40-quarantined" {
      return applyAp2ReplayHardeningMigration(db);
    },
  },
  {
    version: 43,
    name: "agent-resource-foundry",
    signature: AGENT_RESOURCE_FOUNDRY_SQL,
    up(db): void {
      const existing = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_products'",
      ).get();
      if (existing) assertResourceFoundryIntegrity(db);
      db.exec(AGENT_RESOURCE_FOUNDRY_SQL);
      assertResourceFoundryIntegrity(db);
    },
  },
  {
    version: 44,
    name: "resource-release-publication-contract",
    signature: RESOURCE_RELEASE_PUBLICATION_SQL,
    up(db): void {
      if (!hasColumn(db, "resource_releases", "publication_key")) {
        db.exec(RESOURCE_RELEASE_PUBLICATION_SQL);
      }
      assertResourceReleasePublicationIntegrity(db);
    },
  },
  {
    version: 45,
    name: "resource-run-receipt-payment-facts",
    signature: RESOURCE_RUN_RECEIPT_PAYMENT_FACTS_SQL,
    up(db): void {
      const invalid = db.prepare(`SELECT COUNT(*) count FROM resource_run_receipts receipt
        LEFT JOIN resource_releases release ON release.owner_id=receipt.owner_id
          AND release.resource_product_id=receipt.resource_product_id
          AND release.pack_version_id=receipt.pack_version_id
          AND release.flow_version_id=receipt.flow_version_id
          AND release.deployment_id=receipt.deployment_id
        LEFT JOIN settlements settlement ON settlement.run_id=receipt.run_id
          AND settlement.owner_id=receipt.owner_id AND settlement.agent_id=release.agent_id
          AND settlement.gross_usdc=release.price_usdc
        WHERE release.id IS NULL OR (release.price_usdc>0 AND settlement.run_id IS NULL)`).get() as { count: number };
      if (invalid.count !== 0) throw new Error("Cannot bind legacy resource run receipt to exact release and payment facts");
      db.exec(RESOURCE_RUN_RECEIPT_PAYMENT_FACTS_SQL);
      assertResourceRunReceiptPaymentFactsIntegrity(db);
    },
  },
] as const;

function migrationChecksum(migration: SqliteMigration): string {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}:${migration.signature}`, "utf8")
    .digest("hex");
}

/** Exact schema-revision and live constraint proof used by AP2 readiness. */
export function isAp2ReplayStoreAttested(db: Database.Database): boolean {
  const migration = MIGRATIONS[41];
  const row = db.prepare(
    "SELECT name, checksum FROM schema_migrations WHERE version = 42",
  ).get() as { name: string; checksum: string | null } | undefined;
  if (
    !migration
    || row?.name !== migration.name
    || row.checksum !== migrationChecksum(migration)
  ) return false;
  try {
    assertAp2AuthorizationV42Integrity(db);
    return true;
  } catch {
    return false;
  }
}

function validateMigrationDefinitions(): void {
  const names = new Set<string>();
  for (const [index, migration] of MIGRATIONS.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `SQLite migrations must be contiguous and ascending: expected ${expectedVersion}, received ${migration.version}`,
      );
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate SQLite migration name: ${migration.name}`);
    }
    names.add(migration.name);
  }
}

/**
 * Idempotent, and safe to run against a file another process is migrating at
 * the same moment — `next build` prerenders pages in parallel worker processes
 * and each one opens this database. Every write below sits inside an IMMEDIATE
 * transaction that re-reads the ledger while holding the write lock, so a
 * process that loses the race applies nothing rather than replaying a version
 * and colliding on schema_migrations.version. Per-version transactions are
 * deliberate: a failure still leaves the applied prefix committed.
 *
 * Losing the race has to mean waiting long enough, which is what the busy
 * timeout below is for. An IMMEDIATE transaction asks for the write lock up
 * front and waits only as long as the connection's busy timeout allows, so
 * serialising alone leaves a waiter dying with SQLITE_BUSY ("database is
 * locked") whenever the winner's cold migration outlasts that budget. Every
 * caller here budgets 5s — SqliteProjectRepo and SqliteDurableRuntimeRepository
 * set `busy_timeout = 5000` explicitly, and SqliteRepo inherits the same 5000
 * from better-sqlite3's default `timeout` option — which is not reliably longer
 * than a full cold migration of every version below on a machine busy running
 * `next build`. The timeout is raised for the duration so the wait is bounded by
 * the work, not by a budget chosen for ordinary runtime queries.
 */
export function runSqliteMigrations(db: Database.Database): void {
  validateMigrationDefinitions();
  enableForeignKeys(db);
  withMigrationLockTimeout(db, () => applyMigrations(db));
}

/*
 * Long enough to outlast another process's full cold migration, because that is
 * exactly what a waiter waits for. Applied only while migrating and then put
 * back, so a caller's own runtime timeout — every repository budgets 5s, whether
 * explicitly or by better-sqlite3's default — is not silently widened for the
 * life of the connection. A caller that opted out of waiting entirely
 * (`timeout: 0`) is also raised, deliberately: migrating cannot mean refusing to
 * wait for the process already doing it. That opt-out is restored too.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;

function withMigrationLockTimeout<T>(db: Database.Database, run: () => T): T {
  const previous = db.pragma("busy_timeout", { simple: true });
  // A pragma read that is not a number means this connection cannot be reasoned
  // about, so leave its timeout alone rather than widening it with no way to put
  // it back — the caller's budget is not ours to keep.
  if (typeof previous !== "number") return run();
  if (previous >= MIGRATION_LOCK_TIMEOUT_MS) return run();
  db.pragma(`busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  try {
    return run();
  } finally {
    db.pragma(`busy_timeout = ${previous}`);
  }
}

function applyMigrations(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT,
        applied_at INTEGER NOT NULL
      );
    `);
    if (!hasColumn(db, "schema_migrations", "checksum")) {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    }
  }).immediate();

  const applied = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string | null }>;
  if (applied.length > MIGRATIONS.length) {
    throw new Error("SQLite schema is newer than this application");
  }
  const backfillChecksum = db.prepare(
    "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL",
  );
  const checksumBackfills: Array<{ version: number; checksum: string }> = [];
  for (const [index, row] of applied.entries()) {
    const expected = MIGRATIONS[index];
    if (row.version !== expected.version) {
      throw new Error("SQLite migration ledger is not a strict applied prefix");
    }
    if (row.name !== expected.name) {
      throw new Error(
        `SQLite migration ${row.version} name mismatch: expected ${expected.name}, received ${row.name}`,
      );
    }
    const checksum = migrationChecksum(expected);
    if (row.checksum === null) checksumBackfills.push({ version: row.version, checksum });
    else if (row.checksum !== checksum) {
      throw new Error(`SQLite migration ${row.version} checksum mismatch`);
    }
  }
  if (applied.some((row) => row.version === 6)) {
    assertDeploymentIntegrityIndexes(db);
  }
  if (applied.some((row) => row.version === 7)) {
    assertWorkbookFlowTabIntegrity(db);
  }
  if (applied.some((row) => row.version === 8)) {
    assertSubflowImpactReceiptIntegrity(db);
  }
  if (applied.some((row) => row.version === 9)) {
    assertSubflowApiReadIndex(db);
  }
  if (applied.some((row) => row.version === 10)) {
    assertDurableRuntimeIntegrity(db);
  }
  if (applied.some((row) => row.version === 11)) {
    assertDurableInvocationIntegrity(db);
  }
  if (applied.some((row) => row.version === 12)) assertDurableEventUsageIntegrity(db);
  if (applied.some((row) => row.version === 13)) assertDurableParentOwnerIntegrity(db);
  const cryptoOwnerColumnExists = hasColumn(db, "connections", "crypto_owner_id");
  if (applied.some((row) => row.version === 28)) assertLogicalConnectionIntegrity(db, 28);
  else if (applied.some((row) => row.version === 16)) {
    assertLogicalConnectionIntegrity(db, 16, cryptoOwnerColumnExists);
  } else if (applied.some((row) => row.version === 15)) {
    assertLogicalConnectionIntegrity(db, 15, cryptoOwnerColumnExists);
  } else if (applied.some((row) => row.version === 14)) {
    assertLogicalConnectionIntegrity(db, 14, cryptoOwnerColumnExists);
  }
  if (applied.some((row) => row.version === 17)) assertControlAuditIntegrity(db);
  if (applied.some((row) => row.version === 18)) assertImmutableConnectorAssetIntegrity(db);
  if (applied.some((row) => row.version === 19)) assertConnectorPortabilityLookupIntegrity(db);
  if (applied.some((row) => row.version === 20)) assertConnectorOperationListIntegrity(db);
  if (applied.some((row) => row.version === 23)) assertCompanyEmployeeHistoryIntegrity(db);
  if (applied.some((row) => row.version === 24)) assertCompanyApprovalSnapshotIntegrity(db);
  if (applied.some((row) => row.version === 25)) assertCompanyActivityIndexIntegrity(db);
  if (applied.some((row) => row.version === 38)) {
    assertIndexColumns(db, "prospect_records", "idx_prospect_records_owner_updated", ["owner_id", "updated_at"]);
  }
  if (applied.some((row) => row.version === 42)) assertAp2AuthorizationV42Integrity(db);
  else if (applied.some((row) => row.version === 40)) {
    assertAp2AuthorizationAtLeastV40Integrity(db);
  }
  if (applied.some((row) => row.version === 43)) assertResourceFoundryIntegrity(db);
  if (applied.some((row) => row.version === 44)) assertResourceReleasePublicationIntegrity(db);
  if (applied.some((row) => row.version === 45)) assertResourceRunReceiptPaymentFactsIntegrity(db);
  if (checksumBackfills.length > 0) {
    db.transaction(() => {
      for (const backfill of checksumBackfills) {
        backfillChecksum.run(backfill.checksum, backfill.version);
      }
    }).immediate();
  }
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  const ledgerRecords = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");

  let ap2V40Quarantined = false;
  for (const migration of MIGRATIONS.slice(applied.length)) {
    const outcome = db.transaction(() => {
      // `applied` was read without the write lock, so a parallel process may
      // have committed this version since. This is the authoritative check.
      if (ledgerRecords.get(migration.version) !== undefined) return;
      const migrationOutcome = migration.up(db);
      if (migrationOutcome === "ap2-v40-quarantined") return migrationOutcome;
      assertForeignKeyIntegrity(db);
      if (migration.version === 6) assertDeploymentIntegrityIndexes(db);
      if (migration.version === 7) assertWorkbookFlowTabIntegrity(db);
      if (migration.version === 8) assertSubflowImpactReceiptIntegrity(db);
      if (migration.version === 9) assertSubflowApiReadIndex(db);
      if (migration.version === 10) assertDurableRuntimeIntegrity(db);
      if (migration.version === 11) assertDurableInvocationIntegrity(db);
      if (migration.version === 12) assertDurableEventUsageIntegrity(db);
      if (migration.version === 13) assertDurableParentOwnerIntegrity(db);
      if (migration.version === 14) {
        assertLogicalConnectionIntegrity(db, 14, hasColumn(db, "connections", "crypto_owner_id"));
      }
      if (migration.version === 15) {
        assertLogicalConnectionIntegrity(db, 15, hasColumn(db, "connections", "crypto_owner_id"));
      }
      if (migration.version === 16) {
        assertLogicalConnectionIntegrity(db, 16, hasColumn(db, "connections", "crypto_owner_id"));
      }
      if (migration.version === 28) assertLogicalConnectionIntegrity(db, 28);
      if (migration.version === 17) assertControlAuditIntegrity(db);
      if (migration.version === 18) assertImmutableConnectorAssetIntegrity(db);
      if (migration.version === 19) assertConnectorPortabilityLookupIntegrity(db);
      if (migration.version === 20) assertConnectorOperationListIntegrity(db);
      if (migration.version === 23) assertCompanyEmployeeHistoryIntegrity(db);
      if (migration.version === 24) assertCompanyApprovalSnapshotIntegrity(db);
      if (migration.version === 25) assertCompanyActivityIndexIntegrity(db);
      if (migration.version === 38) {
        assertIndexColumns(db, "prospect_records", "idx_prospect_records_owner_updated", ["owner_id", "updated_at"]);
      }
      if (migration.version === 40) assertAp2AuthorizationAtLeastV40Integrity(db);
      if (migration.version === 42) assertAp2AuthorizationV42Integrity(db);
      if (migration.version === 43) assertResourceFoundryIntegrity(db);
      if (migration.version === 44) assertResourceReleasePublicationIntegrity(db);
      if (migration.version === 45) assertResourceRunReceiptPaymentFactsIntegrity(db);
      insert.run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        Date.now(),
      );
    }).immediate();
    if (outcome === "ap2-v40-quarantined") {
      ap2V40Quarantined = true;
      break;
    }
  }
  assertForeignKeyIntegrity(db);
  assertDeploymentIntegrityIndexes(db);
  assertWorkbookFlowTabIntegrity(db);
  assertSubflowImpactReceiptIntegrity(db);
  assertSubflowApiReadIndex(db);
  assertDurableRuntimeIntegrity(db);
  assertDurableInvocationIntegrity(db);
  assertDurableEventUsageIntegrity(db);
  assertDurableParentOwnerIntegrity(db);
  assertLogicalConnectionIntegrity(db, 28);
  assertControlAuditIntegrity(db);
  assertImmutableConnectorAssetIntegrity(db);
  assertConnectorPortabilityLookupIntegrity(db);
  assertConnectorOperationListIntegrity(db);
  assertCompanyEmployeeHistoryIntegrity(db);
  assertCompanyApprovalSnapshotIntegrity(db);
  assertCompanyActivityIndexIntegrity(db);
  const resourceSuffixPresent = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_products'",
  ).get() !== undefined;
  if (!ap2V40Quarantined || resourceSuffixPresent) {
    assertResourceFoundryIntegrity(db);
    assertResourceReleasePublicationIntegrity(db);
    assertResourceRunReceiptPaymentFactsIntegrity(db);
  }
  if (ap2V40Quarantined) assertAp2AuthorizationV40Integrity(db);
  else assertAp2AuthorizationV42Integrity(db);
}
