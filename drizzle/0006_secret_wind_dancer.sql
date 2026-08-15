CREATE TABLE `refund_approval_records` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`refund_address` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`proof_id` text NOT NULL,
	`nonce` text NOT NULL,
	`approved_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_by_refund_id` text,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proof_id`) REFERENCES `refund_human_proofs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refund_approval_amount_positive" CHECK("refund_approval_records"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_approval_proof_unique` ON `refund_approval_records` (`proof_id`);--> statement-breakpoint
CREATE TABLE `refund_human_proofs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`nonce` text NOT NULL,
	`method` text NOT NULL,
	`verified_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_by_approval_id` text,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `human_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_human_proof_nonce_unique` ON `refund_human_proofs` (`nonce`);--> statement-breakpoint
ALTER TABLE `deposit_commitments` ADD `advertiser_ledger_account_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `deposit_commitments` ADD `treasury_ledger_account_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `payout_records` ADD `receiver_ledger_account_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `payout_records` ADD `treasury_ledger_account_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `payout_records` ADD `destination_address` text NOT NULL;--> statement-breakpoint
ALTER TABLE `payout_records` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `payout_records` ADD `queued_at` text NOT NULL;--> statement-breakpoint
ALTER TABLE `refund_records` ADD `approval_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `refund_records` ADD `account_id` text NOT NULL REFERENCES human_accounts(id);--> statement-breakpoint
ALTER TABLE `refund_records` ADD `advertiser_ledger_account_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `refund_records` ADD `treasury_ledger_account_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `refund_records` ADD `failure_reason` text;--> statement-breakpoint
CREATE UNIQUE INDEX `refund_record_campaign_unique` ON `refund_records` (`campaign_id`);