# DB Map

> generated: 1970-01-01T00:00:00.000Z  -  regenerate with `make audit`.

Source: `packages/core/drizzle/schema/sqlite.ts`.  Total tables: **25**.

## `api_keys`

- TS binding: `apiKeys`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (10):
  - `created_at` (text, NOT NULL)
  - `deleted_at` (text)
  - `deleted_by` (text)
  - `expires_at` (text)
  - `id` (text)
  - `key_hash` (text, NOT NULL)
  - `last_used_at` (text)
  - `name` (text, NOT NULL)
  - `role` (text, NOT NULL DEFAULT)
  - `tenant_id` (text, NOT NULL)
- writers (1):
  - `packages/core/auth/api-keys.ts`
- readers (1):
  - `packages/core/auth/api-keys.ts`
- migration history (3):
  - `packages/core/migrations/006_apikeys_soft_delete.ts`
  - `packages/core/migrations/006_apikeys_soft_delete_postgres.ts`
  - `packages/core/migrations/006_apikeys_soft_delete_sqlite.ts`

## `ark_schema_migrations`

- TS binding: `arkSchemaMigrations`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (3):
  - `applied_at` (text, NOT NULL)
  - `name` (text, NOT NULL)
  - `version` (integer)
- writers (0):
- readers (0):
- migration history (2):
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/009_drizzle_cutover.ts`

## `claude_sessions_cache`

- TS binding: `claudeSessionsCache`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (9):
  - `cached_at` (text, NOT NULL)
  - `last_activity` (text, DEFAULT)
  - `message_count` (integer, DEFAULT)
  - `project` (text, NOT NULL)
  - `project_dir` (text, NOT NULL)
  - `session_id` (text)
  - `summary` (text, DEFAULT)
  - `timestamp` (text, DEFAULT)
  - `transcript_path` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (0):

## `compute`

- TS binding: `compute`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (11):
  - `cloned_from` (text)
  - `compute_kind` (text, NOT NULL DEFAULT)
  - `config` (text, DEFAULT)
  - `created_at` (text, NOT NULL)
  - `is_template` (integer, NOT NULL DEFAULT)
  - `isolation_kind` (text, NOT NULL DEFAULT)
  - `name` (text)
  - `provider` (text, NOT NULL DEFAULT)
  - `status` (text, NOT NULL DEFAULT)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `updated_at` (text, NOT NULL)
- writers (2):
  - `packages/core/repositories/schema-postgres.ts`
  - `packages/core/repositories/schema.ts`
- readers (0):
- migration history (9):
  - `packages/core/migrations/001_initial.ts`
  - `packages/core/migrations/002_compute_unify.ts`
  - `packages/core/migrations/002_compute_unify_postgres.ts`
  - `packages/core/migrations/002_compute_unify_sqlite.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/012_isolation_kind_rename.ts`
  - `packages/core/migrations/012_isolation_kind_rename_postgres.ts`
  - `packages/core/migrations/012_isolation_kind_rename_sqlite.ts`

## `compute_pools`

- TS binding: `computePools`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (8):
  - `config` (text, DEFAULT)
  - `created_at` (text, NOT NULL)
  - `max_instances` (integer, NOT NULL DEFAULT)
  - `min_instances` (integer, NOT NULL DEFAULT)
  - `name` (text, NOT NULL)
  - `provider` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `updated_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (2):
  - `packages/core/migrations/008_tenant_compute_config_postgres.ts`
  - `packages/core/migrations/008_tenant_compute_config_sqlite.ts`

## `compute_templates`

- TS binding: `computeTemplates`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (7):
  - `config` (text, DEFAULT)
  - `created_at` (text, NOT NULL)
  - `description` (text)
  - `name` (text, NOT NULL)
  - `provider` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `updated_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (3):
  - `packages/core/migrations/002_compute_unify.ts`
  - `packages/core/migrations/002_compute_unify_postgres.ts`
  - `packages/core/migrations/002_compute_unify_sqlite.ts`

## `events`

- TS binding: `events`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (8):
  - `actor` (text)
  - `created_at` (text, NOT NULL)
  - `data` (text)
  - `id` (integer)
  - `stage` (text)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `track_id` (text, NOT NULL)
  - `type` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (3):
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/004_soft_delete.ts`

