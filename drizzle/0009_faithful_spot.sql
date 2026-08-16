CREATE TABLE `human_approval_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`purpose` text NOT NULL,
	`resource_fingerprint` text NOT NULL,
	`approved_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_by` text,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `human_approval_account_expiry_idx` ON `human_approval_capabilities` (`account_id`,`expires_at`);