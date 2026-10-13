CREATE TABLE `execution_markers` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`workspace_key` text NOT NULL,
	`codex_epoch` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`reconciled_at` integer,
	`reconciliation_operation_id` text,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`client_operation_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reconciliation_operation_id`) REFERENCES `operations`(`client_operation_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "execution_markers_state_check" CHECK("execution_markers"."state" in ('active', 'unknown', 'terminal', 'reconciled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_markers_active_thread` ON `execution_markers` (`thread_id`) WHERE "execution_markers"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `execution_markers_active_workspace` ON `execution_markers` (`workspace_key`) WHERE "execution_markers"."ended_at" is null;--> statement-breakpoint
CREATE TABLE `operations` (
	`client_operation_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`request_digest` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "operations_state_check" CHECK("operations"."state" in ('accepted', 'dispatching', 'acknowledged', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX `operations_state_idx` ON `operations` (`state`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thread_links` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`cwd` text NOT NULL,
	`source` text NOT NULL,
	`managed_epoch` text,
	`updated_at` integer NOT NULL
);