## `groups`

- TS binding: `groups`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (3):
  - `created_at` (text, NOT NULL)
  - `name` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
- writers (0):
- readers (0):
- migration history (0):

## `instance_heartbeat`

- TS binding: `instanceHeartbeat`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (4):
  - `id` (text)
  - `last_heartbeat` (text, NOT NULL)
  - `pid` (integer, NOT NULL)
  - `started_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (0):

## `knowledge`

- TS binding: `knowledge`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (8):
  - `content` (text)
  - `created_at` (text, NOT NULL DEFAULT)
  - `id` (text)
  - `label` (text, NOT NULL)
  - `metadata` (text, DEFAULT)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `type` (text, NOT NULL)
  - `updated_at` (text, NOT NULL DEFAULT)
- writers (0):
- readers (0):
- migration history (1):
  - `packages/core/migrations/013_eval_session_type.ts`

## `knowledge_edges`

- TS binding: `knowledgeEdges`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (7):
  - `created_at` (text, NOT NULL DEFAULT)
  - `metadata` (text, DEFAULT)
  - `relation` (text, NOT NULL)
  - `source_id` (text, NOT NULL)
  - `target_id` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `weight` (real, DEFAULT)
- writers (0):
- readers (0):
- migration history (0):

## `memberships`

- TS binding: `memberships`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (7):
  - `created_at` (text, NOT NULL)
  - `deleted_at` (text)
  - `deleted_by` (text)
  - `id` (text)
  - `role` (text, NOT NULL DEFAULT)
  - `team_id` (text, NOT NULL)
  - `user_id` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (10):
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/004_soft_delete.ts`
  - `packages/core/migrations/004_soft_delete_postgres.ts`
  - `packages/core/migrations/004_soft_delete_sqlite.ts`
  - `packages/core/migrations/005_deleted_by.ts`
  - `packages/core/migrations/005_deleted_by_postgres.ts`
  - `packages/core/migrations/005_deleted_by_sqlite.ts`
  - `packages/core/migrations/006_apikeys_soft_delete.ts`

## `messages`

- TS binding: `messages`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (8):
  - `content` (text, NOT NULL)
  - `created_at` (text, NOT NULL)
  - `id` (integer)
  - `read` (integer, NOT NULL DEFAULT)
  - `role` (text, NOT NULL)
  - `session_id` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `type` (text, NOT NULL DEFAULT)
- writers (0):
- readers (0):
- migration history (3):
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/004_soft_delete.ts`

## `resource_definitions`

- TS binding: `resourceDefinitions`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (6):
  - `content` (text, NOT NULL)
  - `created_at` (text, NOT NULL)
  - `kind` (text, NOT NULL)
  - `name` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `updated_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (0):

## `schedules`

- TS binding: `schedules`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (13):
  - `compute_name` (text)
  - `created_at` (text, NOT NULL)
  - `cron` (text, NOT NULL)
  - `enabled` (integer, NOT NULL DEFAULT)
  - `flow` (text, NOT NULL DEFAULT)
  - `group_name` (text)
  - `id` (text)
  - `last_run` (text)
  - `repo` (text)
  - `summary` (text)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `user_id` (text)
  - `workdir` (text)
