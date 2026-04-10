import type { IDatabase } from "../database.js";
import { initPoolSchema } from "../compute-pool.js";

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
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_pr_url ON sessions(pr_url);

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

    CREATE TABLE IF NOT EXISTS groups (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
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
      created_at TEXT NOT NULL
    );

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
  `);

  // Migration: add tenant_id column to existing tables that lack it.
  // ALTER TABLE ADD COLUMN is safe to run -- SQLite errors if column exists,
  // so we catch and ignore.
  migrateAddColumn(db, "sessions", "tenant_id", "TEXT NOT NULL DEFAULT 'default'");
  migrateAddColumn(db, "events", "tenant_id", "TEXT NOT NULL DEFAULT 'default'");
  migrateAddColumn(db, "compute", "tenant_id", "TEXT NOT NULL DEFAULT 'default'");
  migrateAddColumn(db, "messages", "tenant_id", "TEXT NOT NULL DEFAULT 'default'");
  migrateAddColumn(db, "todos", "tenant_id", "TEXT NOT NULL DEFAULT 'default'");

  // Tenant indexes
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_compute_tenant ON compute(tenant_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_todos_tenant ON todos(tenant_id)");

  // Ensure api_keys table exists for existing DBs (CREATE TABLE IF NOT EXISTS handles it)
  safeExec(db, `
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
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)");

  // Compute pools table
  initPoolSchema(db);

  // Knowledge graph tables
  initKnowledgeSchema(db);
}

export function initKnowledgeSchema(db: IDatabase): void {
  safeExec(db, `
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
  `);
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(tenant_id, type)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_knowledge_label ON knowledge(tenant_id, label)");

  safeExec(db, `
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
  `);
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(tenant_id, source_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(tenant_id, target_id)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_edges_relation ON knowledge_edges(relation)");
}

/** Add a column to a table if it doesn't already exist. Silently ignores duplicate column errors. */
function migrateAddColumn(db: IDatabase, table: string, column: string, definition: string): void {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch {
    // Column already exists -- expected for new databases or re-runs
  }
}

/** Execute a SQL statement, ignoring errors (for idempotent migrations). */
function safeExec(db: IDatabase, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Already exists or other benign error
  }
}

export function seedLocalCompute(db: IDatabase): void {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO compute (name, provider, status, config, created_at, updated_at)
    VALUES ('local', 'local', 'running', '{}', ?, ?)
  `).run(ts, ts);
}
