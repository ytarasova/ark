-- Bootstrap DDL for the dev-stack smoke test.
--
-- WORKAROUND (not a fix). The real fix updates
-- packages/core/repositories/schema-postgres.ts so the legacy
-- initPostgresSchema bootstrap creates these objects on a fresh DB.
-- Tracked by:
--   * spec docs/superpowers/specs/2026-05-06-control-plane-laptop-smoke-test-design.md
--     sections 5.1 (knowledge tables) and 5.2 (pty cols)
--
-- Idempotent. Safe to re-run after `docker compose down -v`.

-- -- 5.1: knowledge graph tables (referenced by migration 013) --------------
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  content TEXT,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (now()::text),
  updated_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_knowledge_label ON knowledge(tenant_id, label);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (now()::text),
  PRIMARY KEY (source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(tenant_id, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(tenant_id, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON knowledge_edges(relation);

-- -- 5.2: sessions.pty_cols / pty_rows (declared by drizzle, omitted by init) -
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pty_cols INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pty_rows INTEGER;
