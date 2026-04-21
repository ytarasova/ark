/**
 * Postgres-specific schema initialization.
 *
 * The main schema.ts uses SQLite-specific features (AUTOINCREMENT, FTS5,
 * INSERT OR IGNORE). This module provides Postgres-compatible DDL that
 * creates the same logical schema using Postgres idioms.
 *
 * Called from app.ts when a Postgres database URL is configured.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function initPostgresSchema(db: IDatabase): Promise<void> {
  // Sessions table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      ticket TEXT,
      summary TEXT,
      repo TEXT,
      branch TEXT,
      compute_name TEXT,
      session_id TEXT,
      claude_session_id TEXT,
      stage TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      flow TEXT NOT NULL DEFAULT 'default',
      agent TEXT,
      workdir TEXT,
      pr_url TEXT,
      pr_id TEXT,
      error TEXT,
      parent_id TEXT,
      fork_group TEXT,
      group_name TEXT,
      breakpoint_reason TEXT,
      attached_by TEXT,
      rejection_count INTEGER NOT NULL DEFAULT 0,
      rework_prompt TEXT,
      rejected_at TEXT,
      rejected_reason TEXT,
      config TEXT DEFAULT '{}',
      user_id TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      workspace_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id)`);

  // Events table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      track_id TEXT NOT NULL,
      type TEXT NOT NULL,
      stage TEXT,
      actor TEXT,
      data TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL
    )
  `);

  // Indexes
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_events_track ON events(track_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_name)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_pr_url ON sessions(pr_url)`);

  // Compute table. Includes compute_kind + runtime_kind columns.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS compute (
      name TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'local',
      compute_kind TEXT NOT NULL DEFAULT 'local',
      runtime_kind TEXT NOT NULL DEFAULT 'direct',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_compute_provider ON compute(provider)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_compute_kind ON compute(compute_kind)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_compute_runtime_kind ON compute(runtime_kind)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_compute_status ON compute(status)`);

  // Compute templates table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS compute_templates (
      name TEXT NOT NULL,
      description TEXT,
      provider TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, tenant_id)
    )
  `);

  // Messages table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      read INTEGER NOT NULL DEFAULT 0,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);

  // Groups table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      PRIMARY KEY (name, tenant_id)
    )
  `);

  // Claude sessions cache
  await db.exec(`
    CREATE TABLE IF NOT EXISTS claude_sessions_cache (
      session_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      summary TEXT DEFAULT '',
      message_count INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT '',
      last_activity TEXT DEFAULT '',
      cached_at TEXT NOT NULL
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_claude_cache_activity ON claude_sessions_cache(last_activity DESC)`);

  // Full-text search -- Postgres uses tsvector/GIN instead of FTS5.
  // Create a GIN index for full-text search on the transcript content.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_index (
      session_id TEXT,
      project TEXT,
      role TEXT,
      content TEXT,
      timestamp TEXT,
      tsv TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(content, '') || ' ' || coalesce(project, ''))
      ) STORED
    )
  `);

  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_transcript_tsv ON transcript_index USING GIN(tsv)`);

  // Todos table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id)`);

  // Schedules table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      flow TEXT NOT NULL DEFAULT 'bare',
      repo TEXT,
      workdir TEXT,
      summary TEXT,
      compute_name TEXT,
      group_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // API keys table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`);

  // Resource definitions table (DB-backed stores for control plane)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS resource_definitions (
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, kind, tenant_id)
    )
  `);

  // Tenant indexes
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_compute_tenant ON compute(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_todos_tenant ON todos(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_compute_pools_tenant ON compute_pools(tenant_id)`);

  // Usage records table (cost tracking)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'system',
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      runtime TEXT,
      agent_role TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      cost_mode TEXT NOT NULL DEFAULT 'api',
      source TEXT NOT NULL DEFAULT 'transcript',
      created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
    )
  `);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage_records(tenant_id)`);
  await safeDdl(db, `CREATE INDEX IF NOT EXISTS idx_usage_cost_mode ON usage_records(cost_mode)`);

  // Compute pools table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS compute_pools (
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      min_instances INTEGER NOT NULL DEFAULT 0,
      max_instances INTEGER NOT NULL DEFAULT 10,
      config TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, tenant_id)
    )
  `);

  // Instance lock table (used by instance-lock.ts)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS instance_heartbeat (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL
    )
  `);
}

export async function seedLocalComputePostgres(db: IDatabase): Promise<void> {
  const ts = new Date().toISOString();
  await db
    .prepare(
      `
    INSERT INTO compute (name, provider, compute_kind, runtime_kind, status, config, created_at, updated_at)
    VALUES ($1, 'local', 'local', 'direct', 'running', '{}', $2, $3)
    ON CONFLICT (name) DO NOTHING
  `,
    )
    .run("local", ts, ts);
}

/** Run a DDL statement, ignoring errors (for idempotent migrations). */
async function safeDdl(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "Already exists or other benign error");
  }
}