- writers (0):
- readers (0):
- migration history (2):
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`

## `session_artifacts`

- TS binding: `sessionArtifacts`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (7):
  - `created_at` (text, NOT NULL DEFAULT)
  - `id` (integer)
  - `metadata` (text, DEFAULT)
  - `session_id` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `type` (text, NOT NULL)
  - `value` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (0):

## `sessions`

- TS binding: `sessions`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (34):
  - `agent` (text)
  - `attached_by` (text)
  - `branch` (text)
  - `breakpoint_reason` (text)
  - `claude_session_id` (text)
  - `compute_name` (text)
  - `config` (text, DEFAULT)
  - `created_at` (text, NOT NULL)
  - `error` (text)
  - `flow` (text, NOT NULL DEFAULT)
  - `fork_group` (text)
  - `group_name` (text)
  - `id` (text)
  - `orchestrator` (text, NOT NULL DEFAULT)
  - `parent_id` (text)
  - `pr_id` (text)
  - `pr_url` (text)
  - `pty_cols` (integer)
  - `pty_rows` (integer)
  - `rejected_at` (text)
  - `rejected_reason` (text)
  - `rejection_count` (integer, NOT NULL DEFAULT)
  - `repo` (text)
  - `rework_prompt` (text)
  - `session_id` (text)
  - `stage` (text)
  - `status` (text, NOT NULL DEFAULT)
  - `summary` (text)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `ticket` (text)
  - `updated_at` (text, NOT NULL)
  - `user_id` (text)
  - `workdir` (text)
  - `workspace_id` (text)
- writers (0):
- readers (2):
  - `packages/core/auth/tenant-policy.ts`
  - `packages/core/repositories/session.ts`
- migration history (8):
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/004_soft_delete.ts`
  - `packages/core/migrations/007_tenant_claude_auth.ts`
  - `packages/core/migrations/011_session_orchestrator.ts`
  - `packages/core/migrations/011_session_orchestrator_postgres.ts`
  - `packages/core/migrations/011_session_orchestrator_sqlite.ts`

## `stage_operations`

- TS binding: `stageOperations`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (7):
  - `created_at` (text, NOT NULL)
  - `id` (integer)
  - `idempotency_key` (text, NOT NULL)
  - `op_kind` (text, NOT NULL)
  - `result_json` (text, NOT NULL)
  - `session_id` (text, NOT NULL)
  - `stage` (text, NOT NULL DEFAULT)
- writers (0):
- readers (0):
- migration history (3):
  - `packages/core/migrations/010_stage_operations.ts`
  - `packages/core/migrations/010_stage_operations_postgres.ts`
  - `packages/core/migrations/010_stage_operations_sqlite.ts`

## `teams`

- TS binding: `teams`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (9):
  - `created_at` (text, NOT NULL)
  - `deleted_at` (text)
  - `deleted_by` (text)
  - `description` (text)
  - `id` (text)
  - `name` (text, NOT NULL)
  - `slug` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL)
  - `updated_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (10):
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/004_soft_delete.ts`
  - `packages/core/migrations/004_soft_delete_postgres.ts`
  - `packages/core/migrations/004_soft_delete_sqlite.ts`
  - `packages/core/migrations/005_deleted_by.ts`
  - `packages/core/migrations/005_deleted_by_postgres.ts`
  - `packages/core/migrations/005_deleted_by_sqlite.ts`
  - `packages/core/migrations/006_apikeys_soft_delete.ts`

## `tenant_claude_auth`

- TS binding: `tenantClaudeAuth`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (5):
  - `created_at` (text, NOT NULL)
  - `kind` (text, NOT NULL)
  - `secret_ref` (text, NOT NULL)
  - `tenant_id` (text)
  - `updated_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (3):
  - `packages/core/migrations/007_tenant_claude_auth.ts`
  - `packages/core/migrations/007_tenant_claude_auth_postgres.ts`
  - `packages/core/migrations/007_tenant_claude_auth_sqlite.ts`

## `tenant_policies`

- TS binding: `tenantPolicies`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (9):
  - `allowed_providers` (text, NOT NULL DEFAULT)
  - `compute_config_yaml` (text)
  - `compute_pools` (text, NOT NULL DEFAULT)
  - `created_at` (text, NOT NULL DEFAULT)
  - `default_provider` (text, NOT NULL DEFAULT)
  - `max_concurrent_sessions` (integer, NOT NULL DEFAULT)
  - `max_cost_per_day_usd` (real)
  - `tenant_id` (text)
  - `updated_at` (text, NOT NULL DEFAULT)
- writers (1):
  - `packages/core/auth/tenant-policy.ts`
- readers (1):
  - `packages/core/auth/tenant-policy.ts`
- migration history (8):
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/007_tenant_claude_auth.ts`
  - `packages/core/migrations/007_tenant_claude_auth_postgres.ts`
  - `packages/core/migrations/008_tenant_compute_config.ts`
  - `packages/core/migrations/008_tenant_compute_config_postgres.ts`
  - `packages/core/migrations/008_tenant_compute_config_sqlite.ts`

