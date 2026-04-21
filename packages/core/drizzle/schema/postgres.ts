/**
 * Postgres drizzle schema -- single source of truth for the hosted dialect.
 *
 * Mirrors `schema/sqlite.ts` but uses Postgres-native column types:
 *   - `serial` for auto-increment ids (SQLite uses INTEGER PK AUTOINCREMENT)
 *   - `text` for dates/times (matches the current hand-rolled schema, which
 *     stores ISO-8601 strings everywhere so the SQLite/Postgres repository
 *     code paths stay identical)
 *   - `boolean` for `is_template` (SQLite represents as INTEGER 0/1)
 *   - `doublePrecision` for real numbers (SQLite: REAL)
 *
 * If/when we move timestamps to `timestamptz`, that is a schema migration
 * (generated via `drizzle-kit generate`) and requires a repo-level data
 * rewrite. Not attempted here -- see DRIZZLE_CUTOVER_STATUS.
 */

import {
  pgTable,
  text,
  integer,
  serial,
  boolean,
  doublePrecision,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── sessions ──────────────────────────────────────────────────────────────

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ticket: text("ticket"),
    summary: text("summary"),
    repo: text("repo"),
    branch: text("branch"),
    computeName: text("compute_name"),
    sessionId: text("session_id"),
    claudeSessionId: text("claude_session_id"),
    stage: text("stage"),
    status: text("status").notNull().default("pending"),
    flow: text("flow").notNull().default("default"),
    agent: text("agent"),
    workdir: text("workdir"),
    prUrl: text("pr_url"),
    prId: text("pr_id"),
    error: text("error"),
    parentId: text("parent_id"),
    forkGroup: text("fork_group"),
    groupName: text("group_name"),
    breakpointReason: text("breakpoint_reason"),
    attachedBy: text("attached_by"),
    rejectionCount: integer("rejection_count").notNull().default(0),
    reworkPrompt: text("rework_prompt"),
    rejectedAt: text("rejected_at"),
    rejectedReason: text("rejected_reason"),
    ptyCols: integer("pty_cols"),
    ptyRows: integer("pty_rows"),
    config: text("config").default("{}"),
    userId: text("user_id"),
    tenantId: text("tenant_id").notNull().default("default"),
    workspaceId: text("workspace_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    idxStatus: index("idx_sessions_status").on(t.status),
    idxRepo: index("idx_sessions_repo").on(t.repo),
    idxParent: index("idx_sessions_parent").on(t.parentId),
    idxGroup: index("idx_sessions_group").on(t.groupName),
    idxPrUrl: index("idx_sessions_pr_url").on(t.prUrl),
    idxTenant: index("idx_sessions_tenant").on(t.tenantId),
    idxUser: index("idx_sessions_user").on(t.userId),
    idxWorkspace: index("idx_sessions_workspace").on(t.workspaceId),
  }),
);

// ── events ────────────────────────────────────────────────────────────────

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    trackId: text("track_id").notNull(),
    type: text("type").notNull(),
    stage: text("stage"),
    actor: text("actor"),
    data: text("data"),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    idxTrack: index("idx_events_track").on(t.trackId),
    idxType: index("idx_events_type").on(t.type),
    idxTenant: index("idx_events_tenant").on(t.tenantId),
  }),
);

// ── compute ───────────────────────────────────────────────────────────────

export const compute = pgTable(
  "compute",
  {
    name: text("name").primaryKey(),
    provider: text("provider").notNull().default("local"),
    computeKind: text("compute_kind").notNull().default("local"),
    runtimeKind: text("runtime_kind").notNull().default("direct"),
    status: text("status").notNull().default("stopped"),
    config: text("config").default("{}"),
    isTemplate: boolean("is_template").notNull().default(false),
    clonedFrom: text("cloned_from"),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    idxProvider: index("idx_compute_provider").on(t.provider),
    idxKind: index("idx_compute_kind").on(t.computeKind),
    idxRuntimeKind: index("idx_compute_runtime_kind").on(t.runtimeKind),
    idxStatus: index("idx_compute_status").on(t.status),
    idxTenant: index("idx_compute_tenant").on(t.tenantId),
  }),
);

