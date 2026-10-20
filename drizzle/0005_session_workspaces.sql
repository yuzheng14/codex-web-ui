CREATE TABLE `session_workspaces` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`root_path` text NOT NULL,
	`canonical_root` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_workspaces_thread_id_unique` ON `session_workspaces` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_workspaces_canonical_root_unique` ON `session_workspaces` (`canonical_root`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_thread_links` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`cwd` text NOT NULL,
	`source` text NOT NULL,
	`managed_epoch` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_thread_links`("thread_id", "project_id", "cwd", "source", "managed_epoch", "updated_at") SELECT "thread_id", "project_id", "cwd", "source", "managed_epoch", "updated_at" FROM `thread_links`;--> statement-breakpoint
DROP TABLE `thread_links`;--> statement-breakpoint
ALTER TABLE `__new_thread_links` RENAME TO `thread_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;