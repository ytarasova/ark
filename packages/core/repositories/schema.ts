import type { IDatabase } from "../database.js";

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
  `);
}

export function seedLocalCompute(db: IDatabase): void {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO compute (name, provider, status, config, created_at, updated_at)
    VALUES ('local', 'local', 'running', '{}', ?, ?)
  `).run(ts, ts);
}