// ── compute_templates ─────────────────────────────────────────────────────

export const computeTemplates = pgTable(
  "compute_templates",
  {
    name: text("name").notNull(),
    description: text("description"),
    provider: text("provider").notNull(),
    config: text("config").default("{}"),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.name, t.tenantId] }),
  }),
);

// ── messages ──────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    type: text("type").notNull().default("text"),
    read: integer("read").notNull().default(0),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    idxSession: index("idx_messages_session").on(t.sessionId),
    idxTenant: index("idx_messages_tenant").on(t.tenantId),
  }),
);

// ── groups ────────────────────────────────────────────────────────────────

export const groups = pgTable(
  "groups",
  {
    name: text("name").notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.name, t.tenantId] }),
    idxTenant: index("idx_groups_tenant").on(t.tenantId),
  }),
);

// ── claude_sessions_cache ─────────────────────────────────────────────────

export const claudeSessionsCache = pgTable(
  "claude_sessions_cache",
  {
    sessionId: text("session_id").primaryKey(),
    project: text("project").notNull(),
    projectDir: text("project_dir").notNull(),
    transcriptPath: text("transcript_path").notNull(),
    summary: text("summary").default(""),
    messageCount: integer("message_count").default(0),
    timestamp: text("timestamp").default(""),
    lastActivity: text("last_activity").default(""),
    cachedAt: text("cached_at").notNull(),
  },
  (t) => ({
    idxActivity: index("idx_claude_cache_activity").on(t.lastActivity),
  }),
);

// ── todos ─────────────────────────────────────────────────────────────────

export const todos = pgTable(
  "todos",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    content: text("content").notNull(),
    done: integer("done").notNull().default(0),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    idxSession: index("idx_todos_session").on(t.sessionId),
    idxTenant: index("idx_todos_tenant").on(t.tenantId),
  }),
);

// ── schedules ─────────────────────────────────────────────────────────────

export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    cron: text("cron").notNull(),
    flow: text("flow").notNull().default("bare"),
    repo: text("repo"),
    workdir: text("workdir"),
    summary: text("summary"),
    computeName: text("compute_name"),
    groupName: text("group_name"),
    enabled: integer("enabled").notNull().default(1),
    lastRun: text("last_run"),
    tenantId: text("tenant_id").notNull().default("default"),
    userId: text("user_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    idxTenant: index("idx_schedules_tenant").on(t.tenantId),
  }),
);

// ── api_keys ──────────────────────────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    keyHash: text("key_hash").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default("member"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
  },
  (t) => ({
    idxTenant: index("idx_api_keys_tenant").on(t.tenantId),
    idxHash: index("idx_api_keys_hash").on(t.keyHash),
    idxHashLive: uniqueIndex("idx_api_keys_hash_live")
      .on(t.keyHash)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ── resource_definitions ──────────────────────────────────────────────────

export const resourceDefinitions = pgTable(
  "resource_definitions",
  {
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.name, t.kind, t.tenantId] }),
  }),
);

