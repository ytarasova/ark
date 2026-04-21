CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"deleted_at" text,
	"deleted_by" text,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"expires_at" text
);
--> statement-breakpoint
CREATE TABLE "ark_schema_migrations" (
	"version" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"applied_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claude_sessions_cache" (
	"session_id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"project_dir" text NOT NULL,
	"transcript_path" text NOT NULL,
	"summary" text DEFAULT '',
	"message_count" integer DEFAULT 0,
	"timestamp" text DEFAULT '',
	"last_activity" text DEFAULT '',
	"cached_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute" (
	"name" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'local' NOT NULL,
	"compute_kind" text DEFAULT 'local' NOT NULL,
	"runtime_kind" text DEFAULT 'direct' NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"config" text DEFAULT '{}',
	"is_template" boolean DEFAULT false NOT NULL,
	"cloned_from" text,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_pools" (
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"min_instances" integer DEFAULT 0 NOT NULL,
	"max_instances" integer DEFAULT 10 NOT NULL,
	"config" text DEFAULT '{}',
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "compute_pools_name_tenant_id_pk" PRIMARY KEY("name","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "compute_templates" (
	"name" text NOT NULL,
	"description" text,
	"provider" text NOT NULL,
	"config" text DEFAULT '{}',
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "compute_templates_name_tenant_id_pk" PRIMARY KEY("name","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"type" text NOT NULL,
	"stage" text,
	"actor" text,
	"data" text,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"name" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "groups_name_tenant_id_pk" PRIMARY KEY("name","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "instance_heartbeat" (
	"id" text PRIMARY KEY NOT NULL,
	"pid" integer NOT NULL,
	"started_at" text NOT NULL,
	"last_heartbeat" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"content" text,
	"metadata" text DEFAULT '{}',
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_edges" (
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"relation" text NOT NULL,
	"weight" double precision DEFAULT 1,
	"metadata" text DEFAULT '{}',
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "knowledge_edges_source_id_target_id_relation_pk" PRIMARY KEY("source_id","target_id","relation")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"deleted_at" text,
	"deleted_by" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"read" integer DEFAULT 0 NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_definitions" (
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "resource_definitions_name_kind_tenant_id_pk" PRIMARY KEY("name","kind","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"cron" text NOT NULL,
	"flow" text DEFAULT 'bare' NOT NULL,
	"repo" text,
	"workdir" text,
	"summary" text,
	"compute_name" text,
	"group_name" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"last_run" text,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"user_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"metadata" text DEFAULT '{}',
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket" text,
	"summary" text,
	"repo" text,
	"branch" text,
	"compute_name" text,
	"session_id" text,
	"claude_session_id" text,
	"stage" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"flow" text DEFAULT 'default' NOT NULL,
	"agent" text,
	"workdir" text,
	"pr_url" text,
	"pr_id" text,
	"error" text,
	"parent_id" text,
	"fork_group" text,
	"group_name" text,
	"breakpoint_reason" text,
	"attached_by" text,
	"rejection_count" integer DEFAULT 0 NOT NULL,
	"rework_prompt" text,
	"rejected_at" text,
	"rejected_reason" text,
	"pty_cols" integer,
	"pty_rows" integer,
	"config" text DEFAULT '{}',
	"user_id" text,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"workspace_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"deleted_at" text,
	"deleted_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_claude_auth" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"secret_ref" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_policies" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"allowed_providers" text DEFAULT '[]' NOT NULL,
	"default_provider" text DEFAULT 'k8s' NOT NULL,
	"max_concurrent_sessions" integer DEFAULT 10 NOT NULL,
	"max_cost_per_day_usd" double precision,
	"compute_pools" text DEFAULT '[]' NOT NULL,
	"compute_config_yaml" text,
	"created_at" text DEFAULT now()::text NOT NULL,
	"updated_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"deleted_at" text,
	"deleted_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"content" text NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"user_id" text DEFAULT 'system' NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"runtime" text,
	"agent_role" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0,
	"cache_write_tokens" integer DEFAULT 0,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"cost_mode" text DEFAULT 'api' NOT NULL,
	"source" text DEFAULT 'transcript' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"deleted_at" text,
	"deleted_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_tenant" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_hash_live" ON "api_keys" USING btree ("key_hash") WHERE "api_keys"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_claude_cache_activity" ON "claude_sessions_cache" USING btree ("last_activity");--> statement-breakpoint
CREATE INDEX "idx_compute_provider" ON "compute" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_compute_kind" ON "compute" USING btree ("compute_kind");--> statement-breakpoint
CREATE INDEX "idx_compute_runtime_kind" ON "compute" USING btree ("runtime_kind");--> statement-breakpoint
CREATE INDEX "idx_compute_status" ON "compute" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_compute_tenant" ON "compute" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_compute_pools_tenant" ON "compute_pools" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_events_track" ON "events" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "idx_events_type" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_events_tenant" ON "events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_groups_tenant" ON "groups" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_type" ON "knowledge" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "idx_knowledge_label" ON "knowledge" USING btree ("tenant_id","label");--> statement-breakpoint
CREATE INDEX "idx_edges_source" ON "knowledge_edges" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_edges_target" ON "knowledge_edges" USING btree ("tenant_id","target_id");--> statement-breakpoint
CREATE INDEX "idx_edges_relation" ON "knowledge_edges" USING btree ("relation");--> statement-breakpoint
CREATE INDEX "idx_memberships_user" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_memberships_team" ON "memberships" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memberships_user_team_live" ON "memberships" USING btree ("user_id","team_id") WHERE "memberships"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_session" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_messages_tenant" ON "messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_tenant" ON "schedules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_session" ON "session_artifacts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_type_value" ON "session_artifacts" USING btree ("type","value");--> statement-breakpoint
CREATE INDEX "idx_artifacts_tenant" ON "session_artifacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_status" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sessions_repo" ON "sessions" USING btree ("repo");--> statement-breakpoint
CREATE INDEX "idx_sessions_parent" ON "sessions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_group" ON "sessions" USING btree ("group_name");--> statement-breakpoint
CREATE INDEX "idx_sessions_pr_url" ON "sessions" USING btree ("pr_url");--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant" ON "sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_workspace" ON "sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_teams_tenant" ON "teams" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_tenant_slug_live" ON "teams" USING btree ("tenant_id","slug") WHERE "teams"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_tenants_status" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_slug_live" ON "tenants" USING btree ("slug") WHERE "tenants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_todos_session" ON "todos" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_todos_tenant" ON "todos" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_usage_session" ON "usage_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_usage_cost_mode" ON "usage_records" USING btree ("cost_mode");--> statement-breakpoint
CREATE INDEX "idx_usage_tenant" ON "usage_records" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_usage_user" ON "usage_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_model" ON "usage_records" USING btree ("model");--> statement-breakpoint
CREATE INDEX "idx_usage_created" ON "usage_records" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email_live" ON "users" USING btree ("email") WHERE "users"."deleted_at" IS NULL;