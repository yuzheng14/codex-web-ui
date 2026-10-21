ALTER TABLE `project_registrations` ADD `sort_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) - 1 AS position
  FROM project_registrations
)
UPDATE project_registrations
SET sort_order = (SELECT position FROM ranked WHERE ranked.id = project_registrations.id);
