CREATE TABLE `stage_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`stage` text DEFAULT '' NOT NULL,
	`op_kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stage_operations_unique` ON `stage_operations` (`session_id`,`stage`,`op_kind`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_stage_operations_session` ON `stage_operations` (`session_id`);--> statement-breakpoint
DROP INDEX `idx_compute_provider`;--> statement-breakpoint
DROP INDEX `idx_compute_runtime_kind`;--> statement-breakpoint
ALTER TABLE `compute` ADD `isolation_kind` text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_compute_isolation_kind` ON `compute` (`isolation_kind`);--> statement-breakpoint
ALTER TABLE `compute` DROP COLUMN `provider`;--> statement-breakpoint
ALTER TABLE `compute` DROP COLUMN `runtime_kind`;--> statement-breakpoint
ALTER TABLE `compute_templates` ADD `compute_kind` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `compute_templates` ADD `isolation_kind` text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE `compute_templates` DROP COLUMN `provider`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `orchestrator` text DEFAULT 'custom' NOT NULL;