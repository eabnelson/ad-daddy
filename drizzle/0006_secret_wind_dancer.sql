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
CREATE TABLE `__ad_daddy_0006_empty_table_preflight` (
	`ok` integer NOT NULL,
	CONSTRAINT "payment_tables_must_be_empty_before_0006" CHECK (`ok` = 1)
);--> statement-breakpoint
INSERT INTO `__ad_daddy_0006_empty_table_preflight` (`ok`)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM `deposit_commitments`) = 0 AND
	(SELECT COUNT(*) FROM `payout_records`) = 0 AND
	(SELECT COUNT(*) FROM `refund_records`) = 0
THEN 1 ELSE 0 END;--> statement-breakpoint
DROP TABLE `__ad_daddy_0006_empty_table_preflight`;--> statement-breakpoint
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