## `tenants`

- TS binding: `tenants`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (8):
  - `created_at` (text, NOT NULL)
  - `deleted_at` (text)
  - `deleted_by` (text)
  - `id` (text)
  - `name` (text, NOT NULL)
  - `slug` (text, NOT NULL)
  - `status` (text, NOT NULL DEFAULT)
  - `updated_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (12):
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/004_soft_delete.ts`
  - `packages/core/migrations/004_soft_delete_postgres.ts`
  - `packages/core/migrations/004_soft_delete_sqlite.ts`
  - `packages/core/migrations/005_deleted_by.ts`
  - `packages/core/migrations/005_deleted_by_postgres.ts`
  - `packages/core/migrations/005_deleted_by_sqlite.ts`
  - `packages/core/migrations/006_apikeys_soft_delete.ts`
  - `packages/core/migrations/007_tenant_claude_auth.ts`
  - `packages/core/migrations/007_tenant_claude_auth_postgres.ts`

## `todos`

- TS binding: `todos`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (6):
  - `content` (text, NOT NULL)
  - `created_at` (text, NOT NULL)
  - `done` (integer, NOT NULL DEFAULT)
  - `id` (integer)
  - `session_id` (text, NOT NULL)
  - `tenant_id` (text, NOT NULL DEFAULT)
- writers (0):
- readers (0):
- migration history (2):
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`

## `usage_records`

- TS binding: `usageRecords`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (16):
  - `agent_role` (text)
  - `cache_read_tokens` (integer, DEFAULT)
  - `cache_write_tokens` (integer, DEFAULT)
  - `cost_mode` (text, NOT NULL DEFAULT)
  - `cost_usd` (real, NOT NULL DEFAULT)
  - `created_at` (text, NOT NULL DEFAULT)
  - `id` (integer)
  - `input_tokens` (integer, NOT NULL DEFAULT)
  - `model` (text, NOT NULL)
  - `output_tokens` (integer, NOT NULL DEFAULT)
  - `provider` (text, NOT NULL)
  - `runtime` (text)
  - `session_id` (text, NOT NULL)
  - `source` (text, NOT NULL DEFAULT)
  - `tenant_id` (text, NOT NULL DEFAULT)
  - `user_id` (text, NOT NULL DEFAULT)
- writers (0):
- readers (0):
- migration history (0):

## `users`

- TS binding: `users`
- defined in: `packages/core/drizzle/schema/sqlite.ts`
- columns (7):
  - `created_at` (text, NOT NULL)
  - `deleted_at` (text)
  - `deleted_by` (text)
  - `email` (text, NOT NULL)
  - `id` (text)
  - `name` (text)
  - `updated_at` (text, NOT NULL)
- writers (0):
- readers (0):
- migration history (10):
  - `packages/core/migrations/003_tenants_teams.ts`
  - `packages/core/migrations/003_tenants_teams_postgres.ts`
  - `packages/core/migrations/003_tenants_teams_sqlite.ts`
  - `packages/core/migrations/004_soft_delete.ts`
  - `packages/core/migrations/004_soft_delete_postgres.ts`
  - `packages/core/migrations/004_soft_delete_sqlite.ts`
  - `packages/core/migrations/005_deleted_by.ts`
  - `packages/core/migrations/005_deleted_by_postgres.ts`
  - `packages/core/migrations/005_deleted_by_sqlite.ts`
  - `packages/core/migrations/006_apikeys_soft_delete.ts`

