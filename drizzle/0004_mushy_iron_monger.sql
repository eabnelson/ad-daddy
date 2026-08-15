CREATE TABLE `placement_measurement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`placement_id` text NOT NULL,
	`event_type` text NOT NULL,
	`evidence_status` text NOT NULL,
	`evidence_provider` text,
	`evidence_id` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`placement_id`) REFERENCES `placements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_measurement_evidence_unique` ON `placement_measurement_events` (`placement_id`,`event_type`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `placement_measurement_time_idx` ON `placement_measurement_events` (`placement_id`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `placements` ADD `host_kind` text;--> statement-breakpoint
ALTER TABLE `placements` ADD `delivery_status` text DEFAULT 'verifying' NOT NULL;--> statement-breakpoint
ALTER TABLE `placements` ADD `signed_placement_json` text;--> statement-breakpoint
ALTER TABLE `placements` ADD `rendered_response` text;--> statement-breakpoint
ALTER TABLE `placements` ADD `rendered_response_sha256` text;--> statement-breakpoint
ALTER TABLE `placements` ADD `host_receipt_json` text;--> statement-breakpoint
ALTER TABLE `placements` ADD `creative_retention_expires_at` text;--> statement-breakpoint
ALTER TABLE `placements` ADD `reported_at` text;