// ── tenants ───────────────────────────────────────────────────────────────

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    idxStatus: index("idx_tenants_status").on(t.status),
    idxSlugLive: uniqueIndex("idx_tenants_slug_live")
      .on(t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ── users ─────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    idxEmailLive: uniqueIndex("idx_users_email_live")
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ── teams ─────────────────────────────────────────────────────────────────

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    idxTenant: index("idx_teams_tenant").on(t.tenantId),
    idxTenantSlugLive: uniqueIndex("idx_teams_tenant_slug_live")
      .on(t.tenantId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ── memberships ───────────────────────────────────────────────────────────

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    idxUser: index("idx_memberships_user").on(t.userId),
    idxTeam: index("idx_memberships_team").on(t.teamId),
    idxUserTeamLive: uniqueIndex("idx_memberships_user_team_live")
      .on(t.userId, t.teamId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ── tenant_policies ───────────────────────────────────────────────────────

export const tenantPolicies = pgTable("tenant_policies", {
  tenantId: text("tenant_id").primaryKey(),
  allowedProviders: text("allowed_providers").notNull().default("[]"),
  defaultProvider: text("default_provider").notNull().default("k8s"),
  maxConcurrentSessions: integer("max_concurrent_sessions").notNull().default(10),
  maxCostPerDayUsd: doublePrecision("max_cost_per_day_usd"),
  computePools: text("compute_pools").notNull().default("[]"),
  computeConfigYaml: text("compute_config_yaml"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()::text`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()::text`),
});

// ── tenant_claude_auth ────────────────────────────────────────────────────

export const tenantClaudeAuth = pgTable("tenant_claude_auth", {
  tenantId: text("tenant_id").primaryKey(),
  kind: text("kind").notNull(),
  secretRef: text("secret_ref").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ── knowledge ─────────────────────────────────────────────────────────────

export const knowledge = pgTable(
  "knowledge",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    label: text("label").notNull(),
    content: text("content"),
    metadata: text("metadata").default("{}"),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()::text`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`now()::text`),
  },
  (t) => ({
    idxType: index("idx_knowledge_type").on(t.tenantId, t.type),
    idxLabel: index("idx_knowledge_label").on(t.tenantId, t.label),
  }),
);

export const knowledgeEdges = pgTable(
  "knowledge_edges",
  {
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    relation: text("relation").notNull(),
    weight: doublePrecision("weight").default(1.0),
    metadata: text("metadata").default("{}"),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()::text`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceId, t.targetId, t.relation] }),
    idxSource: index("idx_edges_source").on(t.tenantId, t.sourceId),
    idxTarget: index("idx_edges_target").on(t.tenantId, t.targetId),
    idxRelation: index("idx_edges_relation").on(t.relation),
  }),
);

// ── usage_records ─────────────────────────────────────────────────────────

export const usageRecords = pgTable(
  "usage_records",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    userId: text("user_id").notNull().default("system"),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    runtime: text("runtime"),
    agentRole: text("agent_role"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").default(0),
    cacheWriteTokens: integer("cache_write_tokens").default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    costMode: text("cost_mode").notNull().default("api"),
    source: text("source").notNull().default("transcript"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()::text`),
  },
  (t) => ({
    idxSession: index("idx_usage_session").on(t.sessionId),
    idxCostMode: index("idx_usage_cost_mode").on(t.costMode),
    idxTenant: index("idx_usage_tenant").on(t.tenantId),
    idxUser: index("idx_usage_user").on(t.userId),
    idxModel: index("idx_usage_model").on(t.model),
    idxCreated: index("idx_usage_created").on(t.createdAt),
  }),
);

// ── session_artifacts ─────────────────────────────────────────────────────

export const sessionArtifacts = pgTable(
  "session_artifacts",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    value: text("value").notNull(),
    metadata: text("metadata").default("{}"),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()::text`),
  },
  (t) => ({
    idxSession: index("idx_artifacts_session").on(t.sessionId),
    idxTypeValue: index("idx_artifacts_type_value").on(t.type, t.value),
    idxTenant: index("idx_artifacts_tenant").on(t.tenantId),
  }),
);

// ── compute_pools ─────────────────────────────────────────────────────────

export const computePools = pgTable(
  "compute_pools",
  {
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    minInstances: integer("min_instances").notNull().default(0),
    maxInstances: integer("max_instances").notNull().default(10),
    config: text("config").default("{}"),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.name, t.tenantId] }),
    idxTenant: index("idx_compute_pools_tenant").on(t.tenantId),
  }),
);

// ── instance_heartbeat ────────────────────────────────────────────────────

export const instanceHeartbeat = pgTable("instance_heartbeat", {
  id: text("id").primaryKey(),
  pid: integer("pid").notNull(),
  startedAt: text("started_at").notNull(),
  lastHeartbeat: text("last_heartbeat").notNull(),
});

// ── ark_schema_migrations ─────────────────────────────────────────────────

export const arkSchemaMigrations = pgTable("ark_schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
});
