import type { DatabaseAdapter } from "../database/index.js";
import { initPoolSchema } from "../compute/pool.js";
import { logDebug } from "../observability/structured-log.js";

export async function initSchema(db: DatabaseAdapter): Promise<void> {
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
      pty_cols INTEGER,
      pty_rows INTEGER,
      config TEXT DEFAULT '{}',
      user_id TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      workspace_id TEXT,
      orchestrator TEXT NOT NULL DEFAULT 'custom',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      type TEXT NOT NULL,
      stage TEXT,
      actor TEXT,
      data TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_track ON events(track_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_pr_url ON sessions(pr_url);
    CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);

    CREATE TABLE IF NOT EXISTS compute (
      name TEXT PRIMARY KEY,
      compute_kind TEXT NOT NULL DEFAULT 'local',
      isolation_kind TEXT NOT NULL DEFAULT 'direct',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      is_template INTEGER NOT NULL DEFAULT 0,
      cloned_from TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_compute_kind ON compute(compute_kind);
    CREATE INDEX IF NOT EXISTS idx_compute_isolation_kind ON compute(isolation_kind);
    CREATE INDEX IF NOT EXISTS idx_compute_status ON compute(status);
    CREATE INDEX IF NOT EXISTS idx_compute_tenant ON compute(tenant_id);

    CREATE TABLE IF NOT EXISTS compute_templates (
      name TEXT NOT NULL,
      description TEXT,
      compute_kind TEXT NOT NULL DEFAULT 'local',
      isolation_kind TEXT NOT NULL DEFAULT 'direct',
      config TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, tenant_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      read INTEGER NOT NULL DEFAULT 0,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);

    CREATE TABLE IF NOT EXISTS groups (
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      PRIMARY KEY (name, tenant_id)
    );

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
    );

    CREATE INDEX IF NOT EXISTS idx_claude_cache_activity ON claude_sessions_cache(last_activity DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_index USING fts5(
      session_id UNINDEXED,
      project,
      role,
      content,
      timestamp UNINDEXED
    );

    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
    CREATE INDEX IF NOT EXISTS idx_todos_tenant ON todos(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenant_id);

    -- flow_state: DAG orchestration state (completed/skipped/current stage,
    -- per-stage results). One row per session. Replaces the pre-DB JSON files
    -- under {arkDir}/flow-state/<sessionId>.json; see repositories/flow-state.ts.
    CREATE TABLE IF NOT EXISTS flow_state (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      flow_name TEXT NOT NULL DEFAULT '',
      completed_stages TEXT NOT NULL DEFAULT '[]',
      skipped_stages TEXT NOT NULL DEFAULT '[]',
      current_stage TEXT,
      stage_results TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flow_state_tenant ON flow_state(tenant_id);

    -- ledger_entries: append-only conductor progress ledger (facts, hypotheses,
    -- plan steps, progress reports, stall markers). Replaces the pre-DB
    -- {arkDir}/conductor/<conductorId>/ledger.json; see repositories/ledger.ts.
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      conductor_id TEXT NOT NULL DEFAULT 'default',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_conductor ON ledger_entries(conductor_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_tenant ON ledger_entries(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_created ON ledger_entries(created_at);

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
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_live ON api_keys(key_hash) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS resource_definitions (
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, kind, tenant_id)
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug_live ON tenants(slug) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_live ON users(email) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tenant_slug_live ON teams(tenant_id, slug) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_team_live
      ON memberships(user_id, team_id) WHERE deleted_at IS NULL;
  `);

  // Compute pools table (defined in its own module so the pool manager can
  // re-run it when booted directly in tests).
  await initPoolSchema(db);
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_compute_pools_tenant ON compute_pools(tenant_id)");

  // Usage records table (universal cost tracking)
  await initUsageSchema(db);

  // Session artifacts table (queryable artifact tracking)
  await initArtifactSchema(db);

  // stage_operations table -- idempotency ledger for advance/complete/handoff/executeAction.
  await initStageOperationsSchema(db);

  // --- BEGIN agent-F: tenant_claude_auth ---
  // Tenant-level claude auth binding: exactly one of api_key / subscription_blob
  // per tenant. `secret_ref` is the name of the secret (or blob) in the
  // SecretsCapability backend; this table only stores the binding.
  await safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS tenant_claude_auth (
      tenant_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('api_key','subscription_blob')),
      secret_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  // --- END agent-F ---

  // --- BEGIN agent-G: tenant_policies.compute_config_yaml ---
  // Per-tenant YAML blob of cluster overrides. Parsed into ClusterConfig[]
  // at dispatch via `resolveEffectiveClusters`. The parent table is created
  // lazily by TenantPolicyManager; on a fresh install we ensure it here too
  // so the column is always present out of the box.
  await safeExec(
    db,
    `CREATE TABLE IF NOT EXISTS tenant_policies (
      tenant_id TEXT PRIMARY KEY,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      default_provider TEXT NOT NULL DEFAULT 'k8s',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 10,
      max_cost_per_day_usd REAL,
      compute_pools TEXT NOT NULL DEFAULT '[]',
      compute_config_yaml TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  // If the table already existed, add the column (migration 008 also covers
  // this path; this is defense in depth for installs that never go through
  // the runner).
  await safeExec(db, "ALTER TABLE tenant_policies ADD COLUMN compute_config_yaml TEXT");
  // --- END agent-G ---
}

export async function initUsageSchema(db: DatabaseAdapter): Promise<void> {
  await safeExec(
    db,
    `
    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  );
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id)");
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_cost_mode ON usage_records(cost_mode)");
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage_records(tenant_id)");
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_records(user_id)");
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model)");
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at)");
}

export async function initArtifactSchema(db: DatabaseAdapter): Promise<void> {
  await safeExec(
    db,
    `
    CREATE TABLE IF NOT EXISTS session_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  );
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_artifacts_session ON session_artifacts(session_id)");
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_artifacts_type_value ON session_artifacts(type, value)");
  await safeExec(db, "CREATE INDEX IF NOT EXISTS idx_artifacts_tenant ON session_artifacts(tenant_id)");
}

/**
 * stage_operations -- idempotency key ledger for side-effectful orchestration
 * calls (advance, complete, handoff, executeAction). See migration 010 and
 * services/idempotency.ts. Defined here so fresh installs that run
 * `initSchema` get the table even before the migration runner executes.
 */
export async function initStageOperationsSchema(db: DatabaseAdapter): Promise<void> {
  await safeExec(
    db,
    `
    CREATE TABLE IF NOT EXISTS stage_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      op_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `,
  );
  await safeExec(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_operations_unique
       ON stage_operations(session_id, stage, op_kind, idempotency_key)`,
  );
  await safeExec(db, `CREATE INDEX IF NOT EXISTS idx_stage_operations_session ON stage_operations(session_id)`);
}

/** Run the SQL statement, swallowing errors (for best-effort idempotent init). */
async function safeExec(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "Already exists or other benign error");
  }
}

export async function seedLocalCompute(db: DatabaseAdapter): Promise<void> {
  const ts = new Date().toISOString();
  await db
    .prepare(
      `
    INSERT OR IGNORE INTO compute (name, compute_kind, isolation_kind, status, config, created_at, updated_at)
    VALUES ('local', 'local', 'direct', 'running', '{}', ?, ?)
  `,
    )
    .run(ts, ts);
}
