CREATE TABLE `turn_usage` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`output_tokens` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`)
);
