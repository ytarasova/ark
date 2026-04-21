/**
 * Inferred row types from the drizzle schemas.
 *
 * These are the typed select/insert shapes that repositories and callers will
 * use once the per-repo rewrite (Phase B of the cutover) lands. Exposed now so
 * downstream type aliases in `@ark/types` can start migrating incrementally.
 *
 * The SQLite schema is canonical because it covers the full local-dev surface
 * (including the FTS/knowledge tables). Postgres-specific diffs (`serial` vs
 * INTEGER autoincrement, `boolean` vs INTEGER 0/1) surface in the insert type
 * but NOT in the select type (both dialects read those columns back as
 * number / boolean respectively through drizzle's codecs).
 */

import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import type * as s from "./schema/sqlite.js";

export type SessionRow = InferSelectModel<typeof s.sessions>;
export type SessionInsert = InferInsertModel<typeof s.sessions>;

export type EventRow = InferSelectModel<typeof s.events>;
export type EventInsert = InferInsertModel<typeof s.events>;

export type ComputeRow = InferSelectModel<typeof s.compute>;
export type ComputeInsert = InferInsertModel<typeof s.compute>;

export type ComputeTemplateRow = InferSelectModel<typeof s.computeTemplates>;
export type ComputeTemplateInsert = InferInsertModel<typeof s.computeTemplates>;

export type MessageRow = InferSelectModel<typeof s.messages>;
export type MessageInsert = InferInsertModel<typeof s.messages>;

export type TodoRow = InferSelectModel<typeof s.todos>;
export type TodoInsert = InferInsertModel<typeof s.todos>;

export type ScheduleRow = InferSelectModel<typeof s.schedules>;
export type ScheduleInsert = InferInsertModel<typeof s.schedules>;

export type ApiKeyRow = InferSelectModel<typeof s.apiKeys>;
export type ApiKeyInsert = InferInsertModel<typeof s.apiKeys>;

export type TenantRow = InferSelectModel<typeof s.tenants>;
export type TenantInsert = InferInsertModel<typeof s.tenants>;

export type UserRow = InferSelectModel<typeof s.users>;
export type UserInsert = InferInsertModel<typeof s.users>;

export type TeamRow = InferSelectModel<typeof s.teams>;
export type TeamInsert = InferInsertModel<typeof s.teams>;

export type MembershipRow = InferSelectModel<typeof s.memberships>;
export type MembershipInsert = InferInsertModel<typeof s.memberships>;

export type TenantPolicyRow = InferSelectModel<typeof s.tenantPolicies>;
export type TenantPolicyInsert = InferInsertModel<typeof s.tenantPolicies>;

export type TenantClaudeAuthRow = InferSelectModel<typeof s.tenantClaudeAuth>;
export type TenantClaudeAuthInsert = InferInsertModel<typeof s.tenantClaudeAuth>;

export type ResourceDefinitionRow = InferSelectModel<typeof s.resourceDefinitions>;
export type ResourceDefinitionInsert = InferInsertModel<typeof s.resourceDefinitions>;

export type UsageRecordRow = InferSelectModel<typeof s.usageRecords>;
export type UsageRecordInsert = InferInsertModel<typeof s.usageRecords>;

export type SessionArtifactRow = InferSelectModel<typeof s.sessionArtifacts>;
export type SessionArtifactInsert = InferInsertModel<typeof s.sessionArtifacts>;

export type ComputePoolRow = InferSelectModel<typeof s.computePools>;
export type ComputePoolInsert = InferInsertModel<typeof s.computePools>;

export type InstanceHeartbeatRow = InferSelectModel<typeof s.instanceHeartbeat>;
export type InstanceHeartbeatInsert = InferInsertModel<typeof s.instanceHeartbeat>;

export type ArkSchemaMigrationRow = InferSelectModel<typeof s.arkSchemaMigrations>;
export type ArkSchemaMigrationInsert = InferInsertModel<typeof s.arkSchemaMigrations>;
