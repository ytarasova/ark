import type { IDatabase } from "../database/index.js";
import { initPoolSchema } from "../compute/pool.js";

export function initSchema(db: IDatabase): void {
  db.exec(`
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
      config TEXT DEFAULT '{}',
      user_id TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
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

    CREATE TABLE IF NOT EXISTS compute (
      name TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_compute_provider ON compute(provider);
    CREATE INDEX IF NOT EXISTS idx_compute_status ON compute(status);
    CREATE INDEX IF NOT EXISTS idx_compute_tenant ON compute(tenant_id);

    CREATE TABLE IF NOT EXISTS compute_templates (
      name TEXT NOT NULL,
      description TEXT,
      provider TEXT NOT NULL,
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
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS resource_definitions (
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, kind, tenant_id)
    );
  `);

  // Compute pools table (defined in its own module so the pool manager can
  // re-run it when booted directly in tests).
  initPoolSchema(db);
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_compute_pools_tenant ON compute_pools(tenant_id)");

  // Knowledge graph tables
  initKnowledgeSchema(db);

  // Usage records table (universal cost tracking)
  initUsageSchema(db);

  // Session artifacts table (queryable artifact tracking)
  initArtifactSchema(db);
}

export function initKnowledgeSchema(db: IDatabase): void {
  safeExec(
    db,
    `
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      content TEXT,
      metadata TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  );
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(tenant_id, type)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_knowledge_label ON knowledge(tenant_id, label)");

  safeExec(
    db,
    `
    CREATE TABLE IF NOT EXISTS knowledge_edges (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_id, target_id, relation)
    )
  `,
  );
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(tenant_id, source_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(tenant_id, target_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_edges_relation ON knowledge_edges(relation)");
}

export function initUsageSchema(db: IDatabase): void {
  safeExec(
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
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_cost_mode ON usage_records(cost_mode)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage_records(tenant_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_records(user_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at)");
}

export function initArtifactSchema(db: IDatabase): void {
  safeExec(
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
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_artifacts_session ON session_artifacts(session_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_artifacts_type_value ON session_artifacts(type, value)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_artifacts_tenant ON session_artifacts(tenant_id)");
}

/** Execute a SQL statement, swallowing errors (for best-effort idempotent init). */
function safeExec(db: IDatabase, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Already exists or other benign error
  }
}

export function seedLocalCompute(db: IDatabase): void {
  const ts = new Date().toISOString();
  db.prepare(
    `
    INSERT OR IGNORE INTO compute (name, provider, status, config, created_at, updated_at)
    VALUES ('local', 'local', 'running', '{}', ?, ?)
  `,
  ).run(ts, ts);
}
