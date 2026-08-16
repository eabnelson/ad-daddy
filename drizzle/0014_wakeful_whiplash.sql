CREATE TABLE `settlement_review_approvals` (
	`claim_id` text NOT NULL,
	`operator_account_id` text NOT NULL,
	`resolution` text NOT NULL,
	`approved_at` text NOT NULL,
	PRIMARY KEY(`claim_id`, `operator_account_id`),
	FOREIGN KEY (`claim_id`) REFERENCES `placement_claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operator_account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `settlement_review_approval_resolution_idx` ON `settlement_review_approvals` (`claim_id`,`resolution`);